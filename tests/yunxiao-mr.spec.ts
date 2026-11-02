/** The yunxiao merge-request poller: its Threads, the responses it reads, the Triggers and closes it reports, and its records. */
import { describe, expect, it, vi } from 'vitest'
import type { ThreadRef, Ticket, Trigger } from '../src/core/index.ts'
import { KV, type Family, type Key } from '../src/kv.ts'
import { CliError, type Commands } from '../src/infra/commands.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import type { MergeContext, MergeRound } from '../src/sources/yunxiao-mr.ts'
import { ciSummary, mergeChecksOf, mergeCommentsOf, mergeRequestChannel, mergeRequestOf, mergeRequestThread, mrChangeTrigger,
  mrCiTrigger, mrCommentTrigger, newMergeRound, parseMergeThread, pollMergeRequests } from '../src/sources/yunxiao-mr.ts'
import { YunxiaoFileSchema, type YunxiaoFile } from '../src/sources/yunxiao-config.ts'

/** The receiving rules a deployment writes; the merge-request poller reads the organization out of them. */
const file: YunxiaoFile = YunxiaoFileSchema.parse({ organization: 'org-1', workspace: '/tmp/workspace',
  projects: [{ id: 'proj-1', intake: 'triage', types: [{ category: 'Bug', receive: ['28'], started: '100010', verified: '29' }] }] })
/** The round start a test polls at, which the state-derived Triggers are stamped with. */
const STARTED = '2026-11-02T00:00:00.000Z'
/** Two commits a merge request's head may be at. */
const FIRST = '1111111111111111111111111111111111111111'
const SECOND = '2222222222222222222222222222222222222222'
const THREAD = 'yunxiao:mr:repo-1:12'

/** A merge request as `codeup-get-change-request` reports it, in the field names a real installation prints. */
const changeRequest = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ localId: 12, title: '修复登录失败',
  state: 'OPEN', sourceCommitSha: FIRST, targetBranch: 'release/20261102', conflictCheckStatus: 'PASSED',
  webUrl: 'https://codeup.aliyun.com/org-1/group/app/change/12', ...fields })
/** A comment as `codeup-list-merge-request-comments` reports it. */
const comment = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ commentBizId: 'c-1',
  content: '<p>这里要改</p>', author: { id: 'user-2' }, commentTime: '2026-11-02T01:00:00Z', ...fields })
const commentList = (...items: unknown[]): unknown => ({ comments: items })
/** One CI check as `codeup-list-change-request-ci-check-list` reports it. */
const check = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'build', status: 'SUCCESS', ...fields })
const checkList = (...items: unknown[]): unknown => ({ checkList: items })
/** The CLI's answers before a test routes a subcommand. */
const routes = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  'codeup-get-change-request': changeRequest(), 'codeup-list-merge-request-comments': commentList(),
  'codeup-list-change-request-ci-check-list': checkList(check()), ...overrides })
/** An open ticket following the Threads it names, each a change request's binding (`ends: false`). */
const ticket = (id: string, threads: readonly string[]): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'yunxiao', id: 'user-1' }, scope: 'proj-1' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  follows: threads.map(thread => ({ thread, own: true, ends: false })), origin: { triggerId: `origin-${id}`, triggerIds: [] } })

interface HostOptions {
  tickets?: Ticket[]
  /** Answers by the `devops` subcommand; a value that is an `Error` is thrown as the CLI's failure. */
  routes?: Record<string, unknown>
  /** Records the poller already wrote, by key. */
  state?: Record<string, unknown>
  signal?: AbortSignal
}
/**
 * A Source context for the merge-request poller: a scripted Codeup CLI, in-memory records, the open tickets whose follows name
 * the merge requests, and a `receive` that records what the poller hands the Engine, plus the closes it reports.
 */
