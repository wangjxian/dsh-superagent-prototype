/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import { githubHosting } from '../../src/hosting.ts'
import type { CodeupAccount, CodeupRepository, Deployment, Machine } from '../../src/deployment.ts'
import { codeupHosting } from '../../src/sources/codeup-hosting.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testRepository = (overrides: Partial<CodeupRepository> = {}): CodeupRepository =>
  ({ id: 'repo-1', path: 'group/app', name: 'app', ...overrides })
/** A resolved Codeup account as setup reports it, for tests that deliver to Codeup instead of GitHub. */
export const testCodeup = (overrides: Partial<CodeupAccount> = {}): CodeupAccount => ({
  cli: '/bin/false', organization: 'org-1', workspace: '/tmp/dsh-superagent-workspace',
  account: { id: 'user-1', name: 'yedou', commitEmail: 'user-1@codeup.aliyun.com' },
  repositories: [testRepository()], ...overrides,
})
/** A deployment whose code hosting is GitHub, unless `codeup` is given without `github`, which makes Codeup host. */
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => {
  const base = {
    ...testMachine(), repository: 'acme/widgets',
    github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu' as const, name: 'Widgets Bot' },
    ...overrides,
  }
  const hosting = base.github
    ? githubHosting({ repository: base.repository, account: { id: base.github.login, name: base.github.login, commitEmail: base.github.noreply } })
    : codeupHosting(base.codeup!)
  return { ...base, hosting, ...overrides }
}
