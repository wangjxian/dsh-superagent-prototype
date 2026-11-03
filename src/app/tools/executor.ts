/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, reporting status with the changes the ticket made, and computing a Codeup target release. */
import { z } from 'zod'
import { liveTicket, threadKey, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { triggerChange, type Change } from '../../hosting.ts'
import { targetRelease } from '../../infra/release.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { repositoryOf } from '../../sources/codeup-hosting.ts'
import { currentRules } from '../../sources/yunxiao.ts'
import { yunxiaoRef } from '../../sources/yunxiao-trigger.ts'
import { nonFixConclusion } from '../../sources/yunxiao-write.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { integrateQa, prepareQa, testQa, verifyQa, QaDeploymentSchema, QaEnvironmentSchema, QaProjectSchema } from '../qa.ts'

/** One statement a worker asks to run on PRE: what it does, where it runs, and how to undo and check it. */
export interface SqlActionInput {
  title: string
  file: string
  database: string
  phase: 'before' | 'after'
  sql: string
  rollback: string
  check: string
}

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'get' | 'set' | 'delete' | 'keys'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** A Source context of the deployment: the hosting platform a reported change binds through, its commands, and its Threads. */
  readonly source: SourceContext
  /** The host's approvals: a merge request's, and a pipeline a worker may not start itself. */
  readonly merges?: {
    request(ticketId: string, changes: readonly { repository: string; localId: number }[]): Promise<unknown>
    requestPipeline?(ticketId: string, pipelineId: string): Promise<unknown>
    requestSql?(ticketId: string, actions: readonly SqlActionInput[]): Promise<unknown>
  } | undefined
  sendReplies(): Promise<void>
  runQaCommand?(ticket: Ticket, command: string, directory: string, signal: AbortSignal, variables?: Record<string, string>, timeoutMs?: number): Promise<string>
}

/**
 * The other open ticket that already holds `key`: one that follows the Thread, or, where a change does not end its ticket
 * (Codeup in this phase), one whose worker asked to follow it for context. One change reaches one ticket at a time.
 */
function holder(host: ExecutorToolsHost, ticket: Ticket, key: string): string | undefined {
  const { hosting } = host.source.deployment
  const contexts = hosting.changeEndsTicket ? [] : host.source.threads.get(key)?.context ?? []
  return host.source.tickets.open().find(item => item.id !== ticket.id
    && ((item.follows ?? []).some(follow => follow.thread === key && !follow.closed) || contexts.includes(item.id)))?.id
}
/**
 * Binds one change a report names to the ticket through the platform's own rule and its own Thread: GitHub's ticket ends
 * with the change it follows, whereas a Codeup merge request is followed for context so the ticket still ends with its ready
 * report; merge-request polling delivers discussion without ending the work-item ticket.
 * @throws Error when the platform refuses the change, or another open ticket already holds it.
 */
