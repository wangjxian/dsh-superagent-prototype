/**
 * The yunxiao work-item Source: receiving rules read from a YAML file, the polling loop that turns assigned work items and
 * their comments into Triggers, the approver's question before a triage project's work starts, the status moves that follow a
 * ticket, the write-back of ended tickets, and the Cordis plugin entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { writeWorkerPipelines } from '../infra/environment.ts'
import { sameName } from '../infra/text.ts'
import { AGENT_COMMENT, YUNXIAO } from '../infra/yunxiao.ts'
import { createFeishuDirect } from './feishu-channel.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'
import { loadConfig, MissingRulesError, projectOf, receiveStates, typeOf, YunxiaoConfigSchema, YunxiaoFileSchema,
  type YunxiaoConfig, type YunxiaoFile, type YunxiaoProject, type YunxiaoType } from './yunxiao-config.ts'
import { sendYunxiao, workitemGone, yunxiaoLink } from './yunxiao-channel.ts'
import { newMergeRound, pollMergeRequests } from './yunxiao-mr.ts'
import { yunxiaoThreadContext } from './yunxiao-read.ts'
import { writeBack } from './yunxiao-write.ts'
import { SOURCE, TRIAGE_BARE, commentTrigger, commentsOf, isAgentComment, workitemOf, workitemTrigger, workitemTriggerId,
  yunxiaoRef, type Workitem } from './yunxiao-trigger.ts'

/**
 * The account the Source acts as, learned from the deployment on its first round: an assignment to it is the request the
 * Source receives, and the Policy's allowed list defaults to it. `policy.schema` is a static callback that receives no
 * deployment, so this snapshot is how the default names the account the installation actually runs as.
 */
let agentAccount = ''
/** How many pages of one category's search results a round reads, so a query that never ends cannot spin. */
const MAX_PAGES = 20
/** The page size of one search request; a round should not need many requests. */
const PAGE_SIZE = 50
/**
 * How far back the first round reads. Work items assigned before the Source first started are still pending work, and the
 * cursor cannot say so yet; later rounds read from the cursor.
 */
const FIRST_RUN_BACKFILL_MS = 7 * 24 * 3600_000
/** How far back an ended ticket is still written back: one older than this was handled before this Source ran. */
const WRITEBACK_HORIZON_MS = 7 * 24 * 3600_000
/** Consecutive failed rounds before the Source reports an error, so a single network interruption stays quiet. */
const FAILURES_BEFORE_ERROR = 3

/**
 * What the polling loop last read from the receiving-rule file, with the problem of the latest failed read while the previous
 * version stays in force. `scope`, `policy.rows` and `facts` are synchronous callbacks that receive no context, so this
 * snapshot is the only way they can see the file; the polling loop is its only writer, through `readRules`.
 */
let rules: { file: YunxiaoFile; problem?: string } | undefined
/** The receiving rules the Source is working by, or undefined before its first read. */
export function currentRules(): { file: YunxiaoFile; problem?: string } | undefined { return rules }

