/**
 * Process environment and CLI shims that bind git, gh, aliyun, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { AGENT_COMMENT, COMMENT_FLAG, READ_ONLY_GLOBS, SECURITY, SOURCE_BRANCH_FLAG, TOKEN_MISSING_STATUS, tokenScript, YUNXIAO, YUNXIAO_TOKEN_VARIABLE } from './yunxiao.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['aliyun', 'gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
/** The hooks directory the agent's git configuration names, which replaces the hooks a repository keeps in `.git/hooks`. */
export const workerHooks = (stateDir: string): string => join(stateDir, 'worker-hooks')
/** The file naming the pipeline prefixes a worker may run; the host writes it from the settings, and the forwarding script reads it. */
export const workerPipelines = (stateDir: string): string => join(stateDir, 'worker-pipelines')
/** The prefixes a worker may run when the file above names none, matching the settings' default. */
const DEFAULT_PIPELINE_PREFIXES: readonly string[] = ['qa-', 'pre-']
/**
 * The pipeline prefixes in force, read synchronously for a caller that judges one command right now; see `readWorkerPipelines`.
 * An absent or empty file names none, and the caller falls back to the receiving rules.
 */
export function workerPipelinePrefixes(stateDir: string): string[] {
  try {
    return readFileSync(workerPipelines(stateDir), 'utf8').split('\n').map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
  } catch { return [] }
}
/** The URL Codeup serves over HTTPS, which workers reach over SSH with the operator's key instead of a credential helper. */
export const CODEUP_URL = 'https://codeup.aliyun.com/'
/** The git query proving worker git reads the hooks directory dsh-superagent writes; `verifyEnvironment` runs it and tests answer it. */
export const HOOKS_PATH_QUERY: readonly string[] = ['config', '--global', '--get', 'core.hooksPath']
/** The merged git query proving the environment's hooks directory outranks a repository's own `core.hooksPath`. */
export const HOOKS_PATH_MERGED_QUERY: readonly string[] = ['config', '--get', 'core.hooksPath']
/** The git query that names where each `core.hooksPath` value comes from; the environment's shows as `command line:`. */
export const HOOKS_ORIGIN_QUERY: readonly string[] = ['config', '--show-origin', '--get-all', 'core.hooksPath']
/** The git query proving worker git rewrites Codeup HTTPS remotes to SSH. */
export const CODEUP_REWRITE_QUERY: readonly string[] = ['config', '--global', '--get-all', 'url.git@codeup.aliyun.com:.insteadOf']
/** Hooks of the repository that the agent's `core.hooksPath` hides; each generated hook forwards to the repository's own. */
const FORWARDED_HOOKS: readonly string[] = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-auto-gc', 'post-rewrite',
  'post-index-change', 'reference-transaction', 'sendemail-validate']
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`
/** A `key=value` argument in the form git parses from `GIT_CONFIG_PARAMETERS`, quoted the way git writes it. */
const configParameter = (key: string, value: string): string => `${shellQuote(key)}=${shellQuote(value)}`
const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub and yunxiao tokens, interactive prompts, the repository the
 * host's own environment may name, and operator git identity/config overrides.
 * @param hooks - the hooks directory to name through git's environment configuration, which outranks the `core.hooksPath` a
 * repository sets for itself (husky writes one into `.git/config`). Pass it when the deployment guards pushes, which the
 * isolated git configuration alone cannot do; omit it to keep the environment as it was for a platform that does not.
 * The variable is shared with the host process, which pushes nothing in this phase; a later phase that pushes release branches
 * itself needs a way around the guard, such as running those pushes without it.
 */
export function agentVariables(stateDir: string, hooks?: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, [YUNXIAO_TOKEN_VARIABLE]: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Environment configuration ranks above a repository's own, which the isolated global configuration cannot outrank.
    // It travels as `GIT_CONFIG_PARAMETERS` because DSH strips `GIT_CONFIG_KEY_n` from child environments (a credential-shaped
    // name) but keeps `GIT_CONFIG_COUNT`, and git then fails every command on the missing key.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_KEY_0: undefined, GIT_CONFIG_VALUE_0: undefined,
    GIT_CONFIG_PARAMETERS: hooks ? configParameter('core.hooksPath', hooks) : undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes `files` into `dir` and removes the files dsh-superagent wrote that `files` no longer names, refusing to
 * overwrite foreign files. Workers may be running concurrently: each file is written beside its target and renamed into place,
 * so no command ever resolves past the shim directory.
 */
async function sync(dir: string, files: ReadonlyMap<string, string>, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  for (const [name, body] of files) {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode })
    await rename(temporary, join(dir, name))
  }
  for (const name of before) if (!files.has(name)) await unlink(join(dir, name))
}

/** Strips the shim directory from PATH, so a shim that execs a wrapper script resolving `gh` or `aliyun` by name reaches the real binary. */
const withoutShims = (dir: string): string => [
  `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
  'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
  'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
].join('\n')
const execWith = (dir: string, program: string, args: string): string => `${withoutShims(dir)}\nexec ${shellQuote(program)} ${args}`
const run = (dir: string, program: string): string => execWith(dir, program, '"$@"')
/** The shell word appending the agent marker to a comment body, keeping the body's own bytes. */
const commented = (value: string): string => `"${value}\n\n${AGENT_COMMENT}"`