function claimChange(host: ExecutorToolsHost, ticket: Ticket, change: Change): void {
  const context = host.source
  const { hosting } = context.deployment
  const origin = context.triggers.get(ticket.origin.triggerId)
  const serial = typeof origin?.meta.serial === 'string' && origin.meta.serial ? origin.meta.serial : undefined
  const claim = hosting.claim({ ticket, change, source: triggerChange(origin, change.repository), serial })
  if ('refused' in claim) throw new Error(claim.refused)
  const thread = hosting.thread(change), key = threadKey(thread)
  const owner = holder(host, ticket, key)
  if (owner) throw new Error(`${key} already belongs to the open ticket ${owner}`)
  const follow = ticket.follows?.find(item => item.thread === key)
  // An open change the ticket does not follow yet, or followed as context and now opened itself, is recorded so the ticket shows it.
  if (change.state === 'open' && (!follow || follow.closed || (claim.own && !follow.own))) {
    // A platform whose change does not end its ticket binds it for its messages: the ticket ends with its own ready report.
    context.tickets.bindThread(ticket.id, thread, claim.own, hosting.changeEndsTicket)
    context.threads.patch(key, { number: change.number, isPr: true, url: change.url, prAuthor: change.author })
  }
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const { hosting } = host.source.deployment
  const origin = host.source.triggers.get(ticket.origin.triggerId)
  const qaDelivery = hosting.platform === 'codeup' && !!origin && !!yunxiaoRef(origin).workitemId
  const qaRunner = (signal: AbortSignal, timeoutMs?: number) => (command: string, directory: string, variables?: Record<string, string>) => {
    if (!host.runQaCommand) throw new Error('QA worker command execution is unavailable')
    return host.runQaCommand(ticket, command, directory, signal, variables, timeoutMs)
  }
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another change request, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say, with the changes the ticket made.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        changes: z.array(z.object({
          repository: z.string().min(1).describe(hosting.platform === 'codeup'
            ? 'The repository id in the Codeup workspace, as orchestrator_codeup_target reports it.'
            : 'The repository as owner/name.'),
          localId: z.number().int().positive().describe(hosting.platform === 'codeup' ? 'The merge request local id.' : 'The pull request number.'),
        }).strict()).optional().describe(`The ticket's changes: its source change, or one by ${hosting.account.name} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        result: z.record(z.string(), z.unknown()).optional().describe('The structured outcome: root cause, changes and verification. For Yunxiao, write concise Chinese summaries instead of raw logs; status uses 已修复, 待验证, 阻塞, 待确认 or 无需修改. Actual fixes require QA; explicit non-fix conclusions write the conclusion without claiming a fix.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (its change was closed or work finished); do not resume it')
        if (qaDelivery && args.changes?.length) throw new Error('Report fixed QA publication evidence in result.qa; QA merge requests are managed by orchestrator_qa_integrate')
        const nonFix = qaDelivery && nonFixConclusion(args.result?.status)
        const qa = qaDelivery && args.state === 'ready' && !nonFix ? await verifyQa({ commands: host.source.commands.withSignal(signal), store: host.store }, ticketId, args.result ?? {}) : undefined
        const result = nonFix && args.result ? Object.fromEntries(Object.entries(args.result).filter(([name]) => name !== 'qa')) : args.result
        // Read every change before the transaction, so an unreadable one leaves the ticket and its threads as they were.
        const changes: Change[] = []
        for (const item of args.changes ?? []) changes.push(await hosting.readChange(host.source.commands, item.repository, item.localId, signal))
        // Claim the changes, record the report, and queue the relay atomically so a refused claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const ticket = host.store.tickets.get(ticketId)
          if (!ticket) throw new Error('Ticket ended (its change was closed or work finished); do not resume it')
          for (const change of changes) claimChange(host, ticket, change)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(result ? { result: { ...result, ...qa ? { qa } : {} } } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
    // A statement for PRE waits for the approver; QA statements the worker runs itself, and PROD statements it never runs.
    ...hosting.platform === 'codeup' && !qaDelivery && host.merges?.requestSql ? [tool({
      name: 'orchestrator_sql_approval',
      description: 'Ask the approver to allow statements on PRE before running them. The host sends them the full SQL, the target database and the check query, and answers this ticket when they reply; QA statements need no approval, and a PROD statement is never run by a worker. Submit every statement the ticket needs in one call, each with its rollback and its check.',
      schema: z.object({
        actions: z.array(z.object({
          title: z.string().trim().min(1).describe('What the statement does, in one line.'),
          file: z.string().trim().min(1).describe('The file name the statement lives in, committed with the merge request.'),
          database: z.string().trim().min(1).describe('The target database, as the repository names it.'),
          phase: z.enum(['before', 'after']).describe('Whether it runs before or after the deployment.'),
          sql: z.string().trim().min(1).describe('The statement itself, exactly as committed.'),
          rollback: z.string().trim().min(1).describe('The statement that undoes it.'),
          check: z.string().trim().min(1).describe('A read-only query answering 1 or 0: whether the statement took effect.'),
        }).strict()).min(1),
      }).strict(),
      execute: async args => host.merges!.requestSql!(ticketId, args.actions),
    })] : [],
    // A pipeline a worker may not start itself (anything but qa- and pre-) is the approver's call, which the host asks for.
    ...hosting.platform === 'codeup' && !qaDelivery && host.merges?.requestPipeline ? [tool({
      name: 'orchestrator_request_pipeline',
      description: 'Ask the host to start a pipeline the forwarding script refuses, such as one whose name is not qa- or pre-. The host asks the approver on Feishu and starts it when they agree; their answer comes back to this ticket. Call it instead of retrying a refused command.',
      schema: z.object({
        pipeline_id: z.string().min(1).describe('The pipeline id, as the CLI reports it.'),
      }).strict(),
      execute: async args => host.merges!.requestPipeline!(ticketId, args.pipeline_id),
    })] : [],
    // Only Codeup merges through the host: its worker asks, and the approver confirms the target release on Feishu first.
    ...hosting.platform === 'codeup' && !qaDelivery && host.merges ? [tool({
      name: 'orchestrator_request_merge',
      description: 'Ask the host to merge the ticket\'s merge requests. It checks the merge conditions, asks the approver on Feishu to confirm the target release, and merges once they answer; a rejection, a move to another release or a failure comes back to this ticket. Call it once the work is self-reviewed, naming the changes the report named.',
      schema: z.object({
        changes: z.array(z.object({ repository: z.string().min(1), localId: z.number().int().positive() }).strict()).min(1)
          .describe('The merge requests to merge, as orchestrator_report names them.'),
      }).strict(),
      execute: async args => host.merges!.request(ticketId, args.changes),
    })] : [],
    // A GitHub deployment opens pull requests against branches a person names, so its worker reads no target-release tool at all.
    ...hosting.platform === 'codeup' && !qaDelivery ? [tool({
      name: 'orchestrator_codeup_target',
      description: 'Read the release branch a merge request of a repository targets right now: the previous day\'s release until it has merged back into the base branch, then the day\'s own release. Call it before opening a merge request, and never compute the date yourself.',
      schema: z.object({
        repository: z.string().min(1).optional().describe('The repository id or group path; the workspace\'s first repository when omitted.'),
      }).strict(),
      execute: async args => {
        const { codeup } = host.source.deployment
        if (!codeup) throw new Error('This installation has no Codeup account; configure the Codeup Source')
        const named = args.repository ?? hosting.repositories[0]
        if (!named) throw new Error('The Codeup workspace has no repository a ticket may deliver to')
        const repository = repositoryOf(codeup, named)
        if (!repository) throw new Error(`${named} is not a repository of the Codeup workspace ${codeup.workspace}`)
        // The host computes the target and creates the day's release branch when it is missing: a worker may only push bugfix/ and feat/ branches.
        // The receiving rules may name another release pattern, trunk or zone than the team's default.
        const target = await targetRelease({ organization: codeup.organization, repository, caller: host.source.commands,
          ...currentRules() ? { release: currentRules()!.file.release } : {} })
        return { repository: repository.id, ...target }
      },
    })] : [],
    ...qaDelivery ? [tool({
      name: 'orchestrator_qa_prepare',
      description: 'Register ALL involved projects, their fixed QA pipelines and merge_mode, then execute all local unit tests. Keep development on the bare work-item serial branch. For conflicts, create a QA-only <serial>-qa branch from that clean development branch, merge QA there, resolve and test it using integration_branch; never merge QA into development. qa_environment is the real shared QA entry.',
      schema: z.object({ projects: z.array(QaProjectSchema).min(1), qa_environment: QaEnvironmentSchema,
        timeout_ms: z.number().int().min(1000).max(86_400_000).optional().describe('Timeout per local test command, in milliseconds; defaults to 10 minutes.') }).strict(),
      execute: async (args, signal) => prepareQa({ commands: host.source.commands.withSignal(signal), store: host.store }, ticketId,
        String(origin!.meta.serial ?? ''), ticket.execution?.directory ?? '', args.projects, args.qa_environment, qaRunner(signal, args.timeout_ms)),
    }), tool({
      name: 'orchestrator_qa_test',
      description: 'Test the real shared QA environment after all project deployments succeed. Optionally name newer successful deployments containing this work-item code. DSH_QA_EXPECTED_PROJECTS names required development ancestry and the actual QA checkout/pipeline/run to test; verify deployed QA identity and the core flow. Do not start a mock or pull source instead of testing QA. Only recorded successful execution allows a fixed ready result.',
      schema: z.object({ repository: z.string().min(1), command: z.string().trim().min(1).max(4000),
        deployments: z.array(QaDeploymentSchema).min(1).optional(),
        timeout_ms: z.number().int().min(1000).max(86_400_000).optional().describe('QA test timeout in milliseconds; defaults to 10 minutes, at most 24 hours.') }).strict(),
      execute: async (args, signal) => testQa({ commands: host.source.commands.withSignal(signal), store: host.store }, ticketId,
        args.repository, args.command, qaRunner(signal, args.timeout_ms), args.deployments),
    }), tool({
      name: 'orchestrator_qa_integrate',
      description: 'Merge the tested development commit or its tested QA-only integration branch into the fixed QA branch, directly or via MR per the plan. Keep all branches and existing QA history. A conflict starts no pipeline: resolve on <serial>-qa, never on development, then re-prepare and retry. After merging run that project QA pipeline. Wait for all project deployments and execute orchestrator_qa_test before a fixed ready report.',
      schema: z.object({ pipeline_id: z.string().min(1), repository: z.string().min(1),
        repositories: z.array(z.string().min(1)).min(1).describe('All repositories involved in this work item, including ones not integrated yet. Use the same full list on every call.') }).strict(),
      execute: async (args, signal) => integrateQa({ commands: host.source.commands.withSignal(signal), store: host.store }, ticketId,
        String(origin!.meta.serial ?? ''), args.repository, args.pipeline_id, args.repositories),
    })] : [],
  ]
}
