/** Write-back of a finished ticket to the work item it came from: the result comment people read, and the status it moves to. */
import { latestReport, type Assignment, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { AGENT_COMMENT, YUNXIAO } from '../infra/yunxiao.ts'
import { workitemGone } from './yunxiao-channel.ts'
import { projectOf, typeOf, type YunxiaoFile, type YunxiaoType } from './yunxiao-config.ts'

/** The handling a finished ticket reports, in the vocabulary the team reads on a work item. */
export type Handling = '已修复' | '待验证' | '阻塞' | '待确认' | '无需修改'
const HANDLINGS: readonly Handling[] = ['已修复', '待验证', '阻塞', '待确认', '无需修改']
/** What a write-back settled: whether the work item holds the comment, the status it moved to, and what kept that move. */
export interface WriteBack {
  /** Whether the work item now holds the result comment; false when it no longer exists or no longer takes comments. */
  written: boolean
  /** The workflow status id the work item moved to, which the Source records with the write-back. */
  status?: string
  /** What a person must fix, in English like the health entries: a refused move, or a work item gone. */
  problem?: string
}
/** What a write-back needs: the commands, the receiving rules, the ended ticket, its origin meta, and the account. */
export interface WriteBackInput {
  commands: Commands
  file: YunxiaoFile
  ticket: Ticket
  /** The `meta` of the Trigger the ticket came from, which `yunxiaoRef` reads: `workitemId`, `category`, `projectId`. */
  meta: Record<string, unknown>
  /** The account the comment and the transition act as, which a refused transition names for the operator. */
  agent: string
}

/** An id the Trigger's meta holds, as a string: the meta is JSON, so a numeric id may arrive as a number. */
const idOf = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
/** A failure's text, which `Commands` already keeps free of the command arguments. */
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
/**
 * A result field as text: a string as the worker wrote it, a list one item per line, and a record as `name：value` entries
 * on one line. `result` is a free-form record, so a value of a shape this cannot read contributes nothing rather than a
 * JSON dump in a comment colleagues read.
 */
function prose(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(item => prose(item)).filter(Boolean).join('\n')
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => {
      const text = prose(item)
      return text ? [`${name}：${text}`] : []
    }).join('；')
  }
  return ''
}
/** The bullet lines of a result field, so a list of changes reads as a list in the comment. */
const bullets = (value: unknown): string[] => prose(value).split('\n').map(line => line.trim()).filter(Boolean)
/**
 * The SQL files a result names, by file name only: the comment never carries a statement's body, so a string that is not a
 * plain `.sql` file name is left out, and a record contributes only the file it names.
 */
function sqlFiles(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap(item => {
    if (typeof item === 'string') return /^[\w./-]+\.sql$/i.test(item.trim()) ? [item.trim()] : []
    const record = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    const names = record ? [record.file, record.filename, record.name, record.path] : []
    const file = names.find(name => typeof name === 'string' && name.trim())
    return typeof file === 'string' ? [file.trim()] : []
  })
}
/** The handling a worker declared in its result, if it used the team's vocabulary; anything else falls back to the report. */
function declared(value: unknown): Handling | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return HANDLINGS.find(handling => handling === text)
}
/** The handling of a ticket that reported nothing: only an end with nothing left to do needs no change. */
function endedAs(ticket: Ticket): Handling {
  switch (ticket.ended?.outcome) {
    case 'completed': case 'merged': return '待验证'
    case 'dropped': return '无需修改'
    default: return '阻塞'
  }
}
/**
 * What a ticket ended as: what its worker declared, else what its last report says, else how the ticket ended.
 * A fixed status is a claim that needs evidence, so without a verification section it reads as waiting for verification.
 */