/**
 * The message a worker reads when a pipeline is not one it may run: user-facing copy, so it is Chinese like the marker the
 * forwarding script appends to a merge request comment, and it names the tool that asks the approver.
 */
const PIPELINE_DENIED = 'dsh-superagent: 这个流水线由宿主执行：用 orchestrator_request_pipeline 请审批人确认。'
/** The shell that denies a pipeline and ends the forwarding script. */
const denyPipeline = (): string => `echo ${shellQuote(PIPELINE_DENIED)} >&2; exit 1`
/** A lookup command from `yunxiao.ts`, its last argument replaced by the shell variable holding the id the worker named. */
const lookupCommand = (argv: readonly string[], variable: string): string =>
  [...argv.slice(0, -1).map(shellQuote), `"$${variable}"`].join(' ')

/** Development stays on the work item serial; conflict resolution uses its QA-only branch. */
const WORKITEM_BRANCH_GUARD = [
  'admit_workitem_branch() {',
  '  workitem_expected=${DSH_SUPERAGENT_YUNXIAO_SERIAL:-}',
  `  if ! printf '%s' "$workitem_expected" | grep -Eq '^[A-Za-z0-9]+-[0-9]+$'; then`,
  '    echo "dsh-superagent: a yunxiao delivery needs a valid work item serial" >&2; return 1',
  '  fi',
  '  case "$1" in',
  '    "$workitem_expected"|"$workitem_expected"-qa) return 0 ;;',
  '  esac',
  '  echo "dsh-superagent: this yunxiao work item must use $workitem_expected (or its QA-only $workitem_expected-qa branch), not $1" >&2',
  '  return 1',
  '}',
].join('\n')

/**
 * The body of the workers' `aliyun` shim: it reads the keychain token into its own shell, admits only the subcommands a worker
 * may run, and execs the real CLI, so the token reaches that one process and no other.
 * @param organization - the organization the deployment belongs to, which the pipeline lookups name; a worker's environment has none.
 */
