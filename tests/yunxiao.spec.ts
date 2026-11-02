/** The yunxiao work-item Source: its settings, listening rule, policy rows, variables, polling of work items and comments, write-back, and bundle entry. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import configs from '../tsdown.config.ts'
import type { ReceiveResult, Thread, Ticket, Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { Deployment } from '../src/deployment.ts'
import type { Commands } from '../src/infra/commands.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { HEALTH_TEXT, type SourceContext } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply as applyYunxiao, currentRules, inject, name as pluginName, pollRound, yunxiaoKind } from '../src/sources/yunxiao.ts'
import { DEFAULT_CONFIG_PATH } from '../src/sources/yunxiao-config.ts'
import { commentTriggerId, workitemTriggerId } from '../src/sources/yunxiao-trigger.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

/** The account this deployment acts as, which the Policy admits by default and whose assignments the Source receives. */
const AGENT = '62cf7f1d29d72730d9acc32d'
/** The rules file a deployment writes: one project with the defect and task categories the design's example lists. */
const RULES = `organization: "org-1"
workspace: "/tmp/workspace"
pollSeconds: 120
projects:
  - id: "proj-1"
    intake: triage
    types:
      - category: Bug
        receive: ["28", "30"]
        started: "100010"
        verified: "29"
      - category: Task
        receive: ["100005"]
        started: "100010"
        verified: "100014"
`
/** A second project, to show that the Source reads each configured project's categories. */
const TWO_PROJECTS = `${RULES}  - id: "proj-2"
    intake: direct
    types:
      - category: Bug
        receive: ["28"]
        started: "100010"
        verified: "29"
`
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A work item as `projex-search-workitems` and `projex-get-workitem` report it, assigned to the agent in a receiving status. */
const workitem = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'wi-1', identifier: 'AXOAXO-1',
  subject: 'Login fails', description: '<p>Steps to reproduce</p>', status: '28', assignedTo: { id: AGENT }, spaceId: 'proj-1',
  categoryIdentifier: 'Bug', gmtModified: '2026-09-09T00:00:00Z', ...fields })
/** One page of `projex-search-workitems`. */
const search = (...items: unknown[]): unknown => ({ items })
/** A comment as `projex-list-workitem-comments` reports it. */
const comment = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'c-1', content: '<p>补充一下</p>',
  creator: { id: 'user-2' }, gmtCreate: '2026-09-09T01:00:00Z', gmtModified: '2026-09-09T01:00:00Z', ...fields })
const comments = (...items: unknown[]): unknown => ({ comments: items })
/** The CLI's answers before a test routes a subcommand: an empty page or list, and a write that reports nothing. */
const DEFAULT_ROUTES: Record<string, unknown> = { 'projex-search-workitems': { items: [] }, 'projex-list-workitem-comments': { comments: [] },
  'projex-create-workitem-comment': {}, 'projex-update-workitem': {} }
/** A trigger of the work item, as the Source emitted it, which a ticket's origin names. */
const originTrigger = (workitemId: string): Trigger => ({ id: `origin-${workitemId}`, source: 'yunxiao', threads: [],
  actor: { source: 'yunxiao', id: AGENT }, human: true, at: '', text: '', meta: { workitemId, category: 'Bug', projectId: 'proj-1' } })
/** A ticket the work item started, with the Channel its replies go to. */
const openTicket = (id: string, workitemId: string): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'yunxiao', id: AGENT }, scope: 'proj-1' },
  channels: [{ source: 'yunxiao', thread: `yunxiao:${workitemId}`, address: { workitem: workitemId } }],
  assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: `origin-${workitemId}`, triggerIds: [] } })
/** A ticket that ended with a verified fix, which the Source writes back. */
const endedTicket = (id: string, workitemId: string): Ticket => ({ ...openTicket(id, workitemId),
  ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed' },
  assignments: [{ id: `a-${id}`, state: 'ended', createdAt: '', report: { state: 'ready', summary: 'done', at: new Date().toISOString(),
    result: { verification: '在 PRE 上复现并验证通过' } } }] })