function handlingOf(ticket: Ticket, report: Assignment['report']): Handling {
  const result = report?.result ?? {}
  const stated = declared(result.status)
  if (stated) return stated === '已修复' && !prose(result.verification) ? '待验证' : stated
  switch (report?.state) {
    case 'ready': return prose(result.verification) ? '已修复' : '待验证'
    case 'dropped': return '无需修改'
    case 'blocked': case 'failed': return '阻塞'
    // A ticket that ended while its worker was still working or waiting ended without a verified result, so nothing here
    // may claim a fix; a person has to look at the work item.
    case 'progress': case 'waiting': return '阻塞'
    default: return endedAs(ticket)
  }
}
/**
 * The comment that records a finished ticket on its work item: the handling status first, then only the sections the
 * worker's result filled, and the marker that tells readers an agent posted it. The labels stay plain text rather than
 * Markdown emphasis, so the comment reads correctly whether or not the work item renders Markdown.
 * @param type - the work item's receiving rule, which the callers that hold it pass; the status vocabulary is the team's,
 *   the same for every category, so the comment itself reads only the ticket.
 */
export function resultComment(ticket: Ticket, report: Assignment['report'], type?: YunxiaoType): string {
  const result = report?.result ?? {}
  const parts: string[] = [handlingOf(ticket, report)]
  const cause = prose(result.root_cause)
  if (cause) parts.push(`根因：${cause}`)
  const changes = bullets(result.changes)
  if (changes.length) parts.push(['修改内容：', ...changes.map(line => `- ${line}`)].join('\n'))
  const verification = prose(result.verification)
  if (verification) parts.push(`验证证据：${verification}`)
  const sql = sqlFiles(result.sql)
  if (sql.length) parts.push(['SQL 文件（正文见仓库）：', ...sql.map(file => `- ${file}`)].join('\n'))
  return [...parts, AGENT_COMMENT].join('\n\n')
}
/**
 * The workflow status a finished ticket moves its work item to: only 已修复 does, to the verified status its category's
 * receiving rule names. Every other handling writes the comment alone, so an item never claims a state no one verified.
 */
export function targetStatus(ticket: Ticket, type?: YunxiaoType): string | undefined {
  return handlingOf(ticket, latestReport(ticket)) === '已修复' ? type?.verified || undefined : undefined
}
/**
 * Writes a finished ticket's result back to its work item: the result comment, then the workflow status when the ticket
 * ended 已修复. A workflow that refuses the move keeps the comment and reports a problem instead of failing, because the
 * comment is the record of the work and a retry would write it twice. A ticket a person stopped writes nothing at all.
 * @returns what the write-back settled; a thrown error means nothing settled, so the caller may retry it later.
 */
export async function writeBack(input: WriteBackInput): Promise<WriteBack> {
  const { commands, file, ticket, meta, agent } = input
  const workitemId = idOf(meta.workitemId)
  // The Source may hand over every ended ticket, and one that came from elsewhere has no work item to write back to.
  if (!workitemId) return { written: false }
  // A person stopped the ticket: the team's five handlings have no word for a deliberate stop, and 阻塞 would tell
  // colleagues the work is blocked when someone decided against it, so a stopped ticket writes nothing back.
  if (ticket.ended?.by === 'human' && ticket.ended.outcome === 'stopped') return { written: false }
  const project = projectOf(file, idOf(meta.projectId))
  const type = project ? typeOf(project, idOf(meta.category)) : undefined
  const comment = resultComment(ticket, latestReport(ticket), type)
  try { await commands.aliyun(YUNXIAO.createWorkitemComment(file.organization, workitemId, comment)) }
  catch (error) {
    // A deleted work item, or one the account may no longer comment on, takes the comment never: the write-back settles
    // with the reason instead of failing every poll, and the Source records it and reports the problem once.
    if (workitemGone(error)) return { written: false, problem: `The work item ${workitemId} no longer takes comments: ${message(error)}` }
    throw error
  }
  const status = targetStatus(ticket, type)
  if (!status) return { written: true }
  try { await commands.aliyun(YUNXIAO.updateWorkitem(file.organization, workitemId, { status })) }
  catch (error) {
    // The comment already records the work, so a refused move leaves it and the item for a person to move by hand; the
    // Source reports the refusal as health, and the ticket stays written back rather than repeating both writes.
    return { written: true, problem: `The workflow refused the move to ${status} for ${agent}: ${message(error)}` }
  }
  return { written: true, status }
}
