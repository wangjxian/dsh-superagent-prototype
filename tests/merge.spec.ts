/** Host merge approval: the confirmation a person answers, the checks behind it, and the merge only that answer allows. */
import { describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { releaseDay } from '../src/infra/release.ts'
import { KV } from '../src/kv.ts'
import { Merges, confirmationText, mergeTargetOf, mergeThread, parseReply, sqlFingerprint, type MergeHost,
  type SqlAction } from '../src/app/merge.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

const TODAY = `release/${releaseDay()}`
const YESTERDAY = 'release/20261101'
/** The work item the ticket came from, which names the serial the confirmation shows. */
const origin: Trigger = { id: 'yunxiao:123:0', source: 'yunxiao', threads: [{ source: 'yunxiao', id: 'wi:123' }],
  actor: { source: 'yunxiao', id: '62cf7f1d' }, human: true, addressed: 'mention', at: '2026-11-02T09:00:00Z', text: '',
  meta: { workitemId: '123', serial: 'AXOAXO-6812', category: 'Bug', projectId: 'proj-1' } }
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: '登录后偶发白屏', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, scope: 'proj-1',
    actor: { source: 'yunxiao', id: '62cf7f1d' } },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: origin.id, triggerIds: [origin.id] }, ...overrides,
})
/** The CLI answers one merge flow reads; a test changes the ones it is about. */
interface World {
  branches: string[]
  /** Commits the checked release holds that the base branch does not: zero means it merged back. */
  ahead: number
  checks: unknown[]
  comments: unknown[]
  change: Record<string, unknown>
  /** Per-local-id reports, for a ticket whose merge requests differ. */
  changes?: Record<number, Record<string, unknown>>
  /** The merge request whose merge fails, when the flow must stop partway. */
  mergeFailsFor?: number
  mergeError?: Error
  /** The name of the pipeline the organization reports, and the failures reading or starting one meets. */
  pipelineName?: string
  pipelineError?: Error
  runError?: Error
}
const world = (overrides: Partial<World> = {}): World => ({
  branches: ['master', YESTERDAY, TODAY], ahead: 3, checks: [{ name: 'build', state: 'SUCCESS' }], comments: [],
  change: { localId: 12, title: '修复登录后偶发白屏', sourceBranch: 'bugfix/261102-login-12', targetBranch: YESTERDAY,
    sourceCommitSha: 'e0c6a63b7d1f', state: 'OPEN', webUrl: 'https://codeup.aliyun.com/org-1/group/app/change/12',
    conflictStatus: 'NO_CONFLICT', additions: 35, deletions: 12 }, pipelineName: 'prod-axo-manager-x64', ...overrides })
/** The yunxiao CLI answers a merge flow asks for, by subcommand; a schema call gets the object, a raw call its JSON text. */
function answer(state: World, argv: readonly string[], parsed: boolean): unknown {
  const json = (value: unknown) => JSON.stringify(value)
  const localId = Number(argv[argv.indexOf('--local-id') + 1] ?? 0)
  switch (argv[1] ?? '') {
    case 'codeup-list-branches': { const names = state.branches.map(name => ({ name })); return parsed ? { result: names } : json(names) }
    case 'codeup-get-compare': return parsed ? { aheadBy: state.ahead } : json({ aheadBy: state.ahead })
    case 'codeup-get-change-request': return state.changes?.[localId] ?? state.change
    case 'codeup-list-change-request-ci-check-list': return { checkList: state.checks }
    case 'codeup-list-merge-request-comments': return { comments: state.comments }
    case 'codeup-merge-change-request':
      if (state.mergeError || state.mergeFailsFor === localId) throw state.mergeError ?? new CliError('The merge request has conflicts', 400)
      return ''
    case 'flow-get-pipeline': if (state.pipelineError) throw state.pipelineError; return { id: 'pipe-1', name: state.pipelineName }
    case 'flow-create-pipeline-run': if (state.runError) throw state.runError; return ''
    default: return ''
  }
}
/** The argv of one `aliyun` call, whichever overload made it. */
const argvOf = (call: readonly unknown[]): readonly string[] =>
  (Array.isArray(call[0]) ? call[0] : call[1] ?? []) as readonly string[]
