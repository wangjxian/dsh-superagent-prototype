/**
 * The Codeup implementation of the code hosting contract: merge requests as the platform-neutral `Change`, repository file
 * reads, and the rule that binds a merge request to a ticket. Codeup's changes live on the `yunxiao` Source's Threads, which
 * the work-item Source of a later phase polls; this phase only reads and binds them.
 */
import { z } from 'zod'
import type { CodeupAccount, CodeupRepository } from '../deployment.ts'
import type { Change, ClaimInput, Hosting } from '../hosting.ts'
import { ticketBranch } from '../hosting.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'

/** The Source a Codeup change's Thread belongs to; the work-item Source of a later phase owns it. */
export const CODEUP_SOURCE = 'yunxiao'
/** The web page of a merge request, as Codeup writes it for the organization. */
export const codeupUrl = (account: CodeupAccount, repository: CodeupRepository, localId: number): string =>
  `https://codeup.aliyun.com/${account.organization}/${repository.path}/change/${localId}`
/** Resolves a repository the caller names by id or by group path. */
export const repositoryOf = (account: CodeupAccount, repository: string): CodeupRepository | undefined =>
  account.repositories.find(item => item.id === repository || item.path === repository || item.name === repository)

const MergeRequestSchema = z.looseObject({
  localId: z.number().int().positive(),
  title: z.string().nullish(),
  sourceBranch: z.string().nullish(),
  targetBranch: z.string().nullish(),
  sourceCommitSha: z.string().nullish(),
  state: z.string().nullish(),
  webUrl: z.string().nullish(),
  createdAt: z.string().nullish(),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  workItemIds: z.array(z.union([z.string(), z.number()]).transform(String)).nullish(),
  author: z.looseObject({ id: z.union([z.string(), z.number()]).transform(String), name: z.string().nullish() }).nullish(),
})
/** Normalizes Codeup's merge-request states onto the platform-neutral ones. */
const stateOf = (state: string | null | undefined, mergedAt: string | null | undefined): Change['state'] => {
  const value = (state ?? '').toUpperCase()
  if (value === 'MERGED' || mergedAt) return 'merged'
  return value === 'CLOSED' ? 'closed' : 'open'
}
const FileBlobSchema = z.looseObject({
  content: z.string().nullish(), encoding: z.string().nullish(), path: z.string().nullish(),
  children: z.array(z.looseObject({ name: z.string(), type: z.string().nullish() })).nullish(),
  entries: z.array(z.looseObject({ name: z.string() })).nullish(),
})
/**
 * The Codeup implementation: `account` carries the organization, the CLI, and the workspace repositories a ticket may deliver to.
 * The CLI flags of every call come from `YUNXIAO`, so calibrating them against a real installation changes one file.
 */
export function codeupHosting(account: CodeupAccount): Hosting {
  const repositories = account.repositories.map(item => item.id)
  const resolved = (repository: string): CodeupRepository => {
    const found = repositoryOf(account, repository)
    if (!found) throw new Error(`${repository} is not a repository of the Codeup workspace ${account.workspace}`)
    return found
  }
  return {
    platform: 'codeup',
    title: { zh: '云效 Codeup', en: 'Yunxiao Codeup' },
    account: account.account,
    repositories,
    readPath: async (commands, repository, path, kind) => {
      const target = resolved(repository ?? repositories[0] ?? '')
      const text = await commands.aliyun(YUNXIAO.fileBlobs(account.organization, target.id, path))
      const blob = z.union([FileBlobSchema, z.array(FileBlobSchema)]).parse(JSON.parse(text.slice(Math.max(0, text.indexOf('{')))))
      const one = Array.isArray(blob) ? blob[0] : blob
      if (!one) throw new Error(`${path} has no content in ${target.path}`)
      if (kind === 'directory') {
        const names = (one.children ?? one.entries ?? []).map(entry => entry.name).filter(name => !name.startsWith('.')).sort()
        if (!names.length) throw new Error(`${path} is not a directory of ${target.path}`)
        return names.join('\n')
      }
      const content = one.content ?? ''
      // Codeup returns file contents base64-encoded unless the response says otherwise.
      return /base64/i.test(one.encoding ?? '') ? Buffer.from(content, 'base64').toString('utf8') : content
    },
    readChange: async (commands, repository, number, signal) => {
      const target = resolved(repository)
      const request = await commands.withSignal(signal).aliyun(MergeRequestSchema, YUNXIAO.changeRequest(account.organization, target.id, number))
      return { repository: target.id, number: request.localId, url: request.webUrl ?? codeupUrl(account, target, request.localId),
        title: request.title ?? '', state: stateOf(request.state, request.mergedAt), author: request.author?.id ?? '',
        headRef: request.sourceBranch ?? '', baseRef: request.targetBranch ?? '', headSha: request.sourceCommitSha ?? '',
        ...request.createdAt ? { createdAt: request.createdAt } : {}, ...request.mergedAt ? { mergedAt: request.mergedAt } : {},
        ...request.closedAt ? { closedAt: request.closedAt } : {}, ...request.workItemIds?.length ? { workItemIds: request.workItemIds } : {} }
    },
    claim: ({ ticket, change, source }: ClaimInput) => {
      const started = !!source && sameName(source.repository, change.repository) && source.number === change.number
      const opened = sameName(change.author, account.account.id) && ticketBranch(ticket, change.headRef)
        && account.repositories.some(item => item.id === change.repository)
      if (!started && !opened) {
        return { refused: `The merge request does not belong to this ticket: report the ticket's own merge request, or one by ${account.account.name} from a branch that names DSH_SUPERAGENT_NAME` }
      }
      return { own: opened }
    },
    // A merge request's Thread is named by its repository and local id, as the work-item Source reads it.
    thread: change => ({ source: CODEUP_SOURCE, id: `mr:${change.repository}:${change.number}` }),
    // The merge request is followed for its messages, not for its close: the ticket ends with its own ready report.
    changeEndsTicket: false,
    // A ticket in this phase ends with its ready report, so no merge notice is posted; the change tracking of a later phase adds it.
    endNotices: () => [],
  }
}
