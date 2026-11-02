/**
 * The Codeup implementation of the code hosting contract: merge requests as the platform-neutral `Change`, repository file
 * reads, and the rule that binds a merge request to a ticket. Codeup's changes live on the `yunxiao` Source's Threads, which
 * the work-item Source of a later phase polls; this phase only reads and binds them.
 */
import { z } from 'zod'
import type { CodeupAccount, CodeupRepository } from '../deployment.ts'
import type { Change, ClaimInput, Hosting } from '../hosting.ts'
import { ticketBranch } from '../hosting.ts'
import { sameName } from '../infra/text.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'
import { readMergeRequest } from './yunxiao-mr.ts'

/** The Source a Codeup change's Thread belongs to; the work-item Source of a later phase owns it. */
export const CODEUP_SOURCE = 'yunxiao'
/** The web page of a merge request; a repository's path already starts with its organization. */
export const codeupUrl = (repository: CodeupRepository, localId: number): string =>
  `https://codeup.aliyun.com/${repository.path}/change/${localId}`
/** Resolves a repository the caller names by id or by group path. */
export const repositoryOf = (account: CodeupAccount, repository: string): CodeupRepository | undefined =>
  account.repositories.find(item => item.id === repository || item.path === repository || item.name === repository)

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
      const text = await commands.aliyun(YUNXIAO.fileBlobs(account.organization, target.id, path, target.defaultBranch ?? 'master'))
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
      // The merge request is read the way the poller and the merge approval read it, so all three agree on its state and head.
      const request = await readMergeRequest(commands.withSignal(signal), account.organization, { repositoryId: target.id, localId: number })
      const ended = request.endedAt ? request.state === 'merged' ? { mergedAt: request.endedAt } : request.state === 'closed' ? { closedAt: request.endedAt } : {} : {}
      return { repository: target.id, number, url: request.url || codeupUrl(target, number), title: request.title, state: request.state,
        author: request.author, headRef: request.source, baseRef: request.target, headSha: request.head,
        ...request.createdAt ? { createdAt: request.createdAt } : {}, ...ended, ...request.workItemIds?.length ? { workItemIds: request.workItemIds } : {} }
    },
    claim: ({ ticket, change, source, serial }: ClaimInput) => {
      const started = !!source && sameName(source.repository, change.repository) && source.number === change.number
      const opened = sameName(change.author, account.account.id) && ticketBranch(ticket, change.headRef, serial)
        && account.repositories.some(item => item.id === change.repository)
      if (!started && !opened) {
        return { refused: `The merge request does not belong to this ticket: report the ticket's own merge request, or one by ${account.account.name} from a branch that ends with DSH_SUPERAGENT_NAME or the work item's serial` }
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