function aliyunShim(stateDir: string, cli: string, keychain: string, organization: string): string {
  const dir = workerBin(stateDir)
  const branch = SOURCE_BRANCH_FLAG
  const denied = 'dsh-superagent: a worker may not run this yunxiao command; the host runs it, or this phase does not do it'
  // The flags come from the command lists, so calibrating one against a real installation stays a change in `yunxiao.ts`.
  // A run, a retry and a rerun all name their pipeline, so each is admitted by that pipeline's name; no name, no admission.
  const pipelineIdFlag = YUNXIAO.createPipelineRun(organization, '').at(-2) ?? '--pipeline-id'
  const lookupPipeline = lookupCommand(YUNXIAO.pipeline(organization, ''), 'pipeline_id')
  return [
    // The token is exported in this shell only, so it reaches the lookups and the `exec` below and no other process.
    tokenScript(undefined, keychain).trim(),
    // The shim directory leaves PATH here: the CLI is called by absolute path below, and a wrapper script resolving it by name
    // must reach the real binary.
    withoutShims(dir),
    `cli=${shellQuote(cli)}`,
    `pipelines=${shellQuote(workerPipelines(stateDir))}`,
    // Reads one flag's value out of the arguments, in either `--flag value` or `--flag=value` form, and fails when it is absent.
    'argument() {',
    '  wanted=$1; shift',
    '  found=; pending=',
    '  for item in "$@"; do',
    '    if [ -n "$pending" ]; then found=$item; pending=; continue; fi',
    '    case "$item" in',
    '      "$wanted") pending=1 ;;',
    '      "$wanted"=*) found=${item#"$wanted"=} ;;',
    '    esac',
    '  done',
    '  [ -n "$found" ] || return 1',
    '  printf "%s" "$found"',
    '}',
    // Reads the pipeline name out of the CLI's JSON without assuming a parser: `pipelineName`, or the `name` inside a `pipeline`
    // object (the first pattern finds a nested `pipeline.pipelineName` too). Another `name` may be a run's, so a reply without a
    // pipeline name names no pipeline, which the caller refuses.
    'pipeline_name() {',
    `  text=$(printf '%s' "$1" | tr '\\n' ' ')`,
    `  match=$(printf '%s' "$text" | grep -o '"pipelineName"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)`,
    `  [ -n "$match" ] || match=$(printf '%s' "$text" | grep -o '"pipeline"[[:space:]]*:[[:space:]]*{[^}]*"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)`,
    '  [ -n "$match" ] || return 1',
    `  name=$(printf '%s' "$match" | sed 's/.*:[[:space:]]*"\\([^"]*\\)"$/\\1/')`,
    '  [ -n "$name" ] || return 1',
    '  printf "%s" "$name"',
    '}',
    // A pipeline is a worker's when its name starts with one of the prefixes the host wrote for the settings, compared without
    // case; a missing or empty file falls back to the defaults. prod- and prod-pre- match neither, so both stay the host's.
    'admit_pipeline() {',
    `  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')`,
    '  named=',
    '  if [ -r "$pipelines" ]; then',
    '    while IFS= read -r line || [ -n "$line" ]; do',
    `      line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')`,
    `      case "$line" in ''|'#'*) continue ;; esac`,
    '      named=1',
    `      prefix=$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')`,
    `      case "$lower" in "$prefix"*) return 0 ;; esac`,
    '    done < "$pipelines"',
    '  fi',
    '  if [ -z "$named" ]; then',
    `    case "$lower" in ${DEFAULT_PIPELINE_PREFIXES.map(prefix => `${prefix}*`).join('|')}) return 0 ;; esac`,
    '  fi',
    `  ${denyPipeline()}`,
    '}',
    // Every call names the devops plugin; another plugin is outside what dsh-superagent configures for workers.
    'case "$1" in',
    '  devops) shift ;;',
    `  *) ${fail('dsh-superagent: a worker may only run the yunxiao devops plugin')} ;;`,
    'esac',
    'command=$1',
    'shift',
    'case "$command" in',
    `  ${READ_ONLY_GLOBS.join('|')}) ;;`,
    // An update changes only a merge request's title or description, so it names no branch to check.
    '  codeup-update-change-request) ;;',
    '  codeup-create-change-request)',
    '    if [ -n "${DSH_SUPERAGENT_YUNXIAO_WORKITEM:-}${DSH_SUPERAGENT_YUNXIAO_SERIAL:-}" ]; then',
    `      ${fail('dsh-superagent: Use orchestrator_qa_integrate to merge the tested work-item branch into its fixed QA branch, directly or via MR')}`,
    '    fi',
    // Non-work-item tickets keep the team's bugfix/feat convention.
    '    branch=',
    '    expect=',
    '    for arg in "$@"; do',
    '      if [ -n "$expect" ]; then branch=$arg; expect=; continue; fi',
    '      case "$arg" in',
    `        ${branch}) expect=1 ;;`,
    `        ${branch}=*) branch=\${arg#${branch}=} ;;`,
    '      esac',
    '    done',
    '    case "$branch" in',
    '      bugfix/*|feat/*) ;;',
    `      *) echo "dsh-superagent: a worker may only open a merge request from a bugfix/ or feat/ branch, not '$branch'" >&2; exit 1 ;;`,
    '    esac',
    '    ;;',
    '  codeup-create-change-request-comment)',
    // Rewrite the argument list in place so the comment's body carries the marker; the count tracks the arguments not yet moved.
    '    count=$#',
    '    while [ "$count" -gt 0 ]; do',
    '      arg=$1; shift; count=$((count - 1))',
    '      case "$arg" in',
    `        ${COMMENT_FLAG})`,
    '          body=; if [ "$count" -gt 0 ]; then body=$1; shift; count=$((count - 1)); fi',
    `          set -- "$@" "$arg" ${commented('$body')}`,
    '          ;;',
    `        ${COMMENT_FLAG}=*)`,
    `          set -- "$@" ${commented('$arg')}`,
    '          ;;',
    '        *) set -- "$@" "$arg" ;;',
    '      esac',
    '    done',
    '    ;;',
    '  flow-create-pipeline-run|flow-retry-pipeline-job-run|flow-rerun-pipeline-job-run)',
    '    if [ -n "${DSH_SUPERAGENT_YUNXIAO_WORKITEM:-}${DSH_SUPERAGENT_YUNXIAO_SERIAL:-}" ]; then',
    `      ${fail('dsh-superagent: use orchestrator_qa_integrate to merge tested code into the fixed QA branch and observe its pipeline')}`,
    '    fi',
    // The pipeline's name decides whether a worker may run it, so the shim reads it before the run starts; no name, no run.
    `    pipeline_id=$(argument ${shellQuote(pipelineIdFlag)} "$@") || { ${denyPipeline()}; }`,
    `    json=$("$cli" ${lookupPipeline} 2>/dev/null) || json=`,
    `    name=$(pipeline_name "$json") || { ${denyPipeline()}; }`,
    '    admit_pipeline "$name"',
    '    ;;',
    `  *) ${fail(denied)} ;;`,
    'esac',
    'exec "$cli" devops "$command" "$@"',
  ].join('\n')
}

