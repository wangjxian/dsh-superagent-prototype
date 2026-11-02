/** Feishu direct messages: the message the host starts in a person's chat, and the approval reply it becomes. */
import { describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { createFeishuDirect, feishuDirectLink, feishuLink, sendFeishu } from '../src/sources/feishu-channel.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { markApproval } from '../src/sources/feishu-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment()
const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
/** A message the host starts in the approver's direct chat, as the merge flow addresses it. */
const direct = { id: 'merge-confirm-1', text: '【合并确认】AXOAXO-6812 登录后偶发白屏',
  channel: { source: 'feishu', thread: 'feishu:dm:ou_approver', address: { openId: 'ou_approver', new: 'true' } }, kind: 'notice' as const }
/** A reply in a Feishu chat, which the channel answers in the message's thread. */
const reply = { id: 'reply-1', text: '收到', channel: { source: 'feishu', thread: 'feishu:oc_team',
  address: { chatId: 'oc_team', messageId: 'om_1' } }, kind: 'notice' as const }
/** A Feishu message that answers `parentId`, which the approval marker reads. */
const answering = (parentId: string, overrides: Record<string, unknown> = {}): Trigger => ({
  id: 'feishu:om_reply', source: 'feishu', threads: [{ source: 'feishu', id: 'feishu:oc_dm:om_reply' }],
  actor: { source: 'feishu', id: 'ou_approver' }, human: true, addressed: 'direct', at: '2026-11-02T10:05:00Z', text: '同意',
  channel: { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_reply', direct: 'true' } },
  meta: { chatId: 'oc_dm', messageId: 'om_reply', direct: true, parentId }, ...overrides })

describe('a message the host starts in a direct chat', () => {
  it('addresses the person by open_id and keeps one message per idempotency key', async () => {
    const value = commands()
    const lark = vi.spyOn(value, 'lark').mockResolvedValue({ message_id: 'om_confirm' })
    expect(await sendFeishu({ commands: value }, direct)).toBe('sent')
    expect(lark.mock.calls[0]![0]).toEqual(['im', '+messages-send', '--user-id', 'ou_approver',
      '--markdown', '【合并确认】AXOAXO-6812 登录后偶发白屏', '--idempotency-key', 'merge-confirm-1'])
  })
  it('reports the created message id, which a reply to the confirmation names', async () => {
    const value = commands()
    // The CLI may report the id at the top level or under `message`.
    vi.spyOn(value, 'lark').mockResolvedValueOnce({ message_id: 'om_confirm' }).mockResolvedValueOnce({ message: { message_id: 'om_nested' } })
    expect(await createFeishuDirect(value, { openId: 'ou_approver', text: 'x', idempotencyKey: 'k' })).toBe('om_confirm')
    expect(await createFeishuDirect(value, { openId: 'ou_approver', text: 'x', idempotencyKey: 'k' })).toBe('om_nested')
    vi.spyOn(value, 'lark').mockResolvedValueOnce({})
    expect(await createFeishuDirect(value, { openId: 'ou_approver', text: 'x', idempotencyKey: 'k' })).toBeUndefined()
  })
  it('drops a direct message Feishu no longer accepts, and keeps a failure that may pass on a retry', async () => {
    const value = commands()
    const lark = vi.spyOn(value, 'lark')
    lark.mockRejectedValueOnce(new CliError('The message is withdrawn', 230011))
    expect(await sendFeishu({ commands: value }, direct)).toBe('gone')
    lark.mockRejectedValueOnce(new CliError('rate limited', 99991400))
    await expect(sendFeishu({ commands: value }, direct)).rejects.toThrow('rate limited')
    // A reply still needs the message it answers.
    await expect(sendFeishu({ commands: value }, { ...reply, channel: { ...reply.channel, address: {} } })).rejects.toThrow('Missing Feishu reply target')
  })
  it('links the person\'s chat, and a reply to the message it answers', () => {
    expect(feishuLink({ openId: 'ou_approver', new: 'true' }, {})).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openId=ou_approver',
      label: { zh: '飞书私聊', en: 'Feishu direct message' } })
    expect(feishuLink({ openId: 'ou_approver', new: 'true' }, { feishu: deployment.feishu! }).url).toBe(feishuDirectLink('feishu', 'ou_approver'))
    expect(feishuLink({ chatId: 'oc_team', messageId: 'om_1' }, {})).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_team',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: expect.any(String) })
  })
  it('lets the Source send it whatever it receives, which is the person\'s own conversation', () => {
    const config = feishuKind.schema.parse({ directMessages: false })
    expect(feishuKind.channel!.allowed!({ openId: 'ou_approver', new: 'true' }, config)).toBe(true)
    // A reply still follows the chat the Source receives.
    expect(feishuKind.channel!.allowed!({ chatId: 'oc_team', messageId: 'om_1' }, config)).toBe(false)
    expect(feishuKind.channel!.allowed!({ chatId: 'oc_team', messageId: 'om_1' },
      feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions' }] }))).toBe(true)
  })
})

describe('a message the host starts in a ticket\'s conversation', () => {
  /** A Source-scoped record, as the Outbox hands it to a Channel. */
  const records = () => {
    const kv = new Map<string, unknown>()
    return { kv, state: { get: <V>(key: string) => kv.get(key) as V | undefined, set: <V>(key: string, value: V) => { kv.set(key, value) } } }
  }
  it('records the created message, so the person\'s answer reaches that ticket', async () => {
    const value = commands()
    vi.spyOn(value, 'lark').mockResolvedValue({ message_id: 'om_ticket_msg' })
    const { kv, state } = records()
    expect(await sendFeishu({ commands: value, state }, { ...direct, ticketId: 't1' })).toBe('sent')
    expect(kv.get(KV.merge.message('om_ticket_msg'))).toEqual({ thread: 'feishu:dm:ou_approver', ticketId: 't1',
      at: expect.any(String), kind: 'ticket' })
  })
  it('records nothing for a message that belongs to no ticket, or one Feishu reported no id for', async () => {
    const value = commands()
    const lark = vi.spyOn(value, 'lark').mockResolvedValueOnce({ message_id: 'om_unowned' }).mockResolvedValueOnce({})
    const { kv, state } = records()
    await sendFeishu({ commands: value, state }, direct)
    await sendFeishu({ commands: value, state }, { ...direct, ticketId: 't1' })
    expect([...kv.keys()]).toEqual([])
    expect(lark).toHaveBeenCalledTimes(2)
  })
})

describe('the approval marker', () => {
  it('marks a message that answers a merge confirmation, by its parent or its topic root', () => {
    const confirmation = (messageId: string) => messageId === 'om_confirm'
    expect(markApproval(answering('om_confirm'), confirmation).meta.approval).toBe(true)
    expect(markApproval(answering('om_other', { meta: { chatId: 'oc_dm', messageId: 'om_reply', rootId: 'om_confirm' } }), confirmation)
      .meta.approval).toBe(true)
    // A message that answers anything else, or comes from another Source, keeps its meta as it was.
    expect(markApproval(answering('om_other'), confirmation).meta).toEqual({ chatId: 'oc_dm', messageId: 'om_reply', direct: true, parentId: 'om_other' })
    expect(markApproval({ ...answering('om_confirm'), source: 'github' }, confirmation).meta.approval).toBeUndefined()
  })
  it('marks a reply to a message the host started in a ticket\'s conversation, and one to a triage question', () => {
    // The Source marks every message it has a record for: the host's own branches decide what to do with the answer.
    const records = new Map([['om_ticket_msg', { thread: '', ticketId: 't1', at: '', kind: 'ticket' }],
      ['om_triage', { thread: '', ticketId: '', at: '', kind: 'triage', workitemId: 'wi-123' }]])
    const lookup = (messageId: string) => records.has(messageId)
    expect(markApproval(answering('om_ticket_msg'), lookup).meta.approval).toBe(true)
    expect(markApproval(answering('om_triage'), lookup).meta.approval).toBe(true)
    expect(markApproval(answering('om_other'), lookup).meta.approval).toBeUndefined()
  })
})
