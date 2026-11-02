/**
 * The merge requests open tickets follow: polling their state, conflicts, new commits, comments, and CI checks, and the
 * Triggers and Thread closes that come of it. A merge request's Thread is `yunxiao:mr:<repository id>:<local id>`, the one
 * `codeupHosting.thread` names when a ticket binds a change, so this module and the hosting contract read the same Thread.
 */
import { z } from 'zod'
import { key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { releaseBranchDay, targetRelease, type TargetRelease } from '../infra/release.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'
import { repositoryOf } from './codeup-hosting.ts'
import type { SourceContext } from './host.ts'
import type { YunxiaoFile } from './yunxiao-config.ts'
import { isAgentComment, SOURCE } from './yunxiao-trigger.ts'
import { richText } from './yunxiao-text.ts'

/**
 * What polling merge requests needs of a Source's context: the CLI that reads Codeup, its own per-merge-request records, the
 * open tickets whose `follows` name the merge requests, the Codeup account whose repositories the release rule reads, and the
 * Engine. A full `SourceContext` is one, so the work-item Source passes its own context unchanged.
 */
export type MergeContext = Pick<SourceContext, 'commands' | 'state' | 'tickets' | 'receive' | 'deployment'>

/**
 * What one polling round hands the merge-request poller: when the round started (the observation time of a Trigger the
 * response does not time), the round's stop signal, the reads that failed, and the release target each repository was computed
 * to deliver to. A failure is one merge request's step, not the round's: the caller reports them beside its own, and the merge
 * requests it names are read again next round.
 */
export interface MergeRound {
  started: string
  signal?: AbortSignal | undefined
  failures: string[]
  /**
   * The release target of each repository, computed once for the round: `targetRelease` reads a branch list, a compare and the
   * merged merge requests, and a round may hold several merge requests of one repository. A failed computation is kept here
   * too, so the rest of the repository's merge requests do not repeat the read that failed.
   */
  targets: Map<string, TargetRelease | Error>
}
/** A round that has failed nothing yet, which the polling loop of the Source builds before it reads anything. */
export const newMergeRound = (started: string, signal?: AbortSignal): MergeRound =>
  ({ started, signal, failures: [], targets: new Map() })

/** One merge request's identity: the repository it lives in and the local id that repository numbers it by. */
export interface MergeRequestRef { repositoryId: string; localId: number }

/** The Thread a merge request's messages belong to; `codeupHosting.thread` names the same Thread when a ticket binds it. */
export function mergeRequestThread(repositoryId: string, localId: number): ThreadRef {
  return { source: SOURCE, id: `mr:${repositoryId}:${localId}` }
}
/** The Thread key of a merge request, which the tickets' `follows` and the per-merge-request records are keyed by. */
const mergeRequestKey = (ref: MergeRequestRef): string => `${SOURCE}:mr:${ref.repositoryId}:${ref.localId}`
/** How errors name a merge request: the local id people quote, and the repository that numbers it. */
const labelOf = (ref: MergeRequestRef): string => `merge request ${ref.localId} in ${ref.repositoryId}`
/**
 * Reads a Thread key back into the merge request it names, or returns undefined for a Thread of another kind (a work item's
 * `yunxiao:wi:`). A Codeup repository id is numeric and the local id after the last colon is too, so the id delimits itself;
 * a local id of zero names no merge request, as Codeup numbers them from one.
 */
export function parseMergeThread(thread: string): MergeRequestRef | undefined {
  const match = /^(?:yunxiao:)?mr:([^:]+):(\d+)$/.exec(thread)
  if (!match) return undefined
  const localId = Number(match[2])
  return Number.isSafeInteger(localId) && localId > 0 ? { repositoryId: match[1]!, localId } : undefined
}
/**
 * Reply address of a merge request's comments: the repository and local id a write names, and `parentComment`, the comment a
 * reply answers. The channel implementation reads these same keys, so this is the one place the address is spelled.
 */
export function mergeRequestChannel(ref: MergeRequestRef, parent?: string): ChannelRef {
  return { source: SOURCE, thread: mergeRequestKey(ref),
    address: { repository: ref.repositoryId, localId: String(ref.localId), ...parent ? { parentComment: parent } : {} } }
}

/** A JSON object, or undefined for any other value: the CLI's answer may also be a list or a scalar. */
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined)
/** The first candidate name of a field that the response actually filled; an empty string counts as unfilled. */
function first(source: Record<string, unknown> | undefined, names: readonly string[]): unknown {
  if (!source) return undefined
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}
/** A field as a trimmed string, accepting the numbers the CLI prints some ids as. */
function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}
/** A person field may be an object or a bare id; Codeup's `userId` is the account id, and its numeric `id` is not. */
function idOf(value: unknown): string | undefined {
  const record = recordOf(value)
  return record ? stringOf(first(record, ['userId', 'id', 'identifier', 'staffId'])) : stringOf(value)
}
/**
 * Reads a timestamp the CLI prints as epoch milliseconds or seconds, as a number or a numeric string, or as a date string;
 * an unreadable value stays empty, which callers treat as missing rather than as now.
 */