export const yunxiaoKind: SourceKind<YunxiaoConfig> = {
  kind: SOURCE,
  title: { zh: '云效工作项', en: 'Yunxiao work items' },
  description: { zh: '接收云效 Projex 项目里指派给智能体的缺陷和任务，跟进已有工单的评论，工单开始时把工作项流转到处理中、结束时写回结果评论和状态。triage 项目先私聊审批人确认再开工。接收规则写在 YAML 文件里，每轮轮询前重新读取并校验。', en: 'Receives the defects and tasks of yunxiao Projex projects that are assigned to the agent, follows up the comments of open tickets, moves a work item to its started status when a ticket begins, and writes the result comment and status back when it ends. A triage project asks the approver in a direct message before work starts. The receiving rules live in a YAML file, reread and validated before every round.' },
  schema: YunxiaoConfigSchema,
  fields: [
    { key: 'configPath', type: 'text', label: { zh: '接收规则文件', en: 'Receiving-rule file' },
      hint: { zh: 'YAML 文件，写明组织、工作空间、轮询间隔、每个项目的类别与状态（含开工与验证后的状态）、审批人的飞书 open_id，以及 worker 可以自行运行的流水线前缀。每轮轮询前重新读取并校验；校验不过就报健康异常并沿用上一版，文件内容的哈希计入策略版本。', en: 'A YAML file naming the organization, the workspace, the poll interval, each project\'s categories and statuses (including the started and verified ones), the approver\'s Feishu open_id, and the pipeline prefixes a worker may run itself. It is reread and validated before every round; an invalid file is reported as health and the previous version stays in force. Its hash is part of the Policy version.' } },
    { key: 'account', type: 'fact', label: { zh: '云效账号', en: 'Yunxiao account' } },
    { key: 'organization', type: 'fact', label: { zh: '云效组织', en: 'Yunxiao organization' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '留空时用文件里的 pollSeconds。', en: 'Empty uses the poll interval of the file.' } },
  ],
  health: [SOURCE],
  // A Trigger of this Source names a project of the rules file; a work item of any other project is not received.
  scope({ meta }) {
    const projectId = typeof meta.projectId === 'string' ? meta.projectId : ''
    // Only the poller emits these Triggers, and only for projects it read from the file, so an unnamed project is listened to
    // rather than dropped: before the first read there is no file in memory to check against.
    if (!projectId || !rules) return { listened: true, observed: false, ...(projectId ? { row: projectId } : {}) }
    return projectOf(rules.file, projectId) ? { listened: true, observed: false, row: projectId } : { listened: false, reason: 'project_not_configured' }
  },
  channel: { send: sendYunxiao, link: yunxiaoLink },
  threadContext: yunxiaoThreadContext,
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
      .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids')
      .default(() => agentAccount ? [{ id: agentAccount }] : []) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的云效用户', en: 'Yunxiao users who may originate work' },
      hint: { zh: '名单里的账号把工作项指派给智能体，就是明确的请求，直接开工。同事的评论只作为已有工单的跟进，不能独立发起工作。', en: 'A work item this list\'s account assigns to the agent is an explicit request and starts work. A colleague\'s comment only follows up a ticket that already exists; it never starts work by itself.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '云效用户 id', en: 'Yunxiao user id' }, pattern: '[A-Za-z0-9]+' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的账号把工作项指派给智能体。', en: 'An account on the list assigns the work item to the agent.' },
    // One row per project of the rules file, its id the project id, matching what `scope` reports as the row.
    rows() {
      const current = rules?.file
      if (!current) return []
      return current.projects.map(project => ({ id: project.id, label: project.id,
        note: project.intake === 'direct' ? { zh: '直接开工', en: 'Starts directly' } : { zh: '先评估', en: 'Assessed first' },
        // Nothing here is inferred: the only entry is an assignment to an account on the list, which the gate admits as an
        // explicit request, and a comment only follows up an existing ticket.
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_YUNXIAO_WORKITEM', description: { zh: '接单的工作项 id；工单不是从云效来的时为空', en: 'Id of the work item that started the ticket; empty when the ticket did not start on Yunxiao' } },
      { key: 'DSH_SUPERAGENT_YUNXIAO_SERIAL', description: { zh: '工作项编号，如 AXOAXO-6812；工单不是从云效来的时为空', en: 'Serial of the work item, such as AXOAXO-6812; empty when the ticket did not start on Yunxiao' } },
      { key: 'DSH_SUPERAGENT_YUNXIAO_URL', description: { zh: '工作项的网页链接；工单不是从云效来的时为空', en: 'Web address of the work item; empty when the ticket did not start on Yunxiao' } },
      { key: 'DSH_SUPERAGENT_YUNXIAO_CATEGORY', description: { zh: 'Bug 或 Task，决定分支用 bugfix/ 还是 feat/；工单不是从云效来的时为空', en: 'Bug or Task, which decides whether the branch is bugfix/ or feat/; empty when the ticket did not start on Yunxiao' } },
    ],
    values: ({ trigger }) => {
      const yunxiao = trigger?.source === SOURCE
      const ref = yunxiao ? yunxiaoRef(trigger) : {}
      const serial = yunxiao && typeof trigger.meta.serial === 'string' ? trigger.meta.serial : ''
      return { DSH_SUPERAGENT_YUNXIAO_WORKITEM: ref.workitemId ?? '', DSH_SUPERAGENT_YUNXIAO_SERIAL: serial,
        DSH_SUPERAGENT_YUNXIAO_URL: yunxiao ? trigger.url ?? '' : '', DSH_SUPERAGENT_YUNXIAO_CATEGORY: ref.category ?? '' }
    },
  },
  // Facts hang off the field they describe: the account and organization setup resolved, and what the last read of the file found.
  facts: (deployment): Record<string, Localized | string> => {
    const facts: Record<string, Localized | string> = {}
    const account = deployment?.codeup
    if (account) {
      const name = account.account.name || account.account.id
      facts.account = { zh: `当前账号 ${name}`, en: `Current account ${name}` }
      facts.organization = { zh: `当前组织 ${account.organization}`, en: `Current organization ${account.organization}` }
    }
    if (rules) facts.configPath = rules.problem
      ? { zh: '配置有误，沿用上一版（详见来源状态）', en: 'The file is invalid; the previous version is in force (see the Source status)' }
      : { zh: `${rules.file.projects.length} 个项目`, en: `${rules.file.projects.length} projects` }
    return facts
  },
}

export const name = 'dsh-superagent-yunxiao'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(yunxiaoKind), 'yunxiao: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, yunxiaoKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Polls the configured projects until the Source is stopped, reporting an error only after repeated failures. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the CLI this Source calls is not there.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  // Every projex command runs as the Codeup account's aliyun CLI; without that account this Source cannot reach yunxiao.
  if (!ctx.deployment.codeup) { ctx.report(SOURCE, health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    try {
      const config = ctx.config<YunxiaoConfig>(SOURCE)
      if (config) { interval = await pollRound(ctx, signal); failures = 0 }
      else ctx.report(SOURCE, health('paused', 'sourceOff'))
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= FAILURES_BEFORE_ERROR) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause(Math.max(interval, ctx.config<YunxiaoConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string
  /** The window of modification times this round reads: from the cursor to the round's start. */
  since: string
  until: string
  signal?: AbortSignal | undefined
  /** Work items this round read, by id, so a comment read does not ask for the detail again. */
  workitems: Map<string, Workitem>
  /** Work items or comments the Trigger module could not read; one of them is not a failed round. */
  skipped: number
  /**
   * Reads that failed. A failed work-item search keeps the cursor where it is, so the next round reads the same window again;
   * comments, merge requests and write-backs keep their own positions, so their failures are reported without holding it.
   */
  failures: string[]
  /** Where the next round resumes when a search stopped at its page limit: the last modification time it read. */
  resume?: string
  /** Write-backs that settled with a problem: reported as health, but they do not hold the cursor back. */
  problems: string[]
}
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * One polling round: the work items of every configured project and category, then the comments of the work items a ticket
 * or a subscription still follows, then the write-back of tickets that ended. The cursor moves only once the whole round
 * succeeded; Trigger IDs are deterministic, so reading a window twice costs a duplicate rather than a lost request.
 * @returns the polling interval in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<YunxiaoConfig>(SOURCE)
  if (!config) return 60
  const loaded = await readRules(ctx, config)
  // Without any version of the file there is nothing to poll; the health error readRules reported is the whole story.
  if (!loaded) return config.pollSeconds ?? 60
  const { file, problem } = loaded
  const interval = config.pollSeconds ?? file.pollSeconds
  const started = new Date().toISOString()
  const round: Round = { started, since: ctx.state.get(KV.yunxiao.cursor) ?? new Date(Date.parse(started) - FIRST_RUN_BACKFILL_MS).toISOString(),
    until: started, signal, workitems: new Map(), skipped: 0, failures: [], problems: [] }
  const agent = ctx.deployment.codeup?.account.id ?? ''
  // The Policy's allowed list defaults to the account the Source acts as, which only the deployment knows.
  agentAccount = agent
  // The workers may start only the pipelines the rules name, so the file their shell reads follows the rules file.
  if (!problem) await syncPipelines(ctx, round, file)
  await pollWorkitems(ctx, round, file, agent)
  const searched = !round.failures.length
  // The approver answers after the round that asked, by which time the cursor has moved past the work item's last change:
  // the answers are read from their own records rather than from the search window, or a late answer would start nothing.
  await pollTriageAnswers(ctx, round, file, agent)
  await pollStarted(ctx, round, file)
  await pollComments(ctx, round, file, agent)
  // Merge requests the tickets of this Source follow: their comments, CI and close, each read on its own.
  const merges = newMergeRound(round.started, round.signal)
  await pollMergeRequests(ctx, file, merges)
  round.failures.push(...merges.failures)
  await pollWriteBacks(ctx, round, file, agent)
  if (stopped(ctx, round)) return interval
  if (searched) ctx.state.set(KV.yunxiao.cursor, cursorAt(round.resume ?? round.started))
  if (round.failures.length) throw new Error(`${round.failures.length} yunxiao reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  // A write-back that settled with a problem is work a person must finish, and one report is enough: the ticket is recorded,
  // so the next round does not write it again.
  if (round.problems.length) ctx.report(SOURCE, { state: 'error', detail: round.problems[0]! })
  // A broken file keeps its own error report: the round that follows the previous version is not a healthy configuration.
  else if (!problem) {
    const skipped = round.skipped ? `; ${round.skipped} unreadable records skipped` : ''
    ctx.report(SOURCE, { state: 'ready', detail: `${file.projects.length} projects, ${round.workitems.size} work items${skipped}; next poll ≥ ${interval}s`, at: round.started })
  }
  return interval
}
/**
 * Reads the receiving rules. A file that fails to load or validate is reported as a health error and the version that last
 * loaded stays in force, because work already under way must not stop over a bad edit; the hash of every good read is also
 * kept in the Source's digest, which the Policy version carries.
 * @returns the rules in force with the problem, or undefined when no version ever loaded.
 */
async function readRules(ctx: SourceContext, config: YunxiaoConfig): Promise<{ file: YunxiaoFile; problem?: string } | undefined> {
  try {
    const { file, hash } = await loadConfig(config.configPath)
    // Reads run in the file's organization and the CLI's writes run in the account's; two organizations would split them.
    const account = ctx.deployment.codeup?.organization
    if (account && account !== file.organization) {
      ctx.report(SOURCE, { state: 'error', detail: `The receiving rules name the organization ${file.organization}, but the Codeup account is in ${account}` })
      return undefined
    }
    ctx.state.set(KV.yunxiao.config, { hash, file, at: new Date().toISOString() })
    ctx.state.set(KV.sources.digests(SOURCE), hash)
    rules = { file }
    return { file }
  } catch (error) {
    const problem = messageOf(error)
    const cached = cachedRules(ctx)
    // The snapshot is replaced only by a version that validated, so `scope` and the panel keep reading what is in force.
    if (cached) rules = { file: cached, problem }
    // A file that is not there yet leaves the Source waiting for the operator to write it; anything else is a broken configuration.
    ctx.report(SOURCE, error instanceof MissingRulesError ? { state: 'paused', detail: problem } : { state: 'error', detail: problem })
    return cached ? { file: cached, problem } : undefined
  }
}
/** The last rules file that loaded, revalidated so a version this build rejects cannot be resurrected from the cache. */
function cachedRules(ctx: SourceContext): YunxiaoFile | undefined {
  const stored = ctx.state.get(KV.yunxiao.config)
  if (!stored) return undefined
  const parsed = YunxiaoFileSchema.safeParse(stored.file)
  return parsed.success ? parsed.data : undefined
}
/** Searches every project and category of the rules file for work items modified inside the round's window. */
async function pollWorkitems(ctx: SourceContext, round: Round, file: YunxiaoFile, agent: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  for (const project of file.projects) {
    for (const type of project.types) {
      if (stopped(ctx, round)) return
      try {
        for (const item of await search(commands, file.organization, project.id, type.category, round)) {
          round.workitems.set(item.id, item)
          // One work item's Trigger or question failing leaves the state unrecorded, so the next round tries it again.
          try { await intake(ctx, round, file, project, item, agent) }
          catch (error) {
            if (stopped(ctx, round)) return
            round.failures.push(`work item ${item.id}: ${String(error)}`)
          }
        }
      } catch (error) {
        if (stopped(ctx, round)) return
        round.failures.push(`work items of ${project.id} ${type.category}: ${String(error)}`)
      }
    }
  }
}
/**
 * Reads every page of one category's search, oldest first. A search that reaches the page limit with more to read sets the
 * round's resume point to the last modification time it read, so the next round continues there instead of skipping the rest.
 */
async function search(commands: Commands, organization: string, projectId: string, category: string, round: Round): Promise<Workitem[]> {
  const items: Workitem[] = []
  const conditions = searchConditions(round.since, round.until)
  for (let page = 1; page <= MAX_PAGES; page++) {
    const found = await commands.aliyun(SearchSchema, YUNXIAO.searchWorkitems(organization, { category, spaceId: projectId, conditions, page, perPage: PAGE_SIZE }))
    const raw = pageItems(found)
    for (const value of raw) {
      // One work item the Trigger module cannot read is skipped rather than failing the page, and named in health.
      try { items.push(workitemOf(value, projectId)) }
      catch { round.skipped += 1 }
    }
    // An empty page is the end: a page smaller than the one asked for may just be the CLI's own cap on page size.
    if (!raw.length) return items
  }
  const last = items.at(-1)?.modifiedAt
  if (last && (!round.resume || last < round.resume)) round.resume = last
  return items
}
/** Projex compares dates as Asia/Shanghai wall-clock times written `yyyy-MM-dd HH:mm:ss`. */
const PROJEX_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
/** The condition groups `projex-search-workitems` takes as a JSON string: modified inside the round's window. */
function searchConditions(since: string, until: string): string {
  const value = [since, until].map(time => PROJEX_TIME.format(new Date(time)))
  return JSON.stringify({ conditionGroups: [[{ fieldIdentifier: 'gmtModified', operator: 'BETWEEN', value, className: 'date', format: 'input' }]] })
}
/** One page of `projex-search-workitems`: Codeup prints the list itself, or an object holding it under `items`/`result`/`data`. */
const SearchSchema = z.union([z.array(z.unknown()),
  z.looseObject({ items: z.array(z.unknown()).optional(), result: z.unknown().optional(), data: z.unknown().optional() })])
/** The work items of one search page, whichever way the CLI wrapped them. */
function pageItems(page: z.infer<typeof SearchSchema>): unknown[] {
  if (Array.isArray(page)) return page
  if (page.items) return page.items
  const nested = page.result ?? page.data
  if (Array.isArray(nested)) return nested
  const record = nested !== null && typeof nested === 'object' ? nested as Record<string, unknown> : undefined
  return record && Array.isArray(record.items) ? record.items : []
}
/**
 * Compares one work item with what the last round recorded and does what its state calls for: start a repair cycle, follow
 * up an approver's answer, or end the ticket when the work item was assigned to somebody else.
 * A work item assigned to the agent in a receiving status is an explicit request: it is started once per repair cycle, and
 * again when it returns to a receiving status after being verified or closed, which begins the next cycle.
 */
async function intake(ctx: SourceContext, round: Round, file: YunxiaoFile, project: YunxiaoProject, item: Workitem, agent: string): Promise<void> {
  const previous = ctx.state.get(KV.yunxiao.workitem(item.id))
  const receiving = receiveStates(project)
  const assigned = agent !== '' && sameName(item.assignee, agent)
  const wasAssigned = previous !== undefined && agent !== '' && sameName(previous.assignee, agent)
  // A state the last round had not already granted: never seen, assigned to the agent only now, or back in a receiving status.
  const fresh = previous === undefined || !wasAssigned || !receiving.includes(previous.status)
  const grant = assigned && receiving.includes(item.status) && fresh
  const cycle = grant ? (previous ? previous.cycle + 1 : 0) : previous?.cycle ?? 0
  // Assigned away from the agent: the ticket the work item started ends, and the work item says why. The new assignee's
  // record keeps this from happening twice.
  if (wasAssigned && !assigned) await stopReassigned(ctx, round, file, item)
  // Started before the state is recorded, so a Trigger the Engine refused is emitted again by the next round rather than
  // recorded as granted; the Trigger ID is the same, so an Engine that did take it answers `duplicate`.
  if (grant) await startWork(ctx, round, file, project, item, agent, cycle)
  ctx.state.set(KV.yunxiao.workitem(item.id), { cycle, status: item.status, assignee: item.assignee, commentAt: previous?.commentAt ?? '' })
}
/**
 * Starts the repair cycle of one work item: directly for a `direct` project, and only after the approver's answer for a
 * `triage` one, where the design lets a person decide before a worker is started.
 */
async function startWork(ctx: SourceContext, round: Round, file: YunxiaoFile, project: YunxiaoProject, item: Workitem,
  agent: string, cycle: number): Promise<void> {
  if (project.intake === 'direct') {
    await ctx.receive(workitemTrigger(item, item.assignee, cycle, agent, intakeChannel(file)))
    return
  }
  await askTriage(ctx, round, file, item, agent, cycle)
}
/**
 * Asks the approver, in a direct message, whether a triage project's work item should start. The question is asked once per
 * repair cycle; the answer arrives in `KV.yunxiao.triage`, written by the host that reads the approver's reply.
 */
async function askTriage(ctx: SourceContext, round: Round, file: YunxiaoFile, item: Workitem, agent: string, cycle: number): Promise<void> {
  const asked = ctx.state.get(KV.yunxiao.triage(item.id))
  // A question for this cycle is out, or already answered: `answeredTriage` takes it from there.
  if (asked && asked.cycle === cycle) return
  const openId = file.approver.feishuOpenId
  if (!openId) {
    // Nobody to ask: the design's simple case starts the work at once, and health says the question was skipped for want of
    // an approver, so an operator can name one instead of wondering why triage never asks.
    round.problems.push(`triage of ${item.id}: the receiving rules name no approver.feishuOpenId, so the work item started without a question`)
    await ctx.receive(workitemTrigger(item, item.assignee, cycle, agent, intakeChannel(file)))
    return
  }
  // The question's idempotency key is fixed by the work item and its cycle, so a round that retries after a lost answer sends
  // one message rather than two.
  const idempotencyKey = key('yunxiao-triage', item.id, String(cycle))
  const messageId = await createFeishuDirect(ctx.commands.withSignal(round.signal), { openId, text: triageText(item), idempotencyKey })
  if (!messageId) throw new Error('Feishu reported no message id for the triage question')
  ctx.state.set(KV.yunxiao.triage(item.id), { state: 'asked', messageId, at: round.started, cycle })
  // The host reads the approver's answer through this record, which names the work item the question asks about.
  ctx.state.set(KV.merge.message(messageId), { thread: '', ticketId: '', at: round.started, kind: 'triage', workitemId: item.id })
}
/**
 * Starts the work of every triage project whose approver answered `go` and whose cycle has no Trigger yet.
 * The answer is read from its own record rather than from a search result: a work item that nobody touches again never
 * returns to the modification window the cursor has already passed, so waiting for the search would leave it unstarted
 * although the approver was told it began. The work item is read again before starting, because it may have been assigned
 * away or closed while the question waited; then nothing starts and the answer is spent rather than asked again.
 */
async function pollTriageAnswers(ctx: SourceContext, round: Round, file: YunxiaoFile, agent: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  for (const key of ctx.state.keys(KV.yunxiao.triage)) {
    if (stopped(ctx, round)) return
    const asked = ctx.state.get(key)
    if (!asked || asked.state !== 'go') continue
    const id = key.slice(KV.yunxiao.triage.prefix.length)
    if (!id || ctx.triggers.get(workitemTriggerId(id, asked.cycle))) continue
    try {
      const item = workitemOf(await commands.aliyun(z.unknown(), YUNXIAO.workitem(file.organization, id)))
      const project = projectOf(file, item.projectId)
      const assigned = agent !== '' && sameName(item.assignee, agent)
      // The state the answer was given for may be gone: a person's "start" is spent rather than replayed on a work item that
      // is now somebody else's or no longer waiting to be worked on.
      if (!project || !assigned || !receiveStates(project).includes(item.status)) { ctx.state.set(key, undefined); continue }
      const trigger = workitemTrigger(item, item.assignee, asked.cycle, agent, intakeChannel(file))
      // An answer that says more than "go" is material the worker should read, so it rides on the Trigger that starts the work.
      const answer = asked.answer?.trim() ?? ''
      if (answer && !TRIAGE_BARE.test(answer)) trigger.text = `${trigger.text}\n\n补充信息（审批人）：${answer}`
      await ctx.receive(trigger)
    } catch (error) {
      if (stopped(ctx, round)) return
      // A work item that is gone takes no work ever: the answer is spent and named once, so no round asks for it again. Any
      // other failure may pass, and dropping the answer would lose the start the approver was promised, so it is kept and the
      // round reports the failed read instead.
      if (!workitemGone(error)) { round.failures.push(`triage answer of ${id}: ${String(error)}`); continue }
      ctx.state.set(key, undefined)
      round.problems.push(`triage answer of ${id}: ${String(error)}`)
    }
  }
}
/**
 * Ends the ticket a work item started once the work item is assigned to somebody else, and says so on the work item. The
 * record of the new assignee keeps this from running twice; the ticket is stopped either way, and only the note can fail.
 */
async function stopReassigned(ctx: SourceContext, round: Round, file: YunxiaoFile, item: Workitem): Promise<void> {
  const ticket = openTicketOf(ctx, item.id)
  if (!ticket) return
  ctx.tickets.stop(ticket.id, `The work item was assigned to ${item.assignee || 'somebody else'}`)
  const text = [`工作项已改派给 ${item.assignee || '其他同事'}，停止处理。`, '', AGENT_COMMENT].join('\n')
  try { await ctx.commands.withSignal(round.signal).aliyun(YUNXIAO.createWorkitemComment(file.organization, item.id, text)) }
  catch (error) {
    if (!stopped(ctx, round)) round.problems.push(`reassignment comment of ${item.id}: ${String(error)}`)
  }
}
/**
 * Moves the work item of a ticket whose work started to the status its category's rule names, once per ticket: the work item
 * then reads 处理中 while a worker runs, and a later reopen still begins the next cycle, because the receiving rule decides
 * that from the status the round before saw.
 */
async function pollStarted(ctx: SourceContext, round: Round, file: YunxiaoFile): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  for (const ticket of ctx.tickets.open()) {
    if (stopped(ctx, round)) return
    const id = workitemOfTicket(ctx, ticket)
    if (!id) continue
    // The repair cycle the ticket is working: a reopened work item carries on with the same ticket, so the move has to follow
    // the cycle rather than the ticket, or the second repair would leave the work item in the status it was reopened in.
    const cycle = ctx.state.get(KV.yunxiao.workitem(id))?.cycle ?? 0
    const moved = ctx.state.get(KV.yunxiao.started(ticket.id))
    if (moved && moved.cycle === cycle) continue
    // The start of this cycle is still the approver's to give: a question is out, or the answer is on its way but the Trigger
    // that carries it is not stored yet. Moving the status first would leave the answer finding a work item that no longer
    // waits for work, and the start would be dropped.
    const asked = ctx.state.get(KV.yunxiao.triage(id))
    if (asked && asked.cycle === cycle && asked.state !== 'declined' && !ctx.triggers.get(workitemTriggerId(id, cycle))) continue
    const type = startedRuleOf(ctx, file, ticket)
    if (!type) continue
    try {
      await commands.aliyun(YUNXIAO.updateWorkitem(file.organization, id, { status: type.started }))
      ctx.state.set(KV.yunxiao.started(ticket.id), { at: round.started, status: type.started, cycle })
    } catch (error) {
      if (stopped(ctx, round)) return
      // A refused or impossible move is not retried every round: the record marks it attempted for this cycle, and the empty
      // status says the work item never took it. Health names the reason once, for a person to move the work item by hand.
      ctx.state.set(KV.yunxiao.started(ticket.id), { at: round.started, status: '', cycle })
      round.problems.push(`started status of ${ticket.id}${workitemGone(error) ? ' (the work item is gone)' : ''}: ${String(error)}`)
    }
  }
}
/** The receiving rule of the category the ticket's work item belongs to, whose `started` status the move targets. */
function startedRuleOf(ctx: SourceContext, file: YunxiaoFile, ticket: Ticket): YunxiaoType | undefined {
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  const meta = trigger?.source === SOURCE ? trigger.meta : {}
  const project = projectOf(file, typeof meta.projectId === 'string' ? meta.projectId : '')
  return project && typeof meta.category === 'string' ? typeOf(project, meta.category) : undefined
}
/** The open ticket a work item started, if one is still running. */
function openTicketOf(ctx: SourceContext, workitemId: string): Ticket | undefined {
  return ctx.tickets.open().find(ticket => workitemOfTicket(ctx, ticket) === workitemId)
}
/**
 * Where a ticket's own messages go: the approver's direct message when the rules name one, so acknowledgements, questions and
 * results reach the person rather than the work item a colleague reads; otherwise the work item itself.
 */
function intakeChannel(file: YunxiaoFile): ChannelRef | undefined {
  const openId = file.approver.feishuOpenId
  return openId ? { source: 'feishu', thread: `feishu:dm:${openId}`, address: { openId, new: 'true' } } : undefined
}
/**
 * The question the approver answers before a triage project's work item starts: what the work item is, where to read it, and
 * how to answer. Like the merge confirmation, it is user-facing copy in the team's language.
 */
export function triageText(item: Workitem): string {
  const whole = item.description.replace(/\s+/g, ' ').trim()
  const excerpt = whole.length > 300 ? `${whole.slice(0, 300)}…` : whole
  return [['【开工确认】', item.serial, item.title].filter(Boolean).join(' '), ...excerpt ? ['', excerpt] : [],
    ...item.url ? ['', item.url] : [], '', '回复「开工」开始处理；回复「不做」跳过；其他文字视为补充信息并开工。'].join('\n')
}
/**
 * Applies the rules file's pipeline prefixes to the file a worker's shell reads, so a worker may start exactly the pipelines
 * the rules name. A file a person wrote by hand is left alone and reported: their choice outranks the rules.
 */
async function syncPipelines(ctx: SourceContext, round: Round, file: YunxiaoFile): Promise<void> {
  try {
    const written = await writeWorkerPipelines(ctx.deployment.stateDir, file.pipelines.allowPrefixes)
    if (!written) round.problems.push('worker-pipelines: the file was not written by dsh-superagent, so the receiving rules\' prefixes are not in force')
  } catch (error) {
    round.problems.push(`worker-pipelines: ${String(error)}`)
  }
}
/**
 * Reads the comments of every work item a ticket or a subscription still follows, taking in the ones added since the last
 * read. The agent's own comments are marked and never become Triggers; the read position advances only after all of them were
 * taken in, so a failed round reads the same comments again under the same Trigger IDs.
 */
async function pollComments(ctx: SourceContext, round: Round, file: YunxiaoFile, agent: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  for (const id of activeWorkitems(ctx)) {
    if (stopped(ctx, round)) return
    try {
      const comments = commentsOf(await commands.aliyun(z.unknown(), YUNXIAO.workitemComments(file.organization, id)))
      const previous = ctx.state.get(KV.yunxiao.workitem(id))
      const since = previous?.commentAt ?? ''
      const fresh = comments.filter(comment => comment.modifiedAt > since)
      if (!fresh.length) continue
      const item = round.workitems.get(id) ?? workitemOf(await commands.aliyun(z.unknown(), YUNXIAO.workitem(file.organization, id)))
      for (const comment of fresh) {
        // The Source writes its own result comments; `commentOf` marks one whose raw body carried the marker.
        if (comment.agent || isAgentComment(comment.body)) continue
        const trigger = commentTrigger(comment, item, agent)
        if (trigger) await ctx.receive(trigger)
      }
      const newest = comments.reduce((latest, comment) => comment.modifiedAt > latest ? comment.modifiedAt : latest, since)
      ctx.state.set(KV.yunxiao.workitem(id), { cycle: previous?.cycle ?? 0, status: previous?.status ?? item.status,
        assignee: previous?.assignee ?? item.assignee, commentAt: newest })
    } catch (error) {
      if (stopped(ctx, round)) return
      round.failures.push(`comments of ${id}: ${String(error)}`)
    }
  }
}
/**
 * Writes the result of every ticket that ended within the horizon and has not been written back.
 * A result returned by `writeBack` is settled even when it carries a problem (a refused workflow move, a work item that no
 * longer accepts comments): the comment is on the work item or never will be, so it is recorded and not written twice. Only a
 * thrown error leaves the ticket for the next round.
 */
async function pollWriteBacks(ctx: SourceContext, round: Round, file: YunxiaoFile, agent: string): Promise<void> {
  const since = new Date(Date.parse(round.started) - WRITEBACK_HORIZON_MS).toISOString()
  for (const ticket of ctx.tickets.ended(since)) {
    if (stopped(ctx, round)) return
    // A ticket that resumed and ended again has a new end to write back; the record names the end it wrote.
    const written = ctx.state.get(KV.yunxiao.writeback(ticket.id))
    const ended = ticket.ended?.at ?? ''
    if (!workitemOfTicket(ctx, ticket) || (written && (written.ended !== undefined ? written.ended === ended : ended <= written.at))) continue
    const trigger = ctx.triggers.get(ticket.origin.triggerId)
    try {
      const result = await writeBack({ commands: ctx.commands.withSignal(round.signal), file, ticket,
        meta: trigger?.source === SOURCE ? trigger.meta : {}, agent })
      ctx.state.set(KV.yunxiao.writeback(ticket.id), { at: round.started, ended, ...result.status ? { status: result.status } : {} })
      if (result.problem) round.problems.push(`write-back of ${ticket.id}: ${result.problem}`)
    } catch (error) {
      // A thrown write-back settled nothing, so it is retried next round and holds the cursor, like any failed read.
      if (!stopped(ctx, round)) round.failures.push(`write-back of ${ticket.id}: ${String(error)}`)
    }
  }
}
/** The work items whose comments are read: those with an open ticket or a subscribed Thread. */
function activeWorkitems(ctx: SourceContext): Set<string> {
  const active = new Set<string>()
  for (const thread of ctx.threads.subscribed(SOURCE)) {
    const id = workitemIdOfThread(thread.ref.id)
    if (id) active.add(id)
  }
  for (const ticket of ctx.tickets.open()) {
    const id = workitemOfTicket(ctx, ticket)
    if (id) active.add(id)
  }
  return active
}
/** The work item a ticket came from, from its Channel, its origin Trigger, or the Thread it follows. */
function workitemOfTicket(ctx: SourceContext, ticket: Ticket): string | undefined {
  for (const channel of ticket.channels) {
    const id = channel.source === SOURCE ? channel.address.workitem : undefined
    if (id) return id
  }
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  if (trigger?.source === SOURCE) {
    const ref = yunxiaoRef(trigger)
    if (ref.workitemId) return ref.workitemId
  }
  for (const follow of ticket.follows ?? []) {
    const id = workitemOfThreadKey(follow.thread)
    if (id) return id
  }
  return undefined
}
/** The work-item id of a Thread id (`wi:<id>`), or undefined for a Thread that is not a work item's. */
const workitemIdOfThread = (id: string): string | undefined => id.startsWith('wi:') ? id.slice(3) : undefined
/** The work-item id of a Thread key (`yunxiao:wi:<id>`), or undefined for another Source's Thread. */
function workitemOfThreadKey(key: string): string | undefined {
  const [source, prefix, id] = key.split(':')
  return source === SOURCE && prefix === 'wi' && id ? id : undefined
}
