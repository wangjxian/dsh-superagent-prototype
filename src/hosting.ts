/**
 * The code hosting platform dsh-superagent delivers to: the account it acts as, reading repository files, and the rules of the
 * changes (GitHub pull requests or Codeup merge requests) a ticket follows. Core code and Sources see only this interface, so
 * a second platform adds an implementation rather than branches.
 */
import { z } from 'zod'
import { key, type Follow, type OutboundMessage, type ThreadRef, type Ticket, type Trigger } from './core/index.ts'
import type { Commands } from './infra/commands.ts'
import { sameName } from './infra/text.ts'
import { readRepositoryPath } from './sources/github-read.ts'
import type { Localized } from './sources/kind.ts'

/** The code hosting platforms dsh-superagent knows how to deliver to. */
export type Platform = 'github' | 'codeup'
/** The account dsh-superagent acts as on the platform; `commitEmail` is the identity a worker commits with. */
export interface HostAccount { id: string; name: string; commitEmail: string }
/** One change request of a repository, normalized across platforms; `state` collapses a merged change into `merged`. */
export interface Change {
  /** The repository as the platform names it: `owner/name` on GitHub, the repository id on Codeup. */
  repository: string
  number: number
  url: string
  title: string
  state: 'open' | 'merged' | 'closed'
  /** The account id that opened it. */
  author: string
  headRef: string
  baseRef: string
  headSha: string
  /** The repository the change's branch lives in, when it differs from the target: a pull request from a fork names its own. */
  headRepository?: string
  createdAt?: string
  mergedAt?: string
  closedAt?: string
  /** True while the platform's own automatic merge is armed. */
  autoMerge?: boolean
  /** The work items the change is associated with, on platforms that associate them. */
  workItemIds?: readonly string[]
}
/** Whether a change belongs to a ticket; `own` when the ticket's work opened it, and `refused` why it may not bind. */
export type Claim = { own: boolean } | { refused: string }
export interface ClaimInput {
  ticket: Pick<Ticket, 'execution' | 'origin' | 'follows'>
  change: Change
  /** The change the ticket started from, when its origin trigger is one. */
  source?: Change | undefined
  /** The serial of the work item the ticket started from (`AXOAXO-6812`), which the team's branch names end with. */
  serial?: string | undefined
}
/**
 * One platform's code hosting: the account and repositories setup resolved, repository reads, change reads, the binding rule of
 * a change to a ticket, and the notice a ticket's end posts to its other conversations.
 */
export interface Hosting {
  readonly platform: Platform
  readonly title: Localized
  readonly account: HostAccount
  /** The repositories a ticket may deliver to, as the platform names them. */
  readonly repositories: readonly string[]
  /** Reads a non-hidden repository file or a directory listing as text for an assessment. */
  readPath(commands: Commands, repository: string | undefined, path: string, kind: 'file' | 'directory'): Promise<string>
  /** Reads one change request of `repository`. */
  readChange(commands: Commands, repository: string, number: number, signal?: AbortSignal): Promise<Change>
  /**
   * Whether `change` is the ticket's: the change its origin trigger came from, or one this account opened from a branch whose
   * last path segment is the ticket's short name. Binding a change to at most one open ticket is the caller's rule.
   */
  claim(input: ClaimInput): Claim
  /** The Thread a change binds to. */
  thread(change: Change): ThreadRef
  /**
   * Whether a ticket ends when the change it follows closes. GitHub's pull requests do, as they always have; a Codeup merge
   * request does not: the merge is one step of the delivery, so the ticket ends with its own ready report once the work is
   * verified, while the merge request's messages still reach it.
   */
  readonly changeEndsTicket: boolean
  /** Notices for the ticket's other conversations when it ends with the latest change it followed. */
  endNotices(ticket: Ticket, request: string): OutboundMessage[]
}
/**
 * True when a branch belongs to the ticket: its last path segment is the ticket's short name, as in `agent/<name>`, or ends
 * with it, or with the serial of the ticket's work item, after a dash, as the team's `bugfix/<yymmdd>-<description>-<serial>`
 * naming does. A retarget branch keeps the name of the branch it moves and adds `-to-release-<yyyymmdd>`.
 */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string, serial?: string): boolean => {
  const last = (ref.split('/').at(-1) ?? '').replace(/-to-release-\d{8}$/, '')
  const ends = (name: string | undefined): boolean => !!name && (last === name || last.endsWith(`-${name}`))
  return ends(ticket.execution?.name) || ends(serial)
}
/** The change a ticket started from, when its origin trigger is a change of the platform; only its number identifies it. */
export function triggerChange(trigger: Pick<Trigger, 'meta'> | undefined, repository: string): Change | undefined {
  if (!trigger || trigger.meta.isPr !== true) return undefined
  const number = Number(trigger.meta.number)
  if (!Number.isInteger(number) || number <= 0) return undefined
  return { repository, number, url: '', title: '', state: 'open', author: '', headRef: '', baseRef: '', headSha: '' }
}
/** Latest change a ticket followed that has closed, preferring one it opened. */
function latestClosed(ticket: Ticket, parse: (thread: string) => Change | undefined): { change: Change; outcome: 'merged' | 'closed' } | undefined {
  const follows = (ticket.follows ?? []).filter((item): item is Follow & { closed: { at: string; outcome: 'merged' | 'closed' } } => !!item.closed)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  const change = follow ? parse(follow.thread) : undefined
  return follow?.closed && change ? { change, outcome: follow.closed.outcome } : undefined
}
/**
 * Builds the notices a ticket's end posts to its conversations other than the platform's own, in the ticket request's language.
 * The platform's own timeline already shows the merge or close, so its channels are skipped.
 */
