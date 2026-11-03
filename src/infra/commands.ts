/** Subprocess wrapper for running gh, aliyun, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CodeupAccount, Deployment, GithubAccount } from '../deployment.ts'
import { readOnly, tokenCommand, yunxiaoError } from './yunxiao.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/** Attempts of one read-only yunxiao call: its CLI is a network client, and a read that failed once usually succeeds on a retry. */
const YUNXIAO_ATTEMPTS = 3
/** Waits before the second and third attempt; writes are never retried, so a lost answer stays the caller's decision. */
const YUNXIAO_BACKOFF_MS: readonly number[] = [200, 600]
/** Diagnostics of a yunxiao call that never reached the service, which a read-only retry may survive. */
const YUNXIAO_NETWORK = /dial tcp|i\/o timeout|no such host|connection (?:refused|reset|closed|aborted)|network is unreachable|tls handshake|temporary failure/i
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `aliyun devops` reports a failed call as `StatusCode: 404 … Data: {"message":"…"}`, whose HTTP status callers branch on.
    const yunxiao = yunxiaoError(stderr)
    if (yunxiao) return new CliError(yunxiao.message, yunxiao.code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
/** Whether a read-only yunxiao failure may succeed on another attempt: the service answered 5xx, or the call never reached it. */
function retryable(error: unknown): boolean {
  if (!(error instanceof CliError)) return false
  if (typeof error.code === 'number') return error.code >= 500
  return /timed out/.test(error.message) || YUNXIAO_NETWORK.test(error.message)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/** Narrows `aliyun`'s first argument: a schema when one is given, the argv otherwise. */
const isSchema = <T>(value: z.ZodType<T> | readonly string[]): value is z.ZodType<T> => !Array.isArray(value)
/**
 * Executes gh, aliyun, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  /** The GitHub account commands act as; a Codeup-only installation reaches GitHub calls only through a stale reference. */
  private get github(): GithubAccount {
    const github = this.deployment.github
    if (!github) throw new Error('This installation has no GitHub account; configure the GitHub Source or use the Codeup account')
    return github
  }
  /** The Codeup account commands act as; a GitHub-only installation reaches yunxiao calls only through a stale reference. */
  private get codeup(): CodeupAccount {
    const codeup = this.deployment.codeup
    if (!codeup) throw new Error('This installation has no Codeup account; configure the Codeup Source or use the GitHub account')
    return codeup
  }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  /**
   * Runs a subprocess with the deployment's environment, timeout, and abort signal.
   * @param label - the command a failure that prints no diagnostics names, for commands run through a shell.
   */
  async run(program: string, args: string[], cwd?: string, label = program): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, label) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.github.cli, args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  /**
   * Runs the yunxiao CLI as the Codeup account and returns its raw output.
   * The token reaches only this subprocess: the keychain entry is read inside the shell that execs the CLI, so it is in no
   * environment dsh-superagent or a worker keeps.
   * @param argv - the `aliyun` arguments, starting with `devops`; `YUNXIAO` builds them.
   */
  async aliyun(argv: readonly string[]): Promise<string>
  /** Runs the yunxiao CLI and validates its JSON output, skipping log lines the CLI prints before it. */
  async aliyun<T>(schema: z.ZodType<T>, argv: readonly string[]): Promise<T>
  async aliyun<T>(first: z.ZodType<T> | readonly string[], second?: readonly string[]): Promise<T | string> {
    const schema = isSchema(first) ? first : undefined
    const argv = isSchema(first) ? second ?? [] : first
    const output = await this.yunxiao(argv)
    return schema ? schema.parse(JSON.parse(output.slice(Math.max(0, output.search(/[{\[]/))))) : output
  }
  /**
   * Runs one yunxiao call, retrying a read-only subcommand after a 5xx or a call that never reached the service.
   * A write is never retried: a merge request or a comment may exist after a timeout, and only the caller can decide what to do.
   */
  private async yunxiao(argv: readonly string[]): Promise<string> {
    const cli = this.codeup.cli
    // The subcommand follows the `devops` plugin name, which every call starts with.
    const attempts = readOnly(argv[1] ?? '') ? YUNXIAO_ATTEMPTS : 1
    for (let attempt = 1; ; attempt++) {
      try { return await this.run('sh', ['-c', tokenCommand(cli, argv)], undefined, 'aliyun') }
      catch (error) {
        if (attempt >= attempts || !retryable(error)) throw error
        await delay(YUNXIAO_BACKOFF_MS[attempt - 1] ?? 0)
      }
    }
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
  /** The host bypasses worker hooks explicitly; normal push still refuses a non-fast-forward update. */
  async pushQa(branch: string, commit: string, cwd: string): Promise<void> {
    const account = this.codeup
    const repository = account.repositories.find(item => resolve(join(account.workspace, item.name)) === resolve(cwd))
    if (!repository || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || ['master', 'main', repository.defaultBranch].includes(branch)
      || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Invalid host QA publication')
    await this.git(['check-ref-format', '--branch', branch], cwd)
    await this.git(['push', '--no-verify', 'origin', `${commit}:refs/heads/${branch}`], cwd)
  }
}
