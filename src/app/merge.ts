/**
 * Host-side approvals a person answers in Feishu: the conditions a merge request must meet before it may merge, and the
 * pipelines a worker is not allowed to start itself. A worker may open and push merge requests but never merge one, and may
 * run only the qa- and pre- pipelines; this module is the only place either happens, and only after the configured approver
 * replies to the confirmation it sent.
 */
import { z } from 'zod'
import { key, liveTicket, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import type { CodeupAccount, CodeupRepository } from '../deployment.ts'
import type { Change } from '../hosting.ts'
import type { Commands } from '../infra/commands.ts'
import { targetRelease, type TargetRelease } from '../infra/release.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'
import { KV } from '../kv.ts'
import { repositoryOf } from '../sources/codeup-hosting.ts'
import { createFeishuDirect } from '../sources/feishu-channel.ts'
import { feishuRepliesTo } from '../sources/feishu-trigger.ts'
import { isAgentComment } from '../sources/yunxiao-trigger.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

/** The state of one merge request's approval, as `KV.merge.mr` records it. */
export type MergeState = 'waiting' | 'confirmed' | 'merging' | 'merged' | 'rejected' | 'retarget'
/** One merge request a worker asks to merge, as `orchestrator_report` names it. */
export interface MergeRequestRef { repository: string; localId: number }
/** What a merge request's confirmation says about it, which the approver reads before answering. */
export interface ConfirmationChange {
  /** The repository as a person knows it, such as its group path. */
  repository: string
  number: number
  url: string
  title: string
  /** The release branch the merge request targets, and what made the rule choose it. */
  target: string
  basis: TargetRelease['basis']
  additions?: number
  deletions?: number
  /** The CI verdict, from the checks the merge request's latest commit ran. */
  ci: CiState
  /** The commit the confirmation is about; a newer one needs a new confirmation. */
  commit: string
}
export interface ConfirmationInput { serial?: string; title: string; changes: readonly ConfirmationChange[] }
/** What a person's reply to a confirmation asks for. */
export type MergeReply = { kind: 'approve' } | { kind: 'retarget'; release: string } | { kind: 'reject'; reason: string }
/** What a merge request's checks said about the latest commit. */
export type CiState = 'passed' | 'pending' | 'failed' | 'none'
/** What a worker's request produced: a confirmation it waits on, a condition it must fix, or a missing approver. */
export interface MergeRequestResult {
  status: 'requested' | 'already' | 'not-ready' | 'unconfigured' | 'unknown'
  message?: string
}
/** What the merge flow needs from the host: the CLI, the records, the outbound queue, the worker's note channel, the approver. */
export interface MergeHost {
  readonly commands: Commands
  readonly store: {
    readonly tickets: Pick<Store['tickets'], 'get'>
    readonly triggers: Pick<Store['triggers'], 'get'>
    readonly atomic: Store['atomic']
    readonly get: Store['get']
    readonly set: Store['set']
    readonly keys: Store['keys']
  }
  readonly outbox: Pick<Outbox, 'send'>
  /** Delivers a short instruction to the ticket's worker as a note input (see `Engine.note`). */
  readonly note: (ticketId: string, text: string) => void
  /** The approver's Feishu open_id: from the receiving rules, or the last direct message the approver sent. */
  readonly approver: () => string
}

/**
 * A confirmation message's record, as `KV.merge.message` holds it: one message the approver answers, about a merge, a
 * pipeline, or PRE statements.
 */
interface ConfirmationRecord {
  thread: string; ticketId: string; at: string; kind?: 'merge' | 'pipeline' | 'sql'
  pipeline?: { id: string; name: string }
  sql?: readonly SqlStatement[]
}
/** A pipeline a worker asks the host to start, as the CLI reports it. */
export interface PipelineRef { id: string; name: string }
/** The pipelines a worker may start itself, which therefore never reach the approver. */
const WORKER_PIPELINE = /^(qa|pre)-/i
/**
 * The message the approver answers before the host starts a pipeline outside the worker's allowlist: which pipeline, what
 * starting it means, and how to reply. Like the merge confirmation, it is user-facing copy in the team's language.
 */
export function pipelineConfirmationText(input: { serial?: string; title: string; pipeline: PipelineRef }): string {
  const head = ['【流水线确认】', input.serial ?? '', input.title].filter(Boolean).join(' ')
  return [head, '', `流水线：${input.pipeline.name}（id ${input.pipeline.id}）`,
    '这条流水线不在 qa- / pre- 之内，worker 不能自己启动；同意后由宿主启动它，worker 再盯运行和日志。', '',
    '请直接回复本条消息：同意 / 写原因驳回（流水线没有可改的目标 release）。'].join('\n')
}
/**
 * One statement a worker wants to run against PRE, as the team's SQL action names it: the statement, its rollback, the
 * read-only check that answers 1 or 0, the database it targets, and whether it runs before or after the deployment.
 */
export interface SqlAction {
  title: string
  file: string
  database: string
  sql: string
  rollback: string
  /** A read-only statement that returns 1 when the change is in place and 0 when it is not. */
  check: string
  phase: 'before' | 'after'
}
/** One statement of a confirmation message, with the fingerprint its approval is bound to. */
interface SqlStatement { title: string; file: string; database: string; phase: 'before' | 'after'; fingerprint: string }
/** The deployment phase of a statement, as the approver reads it. */
const SQL_PHASE: Record<SqlAction['phase'], string> = { before: '部署前', after: '部署后' }
/**
 * What a statement's approval is bound to: changing the statement, its rollback, its check or its target database is a new
 * decision, so it needs a new approval rather than the one recorded for the old content.
 */
export const sqlFingerprint = (action: SqlAction): string =>
  key('sql', action.database, action.phase, action.sql, action.rollback, action.check)
/** Why a statement cannot be sent for approval, or undefined when it is complete enough to decide on. */
function sqlProblem(action: SqlAction): string | undefined {
  if (!action.sql.trim()) return 'has no SQL'
  if (!action.file.trim()) return 'names no file'
  if (!action.database.trim()) return 'names no database'
  if (!action.check.trim()) return 'has no check statement'
  if (action.phase !== 'before' && action.phase !== 'after') return 'names no deployment phase'
  return undefined
}
/**
 * The message the approver answers before a worker runs statements against PRE: every statement in full, with its target
 * database, its rollback, the check that answers 1 or 0, and the file it lives in. Like the merge confirmation, it is
 * user-facing copy in the team's language.
 */
export function sqlConfirmationText(input: { serial?: string; title: string; actions: readonly SqlAction[] }): string {
  const head = ['【SQL 确认】', input.serial ?? '', input.title].filter(Boolean).join(' ')
  const blocks = input.actions.map((action, index) => [
    `${index + 1}. ${action.title || action.file}（${SQL_PHASE[action.phase]}，目标库 ${action.database}，文件 ${action.file}）`,
    'SQL：', action.sql.trim(), ...action.rollback.trim() ? ['回滚 SQL：', action.rollback.trim()] : [],
    '检查语句（返回 1/0）：', action.check.trim(),
  ].join('\n'))
  return [head, ...blocks, '请直接回复本条消息：同意 / 写原因驳回（SQL 没有可改的目标 release）。'].join('\n\n')
}
/** How the target-release rule reached its answer, in the approver's language. */
const BASIS: Record<TargetRelease['basis'], string> = {
  previous: '前一日 release 尚未合回 master', today: '前一日 release 已合回 master，投当日 release',
  'today-created': '前一日 release 已合回 master，当日 release 已创建', requested: '工作项指定的 release',
}
const CI_TEXT: Record<CiState, string> = { passed: 'CI 通过', pending: 'CI 未完成', failed: 'CI 失败', none: '无 CI 检查' }
/** A failure's text, which `Commands` already keeps free of the command arguments. */
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** The commit's short form, as people quote it. */
const shortCommit = (sha: string): string => sha.slice(0, 8)
/**
 * The message the approver answers: the work item, every merge request with its target release and evidence, and how to
 * reply. It is user-facing copy in the team's language, like the result comment of a finished work item.
 */
export function confirmationText(input: ConfirmationInput): string {
  const head = ['【合并确认】', input.serial ?? '', input.title].filter(Boolean).join(' ')
  const changes = input.changes.flatMap(change => {
    const evidence = [`目标 ${change.target}（${BASIS[change.basis]}）`, ...linesOf(change), CI_TEXT[change.ci],
      change.commit ? `commit ${shortCommit(change.commit)}` : ''].filter(Boolean).join('；')
    const summary = change.title ? [`  摘要：${change.title}`] : []
    return [`- ${change.repository} !${change.number}：${change.url}`, `  ${evidence}`, ...summary]
  })
  return [head, '', ...changes, '', '请直接回复本条消息：同意 / 改 <日期，如 20261102> / 写原因驳回。'].join('\n')
}
/** The changed-line evidence, when the merge request reports it. */
const linesOf = (change: Pick<ConfirmationChange, 'additions' | 'deletions'>): string[] => {
  const additions = change.additions === undefined ? undefined : `+${change.additions}`
  const deletions = change.deletions === undefined ? undefined : `−${change.deletions}`
  return additions || deletions ? [`改动 ${[additions, deletions].filter(Boolean).join(' ')} 行`] : []
}
/**
 * Reads what a person's reply asks for, in code rather than by asking a model: `同意`/`合`/`ok` approves, `改 <date>` moves
 * the delivery to that release, and any other text is a rejection whose words go to the worker as review feedback.
 */
export function parseReply(text: string): MergeReply {
  // Trailing punctuation is how people end a sentence, not what they ask for.
  const clean = text.trim().replace(/[。.!！~～，,；;：:]+$/u, '').trim()
  const retarget = /^改\s*(?:release\/)?(\d{8})$/u.exec(clean)
  if (retarget) return { kind: 'retarget', release: `release/${retarget[1]}` }
  if (/^(同意|合|ok)$/iu.test(clean)) return { kind: 'approve' }
  return { kind: 'reject', reason: text.trim() }
}

/**
 * Candidate field names of the Codeup reports this module reads; the CLI renders the OpenAPI models, and the exact names are
 * a calibration point of a real installation. Each lookup tries them in order, so a renamed field changes this table alone,
 * and a field a report does not carry only drops the evidence that depends on it.
 */
const FIELD = {
  conflict: ['conflictStatus', 'hasConflict', 'conflict', 'conflicts'],
  additions: ['additions', 'totalAdditions', 'addedLines'],
  deletions: ['deletions', 'totalDeletions', 'deletedLines'],
  checkState: ['state', 'status', 'result'],
  commentBody: ['content', 'commentContent', 'body', 'text'],
  commentResolved: ['resolved', 'isResolved'],
  commentState: ['state', 'status', 'resolvedStatus'],
  pipelineName: ['name', 'pipelineName'],
  pipelineId: ['id', 'pipelineId'],
} as const
const CHECK_LIST = ['checkList', 'checks', 'ciChecks', 'items', 'list'] as const
const COMMENT_LIST = ['comments', 'items', 'records', 'list'] as const
const PASSED_CHECK = /^(success|succeeded|passed|pass|ok|通过)$/i
const FAILED_CHECK = /^(fail|failed|failure|error|失败)$/i
const CONFLICT_VALUE = /^(true|yes|conflict|conflicted|冲突)$/i
const RESOLVED_VALUE = /resolved|closed/i

/** A record of the CLI's answer, or undefined for anything else. */
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** The first field of `names` a record fills; a null, empty or absent field falls through to the next name. */
function pick(source: Record<string, unknown> | undefined, names: readonly string[]): unknown {
  if (!source) return undefined
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}
/** The model a report wraps in `result` or `data`, or the report itself. */
function modelOf(raw: unknown): Record<string, unknown> | undefined {
  const record = recordOf(raw)
  for (const wrapper of ['result', 'data'] as const) {
    const nested = recordOf(record?.[wrapper])
    if (nested) return nested
  }
  return record
}
/** A list of a report, under whichever wrapper key the CLI prints it. */
function itemsOf(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw
  const record = recordOf(raw)
  for (const key of keys) { const value = record?.[key]; if (Array.isArray(value)) return value }
  for (const wrapper of ['result', 'data'] as const) {
    const nested = recordOf(record?.[wrapper])
    for (const key of keys) { const value = nested?.[key]; if (Array.isArray(value)) return value }
  }
  return []
}
/** A text field of a report, trimmed; a number reads as its digits. */
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() || undefined : typeof value === 'number' ? String(value) : undefined
/** A count a report writes as a number or a numeric string. */
const countOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
/** Whether a merge request reports a conflict; a report that carries no conflict field reads as none. */
function conflicted(raw: unknown): boolean {
  const value = pick(modelOf(raw), FIELD.conflict)
  if (typeof value === 'boolean') return value
  return typeof value === 'string' && CONFLICT_VALUE.test(value.trim())
}
/** The Thread a Codeup merge request lives on, which the work-item Source polls too (`yunxiao:mr:<repository>:<localId>`). */
export const mergeThread = (repositoryId: string, localId: number): string =>
  threadKey({ source: 'yunxiao', id: `mr:${repositoryId}:${localId}` })
/** The repository and local id a merge-request Thread key names (`yunxiao:mr:<repository>:<localId>`). */
export function mergeTargetOf(thread: string): MergeRequestRef | undefined {
  const match = /^yunxiao:mr:(.+):(\d+)$/.exec(thread)
  return match ? { repository: match[1]!, localId: Number(match[2]) } : undefined
}

/** One prepared merge request: the change, its target release, and the evidence the confirmation shows. */
interface Prepared extends ConfirmationChange { thread: string }
/** What preparing a merge request produced: the prepared change, or the condition it did not meet. */
type Preparation = Prepared | { problem: string }
/** A merge request waiting on one confirmation message. */
interface Waiting { thread: string; commit: string; target: string }

/**
 * The host's merge approval: a worker asks, the conditions and the target release are checked, the approver confirms in a
 * Feishu direct message, and only that reply merges. Records live in `KV.merge`: one per merge request, and one per
 * confirmation message, which is how a reply finds the merge requests it is about.
 */
export class Merges {
  constructor(private readonly host: MergeHost) {}

  /** The Codeup account the host acts as; merging is a Codeup operation, so another platform has none. */
  private account(): CodeupAccount | undefined { return this.host.commands.deployment.codeup }
  /** The repository a caller names by id or by group path. */
  private repository(account: CodeupAccount, name: string): CodeupRepository | undefined { return repositoryOf(account, name) }

  /**
   * A worker asks to merge its ticket's merge requests: checks each one, sends the approver one confirmation listing all of
   * them, and records what the answer will be about.
   * @returns a status the worker can act on; a thrown error means nothing was sent or recorded.
   */
  async request(ticketId: string, changes: readonly MergeRequestRef[]): Promise<MergeRequestResult> {
    const { store, commands } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return { status: 'unknown', message: `Ticket ${ticketId} is not open` }
    if (!changes.length) return { status: 'not-ready', message: 'Name the merge requests to merge' }
    const account = this.account()
    if (!account) return { status: 'not-ready', message: 'This installation has no Codeup account to merge with' }
    const approver = this.host.approver()
    if (!approver) return { status: 'unconfigured', message: 'No approver is configured: set approver.feishuOpenId in the receiving rules' }
    // One confirmation per merge request at a time: asking again while it waits would send the approver a second message.
    const waiting = changes.filter(change => this.recordOf(account, change)?.state === 'waiting')
    if (waiting.length) return { status: 'already', message: 'The approver already has a confirmation for these merge requests' }
    const prepared: Prepared[] = []
    for (const change of changes) {
      const result = await this.prepare(account, change)
      if ('problem' in result) return { status: 'not-ready', message: result.problem }
      prepared.push(result)
    }
    const serial = this.serialOf(ticket)
    const text = confirmationText({ ...serial ? { serial } : {}, title: ticket.title, changes: prepared })
    const idempotencyKey = key('merge-confirm', ticket.id, ...prepared.map(item => `${item.thread}:${item.commit}:${item.target}`))
    const messageId = await createFeishuDirect(commands, { openId: approver, text, idempotencyKey })
    // The message id is what a reply names: without it the confirmation could never be answered (see feishu-channel.ts).
    if (!messageId) throw new Error('Feishu did not report the confirmation message id, so its reply could not be matched')
    const at = new Date().toISOString()
    store.atomic(() => {
      for (const item of prepared) {
        store.set(KV.merge.mr(item.thread), { state: 'waiting', messageId, commit: item.commit, target: item.target })
      }
      store.set(KV.merge.message(messageId), { thread: prepared[0]!.thread, ticketId, at, kind: 'merge' })
    })
    return { status: 'requested', message: `Asked the approver to confirm ${prepared.length} merge request(s) in Feishu` }
  }

  /**
   * A worker asks the host to start a pipeline it may not run itself: the host reads the pipeline, sends the approver one
   * confirmation, and starts it only on that answer.
   * @returns a status the worker can act on; a thrown error means nothing was sent or recorded.
   */
  async requestPipeline(ticketId: string, pipelineId: string): Promise<MergeRequestResult> {
    const { store, commands } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return { status: 'unknown', message: `Ticket ${ticketId} is not open` }
    const account = this.account()
    if (!account) return { status: 'not-ready', message: 'This installation has no Codeup account to run a pipeline with' }
    const approver = this.host.approver()
    if (!approver) return { status: 'unconfigured', message: 'No approver is configured: set approver.feishuOpenId in the receiving rules' }
    const pipeline = await this.readPipeline(account, pipelineId)
    if (!pipeline) return { status: 'unknown', message: `Pipeline ${pipelineId} could not be read from the organization` }
    // The worker starts the qa- and pre- pipelines itself, so only the ones outside that allowlist need the approver.
    if (WORKER_PIPELINE.test(pipeline.name)) {
      return { status: 'not-ready', message: `${pipeline.name} is a pipeline the worker may run itself; start it directly` }
    }
    if (this.pendingPipeline(pipeline.id)) {
      return { status: 'already', message: `The approver already has a confirmation for ${pipeline.name}` }
    }
    const serial = this.serialOf(ticket)
    const text = pipelineConfirmationText({ ...serial ? { serial } : {}, title: ticket.title, pipeline })
    const idempotencyKey = key('pipeline-confirm', ticket.id, pipeline.id, pipeline.name)
    const messageId = await createFeishuDirect(commands, { openId: approver, text, idempotencyKey })
    // The message id is what a reply names: without it the confirmation could never be answered (see feishu-channel.ts).
    if (!messageId) throw new Error('Feishu did not report the confirmation message id, so its reply could not be matched')
    store.set(KV.merge.message(messageId), { thread: '', ticketId, at: new Date().toISOString(), kind: 'pipeline', pipeline })
    return { status: 'requested', message: `Asked the approver to confirm running ${pipeline.name} in Feishu` }
  }

  /**
   * A worker asks to run statements against PRE: the host checks them, sends the approver one confirmation listing every
   * statement in full, and records the approval only on that answer.
   * @returns a status the worker can act on; a thrown error means nothing was sent or recorded.
   */
  async requestSql(ticketId: string, actions: readonly SqlAction[]): Promise<MergeRequestResult> {
    const { store, commands } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return { status: 'unknown', message: `Ticket ${ticketId} is not open` }
    for (const [index, action] of actions.entries()) {
      const problem = sqlProblem(action)
      if (problem) return { status: 'unknown', message: `SQL action ${index + 1} ${problem}` }
    }
    const approver = this.host.approver()
    if (!approver) return { status: 'unconfigured', message: 'No approver is configured: set approver.feishuOpenId in the receiving rules' }
    // A statement already approved under the same fingerprint runs under that approval; only the rest needs a decision.
    const fresh = actions.filter(action => store.get(KV.sql.approved(sqlFingerprint(action))) === undefined)
    if (!fresh.length) return { status: 'already', message: 'Every statement was approved before' }
    if (this.pendingSql(fresh.map(sqlFingerprint))) {
      return { status: 'already', message: 'The approver already has a confirmation for these statements' }
    }
    const serial = this.serialOf(ticket)
    const text = sqlConfirmationText({ ...serial ? { serial } : {}, title: ticket.title, actions: fresh })
    const idempotencyKey = key('sql-confirm', ticket.id, ...fresh.map(sqlFingerprint))
    const messageId = await createFeishuDirect(commands, { openId: approver, text, idempotencyKey })
    // The message id is what a reply names: without it the confirmation could never be answered (see feishu-channel.ts).
    if (!messageId) throw new Error('Feishu did not report the confirmation message id, so its reply could not be matched')
    store.set(KV.merge.message(messageId), { thread: '', ticketId, at: new Date().toISOString(), kind: 'sql',
      sql: fresh.map(action => ({ title: action.title, file: action.file, database: action.database, phase: action.phase,
        fingerprint: sqlFingerprint(action) })) })
    return { status: 'requested', message: `Asked the approver to confirm ${fresh.length} SQL statement(s) in Feishu` }
  }

  /**
   * A Trigger the Feishu Source marked as an answer to a confirmation: the approver's answer, acted on here. Merge
   * confirmations merge the confirmed commit; pipeline confirmations start the pipeline the host may not start alone.
   * @returns whether this module handled the Trigger; a trigger that is no approval reply is left to the host's other parts.
   */
  async onTrigger(trigger: Trigger): Promise<boolean> {
    if (trigger.meta.approval !== true) return false
    const { store } = this.host
    const messageId = feishuRepliesTo(trigger).find(id => store.get(KV.merge.message(id)) !== undefined)
    if (!messageId) return false
    const record = store.get(KV.merge.message(messageId))!
    const ticket = store.tickets.get(record.ticketId)
    if (!ticket || !liveTicket(ticket)) { this.reply(trigger, '这条确认对应的工单已结束，不再处理。'); return true }
    if (trigger.actor.id !== this.host.approver()) {
      this.reply(trigger, '只有配置的审批人可以确认这条请求。'); return true
    }
    const reply = parseReply(trigger.text)
    if (record.kind === 'pipeline') { await this.answerPipeline(ticket, trigger, messageId, record, reply); return true }
    if (record.kind === 'sql') { this.answerSql(ticket, trigger, messageId, record, reply); return true }
    const waiting = this.waitingOn(messageId)
    if (!waiting.length) { this.reply(trigger, '这条确认已经处理过了。'); return true }
    if (reply.kind === 'approve') await this.approve(ticket, trigger, waiting)
    else if (reply.kind === 'retarget') this.retarget(ticket, trigger, waiting, reply.release)
    else this.reject(ticket, trigger, waiting, reply.reason)
    return true
  }

  /**
   * Whether a delivery's release merged back into the base branch, so the merge requests targeting it must move to the release
   * the rule now names.
   * @returns true when the rule now names another release, which is what a retarget is for.
   */
  async releaseMergedBack(repositoryId: string, target: string): Promise<boolean> {
    const account = this.account()
    const repository = account ? this.repository(account, repositoryId) : undefined
    if (!account || !repository) return false
    const fresh = await targetRelease({ organization: account.organization, repository, caller: this.host.commands })
    return fresh.target !== target
  }

  /** Reads one merge request and checks everything a merge needs, or names the first condition it does not meet. */
  private async prepare(account: CodeupAccount, change: MergeRequestRef): Promise<Preparation> {
    const repository = this.repository(account, change.repository)
    if (!repository) return { problem: `${change.repository} is not a repository of the Codeup workspace` }
    const { commands } = this.host
    const label = `${repository.path} !${change.localId}`
    const request: Change = await commands.deployment.hosting.readChange(commands, repository.id, change.localId)
    if (request.state !== 'open') return { problem: `${label} is ${request.state}, so it cannot be merged` }
    // The platform-neutral Change carries no conflict or line counts, and growing it for one platform's fields would make
    // the contract less neutral: the report is read once more, only for the evidence the confirmation shows.
    const raw = await commands.aliyun(z.unknown(), YUNXIAO.changeRequest(account.organization, repository.id, change.localId))
    if (conflicted(raw)) return { problem: `${label} has conflicts; resolve them before asking to merge` }
    const ci = await this.ciState(account, repository.id, change.localId)
    if (ci === 'failed') return { problem: `${label} has a failed CI check` }
    if (ci === 'pending') return { problem: `${label} has a CI check that has not finished` }
    const unresolved = await this.unresolvedComments(account, repository.id, change.localId)
    if (unresolved) return { problem: `${label} has ${unresolved} unresolved review comment(s)` }
    const target = await targetRelease({ organization: account.organization, repository, caller: commands })
    return { thread: threadKey(commands.deployment.hosting.thread(request)), repository: repository.path, number: request.number,
      url: request.url, title: request.title, target: target.target, basis: target.basis,
      ...this.lineCounts(raw), ci, commit: request.headSha }
  }

  /** The changed-line counts a merge-request report carries, which the confirmation shows as evidence. */
  private lineCounts(raw: unknown): Pick<ConfirmationChange, 'additions' | 'deletions'> {
    const model = modelOf(raw)
    const additions = countOf(pick(model, FIELD.additions))
    const deletions = countOf(pick(model, FIELD.deletions))
    return { ...additions === undefined ? {} : { additions }, ...deletions === undefined ? {} : { deletions } }
  }

  /** The CI verdict of a merge request's latest commit: passed only when every check passed. */
  private async ciState(account: CodeupAccount, repositoryId: string, localId: number): Promise<CiState> {
    const raw = await this.host.commands.aliyun(z.unknown(), YUNXIAO.changeRequestChecks(account.organization, repositoryId, localId))
    const states = itemsOf(raw, CHECK_LIST).map(check => String(pick(recordOf(check), FIELD.checkState) ?? '').trim()).filter(Boolean)
    if (!states.length) return 'none'
    if (states.some(state => FAILED_CHECK.test(state))) return 'failed'
    return states.every(state => PASSED_CHECK.test(state)) ? 'passed' : 'pending'
  }

  /** How many review comments are still open: the agent's own comments are its reports, not someone's review. */
  private async unresolvedComments(account: CodeupAccount, repositoryId: string, localId: number): Promise<number> {
    const raw = await this.host.commands.aliyun(z.unknown(), YUNXIAO.changeRequestComments(account.organization, repositoryId, localId))
    return itemsOf(raw, COMMENT_LIST).filter(comment => {
      const record = recordOf(comment)
      if (!record) return false
      if (isAgentComment(String(pick(record, FIELD.commentBody) ?? ''))) return false
      if (pick(record, FIELD.commentResolved) === true) return false
      return !RESOLVED_VALUE.test(String(pick(record, FIELD.commentState) ?? ''))
    }).length
  }

  /** The work item's serial, which the confirmation names so the approver knows what it is about. */
  private serialOf(ticket: Ticket): string | undefined {
    const serial = this.host.store.triggers.get(ticket.origin.triggerId)?.meta.serial
    return typeof serial === 'string' && serial ? serial : undefined
  }

  /** The merge requests waiting on one confirmation message. */
  private waitingOn(messageId: string): Waiting[] {
    const { store } = this.host
    // The key carries the family prefix; the Thread a merge request lives on is the part after it.
    return store.keys(KV.merge.mr).flatMap(name => {
      const record = store.get(name)
      return record?.state === 'waiting' && record.messageId === messageId
        ? [{ thread: name.slice(KV.merge.mr.prefix.length), commit: record.commit, target: record.target }] : []
    })
  }

  /** The record of one merge request, or undefined while none exists. */
  private recordOf(account: CodeupAccount, change: MergeRequestRef) {
    const repository = this.repository(account, change.repository)
    return repository ? this.host.store.get(KV.merge.mr(mergeThread(repository.id, change.localId))) : undefined
  }

  /**
   * Merges what the approver confirmed, one merge request at a time: a failure stops there with the reason the worker must
   * act on, and the merge requests already merged stay merged.
   */
  private async approve(ticket: Ticket, trigger: Trigger, waiting: readonly Waiting[]): Promise<void> {
    const { store } = this.host
    const account = this.account()
    if (!account) { this.reply(trigger, '这个部署没有可用的云效账号，无法合并。'); return }
    // Claim the confirmation before any merge runs, so a second reply to the same message merges nothing twice.
    const held = store.atomic(() => {
      const taken: Waiting[] = []
      for (const item of waiting) {
        const record = store.get(KV.merge.mr(item.thread))
        if (record?.state !== 'waiting') continue
        store.set(KV.merge.mr(item.thread), { ...record, state: 'merging' })
        taken.push(item)
      }
      return taken
    })
    if (!held.length) { this.reply(trigger, '这条确认已经处理过了。'); return }
    const merged: string[] = []
    for (const [index, item] of held.entries()) {
      const label = this.labelOf(item.thread)
      const problem = await this.mergeOne(account, item).catch((error: unknown) => errorText(error))
      const at = new Date().toISOString()
      const record = store.get(KV.merge.mr(item.thread))
      if (!record) continue
      if (problem) {
        store.set(KV.merge.mr(item.thread), { ...record, state: 'confirmed', confirmedAt: at })
        // The merge requests this answer did not reach keep waiting, so a later reply merges them once the failure is fixed.
        store.atomic(() => {
          for (const rest of held.slice(index + 1)) {
            const waiting = store.get(KV.merge.mr(rest.thread))
            if (waiting?.state === 'merging') store.set(KV.merge.mr(rest.thread), { ...waiting, state: 'waiting' })
          }
        })
        const already = merged.length ? `已合并 ${merged.join('、')}。` : ''
        this.note(ticket.id, `【合并结果】${label} 未能合并：${problem}。${already}请处理后重新申请合并。`)
        this.reply(trigger, `${label} 未能合并：${problem}。已通知 worker。`)
        return
      }
      store.set(KV.merge.mr(item.thread), { ...record, state: 'merged', confirmedAt: at })
      merged.push(label)
    }
    this.note(ticket.id, `【合并结果】已合并 ${merged.join('、')}。请继续 PRE 部署与验证。`)
    this.reply(trigger, `已合并 ${merged.join('、')}，已通知 worker 继续。`)
  }

  /**
   * Acts on the approver's answer about a pipeline: approval starts it as the host, and any other answer keeps it stopped
   * and hands the person's words to the worker. A pipeline has no release to move to, so a retarget reads as a rejection.
   */
  private async answerPipeline(ticket: Ticket, trigger: Trigger, messageId: string, record: ConfirmationRecord,
    reply: MergeReply): Promise<void> {
    const pipeline = record.pipeline
    if (!pipeline) { this.reply(trigger, '这条确认已经处理过了。'); return }
    const account = this.account()
    if (!account) { this.reply(trigger, '这个部署没有可用的云效账号，无法启动流水线。'); return }
    const refused = reply.kind === 'approve' ? undefined
      : reply.kind === 'retarget' ? `「${trigger.text.trim()}」——流水线没有可改的目标 release` : reply.reason
    if (refused !== undefined) {
      this.settlePipeline(messageId, record)
      this.note(ticket.id, `【流水线】审批人没有同意 ${pipeline.name}：${refused}。请不要启动这条流水线。`)
      this.reply(trigger, `已按驳回转给 worker：${refused}`)
      return
    }
    try { await this.host.commands.aliyun(YUNXIAO.createPipelineRun(account.organization, pipeline.id)) }
    catch (error) {
      // Starting can fail transiently, so the confirmation stays pending and the approver's next 同意 retries it.
      this.reply(trigger, `${pipeline.name} 启动失败：${errorText(error)}。请稍后回复「同意」重试。`)
      return
    }
    this.settlePipeline(messageId, record)
    this.note(ticket.id, `【流水线】已启动 ${pipeline.name}（${pipeline.id}）。`
      + '按技能说明盯这次运行：读运行和任务日志，失败时修复或重试；PRE 验证通过后报告 ready。')
    this.reply(trigger, `已启动 ${pipeline.name}，已通知 worker。`)
  }

  /** Marks a pipeline confirmation answered: its record still maps the message to its ticket, but names no pipeline. */
  private settlePipeline(messageId: string, record: ConfirmationRecord): void {
    this.host.store.set(KV.merge.message(messageId), { thread: record.thread, ticketId: record.ticketId, at: record.at, kind: 'pipeline' })
  }

  /**
   * Acts on the approver's answer about PRE statements: approval records each statement's fingerprint, which is what the
   * worker's execution is bound to, and any other answer keeps them unapproved and hands the words to the worker. SQL has no
   * release to move to, so a retarget reads as a rejection.
   */
  private answerSql(ticket: Ticket, trigger: Trigger, messageId: string, record: ConfirmationRecord, reply: MergeReply): void {
    const statements = record.sql ?? []
    if (!statements.length) { this.reply(trigger, '这条确认已经处理过了。'); return }
    const refused = reply.kind === 'approve' ? undefined
      : reply.kind === 'retarget' ? `「${trigger.text.trim()}」——SQL 没有可改的目标 release` : reply.reason
    if (refused !== undefined) {
      this.settleSql(messageId, record)
      const files = statements.map(statement => statement.file).join('、')
      this.note(ticket.id, `【SQL】审批人驳回了 ${files}：${refused}。请不要执行这些 SQL。`)
      this.reply(trigger, `已按驳回转给 worker：${refused}`)
      return
    }
    const at = new Date().toISOString()
    this.host.store.atomic(() => {
      for (const statement of statements) {
        this.host.store.set(KV.sql.approved(statement.fingerprint), { ticketId: ticket.id, at, database: statement.database })
      }
    })
    this.settleSql(messageId, record)
    for (const statement of statements) {
      this.note(ticket.id, `【SQL】已批准 ${statement.file}（${statement.database}，${SQL_PHASE[statement.phase]}）：`
        + `执行前核对文件内容与批准时一致（指纹 ${statement.fingerprint}）；`
        + '同一目标只执行一次；结果不明时不要重试。')
    }
    this.reply(trigger, `已批准 ${statements.length} 条 SQL，已通知 worker 按指纹执行。`)
  }

  /** Marks a SQL confirmation answered: its record still maps the message to its ticket, but names no statements. */
  private settleSql(messageId: string, record: ConfirmationRecord): void {
    this.host.store.set(KV.merge.message(messageId), { thread: record.thread, ticketId: record.ticketId, at: record.at, kind: 'sql' })
  }

  /** Whether a confirmation already waits for any of these statement fingerprints. */
  private pendingSql(fingerprints: readonly string[]): boolean {
    const { store } = this.host
    return store.keys(KV.merge.message).some(name => {
      const record = store.get(name)
      return record?.kind === 'sql' && (record.sql ?? []).some(statement => fingerprints.includes(statement.fingerprint))
    })
  }

  /** The confirmation message a pipeline waits on, or undefined while it waits on none. */
  private pendingPipeline(pipelineId: string): string | undefined {
    const { store } = this.host
    for (const name of store.keys(KV.merge.message)) {
      const record = store.get(name)
      if (record?.kind === 'pipeline' && record.pipeline?.id === pipelineId) return name.slice(KV.merge.message.prefix.length)
    }
    return undefined
  }

  /**
   * Reads one pipeline's id and name. A pipeline the organization does not report, or a read that failed after its retries,
   * reads as undefined: the worker then learns the pipeline could not be read, rather than a name it never had.
   */
  private async readPipeline(account: CodeupAccount, pipelineId: string): Promise<PipelineRef | undefined> {
    let raw: unknown
    try { raw = await this.host.commands.aliyun(z.unknown(), YUNXIAO.pipeline(account.organization, pipelineId)) }
    catch { return undefined }
    const model = modelOf(raw)
    const name = textOf(pick(model, FIELD.pipelineName))
    if (!name) return undefined
    return { id: textOf(pick(model, FIELD.pipelineId)) ?? pipelineId, name }
  }

  /** Merges one confirmed merge request, or returns why it cannot be merged. */
  private async mergeOne(account: CodeupAccount, item: Waiting): Promise<string | undefined> {
    const target = mergeTargetOf(item.thread)
    if (!target) return `its thread ${item.thread} names no merge request`
    const { commands } = this.host
    // The confirmation is about the commit the approver saw, so a newer one needs a new confirmation.
    const request = await commands.deployment.hosting.readChange(commands, target.repository, target.localId)
    if (request.state !== 'open') return `it is ${request.state} now`
    if (request.headSha !== item.commit) {
      return `its latest commit ${shortCommit(request.headSha)} is not the confirmed ${shortCommit(item.commit)}`
    }
    if (await this.mergedBack(account, target.repository, item.target)) {
      return `${item.target} has merged back into the base branch, so it needs another release`
    }
    await commands.aliyun(YUNXIAO.mergeChangeRequest(account.organization, target.repository, target.localId))
    return undefined
  }

  /** Whether a release branch has merged back into the base branch, so delivering to it would be late. */
  private async mergedBack(account: CodeupAccount, repositoryId: string, target: string): Promise<boolean> {
    const repository = this.repository(account, repositoryId)
    if (!repository) return false
    const checked = await targetRelease({ organization: account.organization, repository, caller: this.host.commands, requested: target })
    return checked.mergedBack
  }

  /** Records the approver's request to deliver to another release, and tells the worker to move the merge requests there. */
  private retarget(ticket: Ticket, trigger: Trigger, waiting: readonly Waiting[], release: string): void {
    const at = new Date().toISOString()
    this.host.store.atomic(() => {
      for (const item of waiting) {
        const record = this.host.store.get(KV.merge.mr(item.thread))
        if (record) this.host.store.set(KV.merge.mr(item.thread), { ...record, state: 'retarget', target: release, confirmedAt: at })
      }
    })
    const labels = waiting.map(item => this.labelOf(item.thread))
    const day = release.slice('release/'.length)
    this.note(ticket.id, `【合并结果】审批人要求改投 ${release}：请把 ${labels.join('、')} 改投到 ${release}`
      + `（从 master 拉 …-to-release-${day} 分支、合入 ${release}、提新 MR、关旧 MR），然后重新申请合并。`)
    this.reply(trigger, `已通知 worker 把 ${labels.join('、')} 改投到 ${release}，改好后会重新请你确认。`)
  }

  /** Records the approver's rejection, and hands its words to the worker as review feedback. */
  private reject(ticket: Ticket, trigger: Trigger, waiting: readonly Waiting[], reason: string): void {
    const at = new Date().toISOString()
    this.host.store.atomic(() => {
      for (const item of waiting) {
        const record = this.host.store.get(KV.merge.mr(item.thread))
        if (record) this.host.store.set(KV.merge.mr(item.thread), { ...record, state: 'rejected', confirmedAt: at })
      }
    })
    const labels = waiting.map(item => this.labelOf(item.thread))
    this.note(ticket.id, `【合并结果】审批人驳回了 ${labels.join('、')}：${reason}。`
      + '请按这条意见修改后重新申请合并。')
    this.reply(trigger, `已把意见转给 worker：${reason}`)
  }

  /** The merge request a Thread key names, as people read it. */
  private labelOf(thread: string): string {
    const target = mergeTargetOf(thread)
    if (!target) return thread
    const account = this.account()
    const repository = account ? this.repository(account, target.repository) : undefined
    return `${repository?.path ?? target.repository} !${target.localId}`
  }

  /** Answers the approver in the conversation the reply came from. */
  private reply(trigger: Trigger, text: string): void {
    const channel = trigger.channel
    if (!channel) return
    this.host.outbox.send({ id: key('merge-reply', trigger.id, text), channel, text, kind: 'notice' })
  }

  /** Tells the ticket's worker what to do next; a ticket that ended meanwhile has nothing left to instruct. */
  private note(ticketId: string, text: string): void {
    try { this.host.note(ticketId, text) } catch { /* The ticket ended while the approval was being handled. */ }
  }
}
