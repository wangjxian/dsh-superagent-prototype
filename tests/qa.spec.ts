import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/app/store.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { integrateQa, pipelineCommit, prepareQa, testQa, verifyQa } from '../src/app/qa.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

const COMMIT = 'a'.repeat(40), COMMIT2 = 'b'.repeat(40), BASE = 'c'.repeat(40), BASE2 = 'd'.repeat(40)
const MERGED = 'e'.repeat(40), MERGED2 = 'f'.repeat(40)
const PATH = 'org-1/app', PATH2 = 'org-1/service'
function run(id: number, path = PATH, pipelineId = 11, commit = MERGED, status = 'SUCCESS') {
  return { pipelineId, pipelineRunId: id, status, sources: [{ data: { repo: `https://codeup.aliyun.com/${path}.git`, branch: 'qa',
    isBranchMode: false, commit: JSON.stringify([{ commitId: commit }]) } }], stages: [] }
}
function setup(multiple = false) {
  const ancestors = new Map<string, Set<string>>([[MERGED, new Set([BASE, COMMIT])], [MERGED2, new Set([BASE2, COMMIT2])]])
  const world = { latest: run(2), current: run(3), head: COMMIT, secondHead: COMMIT2, qa: BASE, secondQa: BASE2,
    latestSecond: run(2, PATH2, 22, MERGED2), currentSecond: run(4, PATH2, 22, MERGED2), name: 'qa-app', sourceBranch: 'qa',
    activeRuns: [] as unknown[], triggerEvents: '', branchMode: false, conflict: false, mrConflict: false, extraBranch: false, included: '', secondIncluded: '', nextRun: 3, nextSecondRun: 4,
    mr: undefined as undefined | { localId: number; sourceBranch: string; targetBranch: string; sourceProjectId: string; targetProjectId: string; status?: string; state?: string; conflictCheckStatus?: string } }
  const deployment = testDeployment({ github: undefined, codeup: testCodeup({ repositories: [
    { id: 'repo-1', path: PATH, name: 'app' }, ...multiple ? [{ id: 'repo-2', path: PATH2, name: 'service' }] : [],
  ] }) })
  const commands = new Commands(() => deployment, {}, new AbortController().signal), calls: string[][] = []
  vi.spyOn(commands, 'aliyun').mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]; calls.push(args)
    const other = args[args.indexOf('--pipeline-id') + 1] === '22'
    switch (args[1]) {
      case 'flow-get-pipeline': return { name: world.name, pipelineConfig: { flow: `sources:\n  app:\n    endpoint: https://codeup.aliyun.com/${other ? PATH2 : PATH}.git\n    branch: ${world.sourceBranch}\n${world.branchMode ? '    branchMode: {baseBranch: master}\n' : ''}${world.triggerEvents ? `    triggerEvents: ${world.triggerEvents}\n` : ''}` } }
      case 'flow-list-pipeline-runs': return world.activeRuns
      case 'flow-get-latest-pipeline-run': return other ? world.latestSecond : world.latest
      case 'flow-create-pipeline-run': return other ? world.nextSecondRun++ : world.nextRun++
      case 'flow-get-pipeline-run': return other ? world.currentSecond : world.current
      case 'codeup-list-change-requests': return world.mr ? [world.mr] : []
      case 'codeup-create-change-request': world.mr = { localId: 9, sourceBranch: 'SIQB-1', targetBranch: 'qa', sourceProjectId: 'repo-1', targetProjectId: 'repo-1', status: 'TO_BE_MERGED' }; return world.mr
      case 'codeup-get-change-request': return { ...world.mr, conflictCheckStatus: world.mrConflict ? 'HAS_CONFLICT' : 'NO_CONFLICT' }
      case 'codeup-merge-change-request': world.qa = MERGED; world.included = world.head; world.mr!.status = 'MERGED'; return world.mr
      default: throw new Error('Unexpected QA call: ' + args[1])
    }
  }) as never)
  vi.spyOn(commands, 'git').mockImplementation(async (args, cwd) => {
    const other = cwd.endsWith('/service')
    if (args[0] === 'check-ref-format') return 'qa'
    if (args[1] === '--show-toplevel') return cwd
    if (args[0] === 'branch') return 'SIQB-1'
    if (args[0] === 'status' || args[0] === 'fetch') return ''
    if (args[0] === 'rev-parse') return args[1]?.startsWith('refs/remotes/') ? args.slice(1).map(ref => ref.endsWith('/qa') ? (other ? world.secondQa : world.qa) : (other ? world.secondHead : world.head)).join('\n') : other ? world.secondHead : world.head
    if (args[0] === 'merge-base') {
      const seen = new Set<string>(), includes = (tip: string): boolean => {
        if (tip === args[2]) return true
        if (seen.has(tip)) return false
        seen.add(tip)
        return [...ancestors.get(tip) ?? []].some(includes)
      }
      if (!includes(args[3]!)) throw new CliError('not merged', undefined, 1)
      return ''
    }
    if (args[0] === 'merge-tree') { if (world.conflict) throw new CliError('README conflict', undefined, 1); return BASE }
    if (args[0] === 'commit-tree') { const tip = other ? MERGED2 : MERGED; ancestors.set(tip, new Set([...ancestors.get(tip) ?? [], args[3]!, args[5]!])); return tip }
    throw new Error('Unexpected git call: ' + args[0])
  })
  vi.spyOn(commands, 'pushQa').mockImplementation(async (_branch, commit, cwd) => {
    if (cwd.endsWith('/service')) { world.secondQa = commit; world.secondIncluded = world.secondHead }
    else { world.qa = commit; world.included = world.head }
  })
  const records = new Map<string, unknown>()
  const host = { commands, store: { keys: (family: { prefix: string } | string) => [...records.keys()].filter(key => key.startsWith(typeof family === 'string' ? family : family.prefix)), delete: (key: string) => { records.delete(key) }, get: (key: string) => records.get(key), set: (key: string, value: unknown) => { records.set(key, value) } } } as Parameters<typeof integrateQa>[0]
  records.set(KV.yunxiao.qaPlan('t1'), { environment: 'http://qa.example.test', tested: true, projects: [
    { repository: 'repo-1', pipelineId: '11', qaBranch: 'qa', command: 'unit app', directory: '/work/app', commit: COMMIT, output: 'OK' },
  ] })
  const result = { verification: 'QA HTTP passed', qa: { repository: 'repo-1', pipeline_id: '11', run_id: '3', main_flow_passed: true, evidence: 'QA passed' } }
  return { host, world, calls, records, commands, result, ancestors }
}
function group(s: ReturnType<typeof setup>) {
  return { verification: 'QA joint scenario passed', qa: { repositories: [s.result.qa, { ...s.result.qa, repository: 'repo-2', pipeline_id: '22', run_id: '4' }], main_flow_passed: true, evidence: 'QA environment passed' } }
}
function planBoth(s: ReturnType<typeof setup>) {
  s.records.set(KV.yunxiao.qaPlan('t1'), { environment: 'http://qa.example.test', tested: true, projects: [
    { repository: 'repo-1', pipelineId: '11', qaBranch: 'qa', command: 'unit app', directory: '/work/app', commit: s.world.head, output: 'OK' },
    { repository: 'repo-2', pipelineId: '22', qaBranch: 'qa', command: 'unit service', directory: '/work/service', commit: s.world.secondHead, output: 'OK' },
  ] })
}
function retestLocal(s: ReturnType<typeof setup>) {
  const plan = s.host.store.get(KV.yunxiao.qaPlan('t1'))!
  s.records.set(KV.yunxiao.qaPlan('t1'), { ...plan, projects: plan.projects.map(p => ({ ...p, commit: p.repository === 'repo-1' ? s.world.head : s.world.secondHead })) })
}
async function integrateBoth(s: ReturnType<typeof setup>) {
  planBoth(s)
  await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11', ['repo-1', 'repo-2'])
  await integrateQa(s.host, 't1', 'SIQB-1', 'repo-2', '22', ['repo-1', 'repo-2'])
  await testQa(s.host, 't1', 'repo-1', 'QA tests', async () => 'QA passed')
}