function timeOf(value: unknown): string | undefined {
  const iso = (millis: number): string | undefined => Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined
  const seconds = (seconds: number) => iso(seconds * 1000)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) < 1e12 ? seconds(value) : iso(value)
  const text = stringOf(value)
  if (!text) return undefined
  if (/^\d{10}$/.test(text)) return seconds(Number(text))
  if (/^\d{13}$/.test(text)) return iso(Number(text))
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? iso(parsed) : undefined
}
/** Response keys that wrap the payload, outermost first; the CLI prints one of them around the model. */
const ENVELOPE = ['result', 'data', 'value'] as const
/** Unwraps one merge request out of the CLI's envelope; undefined when the answer is not an object at all. */
function unwrap(raw: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  const record = recordOf(raw)
  if (!record) return undefined
  for (const name of names) {
    const nested = recordOf(record[name])
    if (nested) return nested
  }
  for (const name of ENVELOPE) {
    const nested = recordOf(record[name])
    if (nested) return nested
  }
  return record
}
/** Reads an array out of a response whose wrapper key the CLI chooses, including one nested under `result` or `data`. */
function listOf(raw: unknown, keys: readonly string[], what: string): unknown[] {
  if (Array.isArray(raw)) return raw
  const record = recordOf(raw)
  const found = (source: Record<string, unknown> | undefined): unknown[] | undefined => {
    for (const key of keys) {
      const value = source?.[key]
      if (Array.isArray(value)) return value
    }
    return undefined
  }
  const direct = found(record)
  if (direct) return direct
  for (const name of ENVELOPE) {
    const nested = found(recordOf(record?.[name]))
    if (nested) return nested
  }
  throw new Error(`The yunxiao ${what} response was not recognized; the CLI response shape may have changed`)
}

/**
 * CALIBRATE: candidate field names of the Codeup responses, which are the CLI's rendering of the OpenAPI models and are the
 * one place to calibrate against a real installation. Each lookup tries them in order, so a renamed field changes this table
 * and nothing else. A response missing every candidate for an essential field raises a readable error instead of reading as
 * empty, so a real installation that names them differently fails loudly on the first round.
 */
const FIELD = {
  state: ['state', 'status', 'changeRequestStatus'],
  mergedAt: ['mergedAt', 'mergedTime', 'mergedDate'],
  closedAt: ['closedAt', 'closedTime', 'closeTime'],
  head: ['sourceCommitSha', 'sourceCommitHash', 'headSha', 'commitSha'],
  conflict: ['conflictCheckStatus', 'conflictStatus', 'mergeConflictStatus', 'hasConflict', 'conflict'],
  title: ['title', 'subject'],
  // `detailUrl` is the merge request's page; Codeup's `webUrl` is its repository's.
  url: ['detailUrl', 'url'],
  target: ['targetBranch', 'baseBranch'],
  source: ['sourceBranch', 'headBranch'],
  author: ['author', 'creator'],
  created: ['createdAt', 'createTime', 'gmtCreate'],
  workItems: ['workItemIds', 'workitemIds'],
} as const
/** Statuses Codeup reports a merged or a closed merge request with; any other status reads as open, as Codeup adds states. */
const MERGED = /^(?:merged|accepted)\b/i
const CLOSED = /^(?:closed|declined|rejected|canceled|cancelled)\b/i
/** A conflict check result that means the merge request does not merge as it stands; Codeup answers `NO_CONFLICT` otherwise. */
const CONFLICTED = /fail|conflict/i
const NO_CONFLICT = /^no[_ -]?conflicts?$/i

/** What one read of `codeup-get-change-request` says: the state the merge request is in, and what its ticket needs to know. */
export interface MergeRequestState {
  state: 'open' | 'merged' | 'closed'
  /** The commit the merge request would merge; a different one is a new commit to review. Empty for a close that names none. */
  head: string
  /** The latest source patch set, whose id the CI checks are read by; `readMergeRequest` fills it for an open merge request. */
  patchSet?: string
  /** The account id that opened it. */
  author: string
  /** True while Codeup reports the merge request as conflicting with its target branch. */
  conflict: boolean
  title: string
  url: string
  target: string
  /** The branch the merge request delivers. */
  source: string
  /** When it merged or closed, for the ticket's close record; absent when the response times neither. */
  endedAt?: string
  createdAt?: string
  /** The work items the merge request is associated with. */
  workItemIds?: string[]
}
/**
 * Normalizes one merge request of `codeup-get-change-request`, which is the one reading of that report: the poller, the code
 * hosting contract and the merge approval all go through it, so they agree on its state, conflict and commit.
 * `state` is the field the Source cannot work without, so a response lacking it raises rather than reading as open. Codeup's
 * report names no source commit, which `readMergeRequest` reads from the patch sets.
 */
