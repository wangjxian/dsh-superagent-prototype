/** The target release rule: the previous release until it merges back, then the day's own release, created when it is missing. */
import { describe, expect, it } from 'vitest'
import { aheadCount, branchNames, mergedTargets, releaseBranch, releaseBranchDay, releaseDay, targetRelease, type YunxiaoCaller } from '../src/infra/release.ts'
import { testRepository } from './fixtures/deployment.ts'

const repository = testRepository({ id: 'repo-1', path: 'group/app', name: 'app' })
/** Noon of 2026-11-02 in Asia/Shanghai, whatever the host's own zone. */
const NOON = new Date('2026-11-02T04:00:00Z')
const branches = (...names: string[]) => ['master', ...names]
interface Fake { caller: YunxiaoCaller; calls: string[][]; created: () => string[][] }
/**
 * A yunxiao CLI that answers the calls the rule makes, recording them: `compare` is its raw report, and `merged` the target
 * branches of the merged merge requests, every branch by default.
 */
function fakeYunxiao(replies: { branches: string[]; compare?: string; merged?: string[] }): Fake {
  const calls: string[][] = []
  const caller: YunxiaoCaller = { aliyun: async argv => {
    calls.push([...argv])
    const flag = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined
    if (argv[1] === 'codeup-list-branches') {
      // The listing narrows by substring and pages by 100, as Codeup's does.
      const page = Number(flag('--page') ?? 1)
      const names = replies.branches.filter(name => name.includes(flag('--search') ?? '')).slice((page - 1) * 100, page * 100)
      return JSON.stringify(names.map(name => ({ name })))
    }
    if (argv[1] === 'codeup-list-change-requests') return JSON.stringify((replies.merged ?? replies.branches).map(targetBranch => ({ targetBranch })))
    if (argv[1] === 'codeup-get-compare') return replies.compare ?? '{"aheadBy":1}'
    if (argv[1] === 'codeup-create-branch') return '{"result":{"name":"created"}}'
    throw new Error(`unexpected yunxiao call: ${argv.join(' ')}`)
  } }
  return { caller, calls, created: () => calls.filter(call => call[1] === 'codeup-create-branch') }
}

describe('the release day', () => {
  it('takes Asia/Shanghai\'s calendar day, not the host\'s', () => {
    // 16:30 UTC is 00:30 of the next day in Shanghai.
    expect(releaseDay(new Date('2026-11-01T16:30:00Z'))).toBe('20261102')
    expect(releaseDay(new Date('2026-11-01T15:59:00Z'))).toBe('20261101')
    expect(releaseDay(new Date('2026-11-02T04:00:00Z'))).toBe('20261102')
  })
  it('names a branch after its day and reads the day back, refusing another branch', () => {
    expect(releaseBranch('20261102')).toBe('release/20261102')
    expect(releaseBranchDay('release/20261102')).toBe('20261102')
    expect([releaseBranchDay('master'), releaseBranchDay('release/2026-11-02'), releaseBranchDay('release/2026110')])
      .toEqual([undefined, undefined, undefined])
  })
})

describe('the yunxiao reports', () => {
  it('reads branch names from an array or from the object the CLI wraps them in', () => {
    expect(branchNames('{"result":[{"name":"master"},{"name":"release/20261101"}]}')).toEqual(['master', 'release/20261101'])
    expect(branchNames('{"branches":[{"name":"master"}]}')).toEqual(['master'])
    expect(branchNames('["master","release/20261101"]')).toEqual(['master', 'release/20261101'])
    // The CLI may print a banner line before its JSON.
    expect(branchNames('devops plugin ready\n{"result":[{"name":"master"}]}')).toEqual(['master'])
    expect(() => branchNames('{"total":2}')).toThrow('names no branches')
  })
  it('reads the commit count a compare report fills, and refuses one that names none', () => {
    expect(aheadCount('{"aheadBy":3}')).toBe(3)
    expect(aheadCount('{"aheadBy":"0"}')).toBe(0)
    expect(aheadCount('{"totalCommit":2,"commits":[{},{}]}')).toBe(2)
    expect(aheadCount('{"commits":[]}')).toBe(0)
    expect(() => aheadCount('{"files":[]}')).toThrow('names no commit count')
  })
  it('reads the target branches of merged merge requests', () => {
    expect(mergedTargets('[{"targetBranch":"release/20261101"},{"targetBranch":null}]')).toEqual(['release/20261101'])
    expect(mergedTargets('{"result":[{"targetBranch":"master"}]}')).toEqual(['master'])
  })
})