describe('fixed QA integration branches', () => {
  it('merges the exact tested commit while preserving QA history, then starts ordinary QA on the fixed branch', async () => {
    const s = setup()
    const receipt = await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(receipt).toMatchObject({ qaBranch: 'qa', qaCommit: MERGED, commit: COMMIT })
    expect(s.commands.git).toHaveBeenCalledWith(['commit-tree', BASE, '-p', BASE, '-p', COMMIT, '-m', 'Merge SIQB-1 into qa'], expect.any(String))
    expect(s.commands.pushQa).toHaveBeenCalledWith('qa', MERGED, expect.any(String))
    expect(JSON.parse(s.calls.find(args => args[1] === 'flow-create-pipeline-run')!.at(-1)!)).toEqual({ runningBranchs: { 'https://codeup.aliyun.com/org-1/app.git': 'qa' } })
  })
  it('does not push QA or start a pipeline when merging conflicts', async () => {
    const s = setup(); s.world.conflict = true
    await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('QA merge conflict')
    expect(s.commands.pushQa).not.toHaveBeenCalled()
    expect(s.calls.some(args => args[1] === 'flow-create-pipeline-run')).toBe(false)
  })
  it('accepts an already merged work-item commit without merging it again', async () => {
    const s = setup(); s.world.qa = MERGED; s.world.included = COMMIT
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(s.commands.pushQa).not.toHaveBeenCalled()
  })
  it('creates and merges a QA MR without deleting its source branch', async () => {
    const s = setup(); const plan = s.host.store.get(KV.yunxiao.qaPlan('t1'))!; plan.projects[0]!.mergeMode = 'merge-request'
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(s.commands.pushQa).not.toHaveBeenCalled()
    const merge = s.calls.find(args => args[1] === 'codeup-merge-change-request')!
    expect(merge.slice(-4)).toEqual(['--merge-type', 'no-fast-forward', '--remove-source-branch', 'false'])
  })
  it('reuses an existing conflicting MR and starts no QA pipeline until resolution', async () => {
    const s = setup(); s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.mergeMode = 'merge-request'
    s.world.mrConflict = true
    await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('QA merge conflict')
    s.world.mrConflict = false
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(s.calls.filter(args => args[1] === 'codeup-create-change-request')).toHaveLength(1)
  })
  it('retains MR evidence when retrying a failed QA run for the same development commit', async () => {
    const s = setup(); s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.mergeMode = 'merge-request'
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    s.world.latest = run(3, PATH, 11, MERGED, 'FAIL')
    expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '4', mergeRequest: 9 })
    expect(s.calls.filter(args => args[1] === 'codeup-merge-change-request')).toHaveLength(1)
  })
  it.each(['old branch mode', 'trunk', 'running', 'stale latest', 'push trigger', 'MR trigger'])('refuses publication for %s', async failure => {
    const s = setup()
    if (failure === 'old branch mode') s.world.branchMode = true
    if (failure === 'trunk') s.world.sourceBranch = 'master'
    if (failure === 'push trigger') s.world.triggerEvents = 'push'
    if (failure === 'MR trigger') s.world.triggerEvents = 'mergeRequestMerged'
    if (failure === 'running') s.world.latest.status = 'RUNNING'
    if (failure === 'stale latest') s.records.set(KV.yunxiao.qaLatest('org-1', '11'), { runId: '99' })
    await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow()
    expect(s.commands.pushQa).not.toHaveBeenCalled()
  })
  it.each(['wrong checkout', 'QA lost work', 'development changed', 'missing repository', 'failed run'])('refuses completion for %s', async failure => {
    const s = setup(true); await integrateBoth(s)
    const result = group(s)
    if (failure === 'wrong checkout') s.world.currentSecond.sources[0]!.data.commit = JSON.stringify([{ commitId: BASE2 }])
    if (failure === 'QA lost work') s.world.secondQa = '9'.repeat(40)
    if (failure === 'development changed') s.world.secondHead = '8'.repeat(40)
    if (failure === 'missing repository') result.qa.repositories.pop()
    if (failure === 'failed run') s.world.currentSecond.status = 'FAIL'
    await expect(verifyQa(s.host, 't1', result)).rejects.toThrow()
  })
  it('checks the actual fixed branch checkout, not build inputs or old merge-manager output', () => {
    expect(pipelineCommit(run(3), PATH, 'qa')).toBe(MERGED)
    expect(() => pipelineCommit(run(3), PATH, 'other')).toThrow('no verified checkout')
  })
})

