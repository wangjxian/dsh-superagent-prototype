/** Merge into fixed QA branches and verify deployed runs before a work item can finish. */
import { z } from 'zod'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { parse } from 'yaml'
import { codeupPath } from '../deployment.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'
import { KV } from '../kv.ts'
import { repositoryOf } from '../sources/codeup-hosting.ts'
import { QaResultSchema } from '../sources/yunxiao-write.ts'
import type { Store } from './store.ts'

const Text = z.string().trim().min(1)
const Sha = z.string().regex(/^[a-f0-9]{40}$/i)
const Id = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
const Run = z.looseObject({ pipelineId: Id, pipelineRunId: Id, status: Text,
  sources: z.array(z.looseObject({ data: z.unknown() })).default([]) })
type QaHost = { commands: Commands; store: Pick<Store, 'get' | 'set' | 'delete' | 'keys'> }
export type QaRunner = (command: string, directory: string, variables?: Record<string, string>) => Promise<string>
export const QaProjectSchema = z.object({ repository: Text, pipeline_id: z.string().regex(/^[1-9]\d*$/), unit_test_command: Text.max(4000), merge_mode: z.enum(['direct', 'merge-request']).default('direct'), integration_branch: Text.optional() }).strict()
export const QaDeploymentSchema = z.object({ repository: Text, pipeline_id: z.string().regex(/^[1-9]\d*$/), run_id: z.string().regex(/^[1-9]\d*$/) }).strict()
export const QaEnvironmentSchema = Text.url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Use the QA environment URL without credentials or tokens')
const starting = new Set<string>()
const testing = new Set<string>()

async function localCommit(commands: Commands, directory: string, branch: string): Promise<string> {
  if (resolve((await commands.git(['rev-parse', '--show-toplevel'], directory)).trim()) !== resolve(directory)
    || (await commands.git(['branch', '--show-current'], directory)).trim() !== branch) throw new Error('Local tests must use this work item project worktree')
  if ((await commands.git(['status', '--porcelain'], directory)).trim()) throw new Error('Commit all project changes before local unit tests or QA delivery')
  return Sha.parse((await commands.git(['rev-parse', 'HEAD'], directory)).trim())
}

/** Test the complete project set before any project can publish to its fixed QA pipeline. */
export async function prepareQa(host: QaHost, ticketId: string, serial: string, directory: string,
  projects: z.input<typeof QaProjectSchema>[], environment: string, run: QaRunner) {
  const account = host.commands.deployment.codeup
  if (!account || !directory || !/^[A-Za-z0-9]+-\d+$/.test(serial)) throw new Error('QA preparation needs the work item and its workspace')
  environment = QaEnvironmentSchema.parse(environment)
  const selected = z.array(QaProjectSchema).min(1).parse(projects)
  const previous = host.store.get(KV.yunxiao.qaPlan(ticketId))
  const entries = selected.map(item => {
    const repo = repositoryOf(account, item.repository)
    if (!repo) throw new Error('QA project is not in the configured workspace')
    if (previous?.projects.some(old => old.repository === repo.id && old.pipelineId !== item.pipeline_id)) throw new Error('Each project must keep its assigned QA pipeline')
    if (item.integration_branch && item.integration_branch !== `${serial}-qa`) throw new Error('QA conflict resolution must use <work-item serial>-qa, never the development branch')
    return { repository: repo.id, pipelineId: item.pipeline_id, command: item.unit_test_command, directory: join(directory, repo.name), qaBranch: '', mergeMode: item.merge_mode,
      ...(item.integration_branch ? { integrationBranch: item.integration_branch, integrationDirectory: join(directory, '.qa', repo.name) } : {}) }
  })
  if (new Set(entries.map(item => item.repository)).size !== entries.length || new Set(entries.map(item => item.pipelineId)).size !== entries.length) throw new Error('Each project needs exactly one separate QA pipeline')
  const required = host.store.get(KV.yunxiao.qaScope(ticketId))
  if (required && required.branch !== serial) throw new Error('The QA work item branch changed')
  if (required?.repositories.some(id => !entries.some(item => item.repository === id))) throw new Error('The QA project plan cannot omit an involved project')
  if (previous && previous.environment !== environment) throw new Error('Keep the same QA integration environment for this work item')
  if (testing.has(ticketId) || entries.some(item => starting.has(`${account.organization}:${item.pipelineId}`))) throw new Error('Wait for the active QA operation first')
  testing.add(ticketId)
  try {
    const changed: string[] = []
    for (const item of entries) {
      item.qaBranch = (await checkPipeline(host, account.organization, repositoryOf(account, item.repository)!.path, item.pipelineId)).branch
      const old = previous?.projects.find(project => project.repository === item.repository)
      if (old?.qaBranch && old.qaBranch !== item.qaBranch) {
        await idleQaTarget(host, ticketId, item.repository, item.pipelineId, old.qaBranch, item.qaBranch)
        changed.push(item.repository)
      }
    }
    if (entries.some(item => starting.has(`${account.organization}:${item.pipelineId}`))) throw new Error('Wait for the active QA operation first')
    const plan = { environment, projects: entries, tested: false }
    host.store.set(KV.yunxiao.qaScope(ticketId), { branch: serial, repositories: entries.map(item => item.repository) })
    host.store.set(KV.yunxiao.qaPlan(ticketId), plan)
    host.store.delete(KV.yunxiao.qaTest(ticketId))
    for (const repository of changed) {
      host.store.delete(KV.yunxiao.qa(ticketId, repository))
      host.store.delete(KV.yunxiao.qaDelivery(ticketId, repository))
    }
    const tested = []
    for (const item of entries) {
      const commit = await localCommit(host.commands, item.directory, serial)
      const output = (await run(item.command, item.directory)).slice(-8000)
      if (await localCommit(host.commands, item.directory, serial) !== commit) throw new Error('The project changed during unit tests; test again')
      let integrationCommit: string | undefined, integrationOutput: string | undefined
      if (item.integrationBranch) {
        integrationCommit = await localCommit(host.commands, item.integrationDirectory!, item.integrationBranch)
        if (!await contains(host.commands, item.directory, commit, integrationCommit)) throw new Error('QA-only integration branch must contain the tested development commit')
        integrationOutput = (await run(item.command, item.integrationDirectory!)).slice(-8000)
        if (await localCommit(host.commands, item.integrationDirectory!, item.integrationBranch) !== integrationCommit) throw new Error('QA-only integration branch changed during tests')
      }
      tested.push({ ...item, commit, output, ...(item.integrationBranch ? { integrationCommit: integrationCommit!, integrationOutput: integrationOutput! } : {}) })
    }
    const value = { environment, projects: tested, tested: true }
    host.store.set(KV.yunxiao.qaPlan(ticketId), value)
    return value
  } finally { testing.delete(ticketId) }
}

