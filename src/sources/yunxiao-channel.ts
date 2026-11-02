/** Yunxiao outbound channel: writes a work item's comments as the agent account and links a work item to its page. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { AGENT_COMMENT, YUNXIAO } from '../infra/yunxiao.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { workitemUrl } from './yunxiao-trigger.ts'

/** Work-item ids are digit strings in projex; an address of another shape names no work item we may write to. */
const WORKITEM_ID = /^\d+$/
/**
 * True when the work item permanently refuses writes: 云效 answers 404 for a deleted one and 403 for one the account may no
 * longer comment on. Neither changes on a retry, while 401 (the token), 5xx and a lost connection may pass later.
 */
export function workitemGone(error: unknown): boolean {
  return error instanceof CliError && (error.code === 404 || error.code === 403)
}
/** The work item a reply goes to, which is the address of the comment thread it belongs to. */
function workitemIdOf(address: Record<string, string>): string {
  const id = address.workitem ?? ''
  if (!id) throw new Error('Missing yunxiao work item id')
  if (!WORKITEM_ID.test(id)) throw new Error(`Not a yunxiao work item id: ${id}`)
  return id
}
/**
 * Whether any string of the CLI's answer carries `marker`. The reply's marker is this deployment's own, so a walk of the
 * whole answer finds it wherever the CLI put it, without depending on the comment field names that need calibrating.
 */
function carries(value: unknown, marker: string): boolean {
  if (typeof value === 'string') return value.includes(marker)
  if (Array.isArray(value)) return value.some(item => carries(item, marker))
  if (value !== null && typeof value === 'object') return Object.values(value).some(item => carries(item, marker))
  return false
}
/**
 * Posts a comment on the work item its Channel names, as the account the deployment's Codeup CLI acts for. Work-item
 * comments are flat, so a reply lands on the item rather than under the comment it answers, and the address's `parent`
 * needs no handling.
 *
 * The body carries two hidden markers: the reply's own id, which makes a retried send find the comment it already wrote
 * instead of writing a second one, and `AGENT_COMMENT`, the marker a worker's merge-request comment carries too, so the
 * work-item Source does not read the agent's own answer back as a person's message. `AGENT_COMMENT` stays last, so the
 * visible line that says an agent posted the comment ends what readers see. A work item that was deleted or is no longer
 * writable is reported as `'gone'` rather than retried forever.
 */
export async function sendYunxiao(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const id = workitemIdOf(message.channel.address)
  // The organization comes from the Codeup account setup verified, the only one this deployment may write as; the
  // receiving-rule file names the same organization, and the Source reports a file that names another one.
  const organization = commands.deployment.codeup?.organization
  if (!organization) throw new Error('The yunxiao Source needs the Codeup account\'s organization')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    // A failed read is a failed send: writing the comment without knowing whether it already exists could duplicate it.
    const comments = await commands.aliyun(z.unknown(), YUNXIAO.workitemComments(organization, id))
    if (carries(comments, marker)) return 'sent'
    await commands.aliyun(YUNXIAO.createWorkitemComment(organization, id, `${message.text}\n\n${marker}\n${AGENT_COMMENT}`))
  } catch (error) {
    if (workitemGone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** The work item's page; the address alone decides the URL, so the deployment's links add nothing. */
export const yunxiaoLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: address.workitem ? workitemUrl(address.workitem) : '', label: { zh: '云效工作项', en: 'Yunxiao work item' },
})
