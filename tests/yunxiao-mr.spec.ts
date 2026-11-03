/** The yunxiao merge-request poller: its Threads, the responses it reads, the Triggers and closes it reports, and its records. */
import { describe, expect, it, vi } from 'vitest'
import type { ThreadRef, Ticket, Trigger } from '../src/core/index.ts'
import type { Deployment } from '../src/deployment.ts'
import { KV, type Family, type Key } from '../src/kv.ts'
import { CliError, type Commands } from '../src/infra/commands.ts'
import { releaseBranch, releaseDay, type TargetRelease } from '../src/infra/release.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import type { MergeContext, MergeRound } from '../src/sources/yunxiao-mr.ts'
import { ciSummary, latestPatchSet, mergeChecksOf, mergeCommentsOf, mergeRequestChannel, mergeRequestOf, mergeRequestThread, mrChangeTrigger,
  mrCiTrigger, mrCommentTrigger, mrRetargetTrigger, newMergeRound, parseMergeThread, pollMergeRequests, readMergeRequest } from '../src/sources/yunxiao-mr.ts'
import { YunxiaoFileSchema, type YunxiaoFile } from '../src/sources/yunxiao-config.ts'
import { testCodeup, testDeployment, testRepository } from './fixtures/deployment.ts'

/** The receiving rules a deployment writes; the merge-request poller reads the organization out of them. */
const file: YunxiaoFile = YunxiaoFileSchema.parse({ organization: 'org-1', workspace: '/tmp/workspace',
  projects: [{ id: 'proj-1', intake: 'triage', types: [{ category: 'Bug', receive: ['28'], started: '100010', verified: '29' }] }] })
/** The round start a test polls at, which the state-derived Triggers are stamped with. */
const STARTED = '2026-11-02T00:00:00.000Z'
/** Two commits a merge request's head may be at. */
const FIRST = '1111111111111111111111111111111111111111'
const SECOND = '2222222222222222222222222222222222222222'
const THREAD = 'yunxiao:mr:repo-1:12'

/**
 * A merge request as `codeup-get-change-request` reports it, in the field names a real installation prints: `webUrl` is the
 * repository's page, and the head commit is not there but in the patch sets.
 */
const changeRequest = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ localId: 12, title: '修复登录失败',
  status: 'UNDER_REVIEW', sourceBranch: 'bugfix/261102-login-AXOAXO-6812', targetBranch: 'master', conflictCheckStatus: 'NO_CONFLICT',
  author: { userId: 'user-1', id: 881811, name: 'yedou' }, detailUrl: 'https://codeup.aliyun.com/org-1/group/app/change/12',
  webUrl: 'https://codeup.aliyun.com/org-1/group/app', ...fields })
/** The patch sets of a merge request whose head is at `head`, as `codeup-list-change-request-patch-sets` reports them. */
const patchSets = (head = FIRST): unknown => [
  { patchSetBizId: 'ps-old', relatedMergeItemType: 'MERGE_SOURCE', commitId: 'f'.repeat(40), versionNo: 1 },
  { patchSetBizId: `ps-${head.slice(0, 4)}`, relatedMergeItemType: 'MERGE_SOURCE', commitId: head, versionNo: 2 },
  { patchSetBizId: 'ps-target', relatedMergeItemType: 'MERGE_TARGET', commitId: 'e'.repeat(40), versionNo: 3 }]
/** A comment as `codeup-list-merge-request-comments` reports it. */
const comment = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ commentBizId: 'c-1',
  content: '<p>这里要改</p>', author: { id: 'user-2' }, commentTime: '2026-11-02T01:00:00Z', ...fields })
const commentList = (...items: unknown[]): unknown => ({ comments: items })
/** One CI check as `codeup-list-change-request-ci-check-list` reports it. */
const check = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'build', status: 'SUCCESS', ...fields })
const checkList = (...items: unknown[]): unknown => ({ checkList: items })
/** The CLI's answers before a test routes a subcommand. */
const routes = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  'codeup-get-change-request': changeRequest(), 'codeup-list-change-request-patch-sets': patchSets(), 'codeup-list-merge-request-comments': commentList(),
  'codeup-list-change-request-ci-check-list': checkList(check()), ...overrides })
