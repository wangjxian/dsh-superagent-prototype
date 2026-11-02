/** Reads a yunxiao work item's material — its description, comments, parent and related requirements — as context. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { YUNXIAO } from '../infra/yunxiao.ts'
import { loadConfig, type YunxiaoFile } from './yunxiao-config.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { commentsOf, relationOf, relationsOf, workitemOf, yunxiaoRef, type Workitem, type WorkitemComment } from './yunxiao-trigger.ts'

/** Comments of one page; the CLI returns every comment of a work item at once, so the pages are cut here. */
const COMMENTS_PER_PAGE = 20
/** Related work items read per resource call, which bounds the calls one read makes; the rest are counted, not silently dropped. */
const RELATED_READ = 10
/** The CLI prints one JSON object; its fields are read by the normalizers, so the schema only checks the envelope. */
const RESPONSE = z.looseObject({})
/**
 * Yunxiao's requirement category, which is read as context only; a related task or bug is counted instead of read.
 * CALIBRATE: these are the OpenAPI's own identifiers, so a renamed category is changed here and nowhere else.
 */
const isRequirement = (category: string): boolean => /^(req|requirement)/i.test(category)
/** The relation type that names this work item's parent, rather than one of its children or peers. */
const isParent = (type: string): boolean => /parent/i.test(type) && !/sub|child/i.test(type)

/**
 * The organization the projex calls belong to: the receiving rules' when the caller has them, otherwise the deployment's
 * Codeup account, which is the same organization the CLI's token is scoped to. A resource read has no YAML file at hand,
 * so it takes the account; a mismatch between the two is the Source's own health report, not this reader's.
 */
function organizationOf(commands: Commands, file: YunxiaoFile | undefined): string {
  const organization = file?.organization ?? commands.deployment.codeup?.organization
  if (!organization) throw new Error('Reading a yunxiao work item needs a Codeup account or the receiving rules to name its organization')
  return organization
}
async function readWorkitem(commands: Commands, organization: string, id: string): Promise<Workitem> {
  return workitemOf(await commands.aliyun(RESPONSE, YUNXIAO.workitem(organization, id)))
}
/** Every comment of a work item; a comment list the CLI returns in an unknown shape raises rather than reading as none. */
async function readComments(commands: Commands, organization: string, id: string): Promise<WorkitemComment[]> {
  const raw = await commands.aliyun(RESPONSE, YUNXIAO.workitemComments(organization, id))
  return commentsOf(raw)
}
/** The relation types read for a work item's material: its parent, and the requirements it is associated with. */
const RELATION_TYPES = ['PARENT', 'ASSOCIATED'] as const
async function readRelations(commands: Commands, organization: string, id: string) {
  const relations: { workitemId: string; type: string }[] = []
  let unreadable = 0
  for (const type of RELATION_TYPES) {
    const records = relationsOf(await commands.aliyun(RESPONSE, YUNXIAO.workitemRelations(organization, id, type)))
    // A relation record whose target cannot be resolved is not guessed at; it is counted and reported with the material.
    for (const record of records) {
      const relation = relationOf(record, id)
      if (relation) relations.push({ ...relation, type: relation.type || type })
      else unreadable += 1
    }
  }
  return { relations, unreadable }
}
/** A comment as the model reads it; the agent's own comments are marked `bot`, as they can never authorize work. */
export function commentMessage(comment: WorkitemComment): ContextMessage {
  return { id: comment.id, from: comment.author, at: comment.at, text: comment.body,
    ...comment.agent || !comment.human ? { bot: true as const } : {}, ...comment.url ? { url: comment.url } : {} }
}
/**
 * The work item's description as the first message of its thread. The author of a description is not part of what the
 * Source reads, so `from` names the work item itself rather than claiming a person wrote the message just now.
 */
export function descriptionMessage(item: Workitem): ContextMessage {
  return { id: `wi:${item.id}`, from: 'workitem', at: item.modifiedAt, text: [item.title, item.description].filter(Boolean).join('\n\n'),
    url: item.url }
}
/** Parses the page of a comments resource; a page that is not a positive number is a reference the model made up. */
function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1
  if (!/^\d+$/.test(cursor) || Number(cursor) < 1) throw new Error('Read comments by page number: yunxiao/wi/<id>/comments/<page>')
  return Number(cursor)
}