describe('the target release', () => {
  it('targets the previous release while it has not merged back into the base branch', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261031', 'release/20261101'), compare: '{"aheadBy":4}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toEqual({ target: 'release/20261101', basis: 'previous', previous: 'release/20261101', mergedBack: false, base: 'master', ahead: 4 })
    expect(yunxiao.calls[1]).toEqual(['devops', 'codeup-get-compare', '--organization-id', 'org-1', '--repository-id', 'repo-1',
      '--from', 'master', '--to', 'release/20261101'])
    expect(yunxiao.created()).toEqual([])
  })
  it('targets the day\'s own release once the previous one has merged back', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261101', 'release/20261102'), compare: '{"aheadBy":0}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toEqual({ target: 'release/20261102', basis: 'today', previous: 'release/20261101', mergedBack: true, base: 'master', ahead: 0 })
    expect(yunxiao.created()).toEqual([])
  })
  it('creates the day\'s release from the base branch when the previous one merged back and it is missing', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261101'), compare: '{"commits":[]}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toEqual({ target: 'release/20261102', basis: 'today-created', previous: 'release/20261101', mergedBack: true, base: 'master', ahead: 0 })
    expect(yunxiao.created()).toEqual([['devops', 'codeup-create-branch', '--organization-id', 'org-1', '--repository-id', 'repo-1',
      '--branch', 'release/20261102', '--ref', 'master']])
  })
  it('narrows the branch listing by the prefix the configured pattern names', async () => {
    const yunxiao = fakeYunxiao({ branches: ['master', 'hotfix/20261101'], compare: '{"aheadBy":1}' })
    const release = { pattern: 'hotfix/{yyyymmdd}', trunk: '', timezone: 'Asia/Shanghai', mergeType: '' }
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON, release }))
      .toMatchObject({ target: 'hotfix/20261101', basis: 'previous' })
    // The search follows the pattern, so a renamed release line still finds its branches.
    expect(yunxiao.calls.find(call => call[1] === 'codeup-list-branches')).toContain('hotfix/')
  })
  it('cuts releases from the trunk the rules name, over the repository\'s default branch', async () => {
    const yunxiao = fakeYunxiao({ branches: ['main', 'develop'] })
    const release = { pattern: 'release/{yyyymmdd}', trunk: 'develop', timezone: 'Asia/Shanghai', mergeType: '' }
    expect(await targetRelease({ organization: 'org-1', repository: testRepository({ defaultBranch: 'main' }), caller: yunxiao.caller,
      now: NOON, release })).toEqual({ target: 'release/20261102', basis: 'today-created', mergedBack: false, base: 'develop' })
  })
  it('reports the day\'s release without creating it when the caller asks for a read-only answer', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261101'), compare: '{"commits":[]}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON, create: false }))
      .toEqual({ target: 'release/20261102', basis: 'today', previous: 'release/20261101', mergedBack: true, base: 'master', ahead: 0 })
    expect(yunxiao.created()).toEqual([])
  })
  it('keeps the previous release while nothing has merged into it, though nothing is ahead of the base either', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261101'), compare: '{"commits":[]}', merged: ['release/20261031'] })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toEqual({ target: 'release/20261101', basis: 'previous', previous: 'release/20261101', mergedBack: false, base: 'master', ahead: 0 })
    expect(yunxiao.created()).toEqual([])
  })
  it('reads every page of release branches', async () => {
    const old = Array.from({ length: 150 }, (_, index) => `release/20260101-${String(index).padStart(3, '0')}_release_1_${index}`)
    const yunxiao = fakeYunxiao({ branches: branches(...old, 'release/20261101'), compare: '{"aheadBy":1}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toMatchObject({ target: 'release/20261101', basis: 'previous' })
    expect(yunxiao.calls.filter(call => call[1] === 'codeup-list-branches').map(call => call[call.indexOf('--page') + 1])).toEqual(['1', '2'])
  })
  it('cuts releases from the repository\'s default branch, and targets the day\'s release when there is no previous one', async () => {
    const yunxiao = fakeYunxiao({ branches: ['main', 'develop'] })
    expect(await targetRelease({ organization: 'org-1', repository: testRepository({ defaultBranch: 'main' }), caller: yunxiao.caller, now: NOON }))
      .toEqual({ target: 'release/20261102', basis: 'today-created', mergedBack: false, base: 'main' })
    // Without a previous release there is nothing to compare.
    expect(yunxiao.calls.map(call => call[1])).toEqual(['codeup-list-branches', 'codeup-create-branch'])
  })
  it('ignores branches that are not dated releases, and future ones, when choosing the previous release', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261105', 'release/next', 'release/20261031', 'release/2026-10-30') })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON }))
      .toMatchObject({ target: 'release/20261031', basis: 'previous', previous: 'release/20261031' })
  })
  it('targets a release a person named, which must be a branch of the repository', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261101', 'release/20261105'), compare: '{"aheadBy":0}' })
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON, requested: 'release/20261105' }))
      .toEqual({ target: 'release/20261105', basis: 'requested', previous: 'release/20261101', mergedBack: true, base: 'master', ahead: 0 })
    // The named release is the one checked for a merge back, not the computed previous one.
    expect(yunxiao.calls.filter(call => call[1] === 'codeup-get-compare')).toEqual([['devops', 'codeup-get-compare', '--organization-id', 'org-1',
      '--repository-id', 'repo-1', '--from', 'master', '--to', 'release/20261105']])
    await expect(targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: NOON, requested: 'release/20261109' }))
      .rejects.toThrow('release/20261109 is not a branch of group/app')
  })
  it('moves the day with the zone: 00:30 in Shanghai already targets the new day\'s previous release', async () => {
    const yunxiao = fakeYunxiao({ branches: branches('release/20261031', 'release/20261101'), compare: '{"aheadBy":2}' })
    // 16:30 UTC is 2026-11-02 in Shanghai, so release/20261101 is that day's previous release.
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: new Date('2026-11-01T16:30:00Z') }))
      .toMatchObject({ target: 'release/20261101', basis: 'previous' })
    // 15:00 UTC is still 2026-11-01 there, so release/20261031 is the previous release of the day.
    expect(await targetRelease({ organization: 'org-1', repository, caller: yunxiao.caller, now: new Date('2026-11-01T15:00:00Z') }))
      .toMatchObject({ target: 'release/20261031', basis: 'previous' })
  })
})