/** The Codeup account the release rule reads: the poller resolves a merge request's repository by its id or group path. */
const DEPLOYMENT: Deployment = testDeployment({ codeup: testCodeup({ organization: 'org-1',
  repositories: [testRepository({ id: 'repo-1', path: 'group/app' }), testRepository({ id: 'repo-2', path: 'group/app2', name: 'app2' })] }) })
/** An open ticket following the Threads it names, each a change request's binding (`ends: false`). */
const ticket = (id: string, threads: readonly string[]): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'yunxiao', id: 'user-1' }, scope: 'proj-1' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  follows: threads.map(thread => ({ thread, own: true, ends: false })), origin: { triggerId: `origin-${id}`, triggerIds: [] } })

interface HostOptions {
  triggers?: Record<string, Trigger>
  tickets?: Ticket[]
  /** Answers by the `devops` subcommand; a value that is an `Error` is thrown as the CLI's failure. */
  routes?: Record<string, unknown>
  /** Records the poller already wrote, by key. */
  state?: Record<string, unknown>
  deployment?: Deployment
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
    deployment: options.deployment ?? DEPLOYMENT,
    state: {
      get: <V>(key: Key<V>): V | undefined => records.get(key) as V | undefined,
      set: <V>(key: Key<V>, value: V | undefined): void => { if (value === undefined) records.delete(key); else records.set(key, value) },
      keys: <V>(family: Family<V, never>): Key<V>[] => [...records.keys()].filter(key => key.startsWith(family.prefix)) as Key<V>[],
    },
    triggers: { get: (id: string) => options.triggers?.[id], latest: () => undefined },
    tickets: {
      get: (id: string) => options.tickets?.find(item => item.id === id),
      open: () => (options.tickets ?? []).filter(ticket => !ticket.ended),
      ended: () => [],
      stop: () => {},
      bindThread: vi.fn((id: string, thread: ThreadRef, own: boolean, ends = true) => {
        const item = options.tickets?.find(ticket => ticket.id === id)
        if (item) (item.follows ??= []).push({ thread: `${thread.source}:${thread.id}`, own, ends })
      }),
      threadClosed: (thread: ThreadRef, outcome: 'merged' | 'closed', at: string) => {
        closed.push({ thread, outcome, at })
        for (const item of options.tickets ?? []) {
          const follow = item.follows?.find(follow => follow.thread === `${thread.source}:${thread.id}` && !follow.closed)
          if (follow) follow.closed = { outcome, at }
        }
      },
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
    expect(mergeRequestOf(changeRequest(), { repositoryId: 'repo-1', localId: 12 })).toEqual({ state: 'open', head: '', author: 'user-1',
      conflict: false, title: '修复登录失败', url: 'https://codeup.aliyun.com/org-1/group/app/change/12', target: 'master',
      source: 'bugfix/261102-login-AXOAXO-6812' })
    // A wrapped answer, the other spellings of the same fields, and a merge that names only its time.
    expect(mergeRequestOf({ result: { status: 'MERGED', sourceCommitHash: SECOND, mergedTime: '2026-11-02T02:00:00Z' } },
      { repositoryId: 'repo-1', localId: 12 })).toMatchObject({ state: 'merged', head: SECOND, endedAt: '2026-11-02T02:00:00.000Z' })
    expect(mergeRequestOf({ status: 'CLOSED', closedAt: '2026-11-02T03:00:00Z' }, { repositoryId: 'repo-1', localId: 12 }))
      .toMatchObject({ state: 'closed', endedAt: '2026-11-02T03:00:00.000Z' })
    // An unknown status reads as open, as Codeup adds states this build does not know; the conflict is what matters there.
    expect(mergeRequestOf(changeRequest({ state: 'UNDER_REVIEW', conflictCheckStatus: 'FAILED' }), { repositoryId: 'repo-1', localId: 12 }))
      .toMatchObject({ state: 'open', conflict: true })
    expect(mergeRequestOf(changeRequest({ conflictCheckStatus: undefined, hasConflict: true }), { repositoryId: 'repo-1', localId: 12 }).conflict).toBe(true)
    expect(mergeRequestOf(changeRequest({ conflictCheckStatus: 'HAS_CONFLICT' }), { repositoryId: 'repo-1', localId: 12 }).conflict).toBe(true)
  })
  it('reads the head commit and the CI patch set from the latest source patch set', async () => {
    expect(latestPatchSet(patchSets(SECOND))).toEqual({ id: 'ps-2222', commit: SECOND })
    expect(latestPatchSet([])).toBeUndefined()
    const calls: string[][] = []
    const cli = (sets: unknown) => ({ aliyun: async (_schema: unknown, argv: readonly string[]) => {
      calls.push([...argv])
      return argv[1] === 'codeup-get-change-request' ? changeRequest() : sets
    } }) as unknown as Commands
    expect(await readMergeRequest(cli(patchSets(SECOND)), 'org-1', { repositoryId: 'repo-1', localId: 12 }))
      .toMatchObject({ state: 'open', head: SECOND, patchSet: 'ps-2222' })
    expect(calls.map(argv => argv[1])).toEqual(['codeup-get-change-request', 'codeup-list-change-request-patch-sets'])
    // An open merge request without a source patch set could not report a new commit.
    await expect(readMergeRequest(cli([]), 'org-1', { repositoryId: 'repo-1', localId: 12 }))
      .rejects.toThrow('The yunxiao merge request 12 in repo-1 names no source commit; a new commit could not be told from the last one')
  })
  it('raises a readable error when a merge request names no state', () => {
    // Without a state the poller cannot tell an open merge request from a closed one, so it must not guess.
    expect(() => mergeRequestOf({ title: 'x' }, { repositoryId: 'repo-1', localId: 12 }))
      .toThrow('The yunxiao merge request 12 in repo-1 names no state; the CLI response shape may have changed')
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
    // Codeup's own report holds checks and commit statuses in snake_case lists, all of which count.
    expect(mergeChecksOf({ check_list: [check()], check_runs: null, commit_statuses: [check({ name: 'lint', status: 'FAIL' })] }))
      .toEqual([{ name: 'build', status: 'SUCCESS' }, { name: 'lint', status: 'FAIL' }])
    expect(mergeChecksOf({ check_list: [], commit_statuses: [], display_type: 'DEFAULT_PAGE_NO_RUN_RECORD' })).toEqual([])
  })
  it('reads Codeup\'s snake_case comments with the replies nested under them, by the account id of their author', () => {
    const reply = { comment_biz_id: 'c-2', content: '已改', author: { userId: 'user-1', id: 881811 }, comment_time: '2026-11-02T02:00:00+08:00' }
    expect(mergeCommentsOf([{ comment_biz_id: 'c-1', content: '这里要改', author: { userId: 'user-2', id: 881812 },
      comment_time: '2026-11-02T01:00:00+08:00', last_edit_time: '2026-11-02T01:30:00+08:00', child_comments_list: [reply] }]))
      .toEqual([{ id: 'c-1', body: '这里要改', author: 'user-2', human: true, at: '2026-11-01T17:00:00.000Z', modifiedAt: '2026-11-01T17:30:00.000Z' },
        { id: 'c-2', body: '已改', author: 'user-1', human: true, at: '2026-11-01T18:00:00.000Z', modifiedAt: '2026-11-01T18:00:00.000Z' }])
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
    const open = { ...mergeRequestOf(changeRequest(), ref), head: FIRST }
    const clean = mrChangeTrigger(ref, open, STARTED)
    expect(clean).toMatchObject({ source: 'yunxiao', human: false, actor: { source: 'yunxiao', id: '' }, at: STARTED,
      channel: { source: 'yunxiao', thread: THREAD, address: { repository: 'repo-1', localId: '12' } },
      meta: { repository: 'repo-1', localId: 12, kind: 'mr-change', head: FIRST, conflict: false, target: 'master' } })
    expect(clean.text).toBe(`Merge request !12 "修复登录失败" in repo-1 is at ${FIRST.slice(0, 7)}, targeting master.`)
    const conflicted = mrChangeTrigger(ref, { ...open, conflict: true }, STARTED)
    expect(conflicted.text).toContain('It conflicts with master')
    // The ID names the commit and the conflict, so the same state read twice is one piece of work.
    expect(mrChangeTrigger(ref, open, STARTED).id).toBe(clean.id)
    expect(mrChangeTrigger(ref, { ...open, head: SECOND }, STARTED).id).not.toBe(clean.id)
    expect(conflicted.id).not.toBe(clean.id)
  })
  it('summarizes CI results and gives each reported change its own revision', () => {
    const ref = { repositoryId: 'repo-1', localId: 12 }
    const open = { ...mergeRequestOf(changeRequest(), ref), head: FIRST }
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
    expect(issued(h.calls)).toEqual(['codeup-get-change-request', 'codeup-list-change-request-patch-sets', 'codeup-list-merge-request-comments',
      'codeup-list-change-request-ci-check-list'])
    // The checks are read for the latest source patch set, which names the head.
    expect(flag(h.calls[3]!, '--patch-set-biz-id')).toBe('ps-1111')

    const moved = host({ tickets: [ticket('t-1', [THREAD])], state: Object.fromEntries(h.records),
      routes: routes({ 'codeup-list-change-request-patch-sets': patchSets(SECOND) }) })
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

describe('merge request re-targeting', () => {
  /** The release day the rule computes right now, the branch it names, and the release before it a delivery may still target. */
  const DAY = releaseDay()
  const TODAY = releaseBranch(DAY)
  const PREVIOUS = releaseBranch(releaseDay(new Date(Date.now() - 24 * 3600_000)))
  /** The merge request report of whichever local id a command names, so one repository's merge requests are scripted apart. */
  const byLocalId = (fields: Record<string, unknown> = {}) => (argv: string[]): unknown =>
    changeRequest({ localId: Number(flag(argv, '--local-id')), ...fields })
  /**
   * The CLI's answers for a repository that delivers to the day's release: its branches are the previous release and the day's,
   * and the previous one has merged back into the trunk, which is what makes the day's release the target.
   */
  const released = (overrides: Record<string, unknown> = {}): Record<string, unknown> => routes({
    'codeup-list-branches': JSON.stringify([PREVIOUS, TODAY]),
    'codeup-get-compare': JSON.stringify({ aheadBy: 0 }),
    'codeup-list-change-requests': JSON.stringify({ result: [{ targetBranch: PREVIOUS }] }), ...overrides })
  /** The release an approver names instead of the rule's, which the rule itself never computes. */
  const APPROVED = 'release/20991231'
  /** The record merge.ts writes when the approver moves a ticket's delivery: the release decision, on the merge request it was made about. */
  const retargeted = (target: string): Record<string, unknown> => ({ [KV.merge.mr(THREAD)]: { state: 'retarget', commit: FIRST, target } })

  it('tells the ticket to move a merge request whose release has merged back to the day\'s release', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])],
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    const moves = h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ source: 'yunxiao', human: false, at: STARTED,
      threads: [{ source: 'yunxiao', id: 'mr:repo-1:12' }],
      channel: { source: 'yunxiao', thread: THREAD, address: { repository: 'repo-1', localId: '12' } },
      meta: { mrChange: 'retarget', repository: 'repo-1', localId: 12, from: PREVIOUS, to: TODAY } })
    // The text says why, and what the worker must do: the move is its work, not an approval state.
    expect(moves[0]!.text).toContain(`${PREVIOUS} has merged back into master`)
    expect(moves[0]!.text).toContain(`create bugfix/261102-login-AXOAXO-6812-to-release-${DAY}`)
    expect(moves[0]!.text).toContain('open a new merge request to ' + TODAY)
    expect(moves[0]!.text).toContain('close !12, then ask to merge again')
  })
  it('leaves a merge request alone while it targets the release the rule computes', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])],
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: TODAY }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget')).toEqual([])
    expect(h.round.failures).toEqual([])
  })
  it('does not compute a release target for a merge request that delivers to the trunk', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])] })
    await pollMergeRequests(h.ctx, file, h.round)
    // The default report targets master, which is no release branch: the release rule is not asked at all.
    expect(h.triggers()).toEqual([])
    expect(issued(h.calls)).not.toContain('codeup-list-branches')
  })
  it('hands the same move as the same Trigger, and a move to another release as a new one', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])],
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    await pollMergeRequests(h.ctx, file, h.round)
    const ids = h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget').map(trigger => trigger.id)
    // The ID names the merge request and the release to move to, so the second round is the Trigger the Engine drops.
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    const ref = { repositoryId: 'repo-1', localId: 12 }
    const change = { ...mergeRequestOf(changeRequest({ targetBranch: PREVIOUS }), ref), head: FIRST }
    const target: TargetRelease = { target: TODAY, basis: 'today', mergedBack: true, base: 'master', previous: PREVIOUS }
    expect(mrRetargetTrigger(ref, change, { ...target, target: releaseBranch('20260101') }, DAY, STARTED).id)
      .not.toBe(mrRetargetTrigger(ref, change, target, DAY, STARTED).id)
  })
  it('computes a repository\'s release target once for the merge requests that share it', async () => {
    const threads = ['yunxiao:mr:repo-1:12', 'yunxiao:mr:repo-1:13']
    const h = host({ tickets: [ticket('t-1', threads)],
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(issued(h.calls).filter(name => name === 'codeup-list-branches')).toHaveLength(1)
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget').map(trigger => trigger.meta.localId)).toEqual([12, 13])
  })
  it('stops asking about a merge request the approver already moved to another release', async () => {
    const h = host({ tickets: [ticket('t-1', [THREAD])], state: retargeted(APPROVED),
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    // The approver's release wins over the rule, so the merge request waiting to be replaced is not asked again.
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget')).toEqual([])
    // The decision is read before the rule runs, so the release rule is not even asked.
    expect(issued(h.calls)).not.toContain('codeup-list-branches')
  })
  it('leaves the replacement merge request to the release the approver named', async () => {
    const REPLACEMENT = 'yunxiao:mr:repo-1:15'
    const h = host({ tickets: [ticket('t-1', [THREAD, REPLACEMENT])], state: retargeted(APPROVED),
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: APPROVED }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    // The new merge request targets the approver's release, which the rule would have moved back to the day's release.
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget')).toEqual([])
    expect(issued(h.calls)).not.toContain('codeup-list-branches')
    // Both merge requests were still read.
    expect(h.calls.filter(argv => argv[1] === 'codeup-get-change-request')).toHaveLength(2)
  })
  it('skips a superseded merge request without inheriting its expired release for the replacement', async () => {
    const REPLACEMENT = 'yunxiao:mr:repo-1:15'
    const h = host({ tickets: [ticket('t-1', [THREAD, REPLACEMENT])],
      state: { [KV.merge.mr(THREAD)]: { state: 'replaced', commit: FIRST, target: APPROVED } },
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget').map(trigger => trigger.meta.localId)).toEqual([15])
  })
  it('still moves a merge request whose ticket the approver has not decided about', async () => {
    // One ticket's delivery was moved by the approver; another ticket's was not, in the same repository.
    const OTHER = 'yunxiao:mr:repo-1:16'
    const h = host({ tickets: [ticket('t-1', [THREAD]), ticket('t-2', [OTHER])], state: retargeted(APPROVED),
      routes: released({ 'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget').map(trigger => trigger.meta.localId)).toEqual([16])
  })
  it('never creates the day\'s release while polling, even when it is missing', async () => {
    // The branch list holds only the previous release, so the rule computes the day's release without cutting it.
    const h = host({ tickets: [ticket('t-1', [THREAD])], routes: released({
      'codeup-list-branches': JSON.stringify([PREVIOUS]),
      'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }) }) })
    await pollMergeRequests(h.ctx, file, h.round)
    const moves = h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget')
    expect(moves).toHaveLength(1)
    expect(moves[0]!.meta).toMatchObject({ from: PREVIOUS, to: TODAY })
    // A poll is a read: the branch the merge needs is created by the merge, never here.
    expect(issued(h.calls)).not.toContain('codeup-create-branch')
  })
  it('records a release target that could not be computed once, and reads the other merge requests anyway', async () => {
    const threads = ['yunxiao:mr:repo-1:12', 'yunxiao:mr:repo-1:13', 'yunxiao:mr:repo-2:14']
    const h = host({ tickets: [ticket('t-1', threads)], routes: released({
      'codeup-get-change-request': byLocalId({ targetBranch: PREVIOUS }),
      'codeup-list-branches': (argv: string[]) => flag(argv, '--repository-id') === 'repo-1'
        ? new Error('StatusCode: 500') : JSON.stringify([PREVIOUS, TODAY]),
    }) })
    await pollMergeRequests(h.ctx, file, h.round)
    // Both merge requests of the repository share one failed computation, so the round reports it once.
    expect(h.round.failures).toHaveLength(1)
    expect(h.round.failures[0]).toContain('repo-1 release target: StatusCode: 500')
    // The rest of those merge requests' steps still ran, and the other repository is computed and moved as usual.
    expect(h.records.has(KV.yunxiao.mr('yunxiao:mr:repo-1:12'))).toBe(true)
    expect(h.triggers().filter(trigger => trigger.meta.mrChange === 'retarget').map(trigger => trigger.meta.repository)).toEqual(['repo-2'])
  })
})

it('binds a pending QA MR before merging, forwards its review once and never treats it as a release retarget', async () => {
  const item = ticket('qa-ticket', [])
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const h = host({ tickets: [item], triggers: { [item.origin.triggerId]: origin },
    state: { [KV.yunxiao.qaMr('org-1', 'repo-1', 12)]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 12,
      sourceBranch: 'SIQB-4-qa', qaBranch: 'release/261102', commit: FIRST } },
    routes: routes({ 'codeup-get-change-request': changeRequest({ sourceBranch: 'SIQB-4-qa', targetBranch: 'release/261102' }),
      'codeup-list-merge-request-comments': commentList(comment({ content: '<p>请补充空名称用例后再合并</p>' })) }) })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.ctx.tickets.bindThread).toHaveBeenCalledWith(item.id, mergeRequestThread('repo-1', 12), true, false)
  expect(h.triggers()).toHaveLength(1)
  expect(h.triggers()[0]).toMatchObject({ text: '请补充空名称用例后再合并', threads: [mergeRequestThread('repo-1', 12)] })
  expect(issued(h.calls)).not.toContain('codeup-list-branches')
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.ctx.tickets.bindThread).toHaveBeenCalledTimes(1)
  expect(h.triggers()).toHaveLength(1)
  expect(h.round.failures).toEqual([])
})

it('removes QA MR indices belonging to unrelated tickets without binding or polling', async () => {
  const item = ticket('ordinary-ticket', [])
  const h = host({ tickets: [item], state: { [KV.yunxiao.qaMr('org-1', 'repo-1', 12)]: {
    ticketId: item.id, repository: 'repo-1', mergeRequest: 12, sourceBranch: 'SIQB-4', qaBranch: 'qa', commit: FIRST } } })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.ctx.tickets.bindThread).not.toHaveBeenCalled()
  expect(h.calls).toEqual([])
  expect(h.records.has(KV.yunxiao.qaMr('org-1', 'repo-1', 12))).toBe(false)
})

it.each(['SIQB-4', 'SIQB-4-qa'])('directs QA MR conflicts from %s to the QA-only branch without rewriting development', async sourceBranch => {
  const item = ticket('qa-ticket', [])
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const h = host({ tickets: [item], triggers: { [item.origin.triggerId]: origin },
    state: { [KV.yunxiao.qaMr('org-1', 'repo-1', 12)]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 12,
      sourceBranch, qaBranch: 'release/qa', commit: FIRST } },
    routes: routes({ 'codeup-get-change-request': changeRequest({ sourceBranch, targetBranch: 'release/qa', conflictCheckStatus: 'HAS_CONFLICT' }) }) })
  await pollMergeRequests(h.ctx, file, h.round)
  const conflict = h.triggers().find(trigger => trigger.meta.kind === 'mr-change')!
  expect(conflict.text).toContain('Keep development branch SIQB-4 unchanged')
  expect(conflict.text).toContain('QA-only SIQB-4-qa')
  expect(conflict.text).toContain('integration_branch=SIQB-4-qa')
  expect(conflict.text).not.toContain('SIQB-4-qa-qa')
  expect(conflict.text).not.toContain('the source branch must be updated')
  const ref = { repositoryId: 'repo-1', localId: 12 }, change = { ...mergeRequestOf(changeRequest({ targetBranch: 'release/qa', conflictCheckStatus: 'HAS_CONFLICT' }), ref), head: FIRST }
  expect(conflict.id).not.toBe(mrChangeTrigger(ref, change, STARTED).id)
  expect(conflict.id).toBe(mrChangeTrigger(ref, change, STARTED, 'SIQB-4').id)
  expect(issued(h.calls)).not.toContain('codeup-list-branches')
  expect(h.round.failures).toEqual([])
})

it('closes the superseded QA follow once, retains history and polls only its replacement', async () => {
  const replacement = 'yunxiao:mr:repo-1:15'
  const item = ticket('qa-ticket', [THREAD])
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const h = host({ tickets: [item], triggers: { [item.origin.triggerId]: origin }, state: {
    [KV.yunxiao.qaMr('org-1', 'repo-1', 12)]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 12,
      sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST, superseded: true },
    [KV.yunxiao.qaMr('org-1', 'repo-1', 15)]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 15,
      sourceBranch: 'SIQB-4-qa', qaBranch: 'release/qa', commit: SECOND },
    [KV.yunxiao.mr(THREAD)]: { head: FIRST, fingerprint: 'prior-checks', commentAt: STARTED, revision: 2 },
  }, routes: routes({ 'codeup-get-change-request': (argv: string[]) => {
    expect(flag(argv, '--local-id')).toBe('15')
    return changeRequest({ localId: 15, sourceBranch: 'SIQB-4-qa', targetBranch: 'release/qa' })
  } }) })
  const enumerated = vi.spyOn(h.ctx.state, 'keys')
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(KV.yunxiao.qaMr('org-1', 'repo-1', 12))).toBe(false)
  await pollMergeRequests(h.ctx, file, h.round)
  expect(enumerated.mock.results[1]!.value).not.toContain(KV.yunxiao.qaMr('org-1', 'repo-1', 12))
  expect(item.follows?.find(follow => follow.thread === THREAD)).toMatchObject({ ends: false, closed: { at: STARTED, outcome: 'closed' } })
  expect(item.follows?.find(follow => follow.thread === replacement)).toMatchObject({ ends: false })
  expect(item.ended).toBeUndefined()
  expect(h.closed).toEqual([{ thread: mergeRequestThread('repo-1', 12), outcome: 'closed', at: STARTED }])
  expect(h.ctx.tickets.bindThread).toHaveBeenCalledOnce()
  expect(h.ctx.tickets.bindThread).toHaveBeenCalledWith(item.id, mergeRequestThread('repo-1', 15), true, false)
  expect(h.calls.every(argv => !argv.includes('--local-id') || flag(argv, '--local-id') === '15')).toBe(true)
  expect(h.triggers()).toEqual([])
  expect(h.record()).toEqual({ head: FIRST, fingerprint: 'prior-checks', commentAt: STARTED, revision: 2 })
  expect(h.round.failures).toEqual([])
})

it('does not bind or poll a superseded QA MR that was never followed', async () => {
  const item = ticket('qa-ticket', [])
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const h = host({ tickets: [item], triggers: { [item.origin.triggerId]: origin }, state: {
    [KV.yunxiao.qaMr('org-1', 'repo-1', 12)]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 12,
      sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST, superseded: true },
  } })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.ctx.tickets.bindThread).not.toHaveBeenCalled()
  expect(h.closed).toEqual([])
  expect(h.calls).toEqual([])
  expect(h.records.has(KV.yunxiao.qaMr('org-1', 'repo-1', 12))).toBe(false)
})

it('removes an orphan QA MR index without erasing its history or reading Codeup', async () => {
  const mr = KV.yunxiao.qaMr('org-1', 'repo-1', 12), history = KV.yunxiao.mr(THREAD)
  const prior = { head: FIRST, fingerprint: 'retained', commentAt: STARTED, revision: 2 }
  const h = host({ state: { [mr]: { ticketId: 'missing', repository: 'repo-1', mergeRequest: 12,
    sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST }, [history]: prior } })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(mr)).toBe(false)
  expect(h.records.get(history)).toEqual(prior)
  expect(h.calls).toEqual([])
  expect(h.closed).toEqual([])
})

