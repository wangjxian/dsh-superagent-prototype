/** Normalizes yunxiao work items and their comments into domain Triggers, and reads the fields the CLI returns. */
import { isoTime, key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { AGENT_COMMENT } from '../infra/yunxiao.ts'
import { richText } from './yunxiao-text.ts'

export const SOURCE = 'yunxiao'
/**
 * A work item as the Source works with it: `description` is already Markdown, `assignee` and `projectId` are the IDs the
 * receiving rules and the Policy compare, and `modifiedAt` is an ISO timestamp.
 */
export interface Workitem {
  id: string; serial: string; title: string; description: string; category: string
  status: string; assignee: string; projectId: string; url: string; modifiedAt: string
}
/** A work-item comment; `body` is already Markdown, and `agent` marks one this Source wrote itself. */
export interface WorkitemComment {
  id: string; body: string; author: string; human: boolean; at: string; modifiedAt: string; url?: string
  /** The hidden `AGENT_COMMENT` marker was in the raw body, so the comment is the agent's own write. */
  agent?: true
}
/**
 * Candidate field names of the Projex responses, which are the CLI's rendering of the OpenAPI models and are the one
 * place to calibrate against a real installation: each lookup tries them in order, so a renamed field changes this table
 * and nothing else. A response missing every candidate for an essential field raises a readable error instead of
 * reading as empty.
 */
const FIELD = {
  id: ['id', 'workitemId', 'workItemId'],
  serial: ['serialNumber', 'identifier', 'serial', 'code'],
  title: ['subject', 'title', 'name'],
  description: ['description', 'content', 'detail', 'descriptionHtml'],
  category: ['categoryId', 'categoryIdentifier', 'category', 'workitemTypeIdentifier', 'typeIdentifier'],
  status: ['status', 'statusIdentifier', 'statusName'],
  assignee: ['assignedTo', 'assignee', 'assignedToUser', 'owner'],
  project: ['spaceIdentifier', 'spaceId', 'projectId', 'projectIdentifier'],
  projectObject: ['space', 'project'],
  modified: ['gmtModified', 'modifiedAt', 'updatedAt', 'gmtCreate'],
  url: ['url', 'workitemUrl', 'detailUrl'],
  commentId: ['id', 'commentId'],
  commentBody: ['content', 'body', 'commentContent', 'text'],
  commentAuthor: ['creator', 'author', 'user', 'createdBy', 'operator'],
  commentCreated: ['gmtCreate', 'createdAt', 'createTime'],
  commentModified: ['gmtModified', 'updatedAt', 'modifyTime'],
  commentUrl: ['url', 'commentUrl', 'htmlUrl'],
} as const
/** Response keys that wrap the payload, outermost first; the CLI prints one of them around the model. */
const ENVELOPE = ['result', 'data', 'value'] as const
const COMMENT_LIST = ['comments', 'workitemComments', 'items', 'records', 'list'] as const
const RELATION_LIST = ['relationRecords', 'workitemRelationRecords', 'relations', 'records', 'items', 'list'] as const
/** The hidden first line of `AGENT_COMMENT`: a comment carrying it is this Source's own write, never a person's request. */
export const AGENT_MARKER = AGENT_COMMENT.split('\n')[0]!
/** Whether a comment body carries the marker, which no person writes, so the comment is the agent's own. */
export const isAgentComment = (body: string): boolean => body.includes(AGENT_MARKER)
/** The work item's web page, which the Source's link builder and every trigger share. */
/**
 * The words that refuse a triage question, wherever they sit in the reply: a person who says the work waits, or names what it
 * waits for, decided against starting it now. A message that says both kinds of thing reads as a refusal, because starting
 * work nobody asked for is the worse mistake.
 */
export const TRIAGE_NO = new RegExp(['不可以', '不能', '不行', '没法', '不做', '不用', '不接', '别做', '不开始', '别开始',
  '不开工', '别开工', '先别', '跳过', '先不', '暂不', '暂缓', '缓一下', '待定', '等一下', '等等', '不处理', '先放着',
  '等[^。！？\\n]{0,12}确认'].join('|'), 'i')
/**
 * The words that start the work item, which decide only as the reply's first word: `开始之前先问下产品` and `还不能开始` are no
 * start, and `looks good` carries `go` inside another word.
 */
export const TRIAGE_GO = /^(开工|开始|可以|做吧|ok|go)[吧啊呀哈]?(?:$|[\s，,。.!！：:；;])/i
/** A bare approval carries nothing beyond the decision, so no supplement travels with it. */
export const TRIAGE_BARE = /^(开工|开始|可以|做吧|go|ok)[。.!！]*$/i
export const workitemUrl = (id: string): string => `https://devops.aliyun.com/projex/workitem/${encodeURIComponent(id)}`

/** Deterministic trigger ID of one repair cycle of a work item, so reading the same cycle twice never opens a second ticket. */
export const workitemTriggerId = (id: string, cycle: number): string => key('yunxiao', id, String(cycle))
/** Deterministic trigger ID of a comment; `modifiedAt` makes an edited comment a new trigger, as its text changed. */
export const commentTriggerId = (id: string, modifiedAt: string): string => key('yunxiao', id, modifiedAt)
/** The thread every trigger of a work item belongs to: its description and all of its comments. */
export const workitemThread = (id: string): ThreadRef => ({ source: SOURCE, id: `wi:${id}` })
/** Reply address of a work item's comment thread; `parent` names the comment a reply answers. */
export const workitemChannel = (id: string, parent?: string): ChannelRef =>
  ({ source: SOURCE, thread: `yunxiao:${id}`, address: { workitem: id, ...parent ? { parent } : {} } })

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined)
function first(source: Record<string, unknown> | undefined, names: readonly string[]): unknown {
  if (!source) return undefined
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}
function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}
/** A person or project field may be an object or a bare ID. */
function idOf(value: unknown): string | undefined {
  const record = recordOf(value)
  return record ? stringOf(first(record, ['id', 'identifier', 'userId', 'staffId', 'projectId'])) : stringOf(value)
}
/** Whether a user object declares itself a bot or a system account; yunxiao writes people as ordinary accounts. */
function isBotUser(user: Record<string, unknown> | undefined): boolean {
  const kind = stringOf(first(user, ['userType', 'type', 'accountType', 'userKind', 'identityType']))
  if (kind && /bot|system|app|robot|machine/i.test(kind)) return true
  return first(user, ['isSystem', 'systemAccount']) === true
}
/**
 * Reads a timestamp the CLI prints either as epoch milliseconds or seconds, as a number or a numeric string, or as a
 * date string; an unreadable value stays empty, which the caller treats as missing rather than as now.
 */