describe('local tests then project publications then deployed QA testing', () => {
  const projects = [
    { repository: 'repo-1', pipeline_id: '11', unit_test_command: 'unit app' },
    { repository: 'repo-2', pipeline_id: '22', unit_test_command: 'unit service' },
  ]
  it('runs every local test before permitting either project publication and records executed QA tests', async () => {
    const s = setup(true); s.records.clear()
    const local = vi.fn(async () => 'Ran 4 tests: OK')
    await prepareQa(s.host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', local)
    expect(local.mock.calls).toEqual([['unit app', '/work/app'], ['unit service', '/work/service']])
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11', ['repo-1', 'repo-2'])
    await expect(testQa(s.host, 't1', 'repo-1', 'qa script', local)).rejects.toThrow('ALL involved projects')
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-2', '22', ['repo-1', 'repo-2'])
    await expect(verifyQa(s.host, 't1', group(s))).rejects.toThrow('orchestrator_qa_test')
    const qa = vi.fn(async () => 'QA_ENV_HTTP_PASS')
    await testQa(s.host, 't1', 'app', 'qa script', qa)
    expect(qa).toHaveBeenCalledWith('qa script', '/work/app', expect.objectContaining({ DSH_QA_ENVIRONMENT: 'http://qa.example.test',
      DSH_QA_EXPECTED_PROJECTS: expect.stringContaining('repo-2') }))
    expect(await verifyQa(s.host, 't1', group(s))).toMatchObject({ environment: 'http://qa.example.test', test_output: 'QA_ENV_HTTP_PASS',
      repositories: [{ repository: 'repo-1', repository_name: 'app', unit_tests: { command: 'unit app', commit: COMMIT } }, { repository: 'repo-2', repository_name: 'service', unit_tests: { command: 'unit service', commit: COMMIT2 } }] })
  })
  it('blocks ALL publications when the second project local test fails', async () => {
    const s = setup(true); s.records.clear()
    const local = vi.fn(async (command: string) => { if (command === 'unit service') throw new Error('unit failed'); return 'OK' })
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', local)).rejects.toThrow('unit failed')
    for (const [id, pid] of [['repo-1', '11'], ['repo-2', '22']]) {
      await expect(integrateQa(s.host, 't1', 'SIQB-1', id!, pid!, ['repo-1', 'repo-2'])).rejects.toThrow('local unit tests for ALL')
    }
    expect(s.calls.some(args => args[1] === 'flow-create-pipeline-run')).toBe(false)
  })
  it('requires re-testing all local projects after any commit changes', async () => {
    const s = setup(true); planBoth(s)
    s.world.secondHead = 'c'.repeat(40)
    await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11', ['repo-1', 'repo-2'])).rejects.toThrow('changed after local unit tests')
  })
  it('does not trust a QA pass claim when the actual environment command failed', async () => {
    const s = setup(true); await integrateBoth(s)
    await expect(testQa(s.host, 't1', 'repo-1', 'qa script', async () => { throw new Error('QA HTTP mismatch') })).rejects.toThrow('QA HTTP mismatch')
    await expect(verifyQa(s.host, 't1', group(s))).rejects.toThrow('orchestrator_qa_test')
  })
  it('does not accept an old QA test after a new publication', async () => {
    const s = setup(true); await integrateBoth(s)
    s.world.latestSecond = s.world.currentSecond
    s.world.secondHead = 'c'.repeat(40); retestLocal(s)
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-2', '22', ['repo-1', 'repo-2'])
    expect(s.records.get(KV.yunxiao.qaTest('t1'))).toBeUndefined()
  })
  it('keeps one fixed pipeline per project and refuses duplicate project pipelines', async () => {
    const s = setup(true)
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', [{ ...projects[0]!, pipeline_id: '99' }], 'http://qa.example.test', async () => 'OK')).rejects.toThrow('assigned QA pipeline')
    s.records.clear()
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', [projects[0]!, { ...projects[1]!, pipeline_id: '11' }], 'http://qa.example.test', async () => 'OK')).rejects.toThrow('separate QA pipeline')
  })
  it('does not test dirty worktrees or publish commits other than the local tested version', async () => {
    const s = setup()
    vi.mocked(s.commands.git).mockImplementation(async args => args[0] === 'status' ? ' M source.ts' : args[0] === 'branch' ? 'SIQB-1' : args[1] === '--show-toplevel' ? '/work/app' : COMMIT)
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', [projects[0]!], 'http://qa.example.test', async () => 'OK')).rejects.toThrow('Commit all project changes')
  })
})


it('uses real SQLite for local tests, publication invalidation and QA execution, releasing locks after failure', async () => {
  const s = setup(true)
  const directory = mkdtempSync(join(tmpdir(), 'qa-store-'))
  let store = new Store(join(directory, 'state.sqlite'))
  const host = { commands: s.commands, get store() { return store } }
  const projects = [{ repository: 'repo-1', pipeline_id: '11', unit_test_command: 'unit app' },
    { repository: 'repo-2', pipeline_id: '22', unit_test_command: 'unit service' }]
  try {
    await expect(prepareQa(host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', async command => {
      if (command === 'unit service') throw new Error('controlled unit failure')
      return 'OK'
    })).rejects.toThrow('controlled unit failure')
    await prepareQa(host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', async () => 'Ran tests: OK')
    await integrateQa(host, 't1', 'SIQB-1', 'repo-1', '11', ['repo-1', 'repo-2'])
    await integrateQa(host, 't1', 'SIQB-1', 'repo-2', '22', ['repo-1', 'repo-2'])
    await testQa(host, 't1', 'repo-1', 'QA HTTP tests', async () => 'QA_DEPLOYED_MAIN_FLOW_PASS')
    store.close(); store = new Store(join(directory, 'state.sqlite'))
    expect(await verifyQa(host, 't1', group(s))).toMatchObject({ test_output: 'QA_DEPLOYED_MAIN_FLOW_PASS', verified: true })
    vi.spyOn(store, 'delete').mockImplementationOnce(() => { throw new Error('storage unavailable') })
    await expect(prepareQa(host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', async () => 'OK')).rejects.toThrow('storage unavailable')
    await prepareQa(host, 't1', 'SIQB-1', '/work', projects, 'http://qa.example.test', async () => 'OK')
    expect(store.get(KV.yunxiao.qaTest('t1'))).toBeUndefined()
    await expect(verifyQa(host, 't1', group(s))).rejects.toThrow('orchestrator_qa_test')
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('resolves conflicts only on a QA-only branch and keeps development releasable with real Git', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixed-qa-git-')))
  const repo = join(root, 'app'), remote = join(root, 'remote.git'), work = join(root, 'work'), dev = join(work, 'app')
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let store: Store | undefined
  try {
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
    execFileSync('git', ['-c', 'init.defaultBranch=master', 'init', repo], { stdio: 'ignore' })
    git(['config', 'user.name', 'QA']); git(['config', 'user.email', 'qa@example.test']); git(['config', 'commit.gpgsign', 'false'])
    git(['remote', 'add', 'origin', remote]); writeFileSync(join(repo, 'README'), 'base\n'); git(['add', '.']); git(['commit', '-m', 'base'])
    const base = git(['rev-parse', 'HEAD']); git(['push', 'origin', 'HEAD:master', 'HEAD:qa'])
    git(['worktree', 'add', '-b', 'SIQB-1', dev, base]); writeFileSync(join(dev, 'README'), 'development\n'); git(['add', '.'], dev); git(['commit', '-m', 'development'], dev); git(['push', 'origin', 'SIQB-1'], dev)
    git(['checkout', 'qa']); writeFileSync(join(repo, 'README'), 'existing QA change\n'); writeFileSync(join(repo, 'existing.txt'), 'preserve');git(['add', '.']);git(['commit', '-m', 'existing QA history']);git(['push', 'origin', 'qa'])
    const existing = git(['rev-parse', 'HEAD'])
    const deployment = testDeployment({ github: undefined, codeup: testCodeup({ workspace: root, repositories: [{ id: 'repo-1', path: PATH, name: 'app' }] }) })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    let builtRun: ReturnType<typeof run> | undefined, latestRun = run(2), nextRun = 3
    const api = vi.spyOn(commands, 'aliyun').mockImplementation((async (first: unknown, second?: string[]) => {
      const args = (second ?? first) as string[]
      if (args[1] === 'flow-get-pipeline') return { name: 'qa-app', pipelineConfig: { flow: `sources:\n  app:\n    endpoint: https://codeup.aliyun.com/${PATH}.git\n    branch: qa\n` } }
      if (args[1] === 'flow-get-latest-pipeline-run') return latestRun
      if (args[1] === 'flow-create-pipeline-run') return nextRun++
      if (args[1] === 'flow-get-pipeline-run') return builtRun
      throw new Error('unexpected native QA test call')
    }) as never)
    store = new Store(join(root, 'state.sqlite')); const host = { commands, store }
    const projects = [{ repository: 'repo-1', pipeline_id: '11', unit_test_command: 'unit' }]
    await prepareQa(host, 't1', 'SIQB-1', work, projects, 'http://qa.example.test', async () => 'unit passed')
    await expect(integrateQa(host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('QA merge conflict')
    expect(api.mock.calls.some(args => ((args[1] ?? args[0]) as string[])[1] === 'flow-create-pipeline-run')).toBe(false)
    expect(git(['rev-parse', 'origin/qa'])).toBe(existing)
    const development = git(['rev-parse', 'HEAD'], dev), candidate = join(work, '.qa', 'app')
    git(['worktree', 'add', '-b', 'SIQB-1-qa', candidate, development])
    try { git(['merge', 'origin/qa', '--no-edit'], candidate) } catch { /* Resolve only on the disposable QA branch. */ }
    writeFileSync(join(candidate, 'README'), 'existing QA change\ndevelopment\n');git(['add', '.'], candidate);git(['commit', '-m', 'resolve QA candidate'], candidate);git(['push', 'origin', 'SIQB-1-qa'], candidate)
    await prepareQa(host, 't1', 'SIQB-1', work, [{ ...projects[0]!, integration_branch: 'SIQB-1-qa' }], 'http://qa.example.test', async () => 'unit passed')
    const receipt = await integrateQa(host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(git(['merge-base', '--is-ancestor', existing, receipt.qaCommit!])).toBe('')
    expect(git(['merge-base', '--is-ancestor', receipt.commit, receipt.qaCommit!])).toBe('')
    expect(git(['rev-parse', 'origin/master'])).toBe(base)
    expect(git(['show', `${receipt.qaCommit}:existing.txt`])).toBe('preserve')
    expect(git(['rev-parse', 'HEAD'], dev)).toBe(development)
    expect(receipt.commit).toBe(development)
    expect(git(['rev-list', '--count', `${base}..${development}`])).toBe('1')
    expect(() => git(['merge-base', '--is-ancestor', existing, development])).toThrow()
    expect(git(['merge-base', '--is-ancestor', receipt.integrationCommit!, receipt.qaCommit!])).toBe('')
    // Development alone is insufficient: deployment must include the tested conflict resolution too.
    builtRun = run(9, PATH, 11, development)
    const qaRunner = vi.fn(async () => 'QA passed')
    await expect(testQa(host, 't1', 'repo-1', 'QA test', qaRunner,
      [{ repository: 'repo-1', pipeline_id: '11', run_id: '9' }])).rejects.toThrow('does not contain')
    expect(qaRunner).not.toHaveBeenCalled()
    git(['checkout', '-b', 'colleague', receipt.qaCommit!]);writeFileSync(join(repo, 'colleague.txt'), 'shared QA advancement');git(['add', '.']);git(['commit', '-m', 'other work item']);git(['push', 'origin', 'HEAD:qa'])
    const shared = git(['rev-parse', 'HEAD']); builtRun = run(9, PATH, 11, shared)
    const tested = await testQa(host, 't1', 'repo-1', 'QA test', qaRunner,
      [{ repository: 'repo-1', pipeline_id: '11', run_id: '9' }])
    expect(tested.projects[0]).toMatchObject({ commit: development, qaCommit: shared, runId: '9' })
    const evidence = { verification: 'QA passed', qa: { repository: 'repo-1', pipeline_id: '11', run_id: '9', main_flow_passed: true, evidence: 'QA passed' } }
    writeFileSync(join(repo, 'colleague.txt'), 'another shared change');git(['add', '.']);git(['commit', '-m', 'later work item']);git(['push', 'origin', 'HEAD:qa'])
    expect(await verifyQa(host, 't1', evidence)).toMatchObject({ verified: true })
    expect(git(['rev-parse', 'HEAD'], dev)).toBe(development)
    // A team rebuild changes remote-tracking refs; fetching it must not get stuck on the old cache.
    git(['--git-dir', remote, 'update-ref', 'refs/heads/qa', base])
    await expect(verifyQa(host, 't1', evidence)).rejects.toThrow('does not contain')
    expect(git(['rev-parse', 'origin/qa'])).toBe(base)
    latestRun = builtRun!; nextRun = 10
    await prepareQa(host, 't1', 'SIQB-1', work, projects, 'http://qa.example.test', async () => 'unit passed')
    const rebuilt = await integrateQa(host, 't1', 'SIQB-1', 'repo-1', '11')
    expect(rebuilt.runId).toBe('10')
    expect(git(['merge-base', '--is-ancestor', development, rebuilt.qaCommit!])).toBe('')
    expect(() => git(['merge-base', '--is-ancestor', existing, rebuilt.qaCommit!])).toThrow()
    // A remote-only development rewind produces a domain error, not a fetch rejection.
    builtRun = latestRun = run(10, PATH, 11, rebuilt.qaCommit!)
    git(['--git-dir', remote, 'update-ref', 'refs/heads/SIQB-1', base])
    await expect(integrateQa(host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('Remote development or QA-only branch differs')
    await expect(testQa(host, 't1', 'repo-1', 'QA test', qaRunner)).rejects.toThrow('Development commit changed')
    expect(git(['rev-parse', 'origin/SIQB-1'])).toBe(base)
    expect(git(['rev-parse', 'HEAD'], dev)).toBe(development)
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }) }
}, 15_000)


it('does not let later calls drop a registered project or duplicate it by an alias', async () => {
  const s = setup(true); await integrateBoth(s)
  s.world.latest = s.world.current
  await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11', ['repo-1'])
  await expect(verifyQa(s.host, 't1', s.result)).rejects.toThrow('every work-item repository')
  const result = group(s); result.qa.repositories[1]!.repository = PATH
  await expect(verifyQa(s.host, 't1', result)).rejects.toThrow('every work-item repository')
})
it('does not contact unrelated workspace repositories to discover scope', async () => {
  const s = setup(true)
  await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  await testQa(s.host, 't1', 'repo-1', 'qa', async () => 'QA passed')
  await verifyQa(s.host, 't1', s.result)
  expect(s.commands.git).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('/service'))
  expect(s.commands.git).not.toHaveBeenCalledWith(expect.arrayContaining(['ls-remote']), expect.anything())
})
it('allows newer shared QA heads and tested deployments containing the work', async () => {
  const s = setup(); await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  const newer = '9'.repeat(40); s.ancestors.set(newer, new Set([MERGED])); s.world.qa = newer
  s.world.current = run(8, PATH, 11, newer)
  const tested = await testQa(s.host, 't1', 'app', 'qa', async () => 'QA passed', [{ repository: 'app', pipeline_id: '11', run_id: '8' }])
  expect(tested.projects[0]).toMatchObject({ runId: '8', qaCommit: newer, commit: COMMIT })
  const newerAgain = '8'.repeat(40); s.ancestors.set(newerAgain, new Set([newer])); s.world.qa = newerAgain
  expect(await verifyQa(s.host, 't1', { ...s.result, qa: { ...s.result.qa, run_id: '8' } })).toMatchObject({ verified: true })
})
it('keeps pending MR identity when the platform requires reviews before merge', async () => {
  const s = setup(); s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.mergeMode = 'merge-request'
  const original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'codeup-merge-change-request') throw new Error('review required')
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('review required')
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))).toMatchObject({ mergeRequest: 9 })
  expect(s.host.store.get(KV.yunxiao.qaMr('org-1', 'repo-1', 9))).toMatchObject({ ticketId: 't1', sourceBranch: 'SIQB-1', qaBranch: 'qa' })
})

it('reconciles a lost pipeline creation reply without a duplicate run or lost MR link', async () => {
  const s = setup(); s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.mergeMode = 'merge-request'
  const original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let starts = 0
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run') { starts++; s.world.latest = run(3); throw new Error('reply lost after create') }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('reply lost')
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '3', mergeRequest: 9 })
  expect(starts).toBe(1)
})
it('reuses a successful publication when colleagues advance shared QA', async () => {
  const s = setup(); await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  const newer = '9'.repeat(40); s.ancestors.set(newer, new Set([MERGED])); s.world.qa = newer; s.world.latest = run(8, PATH, 11, newer)
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '3' })
  expect(s.calls.filter(args => args[1] === 'flow-create-pipeline-run')).toHaveLength(1)
  s.world.latest = run(7)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('stale')
})
it('discovers omitted ticket worktrees locally without fetching unrelated repositories', async () => {
  const s = setup(true), root = mkdtempSync(join(tmpdir(), 'qa-scope-'))
  try {
    s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.directory = join(root, 'app')
    await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
    mkdirSync(join(root, 'service'))
    await expect(verifyQa(s.host, 't1', s.result)).rejects.toThrow('every work-item repository')
    expect(s.host.store.get(KV.yunxiao.qaScope('t1'))!.repositories).toEqual(['repo-1', 'repo-2'])
    expect(s.commands.git).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('/service'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('uses release/qa as the fixed integration branch', async () => {
  const s = setup(); s.world.sourceBranch = 'release/qa'; s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.qaBranch = 'release/qa'
  const receipt = await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  expect(receipt.qaBranch).toBe('release/qa')
  expect(s.commands.pushQa).toHaveBeenCalledWith('release/qa', MERGED, expect.any(String))
  expect(JSON.parse(s.calls.find(args => args[1] === 'flow-create-pipeline-run')!.at(-1)!)).toEqual({ runningBranchs: { 'https://codeup.aliyun.com/org-1/app.git': 'release/qa' } })
})
it.each([false, true])('retires the tracked development MR when replacing it with the QA-only MR (lost close reply: %s)', async lostReply => {
  const s = setup(); const project = s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!; project.mergeMode = 'merge-request'; s.world.mrConflict = true
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('QA merge conflict')
  const old = { ...s.world.mr! }, replacement = { ...old, localId: 10, sourceBranch: 'SIQB-1-qa' }, candidate = '1'.repeat(40)
  Object.assign(project, { integrationBranch: 'SIQB-1-qa', integrationDirectory: '/work/.qa/app', integrationCommit: candidate })
  s.ancestors.set(candidate, new Set([COMMIT, BASE])); s.ancestors.get(MERGED)!.add(candidate)
  const git = vi.mocked(s.commands.git).getMockImplementation()!
  vi.mocked(s.commands.git).mockImplementation(async (args, cwd) => {
    if (cwd.includes('/.qa/')) { if (args[0] === 'branch') return 'SIQB-1-qa'; if (args[0] === 'rev-parse' && args[1] === 'HEAD') return candidate }
    if (args[0] === 'rev-parse' && args[1]?.startsWith('refs/remotes/')) return (await git(args, cwd)).split('\n').map((sha, i) => args[i + 1]!.endsWith('/SIQB-1-qa') ? candidate : sha).join('\n')
    return git(args, cwd)
  })
  const native = vi.mocked(s.commands.aliyun).getMockImplementation()!, events: string[] = []
  let created = false
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[], id = args[args.indexOf('--local-id') + 1]
    switch (args[1]) {
      case 'codeup-list-change-requests': return created ? [replacement, old] : [old]
      case 'codeup-create-change-request': created = true; events.push('create 10'); return replacement
      case 'codeup-get-change-request': return { ...(id === '9' ? old : replacement), conflictCheckStatus: 'NO_CONFLICT' }
      case 'codeup-close-change-request': events.push('close 9'); old.status = 'CLOSED'; if (lostReply) { lostReply = false; throw new Error('close response lost') }; return old
      case 'codeup-merge-change-request': events.push('merge 10'); replacement.status = 'MERGED'; s.world.qa = MERGED; return replacement
    }
    return native(first as never, second as never)
  }) as never)
  if (lostReply) {
    await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('close response lost')
    expect(events).toEqual(['create 10', 'close 9'])
  }
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ mergeRequest: 10, integrationCommit: candidate, commit: COMMIT })
  expect(events).toEqual(['create 10', 'close 9', 'merge 10'])
  expect(s.host.store.get(KV.yunxiao.qaMr('org-1', 'repo-1', 9))).toMatchObject({ superseded: true })
  expect(s.host.store.get(KV.yunxiao.qaMr('org-1', 'repo-1', 10))).toMatchObject({ sourceBranch: 'SIQB-1-qa' })
})
it('does not retire an old QA MR or merge its replacement until native closure is confirmed', async () => {
  const s = setup(), project = s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!
  Object.assign(project, { mergeMode: 'merge-request', integrationBranch: 'SIQB-1-qa', integrationDirectory: '/work/.qa/app', integrationCommit: COMMIT })
  const old = { localId: 9, sourceBranch: 'SIQB-1', targetBranch: 'qa', sourceProjectId: 'repo-1', targetProjectId: 'repo-1', status: 'TO_BE_MERGED' }
  s.world.mr = { ...old, localId: 10, sourceBranch: 'SIQB-1-qa' }
  s.host.store.set(KV.yunxiao.qaMr('org-1', 'repo-1', 9), { ticketId: 't1', repository: 'repo-1', mergeRequest: 9, sourceBranch: 'SIQB-1', qaBranch: 'qa', commit: COMMIT })
  const git = vi.mocked(s.commands.git).getMockImplementation()!
  vi.mocked(s.commands.git).mockImplementation(async (args, cwd) => args[0] === 'branch' && cwd.includes('/.qa/') ? 'SIQB-1-qa' : git(args, cwd))
  const native = vi.mocked(s.commands.aliyun).getMockImplementation()!
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'codeup-get-change-request' && args[args.indexOf('--local-id') + 1] === '9') return old
    if (args[1] === 'codeup-close-change-request') return false
    return native(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('Previous QA MR did not close')
  expect(s.host.store.get(KV.yunxiao.qaMr('org-1', 'repo-1', 9))?.superseded).toBeUndefined()
  expect(s.calls.some(args => ['codeup-merge-change-request', 'flow-create-pipeline-run'].includes(args[1]!))).toBe(false)
})