it.each(['closed', 'gone'])('removes a current QA index after its followed MR is %s', async state => {
  const item = ticket('qa-ticket', [THREAD])
  if (state === 'closed') item.follows![0]!.closed = { at: STARTED, outcome: 'merged' }
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const mr = KV.yunxiao.qaMr('org-1', 'repo-1', 12)
  const h = host({ tickets: [item], triggers: { [origin.id]: origin }, state: { [mr]: { ticketId: item.id, repository: 'repo-1',
    mergeRequest: 12, sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST },
    ...state === 'gone' ? { [KV.yunxiao.mr(THREAD)]: { head: FIRST, fingerprint: '', commentAt: STARTED, revision: 0, gone: true } } : {},
  } })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(mr)).toBe(false)
  if (state === 'closed') expect(item.follows![0]!.closed).toEqual({ at: STARTED, outcome: 'merged' })
  else expect(h.record()?.gone).toBe(true)
  expect(h.calls).toEqual([])
  expect(h.closed).toEqual([])
})

it('retains an ended ticket QA index when its receipt names the MR without proving it closed', async () => {
  const item = ticket('qa-ticket', [THREAD])
  item.ended = { at: STARTED, by: 'executor', outcome: 'completed' }
  const before = structuredClone(item)
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const mr = KV.yunxiao.qaMr('org-1', 'repo-1', 12)
  const h = host({ tickets: [item], triggers: { [origin.id]: origin }, state: {
    [mr]: { ticketId: item.id, repository: 'repo-1', mergeRequest: 12, sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST },
    [KV.yunxiao.qa(item.id, 'repo-1')]: { repository: 'repo-1', mergeRequest: 12, pipelineId: '11', runId: '3', branch: 'SIQB-4',
      commit: FIRST, qaBranch: 'release/qa', qaCommit: SECOND },
  } })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(mr)).toBe(true)
  expect(h.records.has(KV.yunxiao.qa(item.id, 'repo-1'))).toBe(true)
  expect(item).toEqual(before)
  expect(h.calls).toEqual([])
  expect(h.closed).toEqual([])
})

