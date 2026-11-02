/** Plugin configuration and startup verification for code hosting access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { githubHosting, type HostAccount, type Hosting } from './hosting.ts'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { TOKEN_MISSING, YUNXIAO, tokenArgv } from './infra/yunxiao.ts'
import { codeupHosting } from './sources/codeup-hosting.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
/** The Codeup account's configuration: the aliyun CLI, the organization, and the workspace whose repositories a ticket may deliver to. */
export const CodeupAccountsSchema = z.object({
  cli: z.string().trim().default(''),
  organization: z.string().trim().default(''),
  workspace: z.string().trim().default(''),
  commitEmail: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), codeup: Object.keys(CodeupAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
}

export interface GithubAccount { cli: string; login: string; noreply: string }
/** One repository of the Codeup workspace a ticket may deliver to: its id, its group path and its local directory name. */
export interface CodeupRepository { id: string; path: string; name: string }
/** The resolved Codeup account: the CLI that reaches the organization, and the workspace repositories it may push to. */
export interface CodeupAccount {
  cli: string
  organization: string
  workspace: string
  account: HostAccount
  repositories: readonly CodeupRepository[]
}
/** What startup resolved: the code hosting platform in use, the accounts it found, and the optional Feishu bot. */
export interface Deployment extends Machine {
  /** The platform a ticket's changes are delivered to, and the account they are made as. */
  hosting: Hosting
  /** The GitHub repository this installation watches; empty unless GitHub is configured. */
  repository: string
  github?: GithubAccount
  codeup?: CodeupAccount
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The account dsh-superagent acts as on GitHub, whose commits carry the account's noreply address. */
export const githubAccount = (github: GithubAccount): HostAccount => ({ id: github.login, name: github.login, commitEmail: github.noreply })

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text.slice(Math.max(0, text.indexOf('{')))) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Verifies the agent's GitHub CLI identity and push access to the configured repository.
 * @returns the repository and account, or undefined when the GitHub Source names neither, which leaves code hosting to another platform.
 */
export async function resolveGithub(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<{ repository: string; github: GithubAccount } | undefined> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote && !accounts.cli) return undefined
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

/**
 * Verifies the agent's GitHub CLI identity and push access to the configured repository.
 * @throws SetupError when the GitHub Source is not configured or its account cannot push.
 */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const resolved = await resolveGithub(machine, github, probe, path)
  if (!resolved) throw new SetupError('repositoryUnset')
  return { ...machine, ...resolved, hosting: githubHosting({ repository: resolved.repository, account: githubAccount(resolved.github) }) }
}

const YunxiaoUser = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  username: z.string().nullish(), name: z.string().nullish(), nickName: z.string().nullish(), email: z.string().nullish(),
})
const WorkspaceRepository = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullish(), path: z.string().nullish(),
  canPush: z.boolean().nullish(), permission: z.string().nullish(),
  permissions: z.looseObject({ push: z.boolean().nullish() }).nullish(),
})
/** The group path of a Codeup remote (`git@codeup.aliyun.com:<group>/<name>.git`), or undefined for another host. */
export const codeupPath = (remote: string): string | undefined => {
  const match = /^(?:(?:https?|ssh):\/\/)?(?:git@)?codeup\.aliyun\.com[:/](.+)$/i.exec(remote.trim())
  return match?.[1]?.replace(/\/+$/, '').replace(/\.git$/, '')
}
/** Whether the repository API reports push access, by whichever field it fills; undefined when it reports none. */
const canPush = (repository: z.infer<typeof WorkspaceRepository>): boolean | undefined =>
  repository.canPush ?? repository.permissions?.push ?? (repository.permission ? /write|admin|owner/i.test(repository.permission) : undefined)
/** What a failed probe printed, preferring the command's own standard error over the wrapper's message about it. */
const detail = (error: unknown): string => {
  const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : undefined
  return (stderr ?? reason(error)).trim()
}
/** Maps a failed yunxiao call to the setup problem that names it, telling a locked keychain from a signed-out CLI. */
const codeupFailure = (error: unknown, code: 'codeupCliSignedOut' | 'codeupRepositoryUnreadable', values: Record<string, string>): SetupError =>
  new SetupError(detail(error).includes(TOKEN_MISSING) ? 'codeupTokenMissing' : code, { ...values, output: detail(error) })