/** Worker pushes are limited to delivery branches and must preserve their existing history. */
const PRE_PUSH = [
  '# Worker branch checks prevent mistakes; server branch protection is the security boundary.',
  WORKITEM_BRANCH_GUARD,
  'while read local_ref local_sha remote_ref remote_sha; do',
  '  if [ -n "${DSH_SUPERAGENT_YUNXIAO_WORKITEM:-}${DSH_SUPERAGENT_YUNXIAO_SERIAL:-}" ]; then',
  '    admit_workitem_branch "${remote_ref#refs/heads/}" || exit 1',
  '    case "$remote_ref" in refs/heads/*) ;; *) echo "dsh-superagent: a worker may only push branches" >&2; exit 1 ;; esac',
  '  else',
  '  case "$remote_ref" in',
  '    refs/heads/bugfix/*|refs/heads/feat/*) ;;',
  '    *) echo "dsh-superagent: a worker may only push bugfix/ and feat/ branches, not $remote_ref" >&2; exit 1 ;;',
  '  esac',
  '  fi',
  '  case "$local_sha" in',
  '    0000000000000000000000000000000000000000) echo "dsh-superagent: a worker may not delete $remote_ref" >&2; exit 1 ;;',
  '  esac',
  '  case "$remote_sha" in',
  '    0000000000000000000000000000000000000000) ;;',
  '    *) git merge-base --is-ancestor "$remote_sha" "$local_sha" || { echo "dsh-superagent: non-fast-forward push refused for $remote_ref; fetch and preserve its history" >&2; exit 1; } ;;',
  '  esac',
  'done',
  'exit 0',
].join('\n')