function host(options: HostOptions = {}) {
  const answers = options.routes ?? routes()
  const records = new Map<string, unknown>(Object.entries(options.state ?? {}))
  const calls: string[][] = []
  const commands = {
    withSignal: () => commands,
    // Both `aliyun(argv)` and `aliyun(schema, argv)` land here; the poller uses the schema form to validate the JSON envelope.
    async aliyun(first: unknown, second?: readonly string[]): Promise<unknown> {
      const argv = (Array.isArray(first) ? first : second ?? []) as string[]
      calls.push([...argv])
      const answer = answers[argv[1] ?? '']
      const value = typeof answer === 'function' ? (answer as (argv: string[]) => unknown)(argv) : answer
      if (value instanceof Error) throw value
      return value ?? {}
    },
  }
  const closed: { thread: ThreadRef; outcome: string; at: string }[] = []
  const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
  const ctx = {
    commands: commands as unknown as Commands,
    state: {
      get: <V>(key: Key<V>): V | undefined => records.get(key) as V | undefined,
      set: <V>(key: Key<V>, value: V | undefined): void => { if (value === undefined) records.delete(key); else records.set(key, value) },
      keys: <V>(family: Family<V, never>): Key<V>[] => [...records.keys()].filter(key => key.startsWith(family.prefix)) as Key<V>[],
    },
    tickets: {
      get: (id: string) => options.tickets?.find(item => item.id === id),
      open: () => options.tickets ?? [],
      ended: () => [],
      bindThread: () => {},
      threadClosed: (thread: ThreadRef, outcome: 'merged' | 'closed', at: string) => { closed.push({ thread, outcome, at }) },
    },
    receive,
  } satisfies MergeContext
  const round: MergeRound = newMergeRound(STARTED, options.signal)
  return { ctx, round, calls, receive, closed, records,
    /** The Triggers handed to the Engine, in order. */
    triggers: () => receive.mock.calls.map(([trigger]) => trigger),
    record: () => records.get(KV.yunxiao.mr(THREAD)) as
      { head: string; fingerprint: string; commentAt: string; revision: number; gone?: true } | undefined }
}
/** The argument after `flag` of a command. */
const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1]!
/** The subcommands a round issued, in order. */
const issued = (calls: string[][]): string[] => calls.map(argv => argv[1] ?? '')

describe('merge request threads', () => {
  it('names the Thread codeupHosting.thread names, and reads it back', () => {
    expect(mergeRequestThread('2819384', 12)).toEqual({ source: 'yunxiao', id: 'mr:2819384:12' })
    expect(parseMergeThread('yunxiao:mr:2819384:12')).toEqual({ repositoryId: '2819384', localId: 12 })
    // The hosting contract and this module must name one Thread, so the round trip is what both sides rely on.
    expect(parseMergeThread(`yunxiao:${mergeRequestThread('2819384', 12).id}`)).toEqual({ repositoryId: '2819384', localId: 12 })
    // Another Source's or kind's Thread is not a merge request; Codeup numbers merge requests from one.
    expect(parseMergeThread('yunxiao:wi:wi-1')).toBeUndefined()
    expect(parseMergeThread('github:12')).toBeUndefined()
    expect(parseMergeThread('yunxiao:mr:repo-1:0')).toBeUndefined()
    expect(parseMergeThread('yunxiao:mr:repo-1:')).toBeUndefined()
  })
  it('addresses a reply to the repository and local id a write names, and to the comment it answers', () => {
    expect(mergeRequestChannel({ repositoryId: 'repo-1', localId: 12 }))
      .toEqual({ source: 'yunxiao', thread: THREAD, address: { repository: 'repo-1', localId: '12' } })
    expect(mergeRequestChannel({ repositoryId: 'repo-1', localId: 12 }, 'c-1').address)
      .toEqual({ repository: 'repo-1', localId: '12', parentComment: 'c-1' })
  })
})