export function changeEndNotices(input: { ticket: Ticket; request: string; change: Change; outcome: 'merged' | 'closed'; source: string; label: string }):
OutboundMessage[] {
  const { ticket, request, change, outcome, source, label } = input
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[${label} #${change.number}](${change.url}) 已合并。` : `[${label} #${change.number}](${change.url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[${label} #${change.number}](${change.url}) has merged.` : `[${label} #${change.number}](${change.url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== source).map(channel => ({
    id: key('pr-terminal', String(change.number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}

const SOURCE = 'github'
/** The GitHub page of a pull request, for notices and cards. */
export const githubPage = (repository: string, number: number): string => `https://github.com/${repository}/pull/${number}`
const GithubChangeSchema = z.looseObject({
  number: z.number().int().positive().nullish(), title: z.string().optional(), state: z.string(), html_url: z.string(),
  merged: z.boolean().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), created_at: z.string().nullish(),
  auto_merge: z.unknown().nullish(),
  user: z.looseObject({ login: z.string() }).nullish(),
  head: z.looseObject({ ref: z.string(), sha: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
  base: z.looseObject({ ref: z.string() }).nullish(),
})
/**
 * Normalizes a GitHub pull request record into the platform-neutral `Change`; `number` names the request when the record omits
 * it, which a listing does not.
 */
export function githubChange(pull: z.infer<typeof GithubChangeSchema>, repository: string, number?: number): Change {
  const merged = pull.merged === true || !!pull.merged_at
  const localId = pull.number ?? number
  if (!localId) throw new Error('The pull request report names no number')
  return { repository, number: localId, url: pull.html_url, title: pull.title ?? '',
    state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open', author: pull.user?.login ?? '',
    headRef: pull.head.ref, baseRef: pull.base?.ref ?? '', headSha: pull.head.sha,
    ...pull.head.repo?.full_name ? { headRepository: pull.head.repo.full_name } : {},
    ...pull.created_at ? { createdAt: pull.created_at } : {}, ...pull.merged_at ? { mergedAt: pull.merged_at } : {},
    ...pull.closed_at ? { closedAt: pull.closed_at } : {}, ...pull.auto_merge != null ? { autoMerge: true } : {} }
}
/** The GitHub implementation: `repository` is the one repository the GitHub Source watches. */
export function githubHosting(input: { repository: string; account: HostAccount }): Hosting {
  const { repository, account } = input
  return {
    platform: 'github',
    title: { zh: 'GitHub', en: 'GitHub' },
    account,
    repositories: repository ? [repository] : [],
    // `Commands.api` already restricts GitHub calls to the configured repository, so the argument only names it.
    readPath: (commands, _repository, path, kind) => readRepositoryPath(commands, path, kind),
    readChange: async (commands, _repository, number, signal) =>
      githubChange(await commands.withSignal(signal).api(GithubChangeSchema, `pulls/${number}`), repository, number),
    claim: ({ ticket, change, source }) => {
      const started = source?.number === change.number
      // A pull request from a fork never belongs to a ticket, whatever its branch is called.
      const opened = sameName(change.author, account.id) && sameName(change.headRepository ?? change.repository, repository)
        && ticketBranch(ticket, change.headRef)
      if (!started && !opened) {
        return { refused: `The change does not belong to this ticket: report the ticket's own change, or one by ${account.id} from a branch that names DSH_SUPERAGENT_NAME` }
      }
      return { own: opened }
    },
    thread: change => ({ source: SOURCE, id: String(change.number) }),
    changeEndsTicket: true,
    endNotices: (ticket, request) => {
      const parse = (thread: string): Change | undefined => {
        const number = thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
        return number ? { repository, number, url: githubPage(repository, number), title: '', state: 'closed', author: '', headRef: '', baseRef: '', headSha: '' } : undefined
      }
      const latest = latestClosed(ticket, parse)
      return latest ? changeEndNotices({ ticket, request, change: latest.change, outcome: latest.outcome, source: SOURCE, label: 'PR' }) : []
    },
  }
}