/** Scans the workspace's immediate children for Codeup checkouts and keeps the ones the account may push to. */
async function workspaceRepositories(workspace: string, organization: string, cli: string, probe: Probe): Promise<CodeupRepository[]> {
  const repositories: CodeupRepository[] = []
  const refused: string[] = []
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const directory = join(workspace, entry.name)
    const remote = await probe(['git', '-C', directory, 'remote', 'get-url', 'origin']).catch(() => '')
    const path = codeupPath(remote)
    if (!path) continue
    const text = await probe(tokenArgv(cli, YUNXIAO.repository(organization, path)))
      .catch((error: unknown) => { throw codeupFailure(error, 'codeupRepositoryUnreadable', { repository: path }) })
    const access = parsed(WorkspaceRepository, text)
    if (!access) throw new SetupError('codeupRepositoryUnreadable', { repository: path, output: text.slice(0, 500) })
    if (canPush(access) !== true) { refused.push(path); continue }
    repositories.push({ id: access.id, path: access.path ?? path, name: entry.name })
  }
  if (!repositories.length) throw new SetupError('codeupNoRepositories', { workspace, refused: refused.join(', ') })
  return repositories
}
/**
 * Verifies the Codeup account, the keychain token, the SSH key, and the workspace repositories a ticket may deliver to.
 * @returns the account, or undefined when the Codeup Source names none of its fields, which leaves code hosting to another platform.
 */
export async function resolveCodeup(machine: Machine, codeup: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<CodeupAccount | undefined> {
  const config = CodeupAccountsSchema.parse(codeup ?? {})
  if (!config.cli && !config.organization && !config.workspace) return undefined
  if (!config.cli) throw new SetupError('codeupCliUnset')
  if (!config.organization) throw new SetupError('codeupOrgUnset')
  if (!config.workspace) throw new SetupError('codeupWorkspaceUnset')
  let cli: string
  try { cli = executable(config.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('codeupCliMissing', { output: reason(error) }) }
  let workspace = ''
  try { workspace = statSync(config.workspace).isDirectory() ? config.workspace : '' } catch { /* Reported below. */ }
  if (!workspace) throw new SetupError('codeupWorkspaceMissing', { workspace: config.workspace })
  const text = await probe(tokenArgv(cli, YUNXIAO.user())).catch((error: unknown) => { throw codeupFailure(error, 'codeupCliSignedOut', {}) })
  const user = parsed(YunxiaoUser, text)
  if (!user) throw new SetupError('codeupAccountUnreported', { output: text.slice(0, 500) })
  // Codeup authenticates git over SSH, so startup proves the operator's key reaches the organization before a worker relies on it.
  const ssh = await probe(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-T', 'git@codeup.aliyun.com'])
    .catch((error: unknown) => reason(error))
  if (!/welcome to codeup/i.test(ssh)) throw new SetupError('codeupSshUnavailable', { output: ssh.slice(0, 500) })
  const name = user.username ?? user.name ?? user.nickName ?? user.id
  return { cli, organization: config.organization, workspace,
    account: { id: user.id, name, commitEmail: config.commitEmail || user.email || `${user.id}@codeup.aliyun.com` },
    repositories: await workspaceRepositories(workspace, config.organization, cli, probe) }
}
/**
 * Resolves the code hosting platform from the GitHub and Codeup Source accounts: GitHub hosts when it is configured, otherwise
 * Codeup, whose repositories the workspace holds.
 * @throws SetupError (`hostingUnset`) when neither Source names an account.
 */
export async function resolveHosting(machine: Machine, accounts: { github: unknown; codeup: unknown }, probe: Probe,
  path = process.env.PATH ?? ''): Promise<Deployment> {
  const github = await resolveGithub(machine, accounts.github, probe, path)
  const codeup = await resolveCodeup(machine, accounts.codeup, probe, path)
  if (!github && !codeup) throw new SetupError('hostingUnset')
  if (github) {
    const hosting = githubHosting({ repository: github.repository, account: githubAccount(github.github) })
    return { ...machine, ...github, hosting, ...(codeup ? { codeup } : {}) }
  }
  const resolved = codeup!
  return { ...machine, repository: '', codeup: resolved, hosting: codeupHosting(resolved) }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