/** One merge flow over an in-memory record, with the CLI and Feishu answers it makes. */
function flow(options: { world?: World; approver?: string } = {}) {
  const state = options.world ?? world()
  const deployment = testDeployment({ github: undefined, codeup: testCodeup() })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const reply = (first: unknown, second: unknown) =>
    answer(state, (Array.isArray(first) ? first : second ?? []) as readonly string[], !Array.isArray(first))
  const aliyun = vi.spyOn(commands, 'aliyun').mockImplementation(((...args: unknown[]) =>
    Promise.resolve(reply(args[0], args[1]))) as never)
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ message_id: 'om_confirm' })
  const kv = new Map<string, unknown>()
  const tickets = new Map<string, Ticket>([[ticket().id, ticket()]])
  const triggers = new Map<string, Trigger>([[origin.id, origin]])
  const store = {
    tickets: { get: (id: string) => tickets.get(id) },
    triggers: { get: (id: string) => triggers.get(id) },
    atomic: <T>(work: () => T): T => work(),
    get: <V>(name: string) => kv.get(name) as V | undefined,
    set: <V>(name: string, value: V) => { kv.set(name, value) },
    keys: (family: string | { prefix: string }) =>
      [...kv.keys()].filter(name => name.startsWith(typeof family === 'string' ? family : family.prefix)),
  } as unknown as MergeHost['store']
  const sent: OutboundMessage[] = []
  const notes: string[] = []
  let approver = options.approver ?? 'ou_approver'
  const merges = new Merges({ commands, store, outbox: { send: message => { sent.push(message) } },
    note: (_ticketId, text) => { notes.push(text) }, approver: () => approver })
  return { state, commands, aliyun, lark, kv, store, sent, notes, merges, tickets,
    setApprover: (value: string) => { approver = value }, ticket: tickets.get('t1')! }
}
/** The reply the approver sends to the confirmation message. */
const approval = (text: string, overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'feishu:om_reply', source: 'feishu', threads: [{ source: 'feishu', id: 'feishu:oc_dm:om_reply' }],
  actor: { source: 'feishu', id: 'ou_approver' }, human: true, addressed: 'direct', at: '2026-11-02T10:05:00Z', text,
  channel: feishuChannel('oc_dm', 'om_reply', true),
  meta: { chatId: 'oc_dm', messageId: 'om_reply', direct: true, parentId: 'om_confirm', approval: true }, ...overrides })

describe('the confirmation message', () => {
  it('names the work item, every merge request with its evidence, and how to answer', () => {
    const text = confirmationText({ serial: 'AXOAXO-6812', title: '登录后偶发白屏', changes: [{ repository: 'group/app', number: 12,
      url: 'https://codeup.aliyun.com/org-1/group/app/change/12', title: '修复登录后偶发白屏', target: YESTERDAY, basis: 'previous',
      additions: 35, deletions: 12, ci: 'passed', commit: 'e0c6a63b7d1f' }] })
    expect(text).toBe(['【合并确认】 AXOAXO-6812 登录后偶发白屏', '',
      '- group/app !12：https://codeup.aliyun.com/org-1/group/app/change/12',
      '  目标 release/20261101（前一日 release 尚未合回 master）；改动 +35 −12 行；CI 通过；commit e0c6a63b',
      '  摘要：修复登录后偶发白屏', '',
      '请直接回复本条消息：同意 / 改 <日期，如 20261102> / 写原因驳回。'].join('\n'))
    // One ticket's merge requests share one message, and a report without line counts or CI leaves those out.
    const two = confirmationText({ title: 'two', changes: [
      { repository: 'group/app', number: 1, url: 'u1', title: 'a', target: TODAY, basis: 'today', ci: 'none', commit: 'aaaa1111' },
      { repository: 'group/lib', number: 2, url: 'u2', title: 'b', target: TODAY, basis: 'today-created', ci: 'none', commit: 'bbbb2222' }] })
    expect(two).toContain('目标 release/' + TODAY.slice('release/'.length) + '（前一日 release 已合回 master，投当日 release）；无 CI 检查；commit aaaa1111')
    expect(two).toContain('- group/lib !2：u2')
    expect(two).not.toContain('改动')
  })
})

