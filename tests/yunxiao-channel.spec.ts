/** The yunxiao Channel: the comment it posts on a work item, the work items it reports gone, and the page it links. */
import { describe, expect, it, vi } from 'vitest'
import type { Deployment } from '../src/deployment.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import { sendYunxiao, workitemGone, yunxiaoLink } from '../src/sources/yunxiao-channel.ts'
import { isAgentComment, workitemChannel } from '../src/sources/yunxiao-trigger.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

/** A deployment whose code hosting is Codeup, which is the account the yunxiao CLI acts for. */
const codeup = testDeployment({ github: undefined, codeup: testCodeup() })
const commands = (deployment: Deployment = codeup) => new Commands(() => deployment, {}, new AbortController().signal)
const reply = { id: 'reply-1', channel: workitemChannel('123'), text: '收到，我看一下。', kind: 'reply' as const }
/** The argv of one `aliyun` call, as the channel builds it. */
const argv = (call: readonly unknown[]): string[] => call[0] as string[]
/** The hidden marker that makes a retried send find the comment it already wrote. */
const MARKER = '<!-- dsh-superagent:reply-1 -->'
/** What `projex-list-workitem-comments` answers when the work item holds the comments given. */
const comments = (...bodies: string[]): string =>
  JSON.stringify({ comments: bodies.map((content, index) => ({ id: String(index + 1), content })) })
const LIST = ['devops', 'projex-list-workitem-comments', '--organization-id', 'org-1', '--workitem-id', '123']

describe('the yunxiao channel', () => {
  it('posts the reply as a work-item comment, carrying its own marker and the one every agent comment carries', async () => {
    const value = commands()
    const aliyun = vi.spyOn(value, 'aliyun').mockResolvedValue('')
    expect(await sendYunxiao({ commands: value }, reply)).toBe('sent')
    // The reply reads the work item's comments first (with a schema, so its argv is the second argument), so a retried
    // send can find what it already wrote.
    expect(aliyun.mock.calls[0]![1]).toEqual(LIST)
    expect(aliyun.mock.calls[1]![0]).toEqual(['devops', 'projex-create-workitem-comment', '--organization-id', 'org-1',
      '--workitem-id', '123', '--content', `收到，我看一下。\n\n${MARKER}\n${AGENT_COMMENT}`])
    // The poll reads the same marker, so the agent's own answer never comes back as a person's message.
    expect(isAgentComment(argv(aliyun.mock.calls[1]!).at(-1)!)).toBe(true)
  })
  it('does not post a reply the work item already carries', async () => {
    const value = commands()
    const aliyun = vi.spyOn(value, 'aliyun').mockResolvedValue(comments(`收到，我看一下。\n\n${MARKER}\n${AGENT_COMMENT}`))
    expect(await sendYunxiao({ commands: value }, reply)).toBe('sent')
    expect(aliyun).toHaveBeenCalledTimes(1)
  })
  it('finds its marker in the middle of a comment, and ignores the marker of another reply', async () => {
    const mid = commands()
    const middled = vi.spyOn(mid, 'aliyun').mockResolvedValue(comments(`前一句\n${MARKER}\n后一句`))
    expect(await sendYunxiao({ commands: mid }, reply)).toBe('sent')
    expect(middled).toHaveBeenCalledTimes(1)
    // Another reply's marker is another message: this one still has to go out.
    const other = commands()
    const elsewhere = vi.spyOn(other, 'aliyun').mockResolvedValue(comments('<!-- dsh-superagent:reply-2 -->\n由智能体代发'))
    expect(await sendYunxiao({ commands: other }, reply)).toBe('sent')
    expect(elsewhere).toHaveBeenCalledTimes(2)
    expect(elsewhere.mock.calls[1]![0]).toContain('projex-create-workitem-comment')
  })
  it('drops a reply to a deleted or unwritable work item, and keeps a failure that may pass on a retry', async () => {
    const value = commands()
    const aliyun = vi.spyOn(value, 'aliyun')
    // 云效 reports a failed call as `StatusCode: 404 … Data: {"message":"…"}`, which Commands reads into a CliError code.
    aliyun.mockRejectedValueOnce(commandError({ stderr: 'StatusCode: 404\nData: {"message":"workitem not found"}' }))
    expect(await sendYunxiao({ commands: value }, reply)).toBe('gone')
    aliyun.mockResolvedValueOnce('').mockRejectedValueOnce(new CliError('Forbidden', 403))
    expect(await sendYunxiao({ commands: value }, reply)).toBe('gone')
    // A 5xx, a lost connection, or a signed-out CLI may pass on a later attempt, so it stays an error for the Outbox to retry.
    for (const error of [new CliError('InternalError', 500), new CliError('dial tcp: i/o timeout'),
      commandError({ stderr: 'StatusCode: 401\nData: {"message":"token expired"}' }), new Error('boom')]) {
      aliyun.mockResolvedValueOnce('').mockRejectedValueOnce(error)
      await expect(sendYunxiao({ commands: value }, reply)).rejects.toThrow()
    }
    expect(workitemGone(new Error('boom'))).toBe(false)
  })
  it('fails the send rather than posting blind when the work item\'s comments cannot be read', async () => {
    const value = commands()
    const aliyun = vi.spyOn(value, 'aliyun').mockRejectedValueOnce(new CliError('InternalError', 500))
    await expect(sendYunxiao({ commands: value }, reply)).rejects.toThrow('InternalError')
    // The comment was never attempted, so nothing can be duplicated by the retry.
    expect(aliyun).toHaveBeenCalledTimes(1)
  })
  it('refuses an address that names no work item', async () => {
    const value = commands()
    const aliyun = vi.spyOn(value, 'aliyun').mockResolvedValue('')
    const at = (address: Record<string, string>) => ({ ...reply, channel: { ...reply.channel, address } })
    await expect(sendYunxiao({ commands: value }, at({}))).rejects.toThrow('Missing yunxiao work item id')
    // A work item is named by a digit string; another shape would reach the CLI as an id that cannot exist.
    const serial = at({ workitem: 'AXOAXO-6701' })
    await expect(sendYunxiao({ commands: value }, serial)).rejects.toThrow('Not a yunxiao work item id: AXOAXO-6701')
    expect(aliyun).not.toHaveBeenCalled()
  })
  it('needs the Codeup account whose organization it writes in', async () => {
    const value = commands(testDeployment())
    await expect(sendYunxiao({ commands: value }, reply)).rejects.toThrow('The yunxiao Source needs the Codeup account\'s organization')
  })
  it('links a work item to its page, in both interface languages', () => {
    expect(yunxiaoLink({ workitem: '123' }, {})).toEqual({ url: 'https://devops.aliyun.com/projex/workitem/123',
      label: { zh: '云效工作项', en: 'Yunxiao work item' } })
    expect(yunxiaoLink({}, {}).url).toBe('')
  })
})
