import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CODEUP_URL, GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, verifyEnvironment, withoutDirectory, workerBin,
  workerGitConfig, workerHooks, writeEnvironment } from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { TOKEN_MISSING, TOKEN_MISSING_STATUS, YUNXIAO } from '../src/infra/yunxiao.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** A stand-in `aliyun` that prints the token it received and its arguments, one per line. */
const aliyunProgram = (path: string): string => program(path, 'printf "%s\\n" "token=$ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN" "$@"')
/** A stand-in `aliyun` that logs every call and answers pipeline lookups, so the forwarding script's guard can be observed. */
const pipelineFake = (path: string, log: string): string => program(path, [
  `echo "$*" >> ${log}`,
  'case "$*" in',
  `  "devops flow-get-pipeline --organization-id org-1 --pipeline-id 11") echo '{"id":11,"name":"pre-axo-manager-x64"}' ;;`,
  `  "devops flow-get-pipeline --organization-id org-1 --pipeline-id 12") echo '{"data":{"pipelineName":"prod-axo-manager-x64"}}' ;;`,
  `  "devops flow-get-pipeline --organization-id org-1 --pipeline-id 13") echo '{"name":"prod-pre-axo-manager-x64"}' ;;`,
  `  "devops flow-get-pipeline --organization-id org-1 --pipeline-id 14") echo '{"name":"staging-axo"}' ;;`,
  `  "devops flow-get-pipeline --organization-id org-1 --pipeline-id 15") echo 'not json' ;;`,
  `  "devops flow-get-pipeline-run --organization-id org-1 --pipeline-run-id 33") echo '{"pipeline":{"id":11,"name":"qa-axo-manager-x64"}}' ;;`,
  `  "devops flow-get-pipeline-run --organization-id org-1 --pipeline-run-id 34") echo '{"pipeline":{"name":"prod-axo-manager-x64"}}' ;;`,
  `  "devops flow-get-pipeline-run --organization-id org-1 --pipeline-run-id 35") exit 3 ;;`,
  `  "devops flow-get-pipeline-run --organization-id org-1 --pipeline-run-id 36") echo '{"name":"run-1","pipeline":{"id":11,"name":"qa-axo-manager-x64"}}' ;;`,
  '  *) printf "OK %s\\n" "$*" ;;',
  'esac',
].join('\n'))
/** A stand-in keychain tool that always holds a token, which tests use because the operator's keychain is not theirs to read. */
const keychainProgram = (path: string, token = 'token-1'): string => program(path, `echo ${token}`)
const github = (cli: string) => ({ cli, login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' })
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: github(wrapper), feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot, each blocked command fail with the agent\'s login, and `security` fail for every installation', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
    // The yunxiao token lives in the keychain, so a worker may not read it back with `security`.
    await expect(exec(join(bin, 'security'), ['find-generic-password', '-s', 'dsh-superagent-yunxiao', '-w']))
      .rejects.toMatchObject({ code: 1, stderr: 'security is blocked in this installation; dsh-superagent reads the keychain for the agents.\n' })
  })
  it('fail the shim of a platform this installation has no account for, so a worker cannot reach the operator\'s own CLI', async () => {
    const aliyun = aliyunProgram(join(dir, 'real', 'aliyun'))
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: aliyun }), feishu: undefined }), [],
      keychainProgram(join(dir, 'real', 'security')))
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'gh'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: 'gh is unavailable: this installation has no GitHub account.\n' })
    expect((await exec(join(bin, 'aliyun'), ['devops', 'base-get-user-by-token'], { env: { PATH: join(dir, 'real') } })).stdout)
      .toContain('devops\nbase-get-user-by-token')
    // The blocked commands name the account the worker may use instead.
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: aliyun }), feishu: undefined }), ['personal-aliyun'],
      keychainProgram(join(dir, 'real', 'security')))
    await expect(exec(join(bin, 'personal-aliyun'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-aliyun is blocked in this installation; use aliyun, which acts as yedou.\n' })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    await writeEnvironment(testDeployment({ stateDir: dir, github: github(gh), feishu: { cli: lark, appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' } }),
      ['gh', 'git', 'lark-cli', 'aliyun', 'security'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
    // `security` keeps its own refusal instead of the blocked-command text.
    expect(readFileSync(join(bin, 'security'), 'utf8')).toContain('security is blocked in this installation; dsh-superagent reads the keychain for the agents.')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['aliyun', 'gh', 'lark-cli', 'security'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
    // The hooks directory is dsh-superagent's too: a hook the operator put there is never overwritten.
    rmSync(workerGitConfig(dir))
    writeFileSync(join(workerHooks(dir), 'pre-commit'), '#!/bin/sh\nexit 0\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerHooks(dir), 'pre-commit')} was not written by dsh-superagent`)
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['aliyun', 'gh', 'lark-cli', 'security'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('aliyun forwarding script', () => {
  /** Writes a Codeup-only installation whose `aliyun` is a stand-in that prints what it received. */
  const setup = async (keychain?: string): Promise<void> => {
    const deployment = testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: aliyunProgram(join(dir, 'real', 'aliyun')) }), feishu: undefined })
    await writeEnvironment(deployment, [], keychain ?? keychainProgram(join(dir, 'real', 'security')))
  }
  // The PATH a worker has: the stand-ins first, then the system's tools, which the script uses to read the CLI's JSON.
  const aliyun = (args: string[]) => exec(join(workerBin(dir), 'aliyun'), args, { env: { PATH: [join(dir, 'real'), '/usr/bin', '/bin'].join(':') }, timeout: 10_000 })
  it('runs a read-only call as the agent with the keychain token in its environment only', async () => {
    await setup()
    const { stdout } = await aliyun(['devops', 'codeup-get-change-request', '--organization-id', 'org-1', '--repository-id', 'repo-1', '--local-id', '3'])
    // The token came from the keychain entry the shim names, and reached only the CLI it execs.
    expect(stdout.split('\n').filter(Boolean)).toEqual(['token=token-1', 'devops', 'codeup-get-change-request', '--organization-id', 'org-1',
      '--repository-id', 'repo-1', '--local-id', '3'])
  })
  it('names the missing keychain entry instead of running the CLI when no token can be read', async () => {
    // The operator's keychain has no dsh-superagent entry in a test: the shim must say so rather than run signed out.
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: aliyunProgram(join(dir, 'real', 'aliyun')) }), feishu: undefined }), [])
    await expect(aliyun(['devops', 'base-get-user-by-token'])).rejects.toMatchObject({ code: TOKEN_MISSING_STATUS, stderr: expect.stringContaining(TOKEN_MISSING) })
  })
  it('opens a merge request only from a bugfix/ or feat/ branch', async () => {
    await setup()
    const create = (branch: string) => aliyun(['devops', 'codeup-create-change-request', '--organization-id', 'org-1', '--source-branch', branch, '--work-item-ids', '12'])
    await expect(create('bugfix/261102-fix-12')).resolves.toBeTruthy()
    await expect(create('feat/261102-add-12')).resolves.toBeTruthy()
    // The `--flag=value` spelling is checked too, and a release branch is never a worker's to open a merge request from.
    await expect(aliyun(['devops', 'codeup-update-change-request', '--source-branch=feat/261102-add-12'])).resolves.toBeTruthy()
    for (const branch of ['release/20261031', 'master']) {
      await expect(create(branch)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`a worker may only open a merge request from a bugfix/ or feat/ branch, not '${branch}'`) })
    }
  })
  it('appends the agent marker to a merge request comment a worker writes', async () => {
    await setup()
    const { stdout } = await aliyun(['devops', 'codeup-create-change-request-comment', '--repository-id', 'repo-1', '--local-id', '3', '--content', 'Done'])
    // The body keeps its own text and gains the hidden marker and the visible line readers see.
    expect(stdout).toContain('--content\nDone\n\n<!-- dsh-superagent:agent -->\n由智能体代发\n')
    expect(stdout.indexOf('--repository-id')).toBeLessThan(stdout.indexOf('--content'))
    expect(stdout).toContain('--local-id\n3')
  })
  it('refuses the commands only the host may run, and any plugin but devops', async () => {
    await setup()
    const denied = ['codeup-merge-change-request', 'codeup-review-change-request', 'codeup-delete-branch', 'codeup-create-branch-protection',
      'projex-create-workitem-comment', 'projex-update-workitem', 'flow-pass-pipeline-validate', 'app-stack-deploy', 'packages-publish']
    for (const command of denied) {
      await expect(aliyun(['devops', command])).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining('a worker may not run this yunxiao command; the host runs it, or this phase does not do it') })
    }
    await expect(aliyun(['configure', 'list'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('a worker may only run the yunxiao devops plugin') })
    // A call that names no subcommand is refused as well.
    await expect(aliyun(['devops'])).rejects.toMatchObject({ code: 1 })
    // The host's own calls go through the same subcommand constants, so the two lists cannot disagree.
    expect(YUNXIAO.user()).toEqual(['devops', 'base-get-user-by-token'])
  })
  /** Writes a Codeup-only installation whose `aliyun` logs every call and answers pipeline lookups. */
  const setupPipelines = async (log: string): Promise<void> => {
    const fake = pipelineFake(join(dir, 'real', 'aliyun'), log)
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: fake }), feishu: undefined }), [],
      keychainProgram(join(dir, 'real', 'security')))
  }
  it('admits only qa- and pre- pipelines, after asking the CLI for the pipeline name', async () => {
    const log = join(dir, 'calls')
    await setupPipelines(log)
    const calls = () => readFileSync(log, 'utf8').trim().split('\n')
    // The lookup runs first, with the organization the shim knows; the admitted call keeps its arguments.
    const created = await aliyun(['devops', 'flow-create-pipeline-run', '--organization-id', 'org-1', '--pipeline-id', '11'])
    expect(created.stdout).toContain('OK devops flow-create-pipeline-run --organization-id org-1 --pipeline-id 11')
    expect(calls()).toEqual(['devops flow-get-pipeline --organization-id org-1 --pipeline-id 11',
      'devops flow-create-pipeline-run --organization-id org-1 --pipeline-id 11'])
    // The `--flag=value` spelling is read too.
    await expect(aliyun(['devops', 'flow-create-pipeline-run', '--pipeline-id=11'])).resolves.toBeTruthy()
    // prod-, prod-pre-, and any other name are the host's to run, once the approver confirms.
    for (const id of ['12', '13', '14']) {
      await expect(aliyun(['devops', 'flow-create-pipeline-run', '--pipeline-id', id]))
        .rejects.toMatchObject({ code: 1, stderr: 'dsh-superagent: 这个流水线由宿主执行：用 orchestrator_request_pipeline 请审批人确认。\n' })
    }
  })
  it('refuses a pipeline whose name it cannot learn, instead of starting its run', async () => {
    const log = join(dir, 'calls')
    await setupPipelines(log)
    // A reply without a name, a lookup that answers nothing, and a call that names no pipeline are all refusals.
    for (const args of [['--pipeline-id', '15'], ['--pipeline-id', '99'], []]) {
      await expect(aliyun(['devops', 'flow-create-pipeline-run', ...args]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('orchestrator_request_pipeline') })
    }
    // No run started: the log holds lookups only, and none at all for the call that named no pipeline.
    const calls = readFileSync(log, 'utf8')
    expect(calls).not.toContain('flow-create-pipeline-run')
    expect(calls).toContain('devops flow-get-pipeline --organization-id org-1 --pipeline-id 15')
    expect(calls).not.toContain('--pipeline-id 99 ')
  })
  it('asks a job run\'s pipeline name before retrying or rerunning it, and refuses a prod- one', async () => {
    const log = join(dir, 'calls')
    await setupPipelines(log)
    // A retry names its run, whose pipeline decides: qa- passes, prod- and an unreadable run do not.
    await expect(aliyun(['devops', 'flow-retry-pipeline-job-run', '--job-run-id', '33'])).resolves.toBeTruthy()
    expect(readFileSync(log, 'utf8')).toContain('devops flow-get-pipeline-run --organization-id org-1 --pipeline-run-id 33')
    // A run whose own `name` comes first is still read through its `pipeline` object.
    await expect(aliyun(['devops', 'flow-retry-pipeline-job-run', '--job-run-id', '36'])).resolves.toBeTruthy()
    for (const [command, id] of [['flow-rerun-pipeline-job-run', '34'], ['flow-retry-pipeline-job-run', '35']] as const) {
      await expect(aliyun(['devops', command, '--job-run-id', id]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('orchestrator_request_pipeline') })
    }
    // The read-only lookups stay a worker's.
    await expect(aliyun(['devops', 'flow-get-pipeline', '--organization-id', 'org-1', '--pipeline-id', '11'])).resolves.toBeTruthy()
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: github('/opt/agent tools/gh') })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    // GitHub tickets push the branches the prepare command names, so no push guard is configured for them.
    await expect(git('config', 'core.hooksPath')).rejects.toThrow()
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    // Git's own message for a missing identity is localized, so the test only asserts that the commit fails.
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toThrow()
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
  it('sends Codeup HTTPS remotes over SSH, and guards pushes with the pre-push hook', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: program(join(dir, 'real', 'aliyun'), 'exit 0') }), feishu: undefined }), [])
    const env = workerEnv({ PATH: process.env.PATH, HOME: dir, ...agentVariables(dir) })
    const git = (...args: string[]) => exec('git', args, { cwd: dir, env })
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'https://codeup.aliyun.com/group/app.git'], { cwd: dir, env })
    // Codeup authenticates SSH, so a worker's HTTPS remote reaches the operator's key.
    expect((await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).stdout.trim()).toBe('git@codeup.aliyun.com:group/app.git')
    expect((await git('-C', 'repo', 'config', 'core.hooksPath')).stdout.trim()).toBe(workerHooks(dir))
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'first')
    const branch = (await git('-C', 'repo', 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    await exec('git', ['init', '-q', '--bare', join(dir, 'remote.git')], { cwd: dir, env })
    await exec('git', ['-C', 'repo', 'remote', 'add', 'target', join(dir, 'remote.git')], { cwd: dir, env })
    // A release branch is the host's to push, and deleting a branch would lose the work item's history.
    await expect(git('-C', 'repo', 'push', 'target', branch)).rejects.toMatchObject({ stderr: expect.stringContaining(`a worker may only push bugfix/ and feat/ branches, not refs/heads/${branch}`) })
    await git('-C', 'repo', 'branch', 'bugfix/261102-fix-12')
    await expect(git('-C', 'repo', 'push', 'target', 'bugfix/261102-fix-12')).resolves.toBeTruthy()
    await expect(git('-C', 'repo', 'push', 'target', '--delete', 'bugfix/261102-fix-12'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('a worker may not delete refs/heads/bugfix/261102-fix-12') })
  })
  it('names the hooks directory in the environment, so a repository\'s own core.hooksPath cannot hide the push guard', async () => {
    const deployment = testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup({ cli: program(join(dir, 'real', 'aliyun'), 'exit 0') }), feishu: undefined })
    await writeEnvironment(deployment, [])
    // Setup hands these to the host and every worker when Codeup guards pushes, and a GitHub-only installation keeps the environment as it was.
    expect(workerEnv(agentVariables(dir, workerHooks(dir)))).toMatchObject({ GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${workerHooks(dir)}'` })
    // DSH strips `GIT_CONFIG_KEY_n` from child environments, so naming the key there would break every worker git command.
    expect(workerEnv(agentVariables(dir, workerHooks(dir)))).not.toHaveProperty('GIT_CONFIG_COUNT')
    expect(workerEnv(agentVariables(dir, workerHooks(dir)))).not.toHaveProperty('GIT_CONFIG_KEY_0')
    expect(workerEnv(agentVariables(dir))).not.toHaveProperty('GIT_CONFIG_PARAMETERS')
    const env = workerEnv({ PATH: process.env.PATH, HOME: dir, ...agentVariables(dir, workerHooks(dir)) })
    const git = (...args: string[]) => exec('git', args, { cwd: dir, env })
    await git('init', '-q', 'repo')
    // husky names the repository's own hooks directory in its local configuration, which outranks the global one.
    mkdirSync(join(dir, 'repo', '.husky'), { recursive: true })
    await git('-C', 'repo', 'config', 'core.hooksPath', '.husky')
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'first')
    await exec('git', ['init', '-q', '--bare', join(dir, 'remote.git')], { cwd: dir, env })
    await exec('git', ['-C', 'repo', 'remote', 'add', 'target', join(dir, 'remote.git')], { cwd: dir, env })
    const branch = (await git('-C', 'repo', 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    await expect(git('-C', 'repo', 'push', 'target', branch))
      .rejects.toMatchObject({ stderr: expect.stringContaining('a worker may only push bugfix/ and feat/ branches') })
    await git('-C', 'repo', 'branch', 'bugfix/261102-fix-12')
    await expect(git('-C', 'repo', 'push', 'target', 'bugfix/261102-fix-12')).resolves.toBeTruthy()
  })
  it('runs the repository\'s own hooks, which the agent\'s hooks directory would otherwise hide', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup() }), [])
    const env = workerEnv({ PATH: process.env.PATH, HOME: dir, ...agentVariables(dir) })
    const git = (...args: string[]) => exec('git', args, { cwd: dir, env })
    await git('init', '-q', 'repo')
    program(join(dir, 'repo', '.git', 'hooks', 'pre-commit'), `echo ran > ${join(dir, 'ran')}`)
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'first')
    expect(readFileSync(join(dir, 'ran'), 'utf8')).toBe('ran\n')
  })
})

