/** Reopening reuses a ticket's occupied development branch without altering its worktree. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitEnv } from './fixtures/git.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('reopens a completed ticket in its existing occupied serial worktree and preserves dirty changes', async () => {
  const h = host = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复 SIQB-4'))
  const repository = join(h.directory, 'source'), project = join(ticket.execution!.directory, 'app')
  mkdirSync(repository)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(repository, 'init', '--initial-branch=master')
  writeFileSync(join(repository, 'workitem.txt'), 'original\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-m', 'baseline')
  git(repository, 'worktree', 'add', '-b', 'SIQB-4', project, 'master')
  const head = git(project, 'rev-parse', 'HEAD'), worktrees = git(repository, 'worktree', 'list', '--porcelain')
  expect(worktrees).toContain('branch refs/heads/SIQB-4')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'fixed' })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
  writeFileSync(join(project, 'workitem.txt'), 'unfinished follow-up\n')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'exit 1' } })
  h.subprocess.spawn.mockClear()
  h.deliveries.mockClear()

  h.runtime.receive(feishu('2', '同一缺陷仍可复现，请继续', { mentions: [], root_id: 'om_1' }))
  await h.runtime.idle()
  const reopened = h.runtime.store.tickets.get(ticket.id)!
  expect(reopened.ended).toBeUndefined()
  expect(reopened.assignments).toHaveLength(2)
  expect(reopened.execution).toEqual(ticket.execution)
  expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === 'sh')).toBe(false)
  expect(git(repository, 'worktree', 'list', '--porcelain')).toBe(worktrees)
  expect(git(project, 'rev-parse', '--show-toplevel')).toBe(realpathSync(project))
  expect(git(project, 'branch', '--show-current')).toBe('SIQB-4')
  expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(project, 'status', '--porcelain')).toBe('M workitem.txt')
  expect(readFileSync(join(project, 'workitem.txt'), 'utf8')).toBe('unfinished follow-up\n')
  const messages = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text)
  expect(messages.some(text => text.includes('Reuse this ticket\'s existing worktrees and branches'))).toBe(true)
  expect(messages.some(text => text.includes('If the branch belongs to an unexpected worktree, stop and report its path'))).toBe(true)
})
