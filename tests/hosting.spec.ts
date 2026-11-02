/** The code hosting contract: the GitHub and Codeup binding rules, the change a ticket started from, and the end notices. */
import { describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { changeEndNotices, githubChange, githubHosting, ticketBranch, triggerChange, type Change } from '../src/hosting.ts'
import { codeupHosting } from '../src/sources/codeup-hosting.ts'
import { testCodeup } from './fixtures/deployment.ts'

const account = { id: 'agent-bot', name: 'agent-bot', commitEmail: '7+agent-bot@users.noreply.github.com' }
const github = githubHosting({ repository: 'acme/widgets', account })
const change = (overrides: Partial<Change> = {}): Change => ({
  repository: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12', title: 'Fix it', state: 'open',
  author: 'agent-bot', headRef: 'bugfix/261102-fix-12', baseRef: 'release/20261031', headSha: 'e0c6a63b', ...overrides,
})
type ClaimTicket = Pick<Ticket, 'execution' | 'origin' | 'follows'>
const ticket = (name: string, overrides: Partial<ClaimTicket> = {}): ClaimTicket => ({
  execution: { name, directory: `/work/${name}`, assignment: '' }, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, follows: [], ...overrides,
})

describe('the GitHub implementation', () => {
  it('normalizes a pull request record, collapsing a merged one into the merged state', () => {
    expect(githubChange({ number: 7, state: 'closed', html_url: 'https://github.com/acme/widgets/pull/7', title: 'Fix',
      merged_at: '2026-11-02T10:00:00Z', user: { login: 'agent-bot' }, head: { ref: 'bugfix/x-7', sha: 'abc' }, base: { ref: 'release/20261101' } }, 'acme/widgets'))
      .toEqual({ repository: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7', title: 'Fix', state: 'merged',
        author: 'agent-bot', headRef: 'bugfix/x-7', baseRef: 'release/20261101', headSha: 'abc', mergedAt: '2026-11-02T10:00:00Z' })
    // A deleted account is reported as no author, which no ticket may claim.
    expect(githubChange({ number: 8, state: 'open', html_url: 'u', head: { ref: 'r', sha: 's' }, base: { ref: 'b' } }, 'acme/widgets').author).toBe('')
  })
  it('binds the change a ticket started from, and the agent\'s own change on the ticket branch', () => {
    // The change the ticket started from binds without being the ticket's own work, even from another branch.
    expect(github.claim({ ticket: ticket('fix-12'), change: change({ headRef: 'release-fix' }), source: change() })).toEqual({ own: false })
    expect(github.claim({ ticket: ticket('fix-12'), change: change() })).toEqual({ own: true })
    expect(github.claim({ ticket: ticket('fix-12'), change: change({ headRef: 'agent/fix-12' }) })).toEqual({ own: true })
    expect(github.claim({ ticket: ticket('other-12'), change: change() })).toMatchObject({ refused: expect.stringContaining('does not belong') })
    expect(github.claim({ ticket: ticket('fix-12'), change: change({ author: 'carol' }) })).toMatchObject({ refused: expect.any(String) })
    expect(github.claim({ ticket: ticket('fix-12'), change: change({ repository: 'acme/other' }) })).toMatchObject({ refused: expect.any(String) })
    expect(github.thread(change())).toEqual({ source: 'github', id: '12' })
    expect(github.repositories).toEqual(['acme/widgets'])
  })
})

describe('the Codeup implementation', () => {
  const codeup = codeupHosting(testCodeup({ repositories: [{ id: 'repo-1', path: 'group/app', name: 'app' }] }))
  const merge = (overrides: Partial<Change> = {}): Change => change({ repository: 'repo-1', url: 'https://codeup.aliyun.com/org-1/group/app/change/12',
    author: 'user-1', headRef: 'bugfix/261102-automation-retry-scope-AXOAXO-6701', baseRef: 'release/20261101', ...overrides })
  it('binds a merge request by the account and the ticket branch, and names its thread by repository and local id', () => {
    expect(codeup.claim({ ticket: ticket('automation-retry-scope-AXOAXO-6701'), change: merge() })).toEqual({ own: true })
    expect(codeup.claim({ ticket: ticket('automation-retry-scope-AXOAXO-6701'), change: merge({ author: 'someone-else' }) }))
      .toMatchObject({ refused: expect.stringContaining('does not belong') })
    expect(codeup.claim({ ticket: ticket('another-ticket'), change: merge() })).toMatchObject({ refused: expect.any(String) })
    expect(codeup.thread(merge())).toEqual({ source: 'yunxiao', id: 'mr:repo-1:12' })
    expect(codeup.platform).toBe('codeup')
    expect(codeup.repositories).toEqual(['repo-1'])
  })
  it('reports no merge notice in this phase, where a ticket ends with its ready report', () => {
    const ended = { ...ticket('automation-retry-scope-AXOAXO-6701'), id: 't1', channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }] } as unknown as Ticket
    expect(codeup.endNotices(ended, '修一下')).toEqual([])
  })
})