describe('the approver\'s reply', () => {
  it('reads approval, a retarget, or a rejection with the words to hand to the worker', () => {
    for (const text of ['同意', ' 同意。', '合', 'ok', 'OK']) expect(parseReply(text)).toEqual({ kind: 'approve' })
    expect(parseReply('改 20261102')).toEqual({ kind: 'retarget', release: 'release/20261102' })
    expect(parseReply('改 release/20261102')).toEqual({ kind: 'retarget', release: 'release/20261102' })
    // Anything else is a rejection, and its words are the review feedback.
    expect(parseReply('这里会把空指针吞掉，重写')).toEqual({ kind: 'reject', reason: '这里会把空指针吞掉，重写' })
  })
})

describe('asking to merge', () => {
  it('checks the merge request, asks the approver in a direct message, and records what the answer is about', async () => {
    const { merges, lark, kv, ticket } = flow()
    expect(await merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'requested' })
    const create = lark.mock.calls[0]![0] as string[]
    expect(create.slice(0, 6)).toEqual(['im', '+messages-create', '--receive-id', 'ou_approver', '--receive-id-type', 'open_id'])
    expect(create).toContain('--idempotency-key')
    const text = create[create.indexOf('--markdown') + 1]!
    expect(text).toContain('【合并确认】 AXOAXO-6812 登录后偶发白屏')
    // The previous release has not merged back, so the rule still delivers to it.
    expect(text).toContain('目标 ' + YESTERDAY + '（前一日 release 尚未合回 master）')
    // The record is keyed by the merge request's Thread and by the message the reply will name.
    expect(kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toEqual({ state: 'waiting', messageId: 'om_confirm',
      commit: 'e0c6a63b7d1f', target: YESTERDAY })
    expect(kv.get(KV.merge.message('om_confirm'))).toEqual({ thread: 'yunxiao:mr:repo-1:12', ticketId: ticket.id,
      at: expect.any(String), kind: 'merge' })
  })
  it('asks once while a confirmation waits', async () => {
    const { merges, lark } = flow()
    await merges.request('t1', [{ repository: 'repo-1', localId: 12 }])
    expect(await merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'already' })
    expect(lark).toHaveBeenCalledTimes(1)
  })
  it('names the condition a merge request does not meet, and asks nothing', async () => {
    const closed = flow({ world: world({ change: { ...world().change, state: 'MERGED' } }) })
    expect(await closed.merges.request('t1', [{ repository: 'repo-1', localId: 12 }]))
      .toEqual({ status: 'not-ready', message: 'group/app !12 is merged, so it cannot be merged' })
    const conflicted = flow({ world: world({ change: { ...world().change, conflictStatus: 'CONFLICTED' } }) })
    expect(await conflicted.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'not-ready',
      message: expect.stringContaining('conflicts') })
    const failing = flow({ world: world({ checks: [{ name: 'build', state: 'FAILED' }] }) })
    expect(await failing.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'not-ready',
      message: expect.stringContaining('failed CI') })
    const reviewed = flow({ world: world({ comments: [{ content: '这里会把空指针吞掉' }] }) })
    expect(await reviewed.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'not-ready',
      message: expect.stringContaining('1 unresolved review comment') })
    for (const run of [closed, conflicted, failing, reviewed]) expect(run.lark).not.toHaveBeenCalled()
    // The agent's own reports are not someone's review, and a resolved comment asks for nothing.
    const quiet = flow({ world: world({ comments: [{ content: '<!-- dsh-superagent:agent -->\n由智能体代发' }, { content: '已改', resolved: true }] }) })
    expect(await quiet.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'requested' })
  })
  it('answers for a ticket that is not open, and for a request that names no merge request', async () => {
    const run = flow()
    run.tickets.set('t1', { ...run.ticket, ended: { at: '2026-11-02T09:30:00Z', by: 'executor', outcome: 'completed' } })
    expect(await run.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'unknown' })
    expect(await run.merges.request('t-missing', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'unknown' })
    expect(await flow().merges.request('t1', [])).toMatchObject({ status: 'not-ready' })
  })
  it('reports a missing approver instead of asking anyone', async () => {
    const { merges, lark, setApprover } = flow()
    setApprover('')
    expect(await merges.request('t1', [{ repository: 'repo-1', localId: 12 }])).toMatchObject({ status: 'unconfigured' })
    expect(lark).not.toHaveBeenCalled()
  })
})