/** A target change abandons old acceptance only after its native delivery is known to be idle. */
async function idleQaTarget(host: QaHost, ticketId: string, repository: string, pipelineId: string, oldBranch: string, nextBranch: string) {
  const { commands, store } = host, organization = commands.deployment.codeup!.organization
  const context = `QA target changed from ${oldBranch} to ${nextBranch} for ${repositoryOf(commands.deployment.codeup!, repository)!.name}`
  const active = await commands.aliyun(z.array(z.unknown()), YUNXIAO.pipelineRuns(organization, pipelineId, 'RUNNING'))
  if (active.length) throw new Error(`${context}; pipeline ${pipelineId} still has running builds. Wait for or cancel them in Codeup, then rerun orchestrator_qa_prepare`)
  const receipt = store.get(KV.yunxiao.qa(ticketId, repository))
  let latest: z.infer<typeof Run> | undefined
  try { latest = Run.parse(await commands.aliyun(z.unknown(), YUNXIAO.latestPipelineRun(organization, pipelineId))) }
  catch (error) { if (!(error instanceof CliError && error.code === 404 && !receipt)) throw error }
  const runs = latest ? [latest] : []
  if (receipt?.pipelineId === pipelineId && receipt.runId !== String(latest?.pipelineRunId)) {
    runs.push(Run.parse(await commands.aliyun(z.unknown(), YUNXIAO.pipelineRun(organization, pipelineId, receipt.runId))))
  }
  if (runs.some(run => !['SUCCESS', 'FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(run.status))) throw new Error(`${context}; the previous QA run is not finished. Wait for or cancel it, then rerun orchestrator_qa_prepare`)
  const ids = new Set<number>()
  const delivery = store.get(KV.yunxiao.qaDelivery(ticketId, repository))
  if (delivery?.createAttempted) throw new Error(`${context}; a previous pipeline creation has an unconfirmed outcome. Reconcile that request in Codeup before changing the QA target; do not create another run`)
  if (delivery?.qaBranch === oldBranch && delivery.mergeRequest) ids.add(delivery.mergeRequest)
  if (receipt?.qaBranch === oldBranch && receipt.mergeRequest) ids.add(receipt.mergeRequest)
  for (const key of store.keys(KV.yunxiao.qaMr)) {
    if (!key.startsWith(`${KV.yunxiao.qaMr.prefix}${organization}:${repository}:`)) continue
    const mr = store.get(key)
    if (mr && !mr.superseded && mr.ticketId === ticketId && mr.qaBranch === oldBranch) ids.add(mr.mergeRequest)
  }
  for (const id of ids) {
    const mr = await commands.aliyun(z.object({ status: Text.optional(), state: Text.optional() }), YUNXIAO.changeRequest(organization, repository, id))
    if (!['MERGED', 'CLOSED'].includes(mr.status ?? mr.state ?? '')) throw new Error(`${context}; QA MR !${id} is still open or unconfirmed. Complete or close it in Codeup, then rerun orchestrator_qa_prepare`)
  }
}

async function testedPlan(host: QaHost, ticketId: string) {
  const plan = host.store.get(KV.yunxiao.qaPlan(ticketId)), scope = host.store.get(KV.yunxiao.qaScope(ticketId))
  if (!plan?.tested || !scope || testing.has(ticketId)) throw new Error('Run local unit tests for ALL involved projects with orchestrator_qa_prepare before QA publication')
  if (scope.repositories.length !== plan.projects.length || scope.repositories.some(id => !plan.projects.some(item => item.repository === id))) throw new Error('Prepare and test the complete QA project scope again')
  for (const item of plan.projects) {
    if (!item.qaBranch) throw new Error('Prepare local tests with the fixed QA branch pipeline first')
    if (!item.commit || await localCommit(host.commands, item.directory, scope.branch) !== item.commit) throw new Error('A project changed after local unit tests; test ALL involved projects again')
    if (item.integrationBranch && (!item.integrationCommit || !item.integrationDirectory || await localCommit(host.commands, item.integrationDirectory, item.integrationBranch) !== item.integrationCommit)) throw new Error('QA-only integration branch changed after tests; prepare all projects again')
  }
  return plan
}

/** Actual checkout metadata of the fixed QA branch, not a branch-manager merge request list. */
export function pipelineCommit(raw: unknown, path: string, branch: string): string {
  for (const source of Run.parse(raw).sources) {
    const parsed = z.object({ repo: Text, branch: Text, commit: Text, isBranchMode: z.boolean().optional() }).safeParse(source.data)
    if (!parsed.success || codeupPath(parsed.data.repo) !== path || parsed.data.branch !== branch) continue
    if (parsed.data.isBranchMode) throw new Error('QA must build the fixed integration branch, not branch mode')
    return z.array(z.object({ commitId: Sha })).min(1).parse(JSON.parse(parsed.data.commit))[0]!.commitId
  }
  throw new Error('QA run has no verified checkout of its fixed integration branch')
}

/** One network fetch per involved project; ancestry checks then use the local object database. */
async function remoteHeads(commands: Commands, repository: string, branches: string[]): Promise<Record<string, string>> {
  const account = commands.deployment.codeup!, repo = repositoryOf(account, repository)
  if (!repo) throw new Error('QA repository is not in the configured workspace')
  const names = [...new Set(branches)], directory = join(account.workspace, repo.name)
  await commands.git(['fetch', '--no-tags', 'origin', ...names.map(name => `+refs/heads/${name}:refs/remotes/origin/${name}`)], directory)
  const values = (await commands.git(['rev-parse', ...names.map(name => `refs/remotes/origin/${name}`)], directory)).trim().split(/\s+/)
  if (values.length !== names.length) throw new Error('Cannot read QA and development branch heads')
  return Object.fromEntries(names.map((name, i) => [name, Sha.parse(values[i])]))
}

async function checkPipeline(host: QaHost, organization: string, path: string, pipelineId: string): Promise<{ branch: string; endpoint: string }> {
  const pipeline = await host.commands.aliyun(z.object({ name: Text, pipelineConfig: z.object({ flow: Text }) }), YUNXIAO.pipeline(organization, pipelineId))
  if (!/^qa-/i.test(pipeline.name)) throw new Error('Work-item integration may only run qa- pipelines')
  const flow = z.object({ sources: z.record(z.string(), z.object({ endpoint: Text.optional(), branch: Text.optional(), branchMode: z.unknown().optional(), triggerEvents: z.unknown().optional() })) }).parse(parse(pipeline.pipelineConfig.flow))
  if (Object.values(flow.sources).some(source => Array.isArray(source.triggerEvents) ? source.triggerEvents.length > 0 : typeof source.triggerEvents === 'string' ? !!source.triggerEvents.trim() : !!source.triggerEvents)) throw new Error('QA publication requires a manually triggered pipeline: disable source triggerEvents before merging; push/MR triggers can create duplicate runs')
  const sources = Object.values(flow.sources).filter(source => source.endpoint && codeupPath(source.endpoint) === path)
  const source = sources[0], repo = host.commands.deployment.codeup?.repositories.find(item => item.path === path)
  if (sources.length !== 1 || !source?.branch || source.branchMode || ['master', 'main', repo?.defaultBranch].includes(source.branch)) throw new Error('QA pipeline must use one fixed non-trunk integration branch of this project')
  await host.commands.git(['check-ref-format', '--branch', source.branch], join(host.commands.deployment.codeup!.workspace, repo!.name))
  return { branch: source.branch, endpoint: source.endpoint! }
}

async function contains(commands: Commands, directory: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await commands.git(['merge-base', '--is-ancestor', ancestor, descendant], directory); return true }
  catch (error) { if (error instanceof CliError && error.exitCode === 1) return false; throw error }
}

async function qaMr(host: QaHost, ticketId: string, repository: string, sourceBranch: string, branch: string, commit: string, record: (id: number) => void): Promise<number> {
  const account = host.commands.deployment.codeup!
  const Mr = z.looseObject({ localId: z.number().int().positive(), sourceBranch: Text, targetBranch: Text,
    sourceProjectId: z.union([z.number().int().positive(), Text]), targetProjectId: z.union([z.number().int().positive(), Text]), status: Text.optional(), state: Text.optional(), conflictCheckStatus: z.string().optional() })
  let mr: z.infer<typeof Mr> | undefined
  for (let page = 1; page <= 100; page++) {
    const list = await host.commands.aliyun(z.array(Mr), YUNXIAO.openChangeRequests(account.organization, repository, page))
    mr = list.find(item => item.sourceBranch === sourceBranch && item.targetBranch === branch
      && String(item.sourceProjectId) === repository && String(item.targetProjectId) === repository)
    if (mr || list.length < 100) break
    if (page === 100) throw new Error('Cannot reconcile existing QA merge requests; do not create a duplicate')
  }
  if (!mr) mr = await host.commands.aliyun(Mr, YUNXIAO.qaChangeRequest(account.organization, repository, sourceBranch, branch))
  record(mr.localId)
  host.store.set(KV.yunxiao.qaMr(account.organization, repository, mr.localId), { ticketId, repository, mergeRequest: mr.localId, sourceBranch, qaBranch: branch, commit })
  if (sourceBranch.endsWith('-qa')) {
    for (const key of host.store.keys(KV.yunxiao.qaMr)) {
      const old = host.store.get(key)
      if (!key.startsWith(`${KV.yunxiao.qaMr.prefix}${account.organization}:`) || !old || old.superseded || old.ticketId !== ticketId
        || old.repository !== repository || old.mergeRequest === mr.localId || old.sourceBranch !== sourceBranch.slice(0, -3) || old.qaBranch !== branch) continue
      const stale = await host.commands.aliyun(Mr, YUNXIAO.changeRequest(account.organization, repository, old.mergeRequest))
      if (stale.sourceBranch !== old.sourceBranch || stale.targetBranch !== branch || String(stale.sourceProjectId) !== repository || String(stale.targetProjectId) !== repository) throw new Error('Previous QA MR changed; review it before replacing it')
      if (!['MERGED', 'CLOSED'].includes(stale.status ?? stale.state ?? '')) {
        await host.commands.aliyun(YUNXIAO.closeChangeRequest(account.organization, repository, old.mergeRequest))
        const closed = await host.commands.aliyun(Mr, YUNXIAO.changeRequest(account.organization, repository, old.mergeRequest))
        if (!['MERGED', 'CLOSED'].includes(closed.status ?? closed.state ?? '')) throw new Error('Previous QA MR did not close; reread its state before merging the replacement')
      }
      host.store.set(key, { ...old, superseded: true })
    }
  }
  mr = await host.commands.aliyun(Mr, YUNXIAO.changeRequest(account.organization, repository, mr.localId))
  if (mr.sourceBranch !== sourceBranch || mr.targetBranch !== branch || String(mr.sourceProjectId) !== repository || String(mr.targetProjectId) !== repository) throw new Error('QA merge request no longer matches the tested project and fixed branch')
  if (mr.conflictCheckStatus && /conflict|fail/i.test(mr.conflictCheckStatus) && !/^no[_ -]?conflicts?$/i.test(mr.conflictCheckStatus)) throw new Error(`QA merge conflict: resolve on the QA-only <work-item serial>-qa branch, preserving development; prepare all projects with integration_branch and retry`)
  if ((mr.status ?? mr.state) !== 'MERGED' && !/^no[_ -]?conflicts?$/i.test(mr.conflictCheckStatus ?? '')) throw new Error('QA MR conflict check is pending; wait and reread it before merging')
  if ((await remoteHeads(host.commands, repository, [sourceBranch]))[sourceBranch] !== commit) throw new Error('Development commit changed before QA MR merge; test again')
  // shortcut: Codeup has no expected-source-SHA merge parameter; external pushes must be serialized during MR merge.
  if ((mr.status ?? mr.state) !== 'MERGED') await host.commands.aliyun(YUNXIAO.mergeQaChangeRequest(account.organization, repository, mr.localId))
  return mr.localId
}

/** Merge tested code into fixed QA, retaining a durable intention before any external write. */
export async function integrateQa(host: QaHost, ticketId: string, serial: string, repository: string, pipelineId: string,
  repositories: readonly string[] = [repository]) {
  const { commands, store } = host, account = commands.deployment.codeup
  const repo = account && repositoryOf(account, repository)
  if (!account || !repo) throw new Error('QA repository is not in the Codeup workspace')
  if (!/^[A-Za-z0-9]+-\d+$/.test(serial)) throw new Error('QA delivery needs the work item serial branch')
  const declared = repositories.map(name => {
    const item = repositoryOf(account, name)
    if (!item) throw new Error(`QA repository ${name} is not in the configured workspace`)
    return item.id
  })
  if (!declared.includes(repo.id)) throw new Error('The complete QA repository list must include the repository being integrated')
  const scope = store.get(KV.yunxiao.qaScope(ticketId))
  if (scope && scope.branch !== serial) throw new Error('The QA work item branch changed')
  store.set(KV.yunxiao.qaScope(ticketId), { branch: serial, repositories: [...new Set([...(scope?.repositories ?? []), ...declared])] })
  const plan = await testedPlan(host, ticketId), project = plan.projects.find(item => item.repository === repo.id)
  if (!project || project.pipelineId !== pipelineId) throw new Error('Use the QA pipeline assigned to this project in the tested plan')
  const lock = `${account.organization}:${pipelineId}`
  if (starting.has(lock)) throw new Error('Another QA integration is starting; wait and read its run first')
  starting.add(lock)
  try {
    const source = await checkPipeline(host, account.organization, repo.path, pipelineId), qaBranch = source.branch
    if (qaBranch !== project.qaBranch) throw new Error('The fixed QA integration branch changed')
    const sourceBranch = project.integrationBranch ?? serial, sourceCommit = project.integrationCommit ?? project.commit!
    const latest = Run.parse(await commands.aliyun(z.unknown(), YUNXIAO.latestPipelineRun(account.organization, pipelineId)))
    const fence = store.get(KV.yunxiao.qaLatest(account.organization, pipelineId))
    if (fence && Number(latest.pipelineRunId) < Number(fence.runId)) throw new Error('QA latest-run data is stale; wait before publication')
    store.set(KV.yunxiao.qaLatest(account.organization, pipelineId), { runId: String(latest.pipelineRunId) })
    let heads = await remoteHeads(commands, repo.id, [qaBranch, serial, sourceBranch])
    const commit = heads[serial]!, directory = join(account.workspace, repo.name)
    if (commit !== project.commit || heads[sourceBranch] !== sourceCommit) throw new Error('Remote development or QA-only branch differs from the locally tested commit. Reconcile origin and the worktree without force, then prepare again; push only unpublished fast-forward changes')
    const previous = store.get(KV.yunxiao.qa(ticketId, repo.id))
    let prior = store.get(KV.yunxiao.qaDelivery(ticketId, repo.id))
    const sameDelivery = prior?.commit === commit && prior.sourceCommit === sourceCommit && prior.sourceBranch === sourceBranch && prior.qaBranch === qaBranch
    if (prior?.createdRunId && !sameDelivery && Number(latest.pipelineRunId) < Number(prior.createdRunId)) throw new Error('QA latest-run data is stale; wait for the known previous run before publishing new commits')
    if (prior?.createAttempted && !sameDelivery) {
      if (Number(latest.pipelineRunId) <= Number(prior.beforeRunId)) throw new Error('Previous QA pipeline creation for an earlier commit is unconfirmed; reconcile it before publishing new commits')
      const built = pipelineCommit(latest, repo.path, prior.qaBranch)
      if (!await contains(commands, directory, prior.sourceCommit, built)) throw new Error('Cannot identify the previous QA creation; no new run will be started')
      prior = { ...prior, createdRunId: String(latest.pipelineRunId) }
      delete prior.createAttempted
      store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), prior)
    }
    let delivery: NonNullable<typeof prior> = sameDelivery
      ? prior! : { branch: serial, commit, sourceBranch, sourceCommit, qaBranch, beforeRunId: String(latest.pipelineRunId) }
    const receipt = (runId: string, qaCommit: string) => {
      const value = { pipelineId, runId, repository: repo.id, branch: serial, commit, qaBranch, qaCommit,
        ...(sourceBranch !== serial ? { integrationBranch: sourceBranch, integrationCommit: sourceCommit } : {}),
        ...(delivery.mergeRequest ? { mergeRequest: delivery.mergeRequest } : {}) }
      delivery = { ...delivery, createdRunId: runId }
      delete delivery.createAttempted
      store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
      store.set(KV.yunxiao.qaLatest(account.organization, pipelineId), { runId })
      store.set(KV.yunxiao.qa(ticketId, repo.id), value)
      return value
    }
    if (delivery.createAttempted) {
      if (Number(latest.pipelineRunId) <= Number(delivery.beforeRunId)) throw new Error('Previous QA pipeline creation is unconfirmed; wait and read its native run before retrying. No duplicate run will be started')
      let built: string
      try { built = pipelineCommit(latest, repo.path, qaBranch) }
      catch (error) {
        if (['SUCCESS', 'FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(latest.status)) throw error
        throw new Error('Previous QA pipeline creation is unconfirmed; wait for native checkout metadata before retrying')
      }
      if (!await contains(commands, directory, sourceCommit, built)) throw new Error('Cannot identify the previous QA creation; no new run will be started')
      return receipt(String(latest.pipelineRunId), built)
    }
    if (delivery.createdRunId && previous?.runId !== delivery.createdRunId && delivery.qaCommit) return receipt(delivery.createdRunId, delivery.qaCommit)
    if (previous?.commit === commit && (previous.integrationCommit ?? previous.commit) === sourceCommit && previous.qaBranch === qaBranch
      && await contains(commands, directory, sourceCommit, heads[qaBranch]!)) {
      const old = String(latest.pipelineRunId) === previous.runId ? latest
        : Run.parse(await commands.aliyun(z.unknown(), YUNXIAO.pipelineRun(account.organization, pipelineId, previous.runId)))
      if (!['FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(old.status)) return previous
    }
    // Reconcile a lost create-run response or a concurrent manual run instead of starting a duplicate.
    if (delivery.qaCommit && !['FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(latest.status) && Number(latest.pipelineRunId) > Number(delivery.beforeRunId)
      && await contains(commands, directory, sourceCommit, heads[qaBranch]!)) {
      let built: string | undefined
      try { built = pipelineCommit(latest, repo.path, qaBranch) }
      catch (error) { if (['SUCCESS', 'FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(latest.status)) throw error }
      if (built && await contains(commands, directory, sourceCommit, built)) return receipt(String(latest.pipelineRunId), built)
    }
    if (!['SUCCESS', 'FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(latest.status)) throw new Error(`QA run ${latest.pipelineRunId} is still ${latest.status}; wait for it`)
    delivery = { ...delivery, beforeRunId: String(latest.pipelineRunId) }
    store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
    store.delete(KV.yunxiao.qaTest(ticketId))
    let qaCommit = heads[qaBranch]!
    if (!await contains(commands, directory, sourceCommit, qaCommit)) {
      const base = qaCommit
      if (project.mergeMode === 'merge-request') {
        await qaMr(host, ticketId, repo.id, sourceBranch, qaBranch, sourceCommit, id => {
          delivery = { ...delivery, mergeRequest: id }
          store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
        })
      } else {
        let tree: string
        try { tree = Sha.parse((await commands.git(['merge-tree', '--write-tree', qaCommit, sourceCommit], directory)).split('\n')[0]) }
        catch (error) {
          if (error instanceof CliError && error.exitCode === 1) throw new Error(`QA merge conflict: create ${serial}-qa FROM ${serial}, merge origin/${qaBranch} there, resolve and test; keep ${serial} unchanged. Prepare all projects with integration_branch=${serial}-qa and retry`)
          throw error
        }
        qaCommit = Sha.parse((await commands.git(['commit-tree', tree, '-p', base, '-p', sourceCommit, '-m', `Merge ${sourceBranch} into ${qaBranch}`], directory)).trim())
        await commands.pushQa(qaBranch, qaCommit, directory)
      }
      heads = await remoteHeads(commands, repo.id, [qaBranch, serial, sourceBranch])
      qaCommit = heads[qaBranch]!
      if (!await contains(commands, directory, base, qaCommit) || !await contains(commands, directory, sourceCommit, qaCommit)) throw new Error('QA merge did not preserve the previous QA head and tested integration commit')
    }
    if (heads[serial] !== commit || heads[sourceBranch] !== sourceCommit) throw new Error('Development or QA-only branch changed during merge; test again before QA')
    delivery = { ...delivery, qaCommit }
    store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
    const fresh = Run.parse(await commands.aliyun(z.unknown(), YUNXIAO.latestPipelineRun(account.organization, pipelineId)))
    if (String(fresh.pipelineRunId) !== String(latest.pipelineRunId)) {
      const built = pipelineCommit(fresh, repo.path, qaBranch)
      if (await contains(commands, directory, sourceCommit, built)) return receipt(String(fresh.pipelineRunId), built)
      throw new Error('A newer QA run does not yet include this work; reread it before starting another run')
    }
    delivery = { ...delivery, createAttempted: true }
    delete delivery.createdRunId
    store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
    let runId: string
    try { runId = String(await commands.aliyun(Id, YUNXIAO.createPipelineRun(account.organization, pipelineId,
      { runningBranchs: { [source.endpoint]: qaBranch } }))) }
    catch (error) {
      if (error instanceof CliError && error.code && error.code >= 400 && error.code < 500 && error.code !== 408) {
        delivery = { ...delivery }; delete delivery.createAttempted
        store.set(KV.yunxiao.qaDelivery(ticketId, repo.id), delivery)
      }
      throw error
    }
    return receipt(runId, qaCommit)
  } finally { starting.delete(lock) }
}

async function verifyQaRuns(host: QaHost, ticketId: string, result: Record<string, unknown>) {
  const evidence = QaResultSchema.parse(result.qa)
  if (typeof result.verification !== 'string' || !result.verification.trim()) throw new Error('QA completion needs real main-flow verification evidence')
  const account = host.commands.deployment.codeup, scope = host.store.get(KV.yunxiao.qaScope(ticketId))
  const plan = host.store.get(KV.yunxiao.qaPlan(ticketId))
  if (!account || !scope || !plan?.projects.length) throw new Error('Register all work-item repositories with the QA integration tool first')
  const required = new Set(scope.repositories), root = dirname(plan.projects[0]!.directory)
  // Detect omitted ticket worktrees locally; never probe every workspace repository over the network.
  for (const repo of account.repositories) if (!required.has(repo.id) && existsSync(join(root, repo.name))) required.add(repo.id)
  const expanded = { branch: scope.branch, repositories: [...required] }
  host.store.set(KV.yunxiao.qaScope(ticketId), expanded)
  const named = evidence.repositories.map(item => {
    const repo = repositoryOf(account, item.repository)
    if (!repo) throw new Error('QA repository is not in the Codeup workspace')
    return { ...item, repository: repo.id }
  })
  if (named.length !== required.size || new Set(named.map(item => item.repository)).size !== named.length
    || named.some(item => !required.has(item.repository))) throw new Error(`QA evidence must cover every work-item repository exactly once; required: ${[...required].join(', ')}`)
  const receipts = named.map(item => {
    const receipt = host.store.get(KV.yunxiao.qa(ticketId, item.repository))
    if (!receipt || receipt.branch !== scope.branch || receipt.pipelineId !== item.pipeline_id) throw new Error('Publish this ticket to the assigned QA pipeline for every repository first')
    return receipt
  })
  const projects: { repository: string; pipelineId: string; runId: string; commit: string; qaBranch: string; qaCommit: string }[] = []
  for (const [i, item] of named.entries()) {
    const receipt = receipts[i]!, repo = repositoryOf(account, receipt.repository)!
    const project = plan.projects.find(project => project.repository === repo.id)
    if (!receipt.qaBranch || !receipt.qaCommit || project?.qaBranch !== receipt.qaBranch) throw new Error('QA branch differs from the tested project plan')
    const run = Run.parse(await host.commands.aliyun(z.unknown(), YUNXIAO.pipelineRun(account.organization, receipt.pipelineId, item.run_id)))
    if (String(run.pipelineId) !== receipt.pipelineId || String(run.pipelineRunId) !== item.run_id || run.status !== 'SUCCESS') throw new Error('QA pipeline has not completed successfully; keep the work item open')
    const built = pipelineCommit(run, repo.path, receipt.qaBranch), heads = await remoteHeads(host.commands, repo.id, [receipt.branch, receipt.qaBranch])
    const directory = join(account.workspace, repo.name), sourceCommit = receipt.integrationCommit ?? receipt.commit
    if (heads[receipt.branch] !== receipt.commit) throw new Error('Development commit changed; test and publish its current commit')
    if (!await contains(host.commands, directory, sourceCommit, heads[receipt.qaBranch]!)
      || !await contains(host.commands, directory, receipt.commit, built)
      || !await contains(host.commands, directory, sourceCommit, built)) throw new Error('QA branch or deployed build does not contain this work item tested commits')
    projects.push({ repository: repo.id, pipelineId: receipt.pipelineId, runId: item.run_id, commit: receipt.commit, qaBranch: receipt.qaBranch, qaCommit: built })
  }
  if (JSON.stringify(host.store.get(KV.yunxiao.qaScope(ticketId))) !== JSON.stringify(expanded)
    || receipts.some(receipt => starting.has(`${account.organization}:${receipt.pipelineId}`)
      || JSON.stringify(host.store.get(KV.yunxiao.qa(ticketId, receipt.repository))) !== JSON.stringify(receipt))) throw new Error('QA publication changed during verification; verify the complete set again')
  const qa = { ...evidence, repositories: named.map((item, i) => ({ ...item, repository_name: repositoryOf(account, item.repository)!.name, commit: receipts[i]!.commit, qa_branch: projects[i]!.qaBranch, qa_commit: projects[i]!.qaCommit,
    merge_request: receipts[i]!.mergeRequest, merge_request_url: receipts[i]!.mergeRequest ? `https://codeup.aliyun.com/${repositoryOf(account, item.repository)!.path}/change/${receipts[i]!.mergeRequest}` : undefined })), verified: true as const }
  return { qa, projects }
}

/** Test the actual deployed build, which may be a later shared QA run containing this work. */
export async function testQa(host: QaHost, ticketId: string, repository: string, command: string, run: QaRunner,
  deployments?: z.infer<typeof QaDeploymentSchema>[]) {
  const plan = await testedPlan(host, ticketId), account = host.commands.deployment.codeup
  const repo = account && repositoryOf(account, repository), project = repo && plan.projects.find(item => item.repository === repo.id)
  if (!project) throw new Error('QA tests must run from an involved project')
  const selected = deployments ? z.array(QaDeploymentSchema).min(1).parse(deployments) : plan.projects.map(item => {
    const receipt = host.store.get(KV.yunxiao.qa(ticketId, item.repository))
    if (!receipt) throw new Error('Publish ALL involved projects before QA integration testing')
    return { repository: item.repository, pipeline_id: receipt.pipelineId, run_id: receipt.runId }
  })
  const evidence = { repositories: selected.map(item => ({ ...item, main_flow_passed: true, evidence: 'Awaiting actual QA environment test' })),
    main_flow_passed: true, evidence: 'Awaiting actual QA environment test' }
  const { projects } = await verifyQaRuns(host, ticketId, { verification: command, qa: evidence })
  if (testing.has(ticketId)) throw new Error('Wait for the active QA test')
  testing.add(ticketId)
  try {
    host.store.delete(KV.yunxiao.qaTest(ticketId))
    const output = (await run(command, project.directory, { DSH_QA_ENVIRONMENT: plan.environment, DSH_QA_EXPECTED_PROJECTS: JSON.stringify(projects) })).slice(-8000)
    for (const item of plan.projects) {
      if (await localCommit(host.commands, item.directory, host.store.get(KV.yunxiao.qaScope(ticketId))!.branch) !== item.commit) throw new Error('Local project changed during QA testing')
      if (item.integrationBranch && await localCommit(host.commands, item.integrationDirectory!, item.integrationBranch) !== item.integrationCommit) throw new Error('QA-only integration branch changed during QA testing')
    }
    const after = await verifyQaRuns(host, ticketId, { verification: output || command, qa: evidence })
    if (JSON.stringify(host.store.get(KV.yunxiao.qaPlan(ticketId))) !== JSON.stringify(plan)
      || JSON.stringify(after.projects) !== JSON.stringify(projects)) throw new Error('Tested QA deployment changed; test again')
    const value = { environment: plan.environment, command, output, projects, at: new Date().toISOString() }
    host.store.set(KV.yunxiao.qaTest(ticketId), value)
    return value
  } finally { testing.delete(ticketId) }
}

export async function verifyQa(host: QaHost, ticketId: string, result: Record<string, unknown>) {
  const plan = await testedPlan(host, ticketId), { qa, projects } = await verifyQaRuns(host, ticketId, result)
  const test = host.store.get(KV.yunxiao.qaTest(ticketId))
  if (!test || testing.has(ticketId) || test.environment !== plan.environment || JSON.stringify(test.projects) !== JSON.stringify(projects)) {
    throw new Error('Test this complete deployed QA build set with orchestrator_qa_test before ready')
  }
  return { ...qa, environment: test.environment, test_command: test.command, test_output: test.output, tested_at: test.at,
    repositories: qa.repositories.map(item => {
      const project = plan.projects.find(project => project.repository === item.repository)!
      return { ...item, unit_tests: { command: project.command, commit: project.commit!, output: project.output! } }
    }) }
}
