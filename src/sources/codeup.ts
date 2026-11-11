/** Codeup account Source kind and Cordis plugin entry: phase one carries the yunxiao account and receives nothing. */
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
import { CodeupAccountsSchema } from '../deployment.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

/** The kind's id and the one health entry it reports; the work-item Source of a later phase is `yunxiao`. */
const SOURCE = 'codeup'
/**
 * The Source's settings: the account setup reads, and phase one adds no field of its own. Strict, unlike the deployment's
 * account schema, which stays open for the other Sources' blocks, so the panel cannot store a field setup would not read.
 */
const CodeupConfigSchema = CodeupAccountsSchema.extend({}).strict()
/** The Codeup account's settings as the panel stores them. */
export type CodeupConfig = z.infer<typeof CodeupConfigSchema>

export const codeupKind: SourceKind<CodeupConfig> = {
  kind: SOURCE,
  title: { zh: '云效 Codeup', en: 'Yunxiao Codeup' },
  description: { zh: '智能体的云效账号，以及交付到 Codeup 的总工作空间。一期只保存账号、给执行器提供工作空间、组织和账号的环境变量，不接收工作项，也不轮询。', en: 'The agent\'s yunxiao account and the workspace it delivers to Codeup. Phase one stores the account and gives Executors the workspace, organization and account variables only: it receives no work items and polls nothing.' },
  schema: CodeupConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '智能体的 aliyun CLI', en: 'Agent aliyun CLI' },
      hint: { zh: '命令名或绝对路径，通常是从钥匙串取云效令牌的 aliyun 包装脚本。智能体以它取到的令牌行事，执行器以 aliyun 调用它。保存时检查它报告的身份，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually an aliyun wrapper that reads the yunxiao token from the keychain. The agent acts with the token it reads and the Executor calls it as aliyun. Saving checks the identity it reports, then restarts dsh-superagent.' } },
    { key: 'organization', type: 'text', label: { zh: '云效组织 id', en: 'Yunxiao organization id' },
      hint: { zh: '云效组织的 id。每个 devops 子命令都用它作为 --organization-id；保存时用 base-get-user-by-token 确认令牌属于这个组织，然后重启 dsh-superagent。', en: 'The organization\'s id. Every devops subcommand passes it as --organization-id; saving confirms with base-get-user-by-token that the token belongs to this organization, then restarts dsh-superagent.' } },
    { key: 'workspace', type: 'text', label: { zh: '总工作空间', en: 'Workspace' },
      hint: { zh: '绝对路径。里面 remote 在 codeup.aliyun.com 的仓库都可以交付；工单涉及的每个仓库在工单目录下各建 worktree，不改动这里的原始检出。保存时扫描它确认账号能推送哪些仓库，然后重启 dsh-superagent。', en: 'An absolute path. Every repository in it whose remote is on codeup.aliyun.com may be delivered; each repository a ticket involves gets a worktree under the ticket\'s directory, leaving the checkouts here untouched. Saving scans it for the repositories the account may push to, then restarts dsh-superagent.' } },
    { key: 'commitEmail', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: '智能体提交时用的邮箱；留空时用云效账号自己的邮箱。', en: 'The email the agent commits with; empty uses the yunxiao account\'s own address.' } },
  ],
  health: [SOURCE],
  // The work-item variables belong to the yunxiao Source, which knows which work item started a ticket; this kind carries only
  // what the account itself decides.
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WORKSPACE', description: { zh: '总工作空间路径：里面 remote 在 codeup.aliyun.com 的仓库都可以交付，工单涉及的每个仓库在 $DSH_SUPERAGENT_DIR/<仓库名> 建 worktree', en: 'The workspace path: every repository in it whose remote is on codeup.aliyun.com may be delivered, and each repository a ticket involves gets a worktree at $DSH_SUPERAGENT_DIR/<repository name>' } },
      { key: 'DSH_SUPERAGENT_YUNXIAO_ORG', description: { zh: '云效组织 id；每个 devops 子命令都用它作为 --organization-id', en: 'The yunxiao organization id every devops subcommand passes as --organization-id' } },
      { key: 'DSH_SUPERAGENT_YUNXIAO_ACCOUNT', description: { zh: '智能体的云效账号；aliyun 以它为它取到的令牌行事，不用其他账号或凭据', en: 'The agent\'s yunxiao account; aliyun acts with the token it reads for it, never another account or credential' } },
    ],
    // A deployment that resolved only GitHub has no Codeup account, while this Source stays enabled; its variables are then
    // empty rather than absent, so a worker that names them still reads a value.
    values: ({ deployment }) => {
      const account = deployment.codeup
      return { DSH_SUPERAGENT_WORKSPACE: account?.workspace ?? '', DSH_SUPERAGENT_YUNXIAO_ORG: account?.organization ?? '',
        DSH_SUPERAGENT_YUNXIAO_ACCOUNT: account ? account.account.name || account.account.id : '' }
    },
  },
  // Facts hang off the field they describe: the account the CLI reaches under the CLI, and what the workspace scan found under it.
  facts: (deployment): Record<string, Localized | string> => {
    const account = deployment?.codeup
    if (!account) return {}
    const name = account.account.name || account.account.id
    return {
      cli: { zh: `当前账号 ${name}`, en: `Current account ${name}` },
      organization: { zh: `当前组织 ${account.organization}`, en: `Current organization ${account.organization}` },
      workspace: { zh: `可交付仓库 ${account.repositories.length} 个`, en: `${account.repositories.length} repositories to deliver` },
    }
  },
}

export const name = 'dsh-superagent-codeup'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(codeupKind), 'codeup: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, codeupKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the report is reported as source health instead.
    const running = announce(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/**
 * Reports the Source's state once: phase one polls nothing, so the account setup resolved is the whole story.
 * Setup restarts dsh-superagent after resolving the accounts, and a deployment that resolved only GitHub never resolves a
 * Codeup one, so the Source waits in both cases for a deployment check that names the account it needs.
 */
async function announce(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (signal.aborted) return
  const account = ctx.configured() ? ctx.deployment.codeup : undefined
  if (!account) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  const name = account.account.name || account.account.id
  ctx.report(SOURCE, { state: 'ready', detail: `${name} in ${account.organization}; ${account.repositories.length} repositories to deliver` })
}