describe('environment verification', () => {
  const signal = new AbortController().signal
  it('passes when worker git reads the configuration dsh-superagent wrote, on either platform', async () => {
    const githubDeployment = testDeployment({ stateDir: dir })
    await writeEnvironment(githubDeployment, [])
    await expect(verifyEnvironment(githubDeployment, subprocess(workerGitConfig(dir)), signal)).resolves.toBeUndefined()
    const codeupDeployment = testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup() })
    await writeEnvironment(codeupDeployment, [])
    await expect(verifyEnvironment(codeupDeployment, subprocess(workerGitConfig(dir), hooksVariables()), signal)).resolves.toBeUndefined()
  })
  it('fails when worker git does not read the hooks directory or the Codeup rewrite dsh-superagent wrote', async () => {
    const codeupDeployment = testDeployment({ stateDir: dir, github: undefined, codeup: testCodeup() })
    await writeEnvironment(codeupDeployment, [])
    // A worker whose git read the operator's configuration would push around the guard.
    writeFileSync(join(dir, 'global'), '[user]\n\tname = Operator\n')
    await expect(verifyEnvironment(codeupDeployment, subprocess(join(dir, 'global'), hooksVariables()), signal))
      .rejects.toThrow(`git reads core.hooksPath as "" instead of ${workerHooks(dir)}`)
    // Without the environment value, a repository's own hooks directory would hide the guard.
    await expect(verifyEnvironment(codeupDeployment, subprocess(workerGitConfig(dir)), signal))
      .rejects.toThrow(`git reads core.hooksPath as "${workerHooks(dir)}" instead of the ${workerHooks(dir)} dsh-superagent sets in the environment`)
    // Without the rewrite, a worker's HTTPS push would need a credential helper Codeup does not use.
    writeFileSync(join(dir, 'hooks-only'), `[core]\n\thooksPath = ${workerHooks(dir)}\n`)
    await expect(verifyEnvironment(codeupDeployment, subprocess(join(dir, 'hooks-only'), hooksVariables()), signal))
      .rejects.toThrow(`git does not rewrite ${CODEUP_URL} to git@codeup.aliyun.com:`)
  })
  it('keeps requiring the agent\'s GitHub credential helper only when GitHub is configured', async () => {
    const deployment = testDeployment({ stateDir: dir })
    await writeEnvironment(deployment, [])
    // A git that reads another configuration reports that configuration's helper, which cannot push as the agent.
    writeFileSync(join(dir, 'global'), '[credential "https://github.com"]\n\thelper = osxkeychain\n')
    await expect(verifyEnvironment(deployment, subprocess(join(dir, 'global')), signal)).rejects.toMatchObject({ code: 'gitTooOld' })
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: github(agent) })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

/** The variables Setup adds when Codeup guards pushes: the environment's `core.hooksPath`, which outranks a repository's own. */
const hooksVariables = (): Record<string, string> => ({ GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${workerHooks(dir)}'` })
/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config and extra environment. */
const subprocess = (config: string, environment: Record<string, string> = {}): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', ...environment }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