function timeOf(value: unknown): string | undefined {
  // `Date#toISOString` throws outside the range a timestamp can name, so an unreadable epoch is reported as missing.
  const iso = (millis: number): string | undefined => Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined
  const seconds = (seconds: number) => iso(seconds * 1000)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) < 1e12 ? seconds(value) : iso(value)
  const text = stringOf(value)
  if (!text) return undefined
  if (/^\d{10}$/.test(text)) return seconds(Number(text))
  if (/^\d{13}$/.test(text)) return iso(Number(text))
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? isoTime(new Date(parsed).toISOString()) : undefined
}
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
 * Normalizes one work item of `projex-get-workitem` or `projex-search-workitems` into a `Workitem`.
 * `id`, `title` and `status` are the fields the Source cannot work without, so a response lacking them raises instead of
 * producing a work item whose empty status would never match a receiving rule. `projectId` is the project a search ran
 * in, for a list result that names no space of its own.
 */
export function workitemOf(raw: unknown, projectId?: string): Workitem {
  const item = unwrap(raw, ['workitem', 'workItem', 'item'])
  if (!item) throw new Error('The yunxiao work item response was not recognized; the CLI response shape may have changed')
  const serial = stringOf(first(item, FIELD.serial))
  const id = stringOf(first(item, FIELD.id)) ?? serial
  if (!id) throw new Error('The yunxiao work item has no id; the CLI response shape may have changed')
  const title = stringOf(first(item, FIELD.title))
  if (!title) throw new Error(`The yunxiao work item ${id} has no title; the CLI response shape may have changed`)
  // Projex reports the status as an object (`{ id: '29', name: '已修复' }`); the receiving rules compare its id.
  const status = idOf(first(item, FIELD.status))
  if (!status) throw new Error(`The yunxiao work item ${id} has no status; the receiving rules compare status IDs`)
  const project = stringOf(first(item, FIELD.project)) ?? idOf(first(item, FIELD.projectObject)) ?? projectId
  if (!project) throw new Error(`The yunxiao work item ${id} has no project; the receiving rules are configured per project`)
  return { id, serial: serial ?? id, title, description: richText(first(item, FIELD.description)),
    category: stringOf(first(item, FIELD.category)) ?? '', status, assignee: idOf(first(item, FIELD.assignee)) ?? '',
    projectId: project, url: stringOf(first(item, FIELD.url)) ?? workitemUrl(id), modifiedAt: timeOf(first(item, FIELD.modified)) ?? '' }
}
/** Normalizes one comment of `projex-list-workitem-comments`; its body becomes Markdown and keeps the agent marker's meaning. */
export function commentOf(raw: unknown): WorkitemComment {
  const comment = unwrap(raw, ['comment', 'item'])
  if (!comment) throw new Error('The yunxiao comment response was not recognized; the CLI response shape may have changed')
  const id = stringOf(first(comment, FIELD.commentId))
  if (!id) throw new Error('A yunxiao comment has no id; the CLI response shape may have changed')
  const rawBody = first(comment, FIELD.commentBody)
  const body = richText(rawBody)
  const created = timeOf(first(comment, FIELD.commentCreated))
  const author = recordOf(first(comment, FIELD.commentAuthor))
  return { id, body, author: idOf(author) ?? '', human: !isBotUser(author), at: created ?? '', modifiedAt: timeOf(first(comment, FIELD.commentModified)) ?? created ?? '',
    ...stringOf(first(comment, FIELD.commentUrl)) ? { url: stringOf(first(comment, FIELD.commentUrl)) } : {},
    // The marker survives in the raw body even when the Markdown conversion drops the HTML comment that carries it.
    ...typeof rawBody === 'string' && rawBody.includes(AGENT_MARKER) || body.includes(AGENT_MARKER) ? { agent: true as const } : {} }
}
/** The comments of a `projex-list-workitem-comments` response, normalized in the order the CLI printed them. */
export const commentsOf = (raw: unknown): WorkitemComment[] => listOf(raw, COMMENT_LIST, 'comment list').map(commentOf)
/** The relation records of a `projex-list-workitem-relation-records` response. */
export const relationsOf = (raw: unknown): unknown[] => listOf(raw, RELATION_LIST, 'work item relation')
/** A relation record's meaning: which work item it points at, and the type that says whether that item is the parent. */
export interface WorkitemRelation { workitemId: string; type: string }
const RELATION_TYPE = ['relationType', 'relationTypeIdentifier', 'type', 'relation']
const RELATED_ID = ['relatedWorkitemId', 'relatedWorkItemId', 'relatedId', 'targetWorkitemId', 'targetId']
const RELATED_OBJECT = ['relatedWorkitem', 'relatedWorkItem', 'related', 'workitem', 'target']
/**
 * Reads one relation record of `projex-list-workitem-relation-records`; returns undefined for a record whose related
 * work item cannot be named, which the caller counts instead of guessing an ID from another field.
 */