it('retains a pending QA review after a ticket ends and resumes it with QA conflict guidance', async () => {
  const item = ticket('qa-ticket', [])
  item.ended = { at: STARTED, by: 'executor', outcome: 'completed' }
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const mr = KV.yunxiao.qaMr('org-1', 'repo-1', 12)
  const h = host({ tickets: [item], triggers: { [origin.id]: origin }, state: { [mr]: { ticketId: item.id, repository: 'repo-1',
    mergeRequest: 12, sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST } }, routes: routes({
      'codeup-get-change-request': changeRequest({ sourceBranch: 'SIQB-4', targetBranch: 'release/qa', conflictCheckStatus: 'HAS_CONFLICT' }),
    }) })
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(mr)).toBe(true)
  expect(h.calls).toEqual([])
  expect(h.ctx.tickets.bindThread).not.toHaveBeenCalled()
  delete item.ended
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.ctx.tickets.bindThread).toHaveBeenCalledWith(item.id, mergeRequestThread('repo-1', 12), true, false)
  expect(h.triggers().some(trigger => trigger.text.includes('Keep development branch SIQB-4 unchanged'))).toBe(true)
  expect(h.records.has(mr)).toBe(true)
  expect(h.round.failures).toEqual([])
})

it('does not poll a just-retired QA MR from a stale ticket snapshot in the same round', async () => {
  const item = ticket('qa-ticket', [THREAD]), stale = structuredClone(item)
  const origin: Trigger = { id: item.origin.triggerId, source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'user-1' },
    human: true, at: '', text: '', meta: { workitemId: 'wi-1' } }
  const mr = KV.yunxiao.qaMr('org-1', 'repo-1', 12)
  const h = host({ tickets: [item], triggers: { [origin.id]: origin }, state: { [mr]: { ticketId: item.id, repository: 'repo-1',
    mergeRequest: 12, sourceBranch: 'SIQB-4', qaBranch: 'release/qa', commit: FIRST, superseded: true } } })
  vi.spyOn(h.ctx.tickets, 'open').mockReturnValueOnce([stale]).mockImplementation(() => [item])
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.records.has(mr)).toBe(false)
  expect(item.follows![0]!.closed).toBeDefined()
  expect(stale.follows![0]!.closed).toBeUndefined()
  expect(h.calls).toEqual([])
  await pollMergeRequests(h.ctx, file, h.round)
  expect(h.closed).toHaveLength(1)
  expect(h.calls).toEqual([])
})