/** A subscribed Thread of a work item, whose comments the Source keeps reading. */
const workitemThread = (workitemId: string): Thread => ({ key: `yunxiao:wi:${workitemId}`, ref: { source: 'yunxiao', id: `wi:${workitemId}` },
  createdAt: new Date().toISOString(), subscriptions: ['t-1'], correlated: [], pending: [], meta: {} })

interface HostOptions {
  /** The rules file's text; `null` leaves the file missing. */
  rules?: string | null
  pollSeconds?: number
  deployment?: Deployment
  /** Answers by the `devops` subcommand; a value that is an `Error` is thrown as the CLI's failure. */
  routes?: Record<string, unknown>
  threads?: Thread[]
  tickets?: { open?: Ticket[]; ended?: Ticket[] }
  triggers?: Record<string, Trigger>
  configured?: boolean
  /** False for the plugin test, which lets `apply` register the kind itself. */
  register?: boolean
}
/**
 * A Source context for the yunxiao kind over a temporary rules file, a scripted projex CLI, and in-memory state, tickets,
 * Threads and Triggers; `receive` records what the Source hands the Engine.
 */
function host(options: HostOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yunxiao-'))
  dirs.push(dir)
  const configPath = join(dir, 'yunxiao.yml')
  const writeRules = (text: string): void => { writeFileSync(configPath, text) }
  if (options.rules !== null) writeRules(options.rules ?? RULES)
  const deployment = options.deployment ?? testDeployment({ codeup: testCodeup({ organization: 'org-1',
    account: { id: AGENT, name: 'yedou', commitEmail: 'yedou@example.com' } }) })
  // The table stays the caller's object, so a test can change a subcommand's answer between rounds.
  const routes: Record<string, unknown> = options.routes ?? {}
  const calls: string[][] = []
  const commands = {
    deployment,
    withSignal: () => commands,
    // Both `aliyun(argv)` and `aliyun(schema, argv)` land here; the Source uses the schema form only to validate the envelope.
    async aliyun(first: unknown, second?: readonly string[]): Promise<unknown> {
      const argv = (Array.isArray(first) ? first : second ?? []) as string[]
      calls.push([...argv])
      const answer = routes[argv[1] ?? ''] ?? DEFAULT_ROUTES[argv[1] ?? '']
      const value = typeof answer === 'function' ? (answer as (argv: string[]) => unknown)(argv) : answer
      if (value instanceof Error) throw value
      return value ?? {}
    },
  }
  const state = new Map<string, unknown>()
  const threads = options.threads ?? []
  const open = options.tickets?.open ?? []
  const ended = options.tickets?.ended ?? []
  const store = {
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => { state.set(key, value) },
    delete: (key: string) => { state.delete(key) },
    keys: (prefix: string) => [...state.keys()].filter(key => key.startsWith(prefix)),
    atomic: <T>(work: () => T): T => work(),
    threads: { get: (key: string) => threads.find(thread => thread.key === key), describe: () => {}, patchMeta: () => {} },
    tickets: { get: (id: string) => [...open, ...ended].find(ticket => ticket.id === id), open: () => open, list: () => [...open, ...ended] },
    triggers: { get: (id: string) => options.triggers?.[id] },
    read: { subscribedThreads: () => threads, threadTriggers: () => [] },
  } as unknown as SourceContextDeps['store']
  const board = new HealthBoard()
  const config = { configPath, ...options.pollSeconds === undefined ? {} : { pollSeconds: options.pollSeconds } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { yunxiao: { enabled: true, config } } }), board)
  if (options.register ?? true) sources.register(yunxiaoKind)
  const receive = vi.fn((_trigger: Trigger): ReceiveResult => 'stored')
  const deps = {
    store, outbox: { send: () => {} }, engine: {} as SourceContextDeps['engine'], commands: commands as unknown as Commands, sources,
    deployment, ready: Promise.resolve(), configured: () => options.configured ?? true, receive,
  } satisfies SourceContextDeps
  const orchestrator = { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
  return {
    ctx: sourceContextOf(deps, yunxiaoKind), board, receive, calls, state, configPath, writeRules, deployment, sources,
    /** Runs the plugin entry, as DSH mounts it, and returns a stop that disposes what it registered. */
    plugin() {
      const disposers: (() => unknown)[] = []
      applyYunxiao({ orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      return { stop: async () => { for (const dispose of disposers) await dispose() } }
    },
  }
}
/** The bodies of the search commands a round issued, in order. */
const searched = (calls: string[][]): Record<string, unknown>[] => calls.filter(argv => argv[1] === 'projex-search-workitems')
  .map(argv => JSON.parse(argv[argv.indexOf('--body') + 1]!) as Record<string, unknown>)
/** The argument after `flag` of a command. */
const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1]!

describe('yunxiao kind', () => {
  it('stores the path of the receiving rules and an optional interval, and refuses a field it would not read', () => {
    expect(yunxiaoKind.schema.parse({})).toEqual({ configPath: DEFAULT_CONFIG_PATH })
    expect(yunxiaoKind.schema.parse({ configPath: ' /tmp/x.yml ', pollSeconds: 120 })).toEqual({ configPath: '/tmp/x.yml', pollSeconds: 120 })
    // A field of another Source, or an interval the polling loop would not accept, cannot be stored.
    expect(yunxiaoKind.schema.safeParse({ configPath: '/tmp/x.yml', repository: 'acme/widgets' }).success).toBe(false)
    expect(yunxiaoKind.schema.safeParse({ pollSeconds: 30 }).success).toBe(false)
    expect(yunxiaoKind.kind).toBe('yunxiao')
    expect(yunxiaoKind.health).toEqual(['yunxiao'])
    expect(yunxiaoKind.title).toEqual({ zh: '云效工作项', en: 'Yunxiao work items' })
    expect(yunxiaoKind.description.zh && yunxiaoKind.description.en).toBeTruthy()
    expect(yunxiaoKind.fields.map(field => field.key)).toEqual(['configPath', 'account', 'organization', 'pollSeconds'])
    for (const field of yunxiaoKind.fields) expect(field.label.zh && field.label.en).toBeTruthy()
  })
  it('lists a work item of a configured project only, and trusts one read before the rules are', async () => {
    const h = host()
    const scope = yunxiaoKind.scope!
    const config = yunxiaoKind.schema.parse({})
    // Before the first read there is no file in memory; a Trigger can only come from a project the poller had configured.
    expect(scope({ meta: { projectId: 'proj-1' } }, config)).toEqual({ listened: true, observed: false, row: 'proj-1' })
    expect(currentRules()).toBeUndefined()
    await pollRound(h.ctx)
    expect(currentRules()?.file.organization).toBe('org-1')
    expect(scope({ meta: { projectId: 'proj-1' } }, config)).toEqual({ listened: true, observed: false, row: 'proj-1' })
    // A project the file does not configure is not received, which is what the reason says.
    expect(scope({ meta: { projectId: 'proj-9' } }, config)).toEqual({ listened: false, reason: 'project_not_configured' })
    // Nothing here is observed beyond what addresses the agent.
    expect(scope({ meta: { projectId: 'proj-1' } }, config)).not.toHaveProperty('observed', true)
  })
  it('admits an assignment from a listed account as the explicit request, with one row per configured project', async () => {
    const h = host({ rules: TWO_PROJECTS })
    const policy = yunxiaoKind.policy!
    // The deployment's own account is on the list by default, so an assignment to it is explicit without any panel edit.
    expect(policy.schema.parse({})).toEqual({ allowed: [{ id: AGENT }] })
    expect(policy.schema.safeParse({ allowed: [{ id: 'not a user id' }] }).success).toBe(false)
    expect(policy.explicit.zh && policy.explicit.en).toBeTruthy()
    expect(policy.fields[0]).toMatchObject({ key: 'allowed', type: 'rows' })
    // The rows come from the rules file, which only the polling loop can read.
    await pollRound(h.ctx)
    expect(policy.rows!({})).toEqual([
      { id: 'proj-1', label: 'proj-1', note: { zh: '先评估', en: 'Assessed first' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
      { id: 'proj-2', label: 'proj-2', note: { zh: '直接开工', en: 'Starts directly' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
    ])
  })
  it('publishes the work item a ticket came from, and empties those variables for a ticket from elsewhere', () => {
    const environment = yunxiaoKind.environment!
    expect(environment.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_YUNXIAO_WORKITEM', 'DSH_SUPERAGENT_YUNXIAO_SERIAL',
      'DSH_SUPERAGENT_YUNXIAO_URL', 'DSH_SUPERAGENT_YUNXIAO_CATEGORY'])
    for (const variable of environment.variables) expect(variable.description.zh && variable.description.en).toBeTruthy()
    const deployment = testDeployment()
    const config = yunxiaoKind.schema.parse({})
    const trigger: Trigger = { id: 'x', source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: AGENT }, human: true, at: '',
      text: '', meta: { workitemId: 'wi-1', serial: 'AXOAXO-1', category: 'Bug', projectId: 'proj-1' },
      url: 'https://devops.aliyun.com/projex/workitem/wi-1' }
    expect(environment.values({ deployment, config, trigger })).toEqual({ DSH_SUPERAGENT_YUNXIAO_WORKITEM: 'wi-1',
      DSH_SUPERAGENT_YUNXIAO_SERIAL: 'AXOAXO-1', DSH_SUPERAGENT_YUNXIAO_URL: 'https://devops.aliyun.com/projex/workitem/wi-1',
      DSH_SUPERAGENT_YUNXIAO_CATEGORY: 'Bug' })
    // A ticket that did not start on yunxiao keeps the variables empty rather than absent, so a worker naming them reads a value.
    const empty = { DSH_SUPERAGENT_YUNXIAO_WORKITEM: '', DSH_SUPERAGENT_YUNXIAO_SERIAL: '', DSH_SUPERAGENT_YUNXIAO_URL: '',
      DSH_SUPERAGENT_YUNXIAO_CATEGORY: '' }
    expect(environment.values({ deployment, config })).toEqual(empty)
    expect(environment.values({ deployment, config, trigger: { ...trigger, source: 'feishu', meta: {} } })).toEqual(empty)
  })
  it('shows the account, the organization, and what the last read of the rules file found', async () => {
    const deployment = testDeployment({ codeup: testCodeup({ organization: 'org-1',
      account: { id: AGENT, name: '夜斗', commitEmail: 'yedou@example.com' } }) })
    expect(yunxiaoKind.facts!(deployment)).toMatchObject({ account: { zh: '当前账号 夜斗', en: 'Current account 夜斗' },
      organization: { zh: '当前组织 org-1', en: 'Current organization org-1' } })
    // Nothing is resolved before setup, so the card names no account.
    expect(yunxiaoKind.facts!(undefined)).not.toHaveProperty('account')
    const h = host({ deployment, rules: TWO_PROJECTS })
    await pollRound(h.ctx)
    expect(yunxiaoKind.facts!(deployment).configPath).toEqual({ zh: '2 个项目', en: '2 projects' })
    // A broken file keeps the version in force, and the fact says so instead of showing a count it no longer trusts.
    h.writeRules('organization: [unclosed\n')
    await pollRound(h.ctx)
    expect(yunxiaoKind.facts!(deployment).configPath).toEqual({ zh: '配置有误，沿用上一版（详见来源状态）',
      en: 'The file is invalid; the previous version is in force (see the Source status)' })
  })
})

describe('yunxiao polling', () => {
  it('receives a work item assigned to the agent in a receiving status once, then moves the cursor past it', async () => {
    const h = host({ routes: { 'projex-search-workitems': search(workitem()) } })
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ id: workitemTriggerId('wi-1', 0), source: 'yunxiao', human: true, addressed: 'mention',
      actor: { source: 'yunxiao', id: AGENT }, meta: { workitemId: 'wi-1', serial: 'AXOAXO-1', category: 'Bug', projectId: 'proj-1',
        status: '28', cycle: 0 } })
    expect(trigger.text).toContain('AXOAXO-1 Login fails')
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toEqual({ cycle: 0, status: '28', assignee: AGENT, commentAt: '' })
    expect(Date.parse(h.state.get(KV.yunxiao.cursor) as string)).toBeLessThanOrEqual(Date.now())
    expect(h.board.all.yunxiao).toMatchObject({ state: 'ready', detail: '1 projects, 1 work items; next poll ≥ 120s' })
    // The hash of the rules is in the digest the Policy version carries, so an edit of the file invalidates old decisions.
    const cached = h.state.get(KV.yunxiao.config) as { hash: string }
    expect(h.state.get(KV.sources.digests('yunxiao'))).toBe(cached.hash)
    // The same window read again is the same work item and the same cycle, so nothing is received twice.
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
  })
  it('searches every category of every project inside the cursor window, oldest first', async () => {
    const h = host({ rules: TWO_PROJECTS })
    await pollRound(h.ctx)
    const first = searched(h.calls)
    expect(first.map(body => [body.category, body.spaceId])).toEqual([['Bug', 'proj-1'], ['Task', 'proj-1'], ['Bug', 'proj-2']])
    // The first round reads a week back, so work assigned before the Source started is still picked up.
    const window = (body: Record<string, unknown>) => (JSON.parse(body.conditions as string) as { conditionGroups: { value: string[] }[][] })
      .conditionGroups[0]![0]!.value
    const [from, to] = window(first[0]!)
    expect(Math.round((Date.parse(to!) - Date.parse(from!)) / 3_600_000)).toBe(168)
    expect(first[0]!.orderBy).toBe('gmtModified')
    expect(first[0]!.sort).toBe('asc')
    // Later rounds read from the cursor, which is five seconds behind the previous round's start.
    h.calls.length = 0
    await pollRound(h.ctx)
    const [since] = window(searched(h.calls)[0]!)
    expect(Date.parse(since!)).toBeLessThanOrEqual(Date.now() - 4000)
    expect(Date.parse(since!)).toBeGreaterThanOrEqual(Date.parse(h.state.get(KV.yunxiao.cursor) as string) - 1000)
  })
  it('reads every page of a search before the cursor moves, stopping at the first empty page', async () => {
    const h = host({ routes: { 'projex-search-workitems': (argv: string[]) => {
      const body = JSON.parse(flag(argv, '--body')) as { page: number; category: string }
      // The defect category answers a full page first, then nothing; the task category is empty straight away.
      if (body.category !== 'Bug' || body.page > 1) return search()
      return search(...Array.from({ length: 50 }, (_unused, index) => workitem({ id: `wi-${index}`, identifier: `AXOAXO-${index}` })))
    } } })
    await pollRound(h.ctx)
    const pages = (category: string) => searched(h.calls)
      .filter(body => body.category === category).map(body => body.page)
    expect(pages('Bug')).toEqual([1, 2])
    expect(pages('Task')).toEqual([1])
    expect(h.receive).toHaveBeenCalledTimes(50)
    expect(h.state.get(KV.yunxiao.cursor)).toBeDefined()
  })
  it('starts the next cycle when a verified work item is reopened, and only records the states between', async () => {
    const routes: Record<string, unknown> = { 'projex-search-workitems': search(workitem()) }
    const h = host({ routes })
    await pollRound(h.ctx)
    // The agent's fix waits for verification: a status outside the receiving set is recorded, not received.
    routes['projex-search-workitems'] = search(workitem({ status: '29' }))
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toMatchObject({ cycle: 0, status: '29' })
    // Reopened: the next repair cycle is a new request, under its own deterministic Trigger ID.
    routes['projex-search-workitems'] = search(workitem({ status: '30' }))
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls[1]![0].id).toBe(workitemTriggerId('wi-1', 1))
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toMatchObject({ cycle: 1, status: '30' })
    // Staying in a receiving status is not a new cycle.
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledTimes(2)
  })
  it('records a work item assigned to someone else, and one outside the receiving statuses, without receiving it', async () => {
    const routes: Record<string, unknown> = { 'projex-search-workitems': search(workitem({ assignedTo: { id: 'user-2' } })) }
    const h = host({ routes })
    await pollRound(h.ctx)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toEqual({ cycle: 0, status: '28', assignee: 'user-2', commentAt: '' })
    // Assigned to the agent, but the status is one the rules do not receive: nothing starts yet.
    routes['projex-search-workitems'] = search(workitem({ status: '100010' }))
    await pollRound(h.ctx)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toMatchObject({ status: '100010' })
    // Being assigned back is a new request even though the status never left the receiving set.
    routes['projex-search-workitems'] = search(workitem({ status: '30' }))
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
    expect(h.receive.mock.calls[0]![0].id).toBe(workitemTriggerId('wi-1', 1))
  })
  it('takes in a comment on a work item a ticket follows, skipping the agent\'s own marked comment', async () => {
    const h = host({ tickets: { open: [openTicket('t-1', 'wi-1')] }, routes: {
      'projex-list-workitem-comments': comments(comment(),
        comment({ id: 'c-2', content: `<!-- dsh-superagent:agent -->\n${AGENT_COMMENT.split('\n')[1]}`, creator: { id: AGENT } })),
      'projex-get-workitem': { workitem: workitem() },
    } })
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger.id).toBe(commentTriggerId('c-1', '2026-09-09T01:00:00.000Z'))
    expect(trigger).toMatchObject({ source: 'yunxiao', human: true, actor: { source: 'yunxiao', id: 'user-2' }, text: '补充一下',
      meta: { workitemId: 'wi-1', commentId: 'c-1', category: 'Bug', projectId: 'proj-1' } })
    // The read position is the newest comment, the agent's own included, so neither is read a second time.
    expect(h.state.get(KV.yunxiao.workitem('wi-1'))).toMatchObject({ commentAt: '2026-09-09T01:00:00.000Z' })
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
  })
  it('reads the comments of a subscribed Thread, and takes in only those newer than the read position', async () => {
    const h = host({ threads: [workitemThread('wi-1')], routes: {
      'projex-list-workitem-comments': comments(comment({ gmtModified: '2026-09-08T00:00:00Z' }), comment({ id: 'c-2' })),
      'projex-get-workitem': { workitem: workitem() },
    } })
    await pollRound(h.ctx)
    // Both are new the first time, and the older one is not read again afterwards.
    expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual([commentTriggerId('c-1', '2026-09-08T00:00:00.000Z'),
      commentTriggerId('c-2', '2026-09-09T01:00:00.000Z')])
    h.receive.mockClear()
    await pollRound(h.ctx)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('reports a broken rules file as health and keeps the version that last loaded', async () => {
    const routes: Record<string, unknown> = { 'projex-search-workitems': search(workitem()) }
    const h = host({ routes })
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'ready' })
    const loaded = h.state.get(KV.yunxiao.config)
    h.writeRules('organization: [unclosed\n')
    routes['projex-search-workitems'] = search(workitem({ id: 'wi-2', identifier: 'AXOAXO-2' }))
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'error', detail: expect.stringContaining('not valid YAML') })
    // The previous version stays in force, so the configured project is still listened to and still polled.
    expect(h.state.get(KV.yunxiao.config)).toEqual(loaded)
    expect(currentRules()?.problem).toContain('not valid YAML')
    expect(h.receive).toHaveBeenCalledTimes(2)
    // A file naming another organization would split the reads from the CLI's writes, so it is refused too.
    h.writeRules(RULES.replace('organization: "org-1"', 'organization: "org-2"'))
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'error', detail: expect.stringContaining('but the Codeup account is in org-1') })
  })
  it('waits paused while the rules file does not exist, and polls nothing', async () => {
    const h = host({ rules: null })
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'paused', detail: expect.stringContaining('Cannot read the yunxiao receiving rules') })
    expect(h.calls).toEqual([])
    expect(h.state.get(KV.yunxiao.cursor)).toBeUndefined()
    // Writing the file is all it takes: the next round reads it and polls.
    h.writeRules(RULES)
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'ready' })
    expect(searched(h.calls)).toHaveLength(2)
  })
  it('keeps the cursor when a read fails, so the next round reads the same window again', async () => {
    const routes: Record<string, unknown> = { 'projex-search-workitems': new Error('StatusCode: 500 Internal Server Error') }
    const h = host({ routes })
    await expect(pollRound(h.ctx)).rejects.toThrow(/2 yunxiao reads failed: work items of proj-1 Bug: .*work items of proj-1 Task/)
    expect(h.state.get(KV.yunxiao.cursor)).toBeUndefined()
    routes['projex-search-workitems'] = search(workitem())
    await pollRound(h.ctx)
    expect(h.state.get(KV.yunxiao.cursor)).toBeDefined()
    expect(h.receive).toHaveBeenCalledOnce()
  })
  it('writes an ended ticket\'s result comment and verified status back once', async () => {
    const h = host({ tickets: { ended: [endedTicket('t-1', 'wi-1')] }, triggers: { 'origin-wi-1': originTrigger('wi-1') } })
    await pollRound(h.ctx)
    const writes = h.calls.filter(argv => argv[1] === 'projex-create-workitem-comment')
    expect(writes).toHaveLength(1)
    const content = flag(writes[0]!, '--content')
    expect(content.startsWith('已修复')).toBe(true)
    expect(content).toContain('验证证据：在 PRE 上复现并验证通过')
    expect(content).toContain(AGENT_COMMENT)
    const moves = h.calls.filter(argv => argv[1] === 'projex-update-workitem')
    expect(JSON.parse(flag(moves[0]!, '--biz-body'))).toEqual({ status: '29' })
    expect(h.state.get(KV.yunxiao.writeback('t-1'))).toEqual({ at: expect.any(String), status: '29' })
    // Recorded, so a later round does not write the comment again.
    await pollRound(h.ctx)
    expect(h.calls.filter(argv => argv[1] === 'projex-create-workitem-comment')).toHaveLength(1)
  })
  it('reports a refused workflow move once, keeping the comment and the write-back record', async () => {
    const h = host({ tickets: { ended: [endedTicket('t-1', 'wi-1')] }, triggers: { 'origin-wi-1': originTrigger('wi-1') },
      routes: { 'projex-update-workitem': new Error('StatusCode: 400 Data: {"message":"状态流转不允许"}') } })
    await pollRound(h.ctx)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'error', detail: expect.stringContaining('The workflow refused the move to 29') })
    expect(h.state.get(KV.yunxiao.writeback('t-1'))).toEqual({ at: expect.any(String) })
    // The comment stays written, the move is not retried, and the next clean round reports ready again.
    await pollRound(h.ctx)
    expect(h.calls.filter(argv => argv[1] === 'projex-create-workitem-comment')).toHaveLength(1)
    expect(h.board.all.yunxiao).toMatchObject({ state: 'ready' })
  })
})