/**
 * A hook that runs the repository's own hook of the same name, which the agent's `core.hooksPath` would otherwise hide.
 * `git rev-parse --git-path hooks` cannot find it, because that path honours `core.hooksPath` and would name this directory.
 */
const forwardHook = (name: string): string => [
  `# Runs the repository's own ${name} hook, which the agent git configuration's core.hooksPath would otherwise hide.`,
  'directory=$(git config --local --get core.hooksPath 2>/dev/null)',
  'if [ -z "$directory" ]; then',
  '  directory=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0',
  '  case "$directory" in /*) ;; *) directory=$PWD/$directory ;; esac',
  '  directory=$directory/hooks',
  'fi',
  'case "$directory" in /*) ;; *) directory=$PWD/$directory ;; esac',
  `[ -x "$directory/${name}" ] || exit 0`,
  `exec "$directory/${name}" "$@"`,
].join('\n')

/**
 * Rewrites the pipelines a worker may run from the receiving rules, atomically and idempotently, keeping the ownership marker
 * the file's other writers check; returns false when the file was written by hand, which is never replaced.
 */
export async function writeWorkerPipelines(stateDir: string, prefixes: readonly string[]): Promise<boolean> {
  const file = workerPipelines(stateDir)
  const text = [MARKER, ...prefixes].join('\n') + '\n'
  // The forwarding script reads this file on every call, so an unchanged one is left alone rather than replaced under a running worker.
  if (await readFile(file, 'utf8').catch(() => undefined) === text) return true
  try { await own(file, text) }
  catch (error) {
    // A hand-written file is the operator's; the caller reports that the rules do not reach workers.
    if (error instanceof SetupError && error.code === 'foreignFile') return false
    throw error
  }
  return true
}

/**
 * Names the prefixes a worker may run, unless the file already names some: a write from the settings is the operator's choice and
 * outlives a restart, while a missing or empty file falls back to the defaults.
 */
async function syncPipelines(stateDir: string): Promise<void> {
  const file = workerPipelines(stateDir)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text !== undefined) {
    if (!await written(file)) throw new SetupError('foreignFile', { file })
    if (text.split('\n').some(line => line.trim() && !line.trim().startsWith('#'))) return
  }
  await writeWorkerPipelines(stateDir, DEFAULT_PIPELINE_PREFIXES)
}

/** The files of the workers' hooks directory: the push guard, and a forwarder for every hook it hides. */
function hookFiles(): Map<string, string> {
  const files = new Map<string, string>()
  files.set('pre-push', PRE_PUSH)
  for (const name of FORWARDED_HOOKS) files.set(name, forwardHook(name))
  return files
}

/** The command a worker should use instead of a blocked one, naming the account it acts as. */
function agentCli(deployment: Pick<Deployment, 'github' | 'codeup'>): string {
  if (deployment.github) return `gh, which acts as ${deployment.github.login}`
  if (deployment.codeup) return `aliyun, which acts as ${deployment.codeup.account.name}`
  return 'the agent account'
}

