/** The yunxiao work-item triggers: their stable IDs, the trigger each kind of change produces, and the field reading behind both. */
import { expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import { AGENT_MARKER, commentOf, commentTrigger, commentTriggerId, commentsOf, isAgentComment, relationOf, workitemChannel,
  workitemOf, workitemThread, workitemTrigger, workitemTriggerId, workitemUrl, yunxiaoRef } from '../src/sources/yunxiao-trigger.ts'
import type { Workitem, WorkitemComment } from '../src/sources/yunxiao-trigger.ts'

/** A work item as the receiving rules hold it once normalized. */
const item: Workitem = { id: '123', serial: 'AXOAXO-6812', title: 'Login fails', description: 'Steps\n\n1. open', category: 'Bug',
  status: '28', assignee: 'agent-1', projectId: 'proj-1', url: workitemUrl('123'), modifiedAt: '2026-11-02T01:00:00.000Z' }
const comment: WorkitemComment = { id: 'c1', body: 'Also fails on Safari', author: 'user-2', human: true,
  at: '2026-11-02T02:00:00.000Z', modifiedAt: '2026-11-02T02:00:00.000Z' }
const millis = (value: number) => new Date(value).toISOString()

it('derives trigger IDs that are stable across reads and distinct per repair cycle and edit', () => {
  expect(workitemTriggerId('123', 0)).toBe(key('yunxiao', '123', '0'))
  expect(workitemTriggerId('123', 0)).toBe(workitemTriggerId('123', 0))
  expect(workitemTriggerId('123', 1)).not.toBe(workitemTriggerId('123', 0))
  expect(commentTriggerId('c1', 't1')).toBe(key('yunxiao', 'c1', 't1'))
  // An edited comment carries a new `modifiedAt`, so it is a new trigger rather than a duplicate of the old text.
  expect(commentTriggerId('c1', 't2')).not.toBe(commentTriggerId('c1', 't1'))
})
it('names one thread per work item and addresses replies to the work item or the comment they answer', () => {
  expect(workitemThread('123')).toEqual({ source: 'yunxiao', id: 'wi:123' })
  expect(workitemChannel('123')).toEqual({ source: 'yunxiao', thread: 'yunxiao:123', address: { workitem: '123' } })
  expect(workitemChannel('123', 'c9')).toEqual({ source: 'yunxiao', thread: 'yunxiao:123', address: { workitem: '123', parent: 'c9' } })
})
it('builds the intake trigger of an assignment as a person’s request addressed to the agent', () => {
  expect(workitemTrigger(item, 'agent-1', 2, 'agent-1')).toEqual({
    id: workitemTriggerId('123', 2), source: 'yunxiao', threads: [{ source: 'yunxiao', id: 'wi:123' }],
    actor: { source: 'yunxiao', id: 'agent-1' }, human: true, addressed: 'mention', at: item.modifiedAt,
    text: 'AXOAXO-6812 Login fails\n\nSteps\n\n1. open', channel: workitemChannel('123'), url: workitemUrl('123'),
    meta: { workitemId: '123', serial: 'AXOAXO-6812', category: 'Bug', projectId: 'proj-1', status: '28', cycle: 2 },
  })
})
it('builds a comment trigger on the work item thread, naming the comment it answers', () => {
  expect(commentTrigger(comment, item, 'agent-1')).toEqual({
    id: commentTriggerId('c1', comment.modifiedAt), source: 'yunxiao', threads: [workitemThread('123')],
    actor: { source: 'yunxiao', id: 'user-2' }, human: true, at: comment.at, text: 'Also fails on Safari',
    channel: workitemChannel('123', 'c1'), url: workitemUrl('123'),
    meta: { workitemId: '123', commentId: 'c1', category: 'Bug', projectId: 'proj-1' },
  })
})
it('drops the Source’s own comments, whether the marker or the normalized flag names them', () => {
  expect(commentTrigger({ ...comment, body: `done\n\n${AGENT_COMMENT}` }, item, 'agent-1')).toBeUndefined()
  expect(commentTrigger({ ...comment, agent: true }, item, 'agent-1')).toBeUndefined()
  expect(commentTrigger({ ...comment, human: false }, item, 'agent-1')).toMatchObject({ human: false })
  expect(isAgentComment(`text ${AGENT_MARKER} more`)).toBe(true)
  expect(isAgentComment('ordinary text')).toBe(false)
})
it('reads the work-item IDs a trigger carries, and nothing from another source', () => {
  const trigger = commentTrigger(comment, item, 'agent-1')!
  expect(yunxiaoRef(trigger)).toEqual({ workitemId: '123', commentId: 'c1', projectId: 'proj-1', category: 'Bug' })
  expect(yunxiaoRef(workitemTrigger(item, 'agent-1', 0, 'agent-1'))).toEqual({ workitemId: '123', projectId: 'proj-1', category: 'Bug' })
  expect(yunxiaoRef({ ...trigger, source: 'github' })).toEqual({})
})
it('normalizes a work item the CLI returns, converting its rich text and timestamps', () => {
  const normalized = workitemOf({ workitem: { id: 123, identifier: 'AXOAXO-6812', subject: 'Login fails',
    description: '<p>Steps</p><ul><li>open</li></ul>', categoryIdentifier: 'Bug', status: '28',
    assignedTo: { id: 'agent-1', name: 'Yedou' }, spaceIdentifier: 'proj-1', gmtModified: 1762045200000 } })
  expect(normalized).toEqual({ id: '123', serial: 'AXOAXO-6812', title: 'Login fails', description: 'Steps\n\n- open', category: 'Bug',
    status: '28', assignee: 'agent-1', projectId: 'proj-1', url: workitemUrl('123'), modifiedAt: millis(1762045200000) })
  // A list result may name no space of its own, so the project the search ran in stands in for it.
  expect(workitemOf({ id: '9', subject: 'T', status: '28' }, 'proj-2').projectId).toBe('proj-2')
  // Epoch seconds and date strings are both read as the same instant.
  expect(workitemOf({ id: '9', subject: 'T', status: '28', spaceIdentifier: 'p', gmtModified: 1762045200 }).modifiedAt).toBe(millis(1762045200000))
  expect(workitemOf({ id: '9', subject: 'T', status: '28', spaceIdentifier: 'p', gmtModified: '2026-11-02T01:00:00Z' }).modifiedAt)
    .toBe('2026-11-02T01:00:00.000Z')
})
it('refuses a work item without the fields the receiving rules and the policy compare', () => {
  expect(() => workitemOf('nonsense')).toThrow('not recognized')
  expect(() => workitemOf({ subject: 'T', status: '28' }, 'p')).toThrow('no id')
  expect(() => workitemOf({ id: '9', status: '28' })).toThrow('no title')
  expect(() => workitemOf({ id: '9', subject: 'T' })).toThrow('no status')
  expect(() => workitemOf({ id: '9', subject: 'T', status: '28' })).toThrow('no project')
})
it('normalizes a comment list, converting its body and keeping what the marker means', () => {
  const comments = commentsOf({ comments: [
    { id: 'c1', content: '<p>Looks good</p>', creator: { id: 'user-2', name: 'A' }, gmtCreate: 1762045200000, gmtModified: 1762045300000 },
    { id: 'c2', content: `<p>${AGENT_MARKER}</p><p>Fixed in the next build</p>`, creator: { id: 'agent-1' }, gmtCreate: 1762045400000 },
    { id: 'c3', content: 'system note', creator: { id: 'robot-1', userType: 'system' }, gmtCreate: 1762045500000 },
  ] })
  expect(comments[0]).toEqual({ id: 'c1', body: 'Looks good', author: 'user-2', human: true,
    at: millis(1762045200000), modifiedAt: millis(1762045300000) })
  // The conversion drops the HTML comment that carries the marker, so the flag keeps what the body no longer shows.
  expect(comments[1]).toMatchObject({ id: 'c2', body: 'Fixed in the next build', author: 'agent-1', agent: true })
  expect(comments[2]).toMatchObject({ id: 'c3', human: false })
  expect(commentOf({ id: 'c4', content: 'plain', creator: { id: 'u' } })).toMatchObject({ id: 'c4', body: 'plain', at: '' })
  expect(() => commentsOf({ unexpected: [] })).toThrow('not recognized')
  expect(() => commentOf({ content: 'no id' })).toThrow('no id')
})
it('reads which work item a relation record points at, and whether that item is the parent', () => {
  expect(relationOf({ relationType: 'PARENT', relatedWorkitemId: '900' }, '123')).toEqual({ workitemId: '900', type: 'PARENT' })
  expect(relationOf({ relationType: 'RELATED', relatedWorkitem: { id: '901', subject: 'Requirement' } }, '123'))
    .toEqual({ workitemId: '901', type: 'RELATED' })
  // A record that names only the work item itself has no other side to read, and is counted rather than guessed at.
  expect(relationOf({ relationType: 'PARENT', workitemId: '123' }, '123')).toBeUndefined()
  expect(relationOf({}, '123')).toBeUndefined()
})