export function mergeRequestOf(raw: unknown, ref: MergeRequestRef): MergeRequestState {
  const item = unwrap(raw, ['changeRequest', 'mergeRequest', 'request', 'item'])
  if (!item) throw new Error(`The yunxiao ${labelOf(ref)} response was not recognized; the CLI response shape may have changed`)
  const status = stringOf(first(item, FIELD.state))
  if (!status) throw new Error(`The yunxiao ${labelOf(ref)} names no state; the CLI response shape may have changed`)
  const mergedAt = timeOf(first(item, FIELD.mergedAt))
  const closedAt = timeOf(first(item, FIELD.closedAt))
  const state = mergedAt || MERGED.test(status) ? 'merged' : CLOSED.test(status) ? 'closed' : 'open'
  const head = stringOf(first(item, FIELD.head)) ?? ''
  const conflictField = first(item, FIELD.conflict)
  const conflictText = stringOf(conflictField) ?? ''
  const conflict = typeof conflictField === 'boolean' ? conflictField : CONFLICTED.test(conflictText) && !NO_CONFLICT.test(conflictText)
  const endedAt = mergedAt ?? closedAt
  const createdAt = timeOf(first(item, FIELD.created))
  const workItems = first(item, FIELD.workItems)
  const workItemIds = (Array.isArray(workItems) ? workItems : typeof workItems === 'string' ? workItems.split(',') : [])
    .map(stringOf).filter((id): id is string => !!id)
  return { state, head, conflict, author: idOf(first(item, FIELD.author)) ?? '', title: stringOf(first(item, FIELD.title)) ?? '',
    url: stringOf(first(item, FIELD.url)) ?? '', target: stringOf(first(item, FIELD.target)) ?? '',
    source: stringOf(first(item, FIELD.source)) ?? '', ...endedAt ? { endedAt } : {},
    ...createdAt ? { createdAt } : {}, ...workItemIds.length ? { workItemIds } : {} }
}
const PATCH_SET_LIST = ['patchSets', 'items', 'list'] as const
/**
 * The latest source patch set of a `codeup-list-change-request-patch-sets` report: its id, which the CI checks are read by,
 * and its commit, the head of the merge request. Target patch sets name the target branch and are skipped.
 */
export function latestPatchSet(raw: unknown): { id: string; commit: string } | undefined {
  const sets = listOf(raw, PATCH_SET_LIST, 'merge request patch set list').flatMap(value => {
    const record = recordOf(value)
    const id = stringOf(first(record, ['patchSetBizId', 'patchSetId', 'id']))
    const commit = stringOf(first(record, ['commitId', 'sha', 'commitSha']))
    const kind = stringOf(first(record, ['relatedMergeItemType', 'type'])) ?? 'MERGE_SOURCE'
    return id && commit && kind !== 'MERGE_TARGET' ? [{ id, commit, version: Number(first(record, ['versionNo', 'version'])) || 0 }] : []
  })
  const latest = sets.reduce<(typeof sets)[number] | undefined>((best, set) => !best || set.version >= best.version ? set : best, undefined)
  return latest ? { id: latest.id, commit: latest.commit } : undefined
}
/**
 * Reads one merge request with its latest source patch set, which names the head commit and the CI checks' patch set.
 * An open merge request without one raises, because a new commit is half of what polling it is for; a merged or closed one
 * may name none: its close is the whole news.
 */
export async function readMergeRequest(commands: Pick<Commands, 'aliyun'>, organization: string, ref: MergeRequestRef): Promise<MergeRequestState> {
  const change = mergeRequestOf(await commands.aliyun(z.unknown(), YUNXIAO.changeRequest(organization, ref.repositoryId, ref.localId)), ref)
  if (change.state !== 'open') return change
  const latest = latestPatchSet(await commands.aliyun(z.unknown(), YUNXIAO.patchSets(organization, ref.repositoryId, ref.localId)))
  if (!latest) throw new Error(`The yunxiao ${labelOf(ref)} names no source commit; a new commit could not be told from the last one`)
  return { ...change, head: latest.commit, patchSet: latest.id }
}

/**
 * CALIBRATE: candidate field names of the merge request's comments and CI checks. `codeup-list-merge-request-comments` and
 * `codeup-list-change-request-ci-check-list` render different models than the work-item commands, so they keep their own
 * table; a real installation that names them differently changes these two tables and the two status patterns below.
 */
const COMMENT_FIELD = {
  id: ['comment_biz_id', 'commentBizId', 'commentId', 'id'],
  body: ['content', 'commentContent', 'body', 'text'],
  author: ['author', 'creator', 'user', 'createdBy'],
  created: ['comment_time', 'commentTime', 'gmtCreate', 'createTime', 'createdAt'],
  modified: ['last_edit_time', 'gmtModified', 'modifyTime', 'updatedAt'],
  url: ['commentUrl', 'url', 'htmlUrl'],
  parent: ['parent_comment_biz_id', 'parentCommentBizId', 'parentCommentId', 'replyToCommentId'],
} as const
const CHECK_FIELD = {
  name: ['name', 'checkName', 'pipelineName', 'jobName', 'displayName', 'title'],
  status: ['status', 'state', 'result', 'checkStatus', 'conclusion'],
  url: ['url', 'detailUrl', 'webUrl', 'link'],
} as const
const COMMENT_LIST = ['comments', 'commentList', 'items', 'records', 'list'] as const
const CHECK_LIST = ['checkList', 'checks', 'ciChecks', 'items', 'records', 'list'] as const
/** The lists Codeup's CI report holds its checks in, all of which count: checks, check runs and commit statuses. */
const CODEUP_CHECK_LISTS = ['check_list', 'check_runs', 'commit_statuses'] as const
/** Whether a user object declares itself a bot or a system account; yunxiao writes people as ordinary accounts. */
function isBotUser(user: Record<string, unknown> | undefined): boolean {
  const kind = stringOf(first(user, ['userType', 'type', 'accountType', 'userKind', 'identityType']))
  if (kind && /bot|system|app|robot|machine/i.test(kind)) return true
  return first(user, ['isSystem', 'systemAccount']) === true
}