/** The agent's git configuration: commit identity, the platform's credentials, the hooks directory, and the LFS filters the operator's global gitconfig would have provided. */
function gitConfig(deployment: Pick<Deployment, 'stateDir' | 'github' | 'codeup'>): string {
  const { stateDir, github, codeup } = deployment
  const lines = [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
  ]
  // GitHub authenticates HTTPS pushes through the agent CLI; Codeup authenticates SSH with the operator's key.
  if (github) lines.push('[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/')
  if (codeup) {
    lines.push('[url "git@codeup.aliyun.com:"]', `\tinsteadOf = ${CODEUP_URL}`)
    // Codeup workers deliver bugfix/ and feat/ branches, so git must run the guard dsh-superagent writes for those pushes.
    lines.push('[core]', `\thooksPath = ${gitQuote(workerHooks(stateDir))}`)
  }
  lines.push(
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true')
  return lines.join('\n') + '\n'
}

/**
 * Atomically writes worker CLI shims, the isolated git configuration, and the workers' hooks into the state directory, refusing
 * to overwrite foreign files. A shim of the platform this installation has no account for fails, so a worker cannot reach the
 * operator's own CLI of that platform, and `security` fails because the yunxiao token lives in the keychain.
 * @param keychain - the tool the `aliyun` shim reads the token with, which tests stand in for; production uses the real one.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'codeup' | 'feishu'>, blockedCommands: readonly string[],
  keychain = SECURITY): Promise<void> {
  const { stateDir, github, codeup, feishu } = deployment
  const dir = workerBin(stateDir)
  const shims = new Map<string, string>()
  shims.set('gh', github ? run(dir, github.cli) : fail('gh is unavailable: this installation has no GitHub account.'))
  shims.set('lark-cli', feishu ? run(dir, feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  shims.set('aliyun', codeup ? aliyunShim(stateDir, codeup.cli, keychain, codeup.organization) : fail('aliyun is unavailable: this installation has no Codeup account.'))
  shims.set('security', fail('security is blocked in this installation; dsh-superagent reads the keychain for the agents.'))
  for (const name of new Set(blockedCommands)) {
    if (WORKER_COMMANDS.includes(name) || name === 'security') continue
    shims.set(name, fail(`${name} is blocked in this installation; use ${agentCli(deployment)}.`))
  }
  await sync(dir, shims, 0o755)
  await own(workerGitConfig(stateDir), gitConfig(deployment))
  // The push guard belongs to Codeup, whose tickets deliver bugfix/ and feat/ branches; GitHub branches follow the prepare command.
  await sync(workerHooks(stateDir), codeup ? hookFiles() : new Map(), 0o755)
  await syncPipelines(stateDir)
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * Verifies that worker git reads the configuration dsh-superagent writes: the deployment's credential helper (GitHub only), the
 * hooks directory that guards pushes together with the environment value that outranks a repository's own, and the Codeup URL
 * rewrite that sends pushes over SSH.
 */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'codeup' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, codeup, stateDir } = deployment
  const git = (args: readonly string[]): Promise<string> =>
    runAsWorker(subprocess, ['git', ...args], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')
  if (github) {
    // `-z` separates fields with NUL and never quotes paths.
    const helpers = (await git(['config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'])).split('\0')
    if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
  }
  if (codeup) {
    const hooks = (await git(HOOKS_PATH_QUERY)).trim()
    if (hooks !== workerHooks(stateDir)) throw new Error(`git reads core.hooksPath as "${hooks}" instead of ${workerHooks(stateDir)}, so it would not run the hooks dsh-superagent writes; dsh-superagent needs git 2.32 or later.`)
    // A repository may name its own hooks directory (husky does), which outranks the file above; only the environment outranks that.
    const merged = (await git(HOOKS_PATH_MERGED_QUERY)).trim()
    const fromEnvironment = (await git(HOOKS_ORIGIN_QUERY)).split('\n')
      .some(line => { const [origin = '', value = ''] = line.split('\t'); return origin.trim() === 'command line:' && value.trim() === workerHooks(stateDir) })
    if (merged !== workerHooks(stateDir) || !fromEnvironment) {
      throw new Error(`git reads core.hooksPath as "${merged}" instead of the ${workerHooks(stateDir)} dsh-superagent sets in the environment, so a repository's own hooks would hide the push guard; dsh-superagent needs git 2.32 or later.`)
    }
    const rewrites = (await git(CODEUP_REWRITE_QUERY)).split('\n').map(line => line.trim())
    if (!rewrites.includes(CODEUP_URL)) throw new Error(`git does not rewrite ${CODEUP_URL} to git@codeup.aliyun.com:, so workers could not push with the operator's SSH key; dsh-superagent needs git 2.32 or later.`)
  }
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