describe('merge request responses', () => {
  it('reads the state, the commit and the conflict of a merge request, and unwraps the CLI envelope', () => {
    expect(mergeRequestOf(changeRequest(), { repositoryId: 'repo-1', localId: 12 })).toEqual({ state: 'open', head: FIRST,
      conflict: false, title: '修复登录失败', url: 'https://codeup.aliyun.com/org-1/group/app/change/12', target: 'release/20261102' })
    // A wrapped answer, the other spellings of the same fields, and a merge that names only its time.
    expect(mergeRequestOf({ result: { status: 'MERGED', sourceCommitHash: SECOND, mergedTime: '2026-11-02T02:00:00Z' } },
      { repositoryId: 'repo-1', localId: 12 })).toMatchObject({ state: 'merged', head: SECOND, endedAt: '2026-11-02T02:00:00.000Z' })
    expect(mergeRequestOf({ status: 'CLOSED', closedAt: '2026-11-02T03:00:00Z' }, { repositoryId: 'repo-1', localId: 12 }))
      .toMatchObject({ state: 'closed', endedAt: '2026-11-02T03:00:00.000Z' })
    // An unknown status reads as open, as Codeup adds states this build does not know; the conflict is what matters there.
    expect(mergeRequestOf(changeRequest({ state: 'UNDER_REVIEW', conflictCheckStatus: 'FAILED' }), { repositoryId: 'repo-1', localId: 12 }))
      .toMatchObject({ state: 'open', conflict: true })
    expect(mergeRequestOf(changeRequest({ conflictCheckStatus: undefined, hasConflict: true }), { repositoryId: 'repo-1', localId: 12 }).conflict).toBe(true)
  })
  it('raises a readable error when a merge request names no state or no commit to compare', () => {
    // Without a state the poller cannot tell an open merge request from a closed one, so it must not guess.
    expect(() => mergeRequestOf({ title: 'x' }, { repositoryId: 'repo-1', localId: 12 }))
      .toThrow('The yunxiao merge request 12 in repo-1 names no state; the CLI response shape may have changed')
    // An open merge request without its commit could not report a new commit; a closed one needs no commit to close.
    expect(() => mergeRequestOf(changeRequest({ sourceCommitSha: undefined }), { repositoryId: 'repo-1', localId: 12 }))
      .toThrow('The yunxiao merge request 12 in repo-1 names no source commit; a new commit could not be told from the last one')
    expect(mergeRequestOf({ state: 'CLOSED' }, { repositoryId: 'repo-1', localId: 12 })).toMatchObject({ state: 'closed', head: '' })
    expect(() => mergeRequestOf('not json', { repositoryId: 'repo-1', localId: 12 })).toThrow('was not recognized')
  })
  it('reads the comments and the CI checks of a merge request, including a wrapped list', () => {
    expect(mergeCommentsOf({ result: { comments: [comment()] } })).toEqual([{ id: 'c-1', body: '这里要改', author: 'user-2', human: true,
      at: '2026-11-02T01:00:00.000Z', modifiedAt: '2026-11-02T01:00:00.000Z' }])
    // A comment this Source wrote carries the marker in its body, so it is never read as a person's request.
    expect(mergeCommentsOf(commentList(comment({ content: `已修复\n\n${AGENT_COMMENT}` })))[0]?.agent).toBe(true)
    // A bot account's comment stays a bot's, which the Policy never admits as a request.
    expect(mergeCommentsOf(commentList(comment({ author: { id: 'bot-1', type: 'BOT' } })))[0]?.human).toBe(false)
    expect(() => mergeCommentsOf(commentList({ content: 'x' }))).toThrow('A yunxiao merge request comment has no id')
    expect(mergeChecksOf(checkList(check(), check({ name: 'test', status: 'RUNNING', detailUrl: 'https://ci/1' })))).toEqual([
      { name: 'build', status: 'SUCCESS' }, { name: 'test', status: 'RUNNING', url: 'https://ci/1' }])
    expect(() => mergeChecksOf(checkList({ status: 'SUCCESS' }))).toThrow('has no name')
    expect(() => mergeChecksOf(checkList({ name: 'build' }))).toThrow('The yunxiao merge request CI check build has no status')
    expect(() => mergeChecksOf({ nothing: [] })).toThrow('was not recognized')
  })
})

