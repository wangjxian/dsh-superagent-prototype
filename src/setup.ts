/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'codeup' | 'feishu'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  hostingUnset: ['deployment', 'No code hosting account is configured: fill in the GitHub Source (repository and CLI), or the Codeup Source (aliyun CLI, organization and workspace).'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  codeupCliUnset: ['codeup', 'The Codeup Source names no aliyun CLI.'],
  codeupCliMissing: ['codeup', 'The aliyun CLI was not found.'],
  codeupCliSignedOut: ['codeup', 'The aliyun CLI cannot read its account; check that the yunxiao access token belongs to this organization.'],
  codeupTokenMissing: ['codeup', 'dsh-superagent cannot read the yunxiao access token from the keychain; add it with security add-generic-password -s dsh-superagent-yunxiao -a <organization> -w.'],
  codeupAccountUnreported: ['codeup', 'The aliyun CLI did not report the yunxiao account.'],
  codeupOrgUnset: ['codeup', 'The Codeup Source names no organization.'],
  codeupWorkspaceUnset: ['codeup', 'The Codeup Source names no workspace.'],
  codeupWorkspaceMissing: ['codeup', '{workspace} is not a directory.'],
  codeupSshUnavailable: ['codeup', 'git@codeup.aliyun.com does not accept the operator\'s SSH key; add the key to Codeup, as docs/006-deployment.md describes.'],
  codeupNoRepositories: ['codeup', 'No repository in {workspace} has a codeup.aliyun.com remote this account may push to{refused}.'],
  codeupRepositoryUnreadable: ['codeup', 'The aliyun CLI could not read the repository {repository}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