/** Validates a model-supplied resource string before any request; only comments take a page. */
export function yunxiaoResource(resource: string): { workitemId: string; section: 'wi' | 'comments'; page?: string } {
  const match = /^yunxiao\/wi\/([^/]+)(?:\/(comments)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) throw new Error('Use yunxiao/wi/<workitem-id> or yunxiao/wi/<workitem-id>/comments/<page>; follow returned next_resource for another page')
  return { workitemId: match[1]!, section: match[2] === 'comments' ? 'comments' : 'wi', ...match[3] ? { page: match[3] } : {} }
}
/** One page of a work item's comments, each as `{ id, from, at, text }`; `next_resource` continues the list. */
async function commentPage(commands: Commands, organization: string, id: string, cursor: string | undefined) {
  const page = pageNumber(cursor)
  const comments = await readComments(commands, organization, id)
  const start = (page - 1) * COMMENTS_PER_PAGE
  const more = start + COMMENTS_PER_PAGE < comments.length
  return { messages: comments.slice(start, start + COMMENTS_PER_PAGE).map(commentMessage), total: comments.length,
    next_resource: more ? `yunxiao/wi/${id}/comments/${page + 1}` : null }
}
/**
 * The material of one work item: its description, its direct parent, and the requirements it is related to together with
 * their comments. Every read that fails raises, because a work item whose material could not be read must block rather
 * than look like one with no parent and no requirements.
 */
async function workitemDetail(commands: Commands, organization: string, id: string) {
  const item = await readWorkitem(commands, organization, id)
  const { relations, unreadable } = await readRelations(commands, organization, id)
  const parentId = relations.find(relation => isParent(relation.type))?.workitemId
  const others = relations.filter(relation => relation.workitemId !== parentId && relation.workitemId !== id)
    .map(relation => relation.workitemId)
  const readIds = [...new Set(others)].slice(0, RELATED_READ)
  const parent = parentId ? await readWorkitem(commands, organization, parentId) : null
  const related = await Promise.all(readIds.map(relatedId => readWorkitem(commands, organization, relatedId)))
  const requirements = related.filter(requirement => isRequirement(requirement.category))
  const comments = await Promise.all(requirements.map(requirement => readComments(commands, organization, requirement.id)))
  return { workitem: item, parent,
    related: requirements.map((requirement, index) => ({ ...requirement, comments: comments[index]!.map(commentMessage) })),
    ...others.length > readIds.length ? { unread_relations: others.length - readIds.length } : {},
    ...unreadable ? { unreadable_relations: unreadable } : {} }
}

/**
 * Reads one `yunxiao/…` resource: the material of a work item, or one page of its comments.
 * `file` supplies the organization when the caller has the receiving rules; a resource read otherwise falls back to the
 * deployment's Codeup account, so a worker Session holding only Commands can read the work item it was handed.
 */
export async function yunxiaoRead(commands: Commands, resource: string, file?: YunxiaoFile): Promise<unknown> {
  const request = yunxiaoResource(resource)
  const organization = organizationOf(commands, file)
  return request.section === 'comments'
    ? commentPage(commands, organization, request.workitemId, request.page)
    : workitemDetail(commands, organization, request.workitemId)
}

/**
 * Context reader for a yunxiao Trigger. Its thread is the work item: the description is the first message (`wi:<id>`) and
 * the comments follow by page; the root and the parent of a comment are that description.
 * The receiving rules live in the YAML file, whose path the Source's configuration carries, so each read loads it for the
 * organization the calls belong to; the type only requires the path, which keeps this reader usable by a configuration
 * that adds fields later.
 */
export const yunxiaoThreadContext: ThreadContext<{ configPath?: string }> = {
  messageId: trigger => {
    const ref = yunxiaoRef(trigger)
    return ref.commentId ?? `wi:${ref.workitemId ?? ''}`
  },
  read: async (commands, trigger, part, cursor, config): Promise<ContextPart> => {
    const ref = yunxiaoRef(trigger)
    if (!ref.workitemId) throw new Error('A yunxiao work item trigger is required to read its thread')
    if (!config?.configPath) throw new Error('The yunxiao Source has no configuration file; its receiving rules name the organization to read from')
    const { file } = await loadConfig(config.configPath)
    const item = await readWorkitem(commands, file.organization, ref.workitemId)
    const description = descriptionMessage(item)
    if (part !== 'thread') return { messages: [description], body: { status: 'workitem', messages: [description] }, status: 'workitem' }
    const page = pageNumber(cursor)
    const comments = await readComments(commands, file.organization, ref.workitemId)
    const start = (page - 1) * COMMENTS_PER_PAGE
    const messages = comments.slice(start, start + COMMENTS_PER_PAGE).map(commentMessage)
    // The description is the first message of the thread, not of every page, so a later page holds comments only.
    const pageMessages = page === 1 ? [description, ...messages] : messages
    const more = start + COMMENTS_PER_PAGE < comments.length
    return { messages: pageMessages, next: more ? String(page + 1) : undefined,
      body: { status: 'workitem_thread', messages: pageMessages, total: comments.length }, status: 'workitem_thread' }
  },
}
