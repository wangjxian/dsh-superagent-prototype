/** Feishu outbound channel: posts threaded bot replies, starts direct messages the host needs, and constructs chat links. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * AppLink that opens a direct chat with a person, which is what a message the host started links to: Feishu names a person
 * by open_id, and the bot's direct chat has no chat id before the bot has written in it.
 * CALIBRATE: a real Feishu client is the authority on whether `openId` opens the conversation `openChatId` would.
 */
export const feishuDirectLink = (brand: 'feishu' | 'lark', openId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openId=${encodeURIComponent(openId)}`
/**
 * The flags that start a message in a person's direct chat. A bot has no thread to reply into before it has written there,
 * so the host addresses the person by open_id instead of a chat id.
 * CALIBRATE: `im +messages-create` and `--receive-id-type` against a real lark-cli; the created message's id is what a
 * reply to the confirmation names, so the answer's shape changes `CreatedMessageSchema` alone.
 */
const createArgs = (openId: string, text: string, idempotencyKey: string): string[] =>
  ['im', '+messages-create', '--receive-id', openId, '--receive-id-type', 'open_id', '--markdown', text,
    '--idempotency-key', idempotencyKey]
/** The created message's id, which the CLI may report at the top level or under `message`. */
const CreatedMessageSchema = z.looseObject({ message_id: z.string().optional(),
  message: z.looseObject({ message_id: z.string().optional() }).optional() })
/**
 * Starts a message in a person's direct chat and returns the Feishu message id a reply to it names, or undefined when the
 * CLI's answer carries none. Feishu keeps at most one message per idempotency key, so a retried call writes one message.
 * The message is the host's own, such as a merge confirmation listing every merge request of a ticket, so the word limit
 * that keeps an agent's replies short does not apply: its length follows what the person has to decide.
 */
export async function createFeishuDirect(commands: Commands, input: { openId: string; text: string; idempotencyKey: string }): Promise<string | undefined> {
  const data = CreatedMessageSchema.parse(await commands.lark(createArgs(input.openId, input.text, input.idempotencyKey)))
  return data.message_id ?? data.message?.message_id
}
/**
 * True when Feishu permanently rejects a message because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/**
 * Replies in the topic of the target message, or starts a message in a person's direct chat when the address names one.
 * Feishu keeps at most one message per idempotency key (the outgoing message's `message.id`).
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const address = message.channel.address
  try {
    if (address.new === 'true' && address.openId) {
      await createFeishuDirect(host.commands, { openId: address.openId, text: message.text, idempotencyKey: message.id })
      return 'sent'
    }
    const messageId = address.messageId
    if (!messageId) throw new Error('Missing Feishu reply target')
    await host.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--markdown', checkedImText(message.text),
      '--reply-in-thread', '--idempotency-key', message.id])
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/**
 * Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. A direct
 * message the host started has no chat yet, so it links to the person instead.
 */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => {
  const brand = links.feishu?.brand ?? 'feishu'
  if (address.new === 'true' && address.openId) {
    return { url: feishuDirectLink(brand, address.openId), label: { zh: '飞书私聊', en: 'Feishu direct message' } }
  }
  return { url: feishuChatLink(brand, address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
    ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {} }
}