/** A merge request comment, normalized: `body` is Markdown, and `agent` marks one this Source wrote itself. */
export interface MergeRequestComment {
  id: string
  body: string
  author: string
  human: boolean
  at: string
  modifiedAt: string
  url?: string
  /** The comment it answers, when Codeup names one. */
  parent?: string
  /** The hidden `AGENT_COMMENT` marker was in the raw body, so the comment is the agent's own write. */
  agent?: true
}
/** Normalizes one comment of `codeup-list-merge-request-comments`; its body becomes Markdown and keeps the agent marker's meaning. */
export function mergeCommentOf(raw: unknown): MergeRequestComment {
  const comment = unwrap(raw, ['comment', 'item'])
  if (!comment) throw new Error('The yunxiao merge request comment response was not recognized; the CLI response shape may have changed')
  const id = stringOf(first(comment, COMMENT_FIELD.id))
  if (!id) throw new Error('A yunxiao merge request comment has no id; the CLI response shape may have changed')
  const rawBody = first(comment, COMMENT_FIELD.body)
  const body = richText(rawBody)
  const created = timeOf(first(comment, COMMENT_FIELD.created))
  const author = recordOf(first(comment, COMMENT_FIELD.author))
  const url = stringOf(first(comment, COMMENT_FIELD.url))
  const parent = stringOf(first(comment, COMMENT_FIELD.parent))
  return { id, body, author: idOf(author) ?? '', human: !isBotUser(author), at: created ?? '',
    modifiedAt: timeOf(first(comment, COMMENT_FIELD.modified)) ?? created ?? '', ...url ? { url } : {}, ...parent ? { parent } : {},
    // The marker survives in the raw body even when the Markdown conversion drops the HTML comment that carries it.
    ...(typeof rawBody === 'string' && isAgentComment(rawBody)) || isAgentComment(body) ? { agent: true as const } : {} }
}
/** The comments of a `codeup-list-merge-request-comments` response, each followed by the replies Codeup nests under it. */
export const mergeCommentsOf = (raw: unknown): MergeRequestComment[] =>
  listOf(raw, COMMENT_LIST, 'merge request comment list').flatMap(function flatten(value: unknown): unknown[] {
    const replies = recordOf(value)?.child_comments_list
    return [value, ...Array.isArray(replies) ? replies.flatMap(flatten) : []]
  }).map(mergeCommentOf)

/** One CI check of a merge request's latest commit. */
export interface MergeCheck { name: string; status: string; url?: string }
/** The CI checks of a `codeup-list-change-request-ci-check-list` response, in the order the CLI printed them. */
export function mergeChecksOf(raw: unknown): MergeCheck[] {
  const report = recordOf(raw)
  const codeup = report && CODEUP_CHECK_LISTS.some(name => name in report)
    ? CODEUP_CHECK_LISTS.flatMap(name => { const list = report[name]; return Array.isArray(list) ? list : [] }) : undefined
  return (codeup ?? listOf(raw, CHECK_LIST, 'merge request CI check list')).map((value, index) => {
    const record = recordOf(value)
    const name = stringOf(first(record, CHECK_FIELD.name))
    // A check without a name or a status cannot be counted or told apart from the last round's, so the step fails loudly
    // rather than reporting a result nobody can calibrate against.
    if (!name) throw new Error(`A yunxiao merge request CI check at position ${index + 1} has no name; the CLI response shape may have changed`)
    const status = stringOf(first(record, CHECK_FIELD.status))
    if (!status) throw new Error(`The yunxiao merge request CI check ${name} has no status; the CLI response shape may have changed`)
    const url = stringOf(first(record, CHECK_FIELD.url))
    return { name, status, ...url ? { url } : {} }
  })
}

/** The short commit a summary reads with, as a person sees it in Codeup's pages. */
const short = (sha: string): string => sha.slice(0, 7)
/** CALIBRATE: check results that count as failures and as still running, told apart by these two patterns. */
const CHECK_FAILED = /fail|error|cancel|timeout|abort/i
const CHECK_RUNNING = /run|pending|queue|progress|checking|waiting|init/i
/** A bounded list of check names, so a summary of fifty checks still reads. */
const namesOf = (list: readonly string[]): string =>
  list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
