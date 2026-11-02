/** The Codeup Source: the account settings it stores, the facts and variables it publishes, its one health report, and the bundle entry it ships as. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import configs from '../tsdown.config.ts'
import { SETUP_FIELDS, type Deployment } from '../src/deployment.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { HEALTH_TEXT } from '../src/sources/host.ts'
import { apply as applyCodeup, codeupKind, inject as codeupInject, name as codeupPlugin } from '../src/sources/codeup.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testCodeup, testDeployment, testRepository } from './fixtures/deployment.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> | Row[] }
/** The patch as DeepSeek Harness reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. */
async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = applyEntryPatches([], patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** A host that hands the plugin the kind's own context: the registry owns the health entry, and the deployment is what setup resolved. */
function pluginHost(options: { deployment?: Deployment; configured?: boolean } = {}) {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { codeup: { enabled: true, config: {} } } }), board)
  const { deployment } = options
  const deps = {
    // The Codeup Source reads no record, sends nothing and binds no Thread, so those parts stay empty.
    store: {} as SourceContextDeps['store'], outbox: { send: () => {} }, engine: {} as SourceContextDeps['engine'],
    commands: {} as SourceContextDeps['commands'], sources,
    // A deployment that setup has not resolved throws on access, as the Runtime's own does.
    get deployment(): Deployment { if (!deployment) throw new Error('dsh-superagent is waiting for setup'); return deployment },
    ready: Promise.resolve(), configured: () => options.configured ?? true, receive: () => 'stored',
  } satisfies SourceContextDeps
  const disposers: (() => unknown)[] = []
  const context = { orchestrator: { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) },
    effect: (effect: () => () => unknown) => { disposers.push(effect()) } }
  return { board, sources, context, stop: async () => { for (const dispose of disposers) await dispose() } }
}
/** The build entries of a tsdown config, which is a list of entry names or a map from entry name to source file. */
const entriesOf = (config: (typeof configs)[number]): Record<string, string | string[]> => {
  const { entry } = config
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {}
}