describe('merging on the approver\'s answer', () => {
  const confirmed = async (options: Parameters<typeof flow>[0] = {}) => {
    const run = flow(options)
    await run.merges.request('t1', [{ repository: 'repo-1', localId: 12 }])
    return run
  }
  it('merges the confirmed commit and tells the worker to carry on', async () => {
    const run = await confirmed()
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    const merge = run.aliyun.mock.calls.map(argvOf).find(argv => argv[1] === 'codeup-merge-change-request')
    expect(merge).toEqual(['devops', 'codeup-merge-change-request', '--organization-id', 'org-1', '--repository-id', 'repo-1', '--local-id', '12'])
    expect(run.kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toMatchObject({ state: 'merged', confirmedAt: expect.any(String) })
    expect(run.notes).toEqual(['【合并结果】已合并 group/app !12。请继续 PRE 部署与验证。'])
    expect(run.sent[0]!.text).toBe('已合并 group/app !12，已通知 worker 继续。')
  })
  it('keeps the approval when the merge fails, stops there, and names why to the worker', async () => {
    const run = await confirmed({ world: world({ mergeError: new CliError('The merge request has conflicts', 400) }) })
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    expect(run.kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toMatchObject({ state: 'confirmed' })
    expect(run.notes[0]).toContain('【合并结果】group/app !12 未能合并：The merge request has conflicts')
    expect(run.sent[0]!.text).toContain('未能合并')
  })
  it('refuses a commit the approver did not see, and a release that has merged back', async () => {
    // The approver confirmed e0c6a63b; a later push makes that confirmation stale.
    const moved = await confirmed()
    moved.state.change = { ...moved.state.change, sourceCommitSha: 'ffff9999' }
    await moved.merges.onTrigger(approval('同意'))
    expect(moved.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'codeup-merge-change-request')).toBe(false)
    expect(moved.notes[0]).toContain('its latest commit ffff9999 is not the confirmed e0c6a63b')
    // The release merged back while the confirmation waited, so delivering to it would be late.
    const late = await confirmed()
    late.state.ahead = 0
    await late.merges.onTrigger(approval('同意'))
    expect(late.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'codeup-merge-change-request')).toBe(false)
    expect(late.notes[0]).toContain('has merged back into the base branch')
  })
  it('moves the delivery to the release the approver names', async () => {
    const run = await confirmed()
    expect(await run.merges.onTrigger(approval('改 20261102'))).toBe(true)
    expect(run.kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toMatchObject({ state: 'retarget', target: 'release/20261102' })
    expect(run.notes[0]).toContain('审批人要求改投 release/20261102')
    expect(run.notes[0]).toContain('group/app !12')
    expect(run.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'codeup-merge-change-request')).toBe(false)
  })
  it('hands a rejection\'s words to the worker', async () => {
    const run = await confirmed()
    expect(await run.merges.onTrigger(approval('这里会把空指针吞掉，重写'))).toBe(true)
    expect(run.kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toMatchObject({ state: 'rejected' })
    expect(run.notes[0]).toBe('【合并结果】审批人驳回了 group/app !12：这里会把空指针吞掉，重写。请按这条意见修改后重新申请合并。')
  })
  it('merges nothing for a reply from someone else, or for a message that is no confirmation', async () => {
    const run = await confirmed()
    expect(await run.merges.onTrigger(approval('同意', { actor: { source: 'feishu', id: 'ou_someone' } }))).toBe(true)
    expect(run.kv.get(KV.merge.mr('yunxiao:mr:repo-1:12'))).toMatchObject({ state: 'waiting' })
    expect(run.sent[0]!.text).toBe('只有配置的审批人可以确认这条请求。')
    // A trigger the Feishu Source did not mark as an answer to a confirmation is none of this module's business.
    expect(await run.merges.onTrigger(approval('同意', { meta: { chatId: 'oc_dm', messageId: 'om_reply' } }))).toBe(false)
    expect(await run.merges.onTrigger(approval('同意', { meta: { approval: true, parentId: 'om_other' } }))).toBe(false)
  })
  it('merges one at a time, stopping at the first failure and leaving the rest waiting', async () => {
    const state = world({ mergeFailsFor: 13, changes: {
      12: { ...world().change, localId: 12, sourceCommitSha: 'aaaa1111' },
      13: { ...world().change, localId: 13, sourceCommitSha: 'bbbb2222' },
      14: { ...world().change, localId: 14, sourceCommitSha: 'cccc3333' },
    } })
    const run = flow({ world: state })
    await run.merges.request('t1', [{ repository: 'repo-1', localId: 12 }, { repository: 'repo-1', localId: 13 }, { repository: 'repo-1', localId: 14 }])
    await run.merges.onTrigger(approval('同意'))
    // The first merged, the second failed, and the third was never reached: it still waits on this confirmation.
    expect(run.kv.get(KV.merge.mr(mergeThread('repo-1', 12)))).toMatchObject({ state: 'merged' })
    expect(run.kv.get(KV.merge.mr(mergeThread('repo-1', 13)))).toMatchObject({ state: 'confirmed' })
    expect(run.kv.get(KV.merge.mr(mergeThread('repo-1', 14)))).toMatchObject({ state: 'waiting' })
    expect(run.notes[0]).toContain('group/app !13 未能合并：The merge request has conflicts')
    expect(run.notes[0]).toContain('已合并 group/app !12')
    expect(run.aliyun.mock.calls.map(argvOf).filter(argv => argv[1] === 'codeup-merge-change-request')).toHaveLength(2)
  })
  it('tells the approver when the ticket ended before the answer came', async () => {
    const run = await confirmed()
    run.tickets.set('t1', { ...run.ticket, ended: { at: '2026-11-02T10:00:00Z', by: 'executor', outcome: 'completed' } })
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    expect(run.sent[0]!.text).toBe('这条确认对应的工单已结束，不再处理。')
    expect(run.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'codeup-merge-change-request')).toBe(false)
  })
  it('merges once, however often the reply arrives', async () => {
    const run = await confirmed()
    await run.merges.onTrigger(approval('同意'))
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    expect(run.aliyun.mock.calls.map(argvOf).filter(argv => argv[1] === 'codeup-merge-change-request')).toHaveLength(1)
    expect(run.sent.at(-1)!.text).toBe('这条确认已经处理过了。')
  })
})