describe('ticket branches and source changes', () => {
  it('matches a branch to a ticket by its short name as the last path segment', () => {
    expect(ticketBranch(ticket('fix-12'), 'bugfix/261102-fix-fix-12')).toBe(true)
    expect(ticketBranch(ticket('fix-plan-color'), 'bugfix/261102-automation-retry-scope-fix-plan-color')).toBe(true)
    expect(ticketBranch(ticket('fix-12'), 'fix-12')).toBe(true)
    expect(ticketBranch(ticket('fix-12'), 'agent/fix-12-2')).toBe(false)
    // The team names a branch after the work item's serial, and a retarget adds `-to-release-<yyyymmdd>` after the branch it moves.
    expect(ticketBranch(ticket('fix-12'), 'bugfix/261102-login-AXOAXO-6812', 'AXOAXO-6812')).toBe(true)
    expect(ticketBranch(ticket('fix-12'), 'bugfix/261102-login-AXOAXO-6812-to-release-20261103', 'AXOAXO-6812')).toBe(true)
    expect(ticketBranch(ticket('fix-12'), 'bugfix/261102-fix-12-to-release-20261103')).toBe(true)
    expect(ticketBranch(ticket('fix-12'), 'bugfix/261102-login-AXOAXO-6813', 'AXOAXO-6812')).toBe(false)
    expect(ticketBranch({} as ClaimTicket, 'agent/x')).toBe(false)
  })
  it('reads the change a ticket started from, and nothing from a comment trigger', () => {
    expect(triggerChange({ meta: { isPr: true, number: 30 } }, 'acme/widgets')).toMatchObject({ repository: 'acme/widgets', number: 30 })
    expect(triggerChange({ meta: { isPr: false, number: 30 } }, 'acme/widgets')).toBeUndefined()
    expect(triggerChange({ meta: { number: 30 } }, 'acme/widgets')).toBeUndefined()
    expect(triggerChange({ meta: { isPr: true, number: 'x' } }, 'acme/widgets')).toBeUndefined()
    expect(triggerChange(undefined, 'acme/widgets')).toBeUndefined()
  })
})

describe('end notices', () => {
  const ended = (overrides: Partial<Ticket> = {}): Ticket => ({
    id: 't1', title: 'one', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
      { source: 'github', thread: 'github:12', address: { number: '12' } }],
    assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'tr', triggerIds: ['tr'] },
    follows: [{ thread: 'github:12', own: true, closed: { at: '2026-11-02T10:00:00Z', outcome: 'merged' } }],
    ...overrides,
  })
  it('notices the other conversations once per outcome, in the language of the request, and skips the platform\'s own', () => {
    const notices = github.endNotices(ended(), '修一下标题')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', text: expect.stringContaining('已合并'),
      channel: expect.objectContaining({ source: 'feishu' }) })])
    expect(github.endNotices(ended(), 'Fix the title')).toEqual([expect.objectContaining({ text: expect.stringContaining('has merged') })])
    // The same outcome yields the same id, so a repeated end does not post it twice.
    expect(github.endNotices(ended(), '修一下标题')[0]!.id).toBe(notices[0]!.id)
    expect(changeEndNotices({ ticket: ended(), request: '修一下', change: change({ url: 'u' }), outcome: 'closed', source: 'github', label: 'PR' })[0]!.text)
      .toContain('已关闭，未合并')
  })
})