describe('yunxiao plugin', () => {
  it('registers its kind and health entry, and reports a wait while setup or the account is missing', async () => {
    expect(pluginName).toBe('dsh-superagent-yunxiao')
    expect(inject).toEqual(['orchestrator'])
    const pending = host({ register: false, configured: false })
    const running = pending.plugin()
    await vi.waitFor(() => expect(pending.board.all.yunxiao).toEqual({ state: 'paused', detail: HEALTH_TEXT.setupPending, code: 'setupPending' }))
    expect(pending.sources.kind('yunxiao')).toBe(yunxiaoKind)
    await running.stop()
    expect(pending.sources.kind('yunxiao')).toBeUndefined()
    // A deployment that resolved only GitHub has no aliyun CLI, so the projex commands have nothing to run as.
    const githubOnly = host({ register: false, deployment: testDeployment() })
    const off = githubOnly.plugin()
    await vi.waitFor(() => expect(githubOnly.board.all.yunxiao).toEqual({ state: 'paused', detail: HEALTH_TEXT.sourceOff, code: 'sourceOff' }))
    await off.stop()
  })
  it('ships as its own bundle entry, exported and built as yunxiao-watch', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(pkg.exports['./yunxiao-watch']).toBe('./lib/yunxiao-watch.js')
    const entries = configs.flatMap(config => typeof config.entry === 'object' && config.entry !== null && !Array.isArray(config.entry)
      ? [config.entry] : [])
    // The entry the export names is the module that exports this plugin, so `pnpm build` writes lib/yunxiao-watch.js.
    expect(entries.find(entry => 'index' in entry)?.['yunxiao-watch']).toBe('src/sources/yunxiao.ts')
    // The YAML parser is a runtime dependency, kept out of the bundle like zod.
    expect(configs[0]!.deps?.neverBundle).toContain('yaml')
  })
})