describe('asking to run a pipeline', () => {
  it('asks the approver to confirm a pipeline the worker may not start itself', async () => {
    const run = flow()
    expect(await run.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'requested' })
    const create = run.lark.mock.calls[0]![0] as string[]
    expect(create.slice(0, 6)).toEqual(['im', '+messages-create', '--receive-id', 'ou_approver', '--receive-id-type', 'open_id'])
    const text = create[create.indexOf('--markdown') + 1]!
    expect(text).toContain('【流水线确认】 AXOAXO-6812 登录后偶发白屏')
    expect(text).toContain('流水线：prod-axo-manager-x64（id pipe-1）')
    expect(text).toContain('请直接回复本条消息')
    // The record is keyed by the message and names the pipeline, which is what a reply starts.
    expect(run.kv.get(KV.merge.message('om_confirm'))).toEqual({ thread: '', ticketId: 't1', at: expect.any(String),
      kind: 'pipeline', pipeline: { id: 'pipe-1', name: 'prod-axo-manager-x64' } })
  })
  it('leaves the qa- and pre- pipelines to the worker', async () => {
    for (const pipelineName of ['qa-axo-manager-x64', 'pre-axo-manager-x64', 'PRE-axo-manager']) {
      const run = flow({ world: world({ pipelineName }) })
      expect(await run.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'not-ready' })
      expect(run.lark).not.toHaveBeenCalled()
    }
  })
  it('reports a pipeline it cannot read, and a deployment with no approver', async () => {
    const unreadable = flow({ world: world({ pipelineError: new CliError('pipeline not found', 404) }) })
    expect(await unreadable.merges.requestPipeline('t1', 'nope')).toMatchObject({ status: 'unknown' })
    // A report without a name is a report we cannot act on.
    const unnamed = flow({ world: world({ pipelineName: '' }) })
    expect(await unnamed.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'unknown' })
    const run = flow()
    run.setApprover('')
    expect(await run.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'unconfigured' })
    expect(run.lark).not.toHaveBeenCalled()
  })
  it('asks once while the pipeline waits, and again once the answer came', async () => {
    const run = flow()
    await run.merges.requestPipeline('t1', 'pipe-1')
    expect(await run.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'already' })
    expect(run.lark).toHaveBeenCalledTimes(1)
    await run.merges.onTrigger(approval('同意'))
    expect(await run.merges.requestPipeline('t1', 'pipe-1')).toMatchObject({ status: 'requested' })
    expect(run.lark).toHaveBeenCalledTimes(2)
  })
})