describe('merge request triggers', () => {
  it('builds a comment Trigger from a person and drops the agent\'s own comment', () => {
    const ref = { repositoryId: 'repo-1', localId: 12 }
    const trigger = mrCommentTrigger(mergeCommentsOf(commentList(comment()))[0]!, ref)!
    expect(trigger).toMatchObject({ source: 'yunxiao', threads: [{ source: 'yunxiao', id: 'mr:repo-1:12' }],
      actor: { source: 'yunxiao', id: 'user-2' }, human: true, at: '2026-11-02T01:00:00.000Z', text: '这里要改',
      channel: { source: 'yunxiao', thread: THREAD, address: { repository: 'repo-1', localId: '12', parentComment: 'c-1' } },
      meta: { repository: 'repo-1', localId: 12, kind: 'mr-comment', commentId: 'c-1' } })
    // A follow-up on a merge request is never an explicit request, so it declares no `addressed`.
    expect(trigger).not.toHaveProperty('addressed')
    expect(mrCommentTrigger(mergeCommentsOf(commentList(comment({ content: AGENT_COMMENT })))[0]!, ref)).toBeUndefined()
    // An edited comment is a new Trigger, because its text changed.
    const edited = mergeCommentsOf(commentList(comment({ gmtModified: '2026-11-02T05:00:00Z' })))[0]!
    expect(mrCommentTrigger(edited, ref)!.id).not.toBe(trigger.id)
  })
  it('builds a change Trigger for a new commit and for a conflict, with the commit in its ID', () => {
    const ref = { repositoryId: 'repo-1', localId: 12 }
    const open = mergeRequestOf(changeRequest(), ref)
    const clean = mrChangeTrigger(ref, open, STARTED)
    expect(clean).toMatchObject({ source: 'yunxiao', human: false, actor: { source: 'yunxiao', id: '' }, at: STARTED,
      channel: { source: 'yunxiao', thread: THREAD, address: { repository: 'repo-1', localId: '12' } },
      meta: { repository: 'repo-1', localId: 12, kind: 'mr-change', head: FIRST, conflict: false, target: 'release/20261102' } })
    expect(clean.text).toBe(`Merge request !12 "修复登录失败" in repo-1 is at ${FIRST.slice(0, 7)}, targeting release/20261102.`)
    const conflicted = mrChangeTrigger(ref, { ...open, conflict: true }, STARTED)
    expect(conflicted.text).toContain('It conflicts with release/20261102')
    // The ID names the commit and the conflict, so the same state read twice is one piece of work.
    expect(mrChangeTrigger(ref, open, STARTED).id).toBe(clean.id)
    expect(mrChangeTrigger(ref, { ...open, head: SECOND }, STARTED).id).not.toBe(clean.id)
    expect(conflicted.id).not.toBe(clean.id)
  })
  it('summarizes CI results and gives each reported change its own revision', () => {
    const ref = { repositoryId: 'repo-1', localId: 12 }
    const open = mergeRequestOf(changeRequest(), ref)
    const failed = [{ name: 'build', status: 'FAIL' }, { name: 'test', status: 'SUCCESS' }]
    expect(ciSummary(failed, '!12 at 1111111')).toBe('CI failed 1/2 on !12 at 1111111: build\nRead codeup-list-change-request-ci-check-list for every check.')
    const read = '\nRead codeup-list-change-request-ci-check-list for every check.'
    expect(ciSummary([{ name: 'build', status: 'RUNNING' }], '!12 at 1111111')).toBe(`CI running 1/1 on !12 at 1111111: build${read}`)
    expect(ciSummary([{ name: 'build', status: 'SUCCESS' }], '!12 at 1111111')).toBe(`CI passed 1/1 on !12 at 1111111${read}`)
    expect(ciSummary([], '!12 at 1111111')).toBe('Merge request !12 at 1111111 has no CI checks yet.')
    const first = mrCiTrigger(ref, open, 0, failed, STARTED)
    expect(first).toMatchObject({ source: 'yunxiao', human: false, actor: { source: 'yunxiao', id: '' }, threads: [{ source: 'yunxiao', id: 'mr:repo-1:12' }] })
    expect(first.meta).toEqual({ repository: 'repo-1', localId: 12, kind: 'mr-ci', ci: true, revision: 0, head: FIRST })
    expect(mrCiTrigger(ref, open, 1, failed, STARTED).id).not.toBe(first.id)
  })
})