describe('adopting a changed fixed QA target', () => {
  const selected = [{ repository: 'repo-1', pipeline_id: '11', unit_test_command: 'unit app' }]
  it('adopts an idle new target, reruns local tests and invalidates only obsolete acceptance', async () => {
    const s = setup(); s.world.sourceBranch = 'release/qa'
    s.records.set(KV.yunxiao.qa('t1', 'repo-1'), { repository: 'repo-1', pipelineId: '11', runId: '3', branch: 'SIQB-1', commit: COMMIT, qaBranch: 'qa', qaCommit: MERGED })
    s.records.set(KV.yunxiao.qaDelivery('t1', 'repo-1'), { branch: 'SIQB-1', commit: COMMIT, sourceBranch: 'SIQB-1', sourceCommit: COMMIT, qaBranch: 'qa', qaCommit: MERGED, beforeRunId: '2' })
    s.records.set(KV.yunxiao.qaTest('t1'), { output: 'old acceptance' })
    const local = vi.fn(async () => 'new unit result')
    const plan = await prepareQa(s.host, 't1', 'SIQB-1', '/work', selected, 'http://qa.example.test', local)
    expect(plan).toMatchObject({ tested: true, projects: [{ qaBranch: 'release/qa', output: 'new unit result' }] })
    expect(local).toHaveBeenCalledExactlyOnceWith('unit app', '/work/app')
    expect(s.host.store.get(KV.yunxiao.qa('t1', 'repo-1'))).toBeUndefined()
    expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))).toBeUndefined()
    expect(s.host.store.get(KV.yunxiao.qaTest('t1'))).toBeUndefined()
    expect(s.calls.find(args => args[1] === 'flow-list-pipeline-runs')).toEqual(expect.arrayContaining(['--status', 'RUNNING', '--per-page', '1']))
    expect(s.commands.pushQa).not.toHaveBeenCalled()
    expect(s.calls.some(args => args[1] === 'flow-create-pipeline-run')).toBe(false)
  })
  it.each(['running list', 'unfinished latest', 'unfinished receipt'])('keeps old acceptance when delivery is active: %s', async phase => {
    const s = setup(); s.world.sourceBranch = 'release/qa'
    const oldPlan = structuredClone(s.host.store.get(KV.yunxiao.qaPlan('t1')))
    s.records.set(KV.yunxiao.qaTest('t1'), { output: 'old acceptance' })
    if (phase === 'running list') s.world.activeRuns = [{ pipelineRunId: 8 }]
    if (phase === 'unfinished latest') s.world.latest.status = 'QUEUED'
    if (phase === 'unfinished receipt') {
      s.records.set(KV.yunxiao.qa('t1', 'repo-1'), { repository: 'repo-1', pipelineId: '11', runId: '3', branch: 'SIQB-1', commit: COMMIT, qaBranch: 'qa' })
      s.world.current.status = 'RUNNING'
    }
    const local = vi.fn(async () => 'OK')
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', selected, 'http://qa.example.test', local)).rejects.toThrow('rerun orchestrator_qa_prepare')
    expect(local).not.toHaveBeenCalled()
    expect(s.host.store.get(KV.yunxiao.qaPlan('t1'))).toEqual(oldPlan)
    expect(s.host.store.get(KV.yunxiao.qaTest('t1'))).toEqual({ output: 'old acceptance' })
  })
  it('waits for an old pending MR and can then adopt the new branch without manually clearing KV', async () => {
    const s = setup(); s.world.sourceBranch = 'release/qa'
    s.world.mr = { localId: 9, sourceBranch: 'SIQB-1', targetBranch: 'qa', sourceProjectId: 'repo-1', targetProjectId: 'repo-1', status: 'TO_BE_MERGED' }
    s.records.set(KV.yunxiao.qaMr('org-1', 'repo-1', 9), { ticketId: 't1', repository: 'repo-1', mergeRequest: 9, sourceBranch: 'SIQB-1', qaBranch: 'qa', commit: COMMIT })
    await expect(prepareQa(s.host, 't1', 'SIQB-1', '/work', selected, 'http://qa.example.test', async () => 'OK')).rejects.toThrow('QA MR !9')
    expect(s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.qaBranch).toBe('qa')
    s.world.mr.status = 'CLOSED'
    expect(await prepareQa(s.host, 't1', 'SIQB-1', '/work', selected, 'http://qa.example.test', async () => 'OK')).toMatchObject({ tested: true, projects: [{ qaBranch: 'release/qa' }] })
  })
  it.each([404, 403, 503])('handles missing history versus unavailable status safely (%s)', async code => {
    const s = setup(); s.world.sourceBranch = 'release/qa'
    const original = vi.mocked(s.commands.aliyun).getMockImplementation()!
    vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
      const args = (second ?? first) as string[]
      if (args[1] === 'flow-get-latest-pipeline-run') throw new CliError('run history unavailable', code)
      return original(first as never, second as never)
    }) as never)
    const operation = prepareQa(s.host, 't1', 'SIQB-1', '/work', selected, 'http://qa.example.test', async () => 'OK')
    if (code === 404) await expect(operation).resolves.toMatchObject({ tested: true })
    else { await expect(operation).rejects.toThrow('run history unavailable'); expect(s.host.store.get(KV.yunxiao.qaPlan('t1'))!.projects[0]!.qaBranch).toBe('qa') }
  })
})
it('does not repeat an uncertain create when latest still reports the old run', async () => {
  const s = setup(), original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let starts = 0
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run') { starts++; throw new Error('lost create reply') }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('lost create reply')
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('unconfirmed')
  expect(starts).toBe(1)
  s.world.latest = run(3)
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '3' })
  expect(starts).toBe(1)
})
it('surfaces invalid terminal checkout metadata instead of creating a duplicate', async () => {
  const s = setup(), original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let starts = 0
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run') { starts++; throw new Error('lost create reply') }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('lost create reply')
  s.world.latest = run(3); s.world.latest.sources = []
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('no verified checkout')
  expect(starts).toBe(1)
})
it('permits retry after a definite native request rejection, without treating it as a lost response', async () => {
  const s = setup(), original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let reject = true
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run' && reject) { reject = false; throw new CliError('bad request', 400) }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('bad request')
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))?.createAttempted).toBeUndefined()
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '3' })
})
it('does not erase an uncertain creation when new development commits are prepared', async () => {
  const s = setup(), original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let starts = 0
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run') { starts++; if (starts === 1) throw new Error('lost create reply'); return 4 }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('lost create reply')
  s.world.head = '9'.repeat(40); retestLocal(s)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('earlier commit is unconfirmed')
  expect(starts).toBe(1)
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))).toMatchObject({ commit: COMMIT, createAttempted: true })
  s.world.latest = run(3)
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '4', commit: s.world.head })
  expect(starts).toBe(2)
})
it('can republish the same tested source after QA is rebuilt despite a previously successful run', async () => {
  const s = setup(); await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  s.world.latest = run(3); s.world.qa = BASE
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))?.createAttempted).toBeUndefined()
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '4' })
})
it.each([false, true])('preserves a newer known run after partial receipt storage failure (new source: %s)', async newSource => {
  const s = setup(); await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11'); s.world.latest = run(3, PATH, 11, MERGED, 'FAIL')
  const set = s.host.store.set.bind(s.host.store)
  let failed = false
  vi.spyOn(s.host.store, 'set').mockImplementation(((key: string, value: { runId?: string }) => {
    if (!failed && key === KV.yunxiao.qaLatest('org-1', '11') && value.runId === '4') { failed = true; throw new Error('store interrupted after known ID') }
    return set(key as never, value as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('store interrupted')
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))).toMatchObject({ createdRunId: '4' })
  if (newSource) { s.world.head = '9'.repeat(40); retestLocal(s); await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('stale') }
  else expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '4' })
  expect(s.calls.filter(args => args[1] === 'flow-create-pipeline-run')).toHaveLength(2)
})
it.each(['failed run', 'rebuilt QA'])('does not reuse old run state after an uncertain retry (%s)', async reason => {
  const s = setup(); await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')
  s.world.latest = run(3, PATH, 11, MERGED, reason === 'failed run' ? 'FAIL' : 'SUCCESS')
  if (reason === 'rebuilt QA') s.world.qa = BASE
  const original = vi.mocked(s.commands.aliyun).getMockImplementation()!
  let starts = 0
  vi.mocked(s.commands.aliyun).mockImplementation((async (first: unknown, second?: string[]) => {
    const args = (second ?? first) as string[]
    if (args[1] === 'flow-create-pipeline-run') { starts++; throw new Error('lost retry reply') }
    return original(first as never, second as never)
  }) as never)
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('lost retry reply')
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))).toMatchObject({ createAttempted: true })
  expect(s.host.store.get(KV.yunxiao.qaDelivery('t1', 'repo-1'))?.createdRunId).toBeUndefined()
  await expect(integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).rejects.toThrow('unconfirmed')
  expect(starts).toBe(1)
  s.world.latest = run(4)
  expect(await integrateQa(s.host, 't1', 'SIQB-1', 'repo-1', '11')).toMatchObject({ runId: '4' })
  expect(starts).toBe(1)
})
it('returns lossless tool JSON when no QA-only candidate is selected', async () => {
  const s = setup(); s.records.clear()
  const prepared = await prepareQa(s.host, 't1', 'SIQB-1', '/work', [{ repository: 'repo-1', pipeline_id: '11', unit_test_command: 'unit' }], 'http://qa.example.test', async () => 'OK')
  expect(prepared).toEqual(JSON.parse(JSON.stringify(prepared)))
  expect(prepared.projects[0]).not.toHaveProperty('integrationCommit')
  expect(prepared.projects[0]).not.toHaveProperty('integrationOutput')
})