describe('starting a confirmed pipeline', () => {
  const asking = async (options: Parameters<typeof flow>[0] = {}) => {
    const run = flow(options)
    await run.merges.requestPipeline('t1', 'pipe-1')
    return run
  }
  it('starts the pipeline as the host, and tells the worker to watch it', async () => {
    const run = await asking()
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    const start = run.aliyun.mock.calls.map(argvOf).find(argv => argv[1] === 'flow-create-pipeline-run')
    expect(start).toEqual(['devops', 'flow-create-pipeline-run', '--organization-id', 'org-1', '--pipeline-id', 'pipe-1'])
    expect(run.notes[0]).toContain('【流水线】已启动 prod-axo-manager-x64（pipe-1）')
    expect(run.sent[0]!.text).toBe('已启动 prod-axo-manager-x64，已通知 worker。')
    // Answered: a repeated reply starts nothing twice.
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    expect(run.aliyun.mock.calls.map(argvOf).filter(argv => argv[1] === 'flow-create-pipeline-run')).toHaveLength(1)
    expect(run.sent.at(-1)!.text).toBe('这条确认已经处理过了。')
  })
  it('starts nothing when the approver refuses, and hands their words to the worker', async () => {
    const run = await asking()
    expect(await run.merges.onTrigger(approval('这条流水线会动生产，先别跑'))).toBe(true)
    expect(run.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'flow-create-pipeline-run')).toBe(false)
    expect(run.notes[0]).toBe('【流水线】审批人没有同意 prod-axo-manager-x64：这条流水线会动生产，先别跑。请不要启动这条流水线。')
  })
  it('reads a move to another release as a refusal, which a pipeline has no use for', async () => {
    const run = await asking()
    await run.merges.onTrigger(approval('改 20261102'))
    expect(run.aliyun.mock.calls.map(argvOf).some(argv => argv[1] === 'flow-create-pipeline-run')).toBe(false)
    expect(run.notes[0]).toContain('「改 20261102」——流水线没有可改的目标 release')
    expect(run.sent[0]!.text).toContain('已按驳回转给 worker')
  })
  it('keeps the confirmation pending when starting fails, so a later 同意 retries it', async () => {
    const run = await asking({ world: world({ runError: new CliError('quota exceeded', 400) }) })
    await run.merges.onTrigger(approval('同意'))
    expect(run.notes).toEqual([])
    expect(run.sent[0]!.text).toBe('prod-axo-manager-x64 启动失败：quota exceeded。请稍后回复「同意」重试。')
    expect(run.kv.get(KV.merge.message('om_confirm'))).toMatchObject({ pipeline: { id: 'pipe-1' } })
  })
})