describe('codeup source', () => {
  it('stores the account settings setup reads, empty by default, and refuses a field setup would not read', () => {
    expect(codeupKind.schema.parse({})).toEqual({ cli: '', organization: '', workspace: '', commitEmail: '' })
    expect(codeupKind.schema.parse({ cli: '  aliyun-codeup  ', workspace: ' /home/me/src ' })).toMatchObject({ cli: 'aliyun-codeup', workspace: '/home/me/src' })
    // The deployment's account schema stays open for the other Sources' blocks; the kind's own schema is as strict as theirs.
    expect(codeupKind.schema.safeParse({ cli: 'aliyun', repository: 'acme/widgets' }).success).toBe(false)
    // Saving any of these fields restarts dsh-superagent, so the panel must edit exactly what setup reads.
    expect(SETUP_FIELDS.codeup).toEqual(codeupKind.fields.map(field => field.key))
  })
  it('describes the account, its organization and the repositories of its workspace once setup resolved them', () => {
    expect(codeupKind.fields.map(field => field.key)).toEqual(['cli', 'organization', 'workspace', 'commitEmail'])
    for (const field of codeupKind.fields) {
      expect(field.type).toBe('text')
      expect(field.label.zh && field.label.en && field.hint?.zh && field.hint.en).toBeTruthy()
    }
    expect(codeupKind.title).toEqual({ zh: '云效 Codeup', en: 'Yunxiao Codeup' })
    expect(codeupKind.description.zh && codeupKind.description.en).toBeTruthy()
    // Nothing is resolved before setup, so the card shows only the fields a person edits.
    expect(codeupKind.facts?.(undefined)).toEqual({})
    expect(codeupKind.facts?.(testDeployment())).toEqual({})
    const two = testDeployment({ codeup: testCodeup({ repositories: [testRepository(), testRepository({ id: 'repo-2', path: 'group/lib', name: 'lib' })] }) })
    expect(codeupKind.facts?.(two)).toEqual({
      cli: { zh: '当前账号 yedou', en: 'Current account yedou' },
      organization: { zh: '当前组织 org-1', en: 'Current organization org-1' },
      workspace: { zh: '可交付仓库 2 个', en: '2 repositories to deliver' },
    })
  })
  it('publishes the workspace, organization and account variables; the work item ones belong to the yunxiao Source', () => {
    const environment = codeupKind.environment!
    expect(environment.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_WORKSPACE', 'DSH_SUPERAGENT_YUNXIAO_ORG',
      'DSH_SUPERAGENT_YUNXIAO_ACCOUNT'])
    for (const variable of environment.variables) expect(variable.description.zh && variable.description.en).toBeTruthy()
    const config = codeupKind.schema.parse({})
    expect(environment.values({ deployment: testDeployment({ codeup: testCodeup() }), config })).toEqual({
      DSH_SUPERAGENT_WORKSPACE: '/tmp/dsh-superagent-workspace', DSH_SUPERAGENT_YUNXIAO_ORG: 'org-1', DSH_SUPERAGENT_YUNXIAO_ACCOUNT: 'yedou',
    })
    // The account's name is optional in the CLI's answer, and its id names it then.
    const unnamed = testCodeup({ account: { id: 'user-1', name: '', commitEmail: 'user-1@codeup.aliyun.com' } })
    expect(environment.values({ deployment: testDeployment({ codeup: unnamed }), config }).DSH_SUPERAGENT_YUNXIAO_ACCOUNT).toBe('user-1')
    // A deployment that resolved only GitHub keeps this Source mounted, so its variables are empty rather than missing.
    expect(environment.values({ deployment: testDeployment(), config })).toEqual({ DSH_SUPERAGENT_WORKSPACE: '',
      DSH_SUPERAGENT_YUNXIAO_ORG: '', DSH_SUPERAGENT_YUNXIAO_ACCOUNT: '' })
  })
  it('registers its kind and one health entry, and receives nothing in phase one', async () => {
    expect(codeupPlugin).toBe('dsh-superagent-codeup')
    expect(codeupInject).toEqual(['orchestrator'])
    expect(codeupKind.kind).toBe('codeup')
    expect(codeupKind.health).toEqual(['codeup'])
    // Phase one carries the account only: no listening rule, channel, Thread context, sender list or search.
    for (const member of ['scope', 'channel', 'threadContext', 'policy', 'find'] as const) expect(codeupKind).not.toHaveProperty(member)
    // Registering claims the kind's one health entry; the report that follows is the health test below.
    const host = pluginHost({ configured: false })
    applyCodeup(host.context as never)
    expect(host.sources.kind('codeup')).toBe(codeupKind)
    expect(host.board.all.codeup).toEqual({ state: 'starting', detail: '' })
    await host.stop()
    expect(host.sources.kind('codeup')).toBeUndefined()
  })
  it('reports the account setup resolved once, and waits for the deployment check while setup resolved none', async () => {
    const ready = pluginHost({ deployment: testDeployment({ codeup: testCodeup() }) })
    applyCodeup(ready.context as never)
    await vi.waitFor(() => expect(ready.board.all.codeup).toMatchObject({ state: 'ready' }))
    expect(ready.board.all.codeup).toEqual({ state: 'ready', detail: 'yedou in org-1; 1 repositories to deliver' })
    // Phase one polls nothing, so the one report is the whole loop: a later tick changes no entry.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ready.board.all.codeup).toMatchObject({ state: 'ready' })
    await ready.stop()
    // A deployment that resolved only GitHub never names a Codeup account, so the Source waits for a check that names one.
    const githubOnly = pluginHost({ deployment: testDeployment() })
    applyCodeup(githubOnly.context as never)
    await vi.waitFor(() => expect(githubOnly.board.all.codeup).toEqual({ state: 'paused', detail: HEALTH_TEXT.setupPending, code: 'setupPending' }))
    await githubOnly.stop()
    // Until setup finishes, the deployment itself cannot be read; the Source reports the wait instead of failing.
    const pending = pluginHost({ configured: false })
    applyCodeup(pending.context as never)
    await vi.waitFor(() => expect(pending.board.all.codeup).toEqual({ state: 'paused', detail: HEALTH_TEXT.setupPending, code: 'setupPending' }))
    await pending.stop()
  })
  it('ships as its own bundle entry, mounted right after GitHub, exported and built as codeup-watch', async () => {
    const rows = await patched()
    const row = rows.find(item => item.id === 'dsh-superagent-codeup')
    expect(row?.name).toBe('dsh-superagent/codeup-watch')
    // On by default: an installation that never configures Codeup still mounts it, and the Source then waits for the account.
    expect(row).not.toHaveProperty('disabled')
    expect(rows.findIndex(item => item.id === 'dsh-superagent-github') + 1).toBe(rows.findIndex(item => item.id === 'dsh-superagent-codeup'))
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(pkg.exports['./codeup-watch']).toBe('./lib/codeup-watch.js')
    // The entry the export names is the module that exports this plugin, so `pnpm build` writes lib/codeup-watch.js.
    expect(configs.map(entriesOf).find(entry => 'index' in entry)?.['codeup-watch']).toBe('src/sources/codeup.ts')
  })
})