/**
 * The text of a CI Trigger: how many checks of the merge request's latest commit failed, are still running, or passed.
 * `where` names the merge request and its commit, so a worker reading the text alone knows what was checked.
 */
export function ciSummary(checks: readonly MergeCheck[], where: string): string {
  if (!checks.length) return `Merge request ${where} has no CI checks yet.`
  const failed = checks.filter(check => CHECK_FAILED.test(check.status)).map(check => check.name)
  const running = checks.filter(check => CHECK_RUNNING.test(check.status)).map(check => check.name)
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${checks.length} on ${where}: ${namesOf(failed)}${still}`
    : running.length ? `CI running ${running.length}/${checks.length} on ${where}: ${namesOf(running)}`
      : `CI passed ${checks.length}/${checks.length} on ${where}`
  return `${line}\nRead codeup-list-change-request-ci-check-list for every check.`
}

/**
 * Builds the Trigger for a comment on a merge request, or returns undefined for one this Source wrote itself: the agent
 * comments as the same account as the person, so the `AGENT_COMMENT` marker, not the author, identifies its own words.
 * A comment is a follow-up on a merge request a ticket already follows, never an explicit request, so it declares no
 * `addressed`: the Policy admits work from an assignment, not from a reviewer's note.
 */
export function mrCommentTrigger(comment: MergeRequestComment, ref: MergeRequestRef): Trigger | undefined {
  if (comment.agent || isAgentComment(comment.body)) return undefined
  const url = comment.url
  return { id: key('yunxiao-mr-comment', mergeRequestKey(ref), comment.id, comment.modifiedAt), source: SOURCE,
    threads: [mergeRequestThread(ref.repositoryId, ref.localId)], actor: { source: SOURCE, id: comment.author },
    human: comment.human, at: comment.at || new Date().toISOString(), text: comment.body,
    channel: mergeRequestChannel(ref, comment.id), ...url ? { url } : {},
    meta: { repository: ref.repositoryId, localId: ref.localId, kind: 'mr-comment', commentId: comment.id,
      ...comment.parent ? { parentComment: comment.parent } : {} } }
}
/**
 * Builds the Trigger for a change in the merge request itself: a new head commit, a conflict with the target branch, or
 * both. The ID names the commit and whether it conflicts, so the round that reads the same state again hands the Engine a
 * duplicate instead of a second piece of work. `human` is false because Codeup observed this, not a person; the ticket's
 * worker still receives it as an input on the Thread it follows.
 */
export function mrChangeTrigger(ref: MergeRequestRef, change: MergeRequestState, at: string): Trigger {
  const title = change.title ? ` "${change.title}"` : ''
  const target = change.target ? `, targeting ${change.target}` : ''
  const lines = [`Merge request !${ref.localId}${title} in ${ref.repositoryId} is at ${short(change.head)}${target}.`]
  if (change.conflict) {
    lines.push(`It conflicts with ${change.target || 'its target branch'}: the source branch must be updated before it can merge.`)
  }
  return { id: key('yunxiao-mr-change', mergeRequestKey(ref), change.head, change.conflict ? 'conflict' : 'clean'), source: SOURCE,
    threads: [mergeRequestThread(ref.repositoryId, ref.localId)], actor: { source: SOURCE, id: '' }, human: false, at,
    text: lines.join('\n'), channel: mergeRequestChannel(ref), ...change.url ? { url: change.url } : {},
    meta: { repository: ref.repositoryId, localId: ref.localId, kind: 'mr-change', head: change.head, conflict: change.conflict,
      target: change.target } }
}
/**
 * Builds the Trigger that tells the ticket its merge request must move to another release: the branch it targets is no longer
 * the one the release rule computes, because the previous day's release has merged back or the delivery belongs to a later one.
 * The worker moves the work itself — it cuts `<source>-to-release-<day>`, merges the new target in, opens a new merge request
 * and closes the old one — so this is an instruction on the merge request's Thread, never a merge approval state.
 *
 * The ID names the merge request and the release to move to, so however many rounds read the same superseded target, the
 * Engine hands the worker one instruction; a further move of the target is a new Trigger.
 * @param day - the release day of `target.target`, which the rules' branch pattern names the new branch after.
 */
export function mrRetargetTrigger(ref: MergeRequestRef, change: MergeRequestState, target: TargetRelease, day: string, at: string): Trigger {
  const title = change.title ? ` "${change.title}"` : ''
  const branch = change.source || 'the source branch'
  const superseded = target.previous === change.target && target.mergedBack
    ? `${change.target} has merged back into ${target.base}`
    : `${change.target} is no longer the release this repository delivers to`
  const lines = [
    `Merge request !${ref.localId}${title} in ${ref.repositoryId} targets ${change.target}: ${superseded}, so the delivery now belongs to ${target.target}.`,
    `From ${branch}, create ${branch}-to-release-${day}, merge ${target.target} into it, open a new merge request to ${target.target}, close !${ref.localId}, then ask to merge again.`,
  ]
  return { id: key('yunxiao-mr-retarget', mergeRequestKey(ref), target.target), source: SOURCE,
    threads: [mergeRequestThread(ref.repositoryId, ref.localId)], actor: { source: SOURCE, id: '' }, human: false, at,
    text: lines.join('\n'), channel: mergeRequestChannel(ref), ...change.url ? { url: change.url } : {},
    meta: { mrChange: 'retarget', repository: ref.repositoryId, localId: ref.localId, from: change.target, to: target.target } }
}
/**
 * Builds the Trigger for a change in the merge request's CI results. `revision` counts the results reported so far, so each
 * one has its own Trigger ID and a repeated round with the same fingerprint stays quiet.
 */
export function mrCiTrigger(ref: MergeRequestRef, change: MergeRequestState, revision: number, checks: readonly MergeCheck[], at: string): Trigger {
  const where = `!${ref.localId} at ${short(change.head)}`
  return { id: key('yunxiao-mr-ci', mergeRequestKey(ref), String(revision)), source: SOURCE,
    threads: [mergeRequestThread(ref.repositoryId, ref.localId)], actor: { source: SOURCE, id: '' }, human: false, at,
    text: ciSummary(checks, where), channel: mergeRequestChannel(ref), ...change.url ? { url: change.url } : {},
    meta: { repository: ref.repositoryId, localId: ref.localId, kind: 'mr-ci', ci: true, revision, head: change.head } }
}

/** A failure's text; `Commands` already keeps the command arguments out of it. */
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Reads one Codeup list or detail through the CLI, with the round's signal, as loose JSON for the normalizers above. */
const readJson = (ctx: MergeContext, argv: readonly string[], round: MergeRound): Promise<unknown> =>
  ctx.commands.withSignal(round.signal).aliyun(z.unknown(), argv)
/** Runs one step of one merge request's poll; a failure is recorded against that step and the other steps still run. */
async function step(round: MergeRound, threadKey: string, what: string, work: () => Promise<void>): Promise<void> {
  try { await work() }
  catch (error) {
    // A stopped round is not a failure: the abort is the caller's doing, and the records must stay where the next round resumes.
    if (!round.signal?.aborted) round.failures.push(`${threadKey} ${what}: ${messageOf(error)}`)
  }
}

/**
 * Polls the merge requests open tickets follow: each one's state (a merge or a close closes its Thread), then a new commit or
 * a conflict, then whether the release it targets has been superseded, then its comments, then its CI checks. Every merge
 * request and every step of one fails on its own, so one unreadable merge request neither hides another's change nor loses the
 * record of what was already read.
 *
 * A merge request whose close a ticket already recorded is not read again: the ticket keeps the Thread to answer messages,
 * while the merge or close itself is a fact no later round changes. One the account can no longer read at all closes its
 * Thread and is recorded as gone, so a deleted merge request cannot fail every round of the Source for the rest of its life.
 */
export async function pollMergeRequests(ctx: MergeContext, file: YunxiaoFile, round: MergeRound): Promise<void> {
  for (const ref of followedMergeRequests(ctx)) {
    if (round.signal?.aborted) return
    await pollMergeRequest(ctx, file, ref, round)
  }
}
/** The merge requests open tickets follow, each once, in the order the tickets are read. */
function followedMergeRequests(ctx: MergeContext): MergeRequestRef[] {
  const seen = new Set<string>()
  const refs: MergeRequestRef[] = []
  for (const ticket of ctx.tickets.open()) {
    for (const follow of ticket.follows ?? []) {
      if (follow.closed || seen.has(follow.thread)) continue
      // A merge request recorded as gone is not read again: its close was the news, and a ticket that binds the Thread anew
      // would otherwise retry a request that can never succeed.
      if (ctx.state.get(KV.yunxiao.mr(follow.thread))?.gone) continue
      const ref = parseMergeThread(follow.thread)
      if (!ref) continue
      seen.add(follow.thread)
      refs.push(ref)
    }
  }
  return refs
}
/**
 * Whether a merge request can no longer be read at all, which no retry changes: Codeup answers 404 for one that was deleted,
 * and 403 for one the account may not read, such as a repository it lost access to. The 403 counts only when its message says
 * access is what was refused; any other failure — the token, a 5xx, a lost connection — may pass later and stays a failed read.
 */
function gone(error: unknown): boolean {
  if (!(error instanceof CliError)) return false
  if (error.code === 404) return true
  return error.code === 403 && /forbidden|denied|permission|authoriz|not allowed|权限|禁止|无权/i.test(error.message)
}
/**
 * Records a merge request that is gone: its Thread closes as a closed change, which ends no ticket (a change binds with
 * `ends: false`) and only stops the follow, and the record keeps every later round from reading it again.
 */
async function closeGone(ctx: MergeContext, thread: ThreadRef, threadKey: string, round: MergeRound): Promise<void> {
  await step(round, threadKey, 'gone', async () => {
    ctx.tickets.threadClosed(thread, 'closed', round.started)
    const previous = ctx.state.get(KV.yunxiao.mr(threadKey))
    ctx.state.set(KV.yunxiao.mr(threadKey), { head: previous?.head ?? '', fingerprint: previous?.fingerprint ?? '',
      commentAt: previous?.commentAt ?? '', revision: previous?.revision ?? 0, gone: true })
  })
}
/** Reads and acts on one merge request; without its state nothing else about it can be read, so the record stays put. */
async function pollMergeRequest(ctx: MergeContext, file: YunxiaoFile, ref: MergeRequestRef, round: MergeRound): Promise<void> {
  const thread = mergeRequestThread(ref.repositoryId, ref.localId)
  const threadKey = mergeRequestKey(ref)
  // Codeup reads run in the organization of the receiving-rule file, as every other read of this Source does.
  const organization = file.organization
  let change: MergeRequestState
  try { change = await readMergeRequest(ctx.commands.withSignal(round.signal), organization, ref) }
  catch (error) {
    if (round.signal?.aborted) return
    // A merge request the account can no longer read at all is gone rather than unreadable: its Thread closes, and closing it
    // is the whole news. Every other failure may pass on a later round and is a failed read.
    if (gone(error)) await closeGone(ctx, thread, threadKey, round)
    else round.failures.push(`${threadKey}: ${messageOf(error)}`)
    return
  }
  const outcome = change.state
  if (outcome !== 'open') {
    // A merged or closed merge request closes its Thread once: `threadClosed` records the close on every ticket following it
    // and leaves the ticket to its own ready report, because a change binds with `ends: false`.
    await step(round, threadKey, 'close', async () => { ctx.tickets.threadClosed(thread, outcome, change.endedAt ?? round.started) })
    return
  }
  await step(round, threadKey, 'change', () => pollChange(ctx, ref, change, round))
  await step(round, threadKey, 'retarget', () => pollRetarget(ctx, file, ref, change, round))
  await step(round, threadKey, 'comments', () => pollComments(ctx, organization, ref, round))
  await step(round, threadKey, 'CI', () => pollChecks(ctx, organization, ref, change, round))
}
/**
 * Reports a new head commit or a conflict. The first read of a merge request records where it stands without reporting it:
 * the ticket opened the merge request and knows, so only a later commit or a conflict is news.
 */
async function pollChange(ctx: MergeContext, ref: MergeRequestRef, change: MergeRequestState, round: MergeRound): Promise<void> {
  const threadKey = mergeRequestKey(ref)
  const previous = ctx.state.get(KV.yunxiao.mr(threadKey))
  const moved = previous !== undefined && previous.head !== change.head
  if (moved || change.conflict) await ctx.receive(mrChangeTrigger(ref, change, round.started))
  // The record follows the Trigger, so a Trigger the Engine refused is reported again by the next round rather than recorded
  // as seen. A conflict that stays is read again every round, and its Trigger ID makes that read a duplicate.
  ctx.state.set(KV.yunxiao.mr(threadKey), { head: change.head, fingerprint: previous?.fingerprint ?? '',
    commentAt: previous?.commentAt ?? '', revision: previous?.revision ?? 0 })
}
/**
 * Tells the ticket when the release its merge request targets has been superseded, so the worker moves the delivery before a
 * person is asked to merge it. Only a merge request that targets a release branch of the rules' pattern can be re-targeted: a
 * delivery to the trunk or to a feature branch is not the release rule's business. An approver's own move wins over the rule
 * (see `approverMoved`), so the worker is never asked to undo what a person decided.
 */
async function pollRetarget(ctx: MergeContext, file: YunxiaoFile, ref: MergeRequestRef, change: MergeRequestState, round: MergeRound): Promise<void> {
  // A delivery to the trunk or to a feature branch is not the release rule's business: only a release branch can be moved.
  if (!releaseBranchDay(change.target, file.release)) return
  if (approverMoved(ctx, ref, mergeRequestKey(ref))) return
  const target = await releaseTargetOf(ctx, file, ref, round)
  // The computed target is the release this delivery belongs to; while the merge request already targets it, nothing moved.
  if (!target || target.target === change.target) return
  // The rules name a release branch after its day, which the new branch of the move carries too.
  const day = releaseBranchDay(target.target, file.release)
  if (!day) return
  await ctx.receive(mrRetargetTrigger(ref, change, target, day, round.started))
}
/**
 * Whether the approver has already decided where this delivery goes. A merge record in the `retarget` state names the release
 * the approver moved the ticket's delivery to, and that decision wins over the release rule until the ticket ends: the merge
 * request it was made about waits for the worker's replacement, and the replacement the worker opens in the same repository
 * must not be asked to move back. The records are the ones merge.ts writes, read from the Threads a ticket follows.
 */
function approverMoved(ctx: MergeContext, ref: MergeRequestRef, threadKey: string): boolean {
  const moved = (thread: string): boolean => ctx.state.get(KV.merge.mr(thread))?.state === 'retarget'
  // The merge request the approval was about carries the record itself, so it is never asked to move a second time.
  if (moved(threadKey)) return true
  for (const ticket of ctx.tickets.open()) {
    if (!(ticket.follows ?? []).some(follow => follow.thread === threadKey)) continue
    // One decision covers the ticket's merge requests in this repository: the one the approver answered about, and the one the
    // worker opens to the release the approver named.
    for (const follow of ticket.follows ?? []) {
      if (parseMergeThread(follow.thread)?.repositoryId === ref.repositoryId && moved(follow.thread)) return true
    }
  }
  return false
}
/**
 * The release target of the merge request's repository in this round, computed at most once: `targetRelease` reads the branch
 * list, a compare and the merged merge requests, and one round may hold several merge requests of a repository. A computation
 * that failed is recorded against the repository once and remembered, so the rest of the round does not repeat it and the other
 * merge requests are still read.
 *
 * Polling only asks where a delivery would go, so it never creates the day's release: `create: false` makes a missing branch
 * read as the target without cutting it, which the merge that needs the branch does instead.
 */
async function releaseTargetOf(ctx: MergeContext, file: YunxiaoFile, ref: MergeRequestRef, round: MergeRound): Promise<TargetRelease | undefined> {
  const known = round.targets.get(ref.repositoryId)
  if (known instanceof Error) return undefined
  if (known) return known
  try {
    const account = ctx.deployment.codeup
    if (!account) throw new Error('The merge request poller needs the Codeup account to compute a release target')
    const repository = repositoryOf(account, ref.repositoryId)
    if (!repository) throw new Error(`${ref.repositoryId} is not a repository of the Codeup workspace ${account.workspace}`)
    const target = await targetRelease({ organization: file.organization, repository, caller: ctx.commands.withSignal(round.signal),
      release: file.release, create: false })
    round.targets.set(ref.repositoryId, target)
    return target
  } catch (error) {
    round.targets.set(ref.repositoryId, error instanceof Error ? error : new Error(String(error)))
    if (!round.signal?.aborted) round.failures.push(`${ref.repositoryId} release target: ${messageOf(error)}`)
    return undefined
  }
}
/**
 * Takes in the merge request's comments added since the last read. The agent's own comments are marked and never become
 * Triggers; the read position advances only after all of them were taken in, so a failed round reads the same comments again
 * under the same Trigger IDs.
 */
async function pollComments(ctx: MergeContext, organization: string, ref: MergeRequestRef, round: MergeRound): Promise<void> {
  const threadKey = mergeRequestKey(ref)
  const comments = mergeCommentsOf(await readJson(ctx, YUNXIAO.changeRequestComments(organization, ref.repositoryId, ref.localId), round))
  const previous = ctx.state.get(KV.yunxiao.mr(threadKey))
  // The first read takes every comment the merge request already carries: a reviewer's note written before the ticket bound it
  // is still about this change. Trigger IDs are the comment and its edit time, so a later round reads it as a duplicate.
  const since = previous?.commentAt ?? ''
  const fresh = comments.filter(comment => !comment.modifiedAt || comment.modifiedAt > since)
  if (!fresh.length) return
  for (const comment of fresh) {
    // Stopping mid-read throws so the read position stays where it was.
    if (round.signal?.aborted) throw new Error('The yunxiao Source stopped during the poll')
    const trigger = mrCommentTrigger(comment, ref)
    // A comment with no text, such as a bare attachment, carries nothing a worker could answer.
    if (trigger?.text) await ctx.receive(trigger)
  }
  const newest = comments.reduce((latest, comment) => comment.modifiedAt > latest ? comment.modifiedAt : latest, since)
  ctx.state.set(KV.yunxiao.mr(threadKey), { head: previous?.head ?? '', fingerprint: previous?.fingerprint ?? '', commentAt: newest,
    revision: previous?.revision ?? 0 })
}
/** Reports a change in the merge request's CI results; the first read records the baseline, as the ticket reports its own run. */
async function pollChecks(ctx: MergeContext, organization: string, ref: MergeRequestRef, change: MergeRequestState, round: MergeRound): Promise<void> {
  const threadKey = mergeRequestKey(ref)
  if (!change.patchSet) return
  const checks = mergeChecksOf(await readJson(ctx, YUNXIAO.changeRequestChecks(organization, ref.repositoryId, ref.localId, change.patchSet), round))
    .sort((a, b) => a.name.localeCompare(b.name))
  // The fingerprint is the result set alone: the same checks against a new commit are the same run, and the commit itself is
  // the change step's news. Codeup answers with the checks of the merge request's latest commit, so a run that starts again
  // changes the statuses this compares.
  const fingerprint = key(JSON.stringify(checks))
  const previous = ctx.state.get(KV.yunxiao.mr(threadKey))
  // A record without a fingerprint has not seen this merge request's checks yet, though the change step may have written it
  // already this round; the first read of them is the baseline, which is recorded and not reported.
  const known = previous?.fingerprint ? previous : undefined
  if (known?.fingerprint === fingerprint) return
  const revision = known ? known.revision + 1 : 0
  if (known) await ctx.receive(mrCiTrigger(ref, change, revision, checks, round.started))
  ctx.state.set(KV.yunxiao.mr(threadKey), { head: previous?.head ?? change.head, fingerprint, commentAt: previous?.commentAt ?? '',
    revision })
}