/** A statement a worker asks to run against PRE, as the team's SQL action names it. */
const action = (overrides: Partial<SqlAction> = {}): SqlAction => ({
  title: '加索引', file: 'db/migrate/001_add_index.sql', database: 'axo_db',
  sql: 'ALTER TABLE orders ADD INDEX idx_tenant (tenant_id);', rollback: 'ALTER TABLE orders DROP INDEX idx_tenant;',
  check: 'SELECT COUNT(*) = 1 FROM information_schema.statistics WHERE index_name = \'idx_tenant\';', phase: 'before', ...overrides })

describe('asking to run statements against PRE', () => {
  it('asks the approver to confirm every statement in full', async () => {
    const run = flow()
    const first = action()
    const second = action({ title: '回填', file: 'db/migrate/002_backfill.sql', phase: 'after',
      sql: 'UPDATE orders SET tenant_id = 1 WHERE tenant_id IS NULL;', rollback: '',
      check: 'SELECT COUNT(*) = 0 FROM orders WHERE tenant_id IS NULL;' })
    expect(await run.merges.requestSql('t1', [first, second])).toMatchObject({ status: 'requested' })
    const args = run.lark.mock.calls[0]![0] as string[]
    const text = args[args.indexOf('--markdown') + 1]!
    expect(text).toContain('【SQL 确认】 AXOAXO-6812 登录后偶发白屏')
    expect(text).toContain('1. 加索引（部署前，目标库 axo_db，文件 db/migrate/001_add_index.sql）')
    expect(text).toContain(first.sql)
    expect(text).toContain(first.rollback)
    expect(text).toContain(first.check)
    expect(text).toContain('2. 回填（部署后，目标库 axo_db，文件 db/migrate/002_backfill.sql）')
    expect(text).toContain('请直接回复本条消息：同意')
    // A statement without a rollback writes no rollback section, rather than an empty one.
    expect(text).not.toContain('回滚 SQL：\n\n')
    // The record names each statement with the fingerprint its approval is bound to.
    expect(run.kv.get(KV.merge.message('om_confirm'))).toEqual({ thread: '', ticketId: 't1', at: expect.any(String),
      kind: 'sql', sql: [
        { title: '加索引', file: 'db/migrate/001_add_index.sql', database: 'axo_db', phase: 'before', fingerprint: sqlFingerprint(first) },
        { title: '回填', file: 'db/migrate/002_backfill.sql', database: 'axo_db', phase: 'after', fingerprint: sqlFingerprint(second) },
      ] })
  })
  it('refuses a statement that is not complete enough to decide on', async () => {
    const run = flow()
    for (const broken of [action({ sql: ' ' }), action({ file: '' }), action({ database: ' ' }), action({ check: '' }),
      action({ phase: 'during' as never })]) {
      expect(await run.merges.requestSql('t1', [broken])).toMatchObject({ status: 'unknown' })
    }
    run.setApprover('')
    expect(await run.merges.requestSql('t1', [action()])).toMatchObject({ status: 'unconfigured' })
    expect(run.lark).not.toHaveBeenCalled()
  })
  it('does not ask twice for a statement it approved, and asks again once the statement changed', async () => {
    const run = flow()
    const first = action()
    await run.merges.requestSql('t1', [first])
    await run.merges.onTrigger(approval('同意'))
    expect(await run.merges.requestSql('t1', [first])).toMatchObject({ status: 'already' })
    // A changed statement is a new decision, whatever the earlier approval said.
    expect(await run.merges.requestSql('t1', [{ ...first, sql: `${first.sql} -- 追加` }])).toMatchObject({ status: 'requested' })
  })
  it('asks once while the statements wait', async () => {
    const run = flow()
    const first = action()
    await run.merges.requestSql('t1', [first])
    expect(await run.merges.requestSql('t1', [first])).toMatchObject({ status: 'already' })
    expect(run.lark).toHaveBeenCalledTimes(1)
  })
  it('asks only for the statements that have no approval yet', async () => {
    const run = flow()
    const first = action()
    await run.merges.requestSql('t1', [first])
    await run.merges.onTrigger(approval('同意'))
    const second = action({ file: 'db/migrate/002.sql', sql: 'UPDATE t SET c = 1;', rollback: '', check: 'SELECT COUNT(*) = 1 FROM t;' })
    await run.merges.requestSql('t1', [first, second])
    const args = run.lark.mock.calls.at(-1)![0] as string[]
    const sent = args[args.indexOf('--markdown') + 1]!
    expect(sent).toContain('db/migrate/002.sql')
    expect(sent).not.toContain('db/migrate/001_add_index.sql')
  })
})