export function relationOf(raw: unknown, self: string): WorkitemRelation | undefined {
  const record = recordOf(raw)
  if (!record) return undefined
  const embedded = recordOf(first(record, RELATED_OBJECT))
  const named = stringOf(first(record, RELATED_ID))
  const own = stringOf(first(record, ['workitemId', 'workItemId']))
  const workitemId = named ?? idOf(embedded) ?? (own && own !== self ? own : undefined)
  if (!workitemId || workitemId === self) return undefined
  return { workitemId, type: stringOf(first(record, RELATION_TYPE)) ?? stringOf(first(embedded, RELATION_TYPE)) ?? '' }
}

/**
 * Builds the trigger for a work item assigned to the agent's account, which is the request itself.
 * `agent` names that account: the assignment counts as a person's request even though the assignee is the account the
 * agent acts as, so it does not change `human`.
 * `channel` is where the ticket's own messages go, the work item unless the Source names the approver's direct message: a
 * person then hears about the work item in Feishu instead of on a colleague's work item.
 */
export function workitemTrigger(item: Workitem, actor: string, cycle: number, agent: string,
  channel: ChannelRef = workitemChannel(item.id)): Trigger {
  return { id: workitemTriggerId(item.id, cycle), source: SOURCE, threads: [workitemThread(item.id)],
    actor: { source: SOURCE, id: actor }, human: true, addressed: 'mention',
    at: item.modifiedAt || new Date().toISOString(),
    text: [[item.serial, item.title].filter(Boolean).join(' '), item.description].filter(Boolean).join('\n\n'),
    channel, url: item.url,
    meta: { workitemId: item.id, serial: item.serial, category: item.category, projectId: item.projectId, status: item.status, cycle } }
}
/**
 * Builds the trigger for a comment on a work item, or returns undefined for one this Source wrote itself: the agent
 * comments as the same account as the person, so the `AGENT_COMMENT` marker, not the author, identifies its own words.
 * `agent` names the account the agent acts as; it cannot decide `human` for the same reason.
 */
export function commentTrigger(comment: WorkitemComment, item: Workitem, agent: string): Trigger | undefined {
  if (comment.agent || isAgentComment(comment.body)) return undefined
  const url = comment.url ?? item.url
  return { id: commentTriggerId(comment.id, comment.modifiedAt), source: SOURCE, threads: [workitemThread(item.id)],
    actor: { source: SOURCE, id: comment.author }, human: comment.human, at: comment.at, text: comment.body,
    channel: workitemChannel(item.id, comment.id), ...url ? { url } : {},
    meta: { workitemId: item.id, commentId: comment.id, category: item.category, projectId: item.projectId } }
}
/** The yunxiao IDs a trigger carries, for readers that serve its resources or write back to it. */
export function yunxiaoRef(trigger: Trigger): { workitemId?: string; commentId?: string; projectId?: string; category?: string } {
  if (trigger.source !== SOURCE) return {}
  const meta = trigger.meta
  const id = (name: string): string | undefined => typeof meta[name] === 'string' && meta[name] ? meta[name] : undefined
  const workitemId = id('workitemId')
  const commentId = id('commentId')
  const projectId = id('projectId')
  const category = id('category')
  return { ...workitemId ? { workitemId } : {}, ...commentId ? { commentId } : {}, ...projectId ? { projectId } : {},
    ...category ? { category } : {} }
}