describe('merge request polling', () => {
  it('records where a merge request stands without reporting it, then reports a new commit once', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])] })
    await pollMergeRequests(h.ctx, file, h.round)
    // The first read is the baseline: the ticket opened the merge request and knows where it stands.
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.record()).toEqual({ head: FIRST, fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/), commentAt: '', revision: 0 })
    // The CI baseline is part of the same record, so the next round compares against this run.
    expect(issued(h.calls)).toEqual(['codeup-get-change-request', 'codeup-list-merge-request-comments', 'codeup-list-change-request-ci-check-list'])

    const moved = host({ tickets: [ticket('t-1', [THREAD])], state: Object.fromEntries(h.records),
      routes: routes({ 'codeup-get-change-request': changeRequest({ sourceCommitSha: SECOND }) }) })
    await pollMergeRequests(moved.ctx, file, moved.round)
    expect(moved.triggers()).toHaveLength(1)
    expect(moved.triggers()[0]).toMatchObject({ meta: { kind: 'mr-change', head: SECOND, conflict: false } })
    expect(moved.record()?.head).toBe(SECOND)
    // The same commit read again is not news.
    await pollMergeRequests(moved.ctx, file, moved.round)
    expect(moved.receive).toHaveBeenCalledOnce()
  })
  it('reports a conflict as news the first time it is read, and reads it as a duplicate while it stays', async () => {
    const conflicted = routes({ 'codeup-get-change-request': changeRequest({ conflictCheckStatus: 'FAILED' }) })
    const h = host({ tickets: [ticket('t-1', [THREAD])], routes: conflicted })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.triggers()).toHaveLength(1)
    expect(h.triggers()[0]).toMatchObject({ meta: { kind: 'mr-change', conflict: true } })
    const id = h.triggers()[0]!.id
    // The next round reads the same conflict: the ID is the commit and the conflict, so the Engine drops the repeat.
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.triggers()[1]!.id).toBe(id)
  })
  it('closes the Thread of a merged or a closed merge request and reads nothing else about it', async () => {
    const merged = host({ tickets: [ticket('t-1', [THREAD])],
      routes: routes({ 'codeup-get-change-request': changeRequest({ state: 'MERGED', mergedAt: '2026-11-02T02:00:00Z' }) }) })
    await pollMergeRequests(merged.ctx, file, merged.round)
    expect(merged.closed).toEqual([{ thread: { source: 'yunxiao', id: 'mr:repo-1:12' }, outcome: 'merged', at: '2026-11-02T02:00:00.000Z' }])
    expect(issued(merged.calls)).toEqual(['codeup-get-change-request'])
    expect(merged.receive).not.toHaveBeenCalled()
    // A close the response does not time is recorded at the round's start.
    const closed = host({ tickets: [ticket('t-1', [THREAD])], routes: routes({ 'codeup-get-change-request': { state: 'CLOSED' } }) })
    await pollMergeRequests(closed.ctx, file, closed.round)
    expect(closed.closed).toEqual([{ thread: { source: 'yunxiao', id: 'mr:repo-1:12' }, outcome: 'closed', at: STARTED }])
  })
  it('takes in the comments after the last read, skipping the agent\'s own, and advances the cursor', async () => {
    const listed = routes({ 'codeup-list-merge-request-comments': commentList(comment(),
      comment({ commentBizId: 'c-2', content: '同意', author: { id: 'user-3' }, commentTime: '2026-11-02T02:00:00Z' }),
      comment({ commentBizId: 'c-3', content: AGENT_COMMENT, commentTime: '2026-11-02T03:00:00Z' })) })
    const h = host({ tickets: [ticket('t-1', [THREAD])], routes: listed })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.triggers().map(trigger => trigger.meta.commentId)).toEqual(['c-1', 'c-2'])
    expect(h.record()?.commentAt).toBe('2026-11-02T03:00:00.000Z')
    // The next round reads the same comments and takes in none of them again.
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.receive).toHaveBeenCalledTimes(2)
  })
  it('reports a CI change after the baseline, one Trigger per reported run', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])] })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.record()?.revision).toBe(0)
    // The same checks against the same commit are the same run.
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.receive).not.toHaveBeenCalled()
    // A failing check is a new result, and its revision makes a distinct Trigger.
    const changed = host({ tickets: [ticket('t-1', [THREAD])], state: Object.fromEntries(h.records),
      routes: routes({ 'codeup-list-change-request-ci-check-list': checkList(check({ status: 'FAIL' })) }) })
    await pollMergeRequests(changed.ctx, file, changed.round)
    expect(changed.triggers()).toHaveLength(1)
    expect(changed.triggers()[0]).toMatchObject({ human: false, meta: { kind: 'mr-ci', revision: 1 } })
    expect(changed.triggers()[0]!.text).toContain('CI failed 1/1')
    expect(changed.record()?.revision).toBe(1)
    await pollMergeRequests(changed.ctx, file, changed.round)
    expect(changed.receive).toHaveBeenCalledOnce()
  })
  it('reads only the merge requests of open tickets, once each, and skips one whose close is recorded', async () => {
    const following = ticket('t-1', ['yunxiao:wi:wi-1', THREAD, THREAD])
    const other = ticket('t-2', [THREAD])
    const h = host({ tickets: [following, other] })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.calls.filter(argv => argv[1] === 'codeup-get-change-request')).toHaveLength(1)
    // A ticket that already recorded the close keeps the Thread to answer messages, but its close is read no more.
    const done: Ticket = { ...ticket('t-1', [THREAD]),
      follows: [{ thread: THREAD, own: true, ends: false, closed: { at: STARTED, outcome: 'merged' } }] }
    const closed = host({ tickets: [done] })
    await pollMergeRequests(closed.ctx, file, closed.round)
    expect(closed.calls).toEqual([])
    // An ended ticket is not polled at all.
    const ended = host({ tickets: [] })
    await pollMergeRequests(ended.ctx, file, ended.round)
    expect(ended.calls).toEqual([])
  })
  it('fails one merge request and one step without losing the other merge request or the records it read', async () => {
    const threads = ['yunxiao:mr:repo-1:12', 'yunxiao:mr:repo-2:13']
    const h = host({ tickets: [ticket('t-1', threads)], routes: routes({
      'codeup-get-change-request': (argv: string[]) => flag(argv, '--repository-id') === 'repo-1' ? new Error('StatusCode: 500') : changeRequest(),
      'codeup-list-merge-request-comments': () => new Error('StatusCode: 502'),
    }) })
    await pollMergeRequests(h.ctx, file, h.round)
    // The unreadable merge request is one failure; the other one is read, and its CI is recorded even though its comments failed.
    expect(h.round.failures).toHaveLength(2)
    expect(h.round.failures[0]).toContain('yunxiao:mr:repo-1:12')
    expect(h.round.failures[1]).toContain('yunxiao:mr:repo-2:13 comments: StatusCode: 502')
    const other = h.records.get(KV.yunxiao.mr('yunxiao:mr:repo-2:13')) as { commentAt: string; fingerprint: string }
    expect(other.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    // A failed comment read leaves the cursor where it was, so the next round reads the same comments.
    expect(other.commentAt).toBe('')
    expect(h.records.has(KV.yunxiao.mr('yunxiao:mr:repo-1:12'))).toBe(false)
  })
  it('stops following a merge request the account can no longer read, without failing the round', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])],
      routes: routes({ 'codeup-get-change-request': new CliError('The merge request does not exist', 404) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    // A deleted merge request closes its Thread once, as a closed change: the ticket itself goes on to its own report.
    expect(h.closed).toEqual([{ thread: { source: 'yunxiao', id: 'mr:repo-1:12' }, outcome: 'closed', at: STARTED }])
    expect(h.round.failures).toEqual([])
    expect(h.record()?.gone).toBe(true)
    // The record keeps later rounds from reading it again, even for a ticket that binds the Thread anew.
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.calls).toHaveLength(1)
    expect(h.closed).toHaveLength(1)
    // A 403 whose message says the account may not read the merge request is the same news.
    const denied = host({ tickets: [ticket('t-1', [THREAD])],
      routes: routes({ 'codeup-get-change-request': new CliError('您没有权限访问该资源', 403) }) })
    await pollMergeRequests(denied.ctx, file, denied.round)
    expect(denied.closed).toHaveLength(1)
    expect(denied.round.failures).toEqual([])
    // Another 403, and a 5xx, may pass on a later round: they stay failed reads that hold the Source's health.
    const refused = host({ tickets: [ticket('t-1', [THREAD])],
      routes: routes({ 'codeup-get-change-request': new CliError('The merge request is not ready', 403) }) })
    await pollMergeRequests(refused.ctx, file, refused.round)
    expect(refused.closed).toEqual([])
    expect(refused.round.failures).toHaveLength(1)
    const unavailable = host({ tickets: [ticket('t-1', [THREAD])],
      routes: routes({ 'codeup-get-change-request': new CliError('Service unavailable', 503) }) })
    await pollMergeRequests(unavailable.ctx, file, unavailable.round)
    expect(unavailable.closed).toEqual([])
    expect(unavailable.round.failures).toHaveLength(1)
  })
  it('stops a round that was aborted, recording no failure of its own', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = host({ tickets: [ticket('t-1', [THREAD])], signal: controller.signal })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.calls).toEqual([])
    expect(h.round.failures).toEqual([])
  })
})