describe('running approved statements', () => {
  const asking = async (actions: readonly SqlAction[] = [action()]) => {
    const run = flow()
    await run.merges.requestSql('t1', actions)
    return run
  }
  it('records each approval and tells the worker how to execute it', async () => {
    const first = action()
    const second = action({ file: 'db/migrate/002.sql', phase: 'after', sql: 'UPDATE t SET c = 1;', rollback: '', check: 'SELECT COUNT(*) = 1 FROM t;' })
    const run = await asking([first, second])
    expect(await run.merges.onTrigger(approval('同意'))).toBe(true)
    expect(run.kv.get(KV.sql.approved(sqlFingerprint(first)))).toEqual({ ticketId: 't1', at: expect.any(String), database: 'axo_db' })
    expect(run.kv.get(KV.sql.approved(sqlFingerprint(second)))).toMatchObject({ database: 'axo_db' })
    expect(run.notes).toHaveLength(2)
    expect(run.notes[0]).toBe('【SQL】已批准 db/migrate/001_add_index.sql（axo_db，部署前）：'
      + `执行前核对文件内容与批准时一致（指纹 ${sqlFingerprint(first)}）；同一目标只执行一次；结果不明时不要重试。`)
    expect(run.sent[0]!.text).toBe('已批准 2 条 SQL，已通知 worker 按指纹执行。')
    // A repeated reply approves nothing twice.
    await run.merges.onTrigger(approval('同意'))
    expect(run.notes).toHaveLength(2)
    expect(run.sent.at(-1)!.text).toBe('这条确认已经处理过了。')
  })
  it('keeps the statements unapproved when the approver refuses', async () => {
    const first = action()
    const run = await asking([first])
    expect(await run.merges.onTrigger(approval('这个索引会锁表，先别加'))).toBe(true)
    expect(run.kv.get(KV.sql.approved(sqlFingerprint(first)))).toBeUndefined()
    expect(run.notes[0]).toBe('【SQL】审批人驳回了 db/migrate/001_add_index.sql：这个索引会锁表，先别加。请不要执行这些 SQL。')
  })
  it('reads a move to another release as a refusal, which SQL has no use for', async () => {
    const first = action()
    const run = await asking([first])
    await run.merges.onTrigger(approval('改 20261102'))
    expect(run.kv.get(KV.sql.approved(sqlFingerprint(first)))).toBeUndefined()
    expect(run.notes[0]).toContain('「改 20261102」——SQL 没有可改的目标 release')
    expect(run.sent[0]!.text).toContain('已按驳回转给 worker')
  })
})

describe('the release a delivery targets', () => {
  it('says whether the rule now names another release', async () => {
    const mergedBack = flow({ world: world({ ahead: 0 }) })
    expect(await mergedBack.merges.releaseMergedBack('repo-1', YESTERDAY)).toBe(true)
    const stillOpen = flow({ world: world({ ahead: 3 }) })
    expect(await stillOpen.merges.releaseMergedBack('repo-1', YESTERDAY)).toBe(false)
    expect(mergeTargetOf('yunxiao:mr:repo-1:12')).toEqual({ repository: 'repo-1', localId: 12 })
    expect(mergeTargetOf('yunxiao:wi:123')).toBeUndefined()
  })
})
