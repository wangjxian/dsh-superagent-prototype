/** The yunxiao read paths: the `yunxiao/…` resources, the material they assemble, and a work item's thread context. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { YUNXIAO } from '../src/infra/yunxiao.ts'
import { loadConfig } from '../src/sources/yunxiao-config.ts'
import { yunxiaoRead, yunxiaoResource, yunxiaoThreadContext } from '../src/sources/yunxiao-read.ts'
import { commentTrigger, workitemOf, workitemUrl, type Workitem } from '../src/sources/yunxiao-trigger.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

/** A deployment that hosts on Codeup, which is where the organization of a resource read comes from when no YAML is passed. */
const commands = new Commands(() => testDeployment({ github: undefined, codeup: testCodeup() }), {}, new AbortController().signal)
const millis = (value: number) => new Date(value).toISOString()

let directory: string
let configPath: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'yunxiao-read-'))
  configPath = join(directory, 'yunxiao.yml')
  writeFileSync(configPath, `organization: org-yaml
workspace: /tmp/dsh-superagent-workspace
projects:
  - id: proj-1
    intake: direct
    types:
      - category: Bug
        receive: ['28']
        started: '100010'
        verified: '29'
`)
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

/** A work item as `projex-get-workitem` prints it, with the CLI's own field names and timestamp form. */
const printed = (id: string, overrides: Record<string, unknown> = {}) => ({ id, identifier: `AXOAXO-${id}`, subject: `Item ${id}`,
  description: `<p>Description ${id}</p>`, categoryIdentifier: 'Bug', status: '28', assignedTo: { id: 'agent-1' },
  spaceIdentifier: 'proj-1', gmtModified: 1762045200000, ...overrides })
interface Answers {
  workitems?: Record<string, Record<string, unknown>>
  comments?: Record<string, Record<string, unknown>[]>
  relations?: Record<string, Record<string, unknown>[]>
}
/** A CLI that answers by subcommand and work-item ID, so a read sees the responses the real one would print. */
function fakeCli(answers: Answers) {
  const aliyun = vi.spyOn(commands, 'aliyun')
  aliyun.mockImplementation((async (first: unknown, second?: unknown) => {
    const argv = (Array.isArray(first) ? first : second) as string[]
    const command = argv[1]!
    const id = argv[argv.indexOf('--id') + 1]!
    if (command === 'projex-get-workitem') {
      const item = answers.workitems?.[id]
      if (!item) throw new Error(`StatusCode: 404 no work item ${id}`)
      return { workitem: item }
    }
    if (command === 'projex-list-workitem-comments') return { comments: answers.comments?.[id] ?? [] }
    if (command === 'projex-list-workitem-relation-records') {
      // The CLI reads one relation type at a time: the parent alone, then the associated items.
      const parent = argv[argv.indexOf('--relation-type') + 1] === 'PARENT'
      return { relationRecords: (answers.relations?.[id] ?? []).filter(record => (record.relationType === 'PARENT') === parent) }
    }
    throw new Error(`unexpected subcommand ${command}`)
  }) as never)
  return aliyun
}

it('accepts only the two resource shapes and rejects the others without a request', async () => {
  expect(yunxiaoResource('yunxiao/wi/123')).toEqual({ workitemId: '123', section: 'wi' })
  expect(yunxiaoResource('yunxiao/wi/123/comments/2')).toEqual({ workitemId: '123', section: 'comments', page: '2' })
  expect(() => yunxiaoResource('yunxiao/wi')).toThrow('Use yunxiao/wi')
  expect(() => yunxiaoResource('yunxiao/wi/123/extra')).toThrow('Use yunxiao/wi')
  expect(() => yunxiaoResource('github/issues/1')).toThrow('Use yunxiao/wi')
  const aliyun = vi.spyOn(commands, 'aliyun')
  await expect(yunxiaoRead(commands, 'yunxiao/wi/123/comments/0')).rejects.toThrow('page number')
  expect(aliyun).not.toHaveBeenCalled()
})
it('reads a work item’s material: its description, its direct parent, and the related requirement with its comments', async () => {
  const aliyun = fakeCli({
    workitems: { '123': printed('123', { description: '<p>Login fails</p>' }),
      '900': printed('900', { subject: 'Parent item', categoryIdentifier: 'Task', status: '100010' }),
      '901': printed('901', { subject: 'Requirement', categoryIdentifier: 'Req', status: '5' }),
      '902': printed('902', { subject: 'Related bug' }) },
    relations: { '123': [{ relationType: 'PARENT', relatedWorkitemId: '900' }, { relationType: 'RELATED', relatedWorkitemId: '901' },
      { relationType: 'RELATED', relatedWorkitemId: '902' }, { relationType: 'RELATED' }] },
    comments: { '901': [{ id: 'rc1', content: '<p>Requirement note</p>', creator: { id: 'user-2' }, gmtCreate: 1762045200000 }] },
  })
  const result = await yunxiaoRead(commands, 'yunxiao/wi/123') as {
    workitem: Workitem; parent: Workitem; related: (Workitem & { comments: unknown[] })[]; unreadable_relations?: number }
  expect(aliyun.mock.calls[0]![1]).toEqual(YUNXIAO.workitem('org-1', '123'))
  expect(aliyun.mock.calls[1]![1]).toEqual(YUNXIAO.workitemRelations('org-1', '123', 'PARENT'))
  expect(aliyun.mock.calls[2]![1]).toEqual(YUNXIAO.workitemRelations('org-1', '123', 'ASSOCIATED'))
  expect(result.workitem).toMatchObject({ id: '123', serial: 'AXOAXO-123', title: 'Item 123', description: 'Login fails', category: 'Bug',
    status: '28', assignee: 'agent-1', projectId: 'proj-1', url: workitemUrl('123'), modifiedAt: millis(1762045200000) })
  expect(result.parent).toMatchObject({ id: '900', title: 'Parent item' })
  // Only requirements are material; the related bug is not read at all, and the record naming no target is counted.
  expect(result.related).toHaveLength(1)
  expect(result.related[0]).toMatchObject({ id: '901', title: 'Requirement',
    comments: [{ id: 'rc1', from: 'user-2', at: millis(1762045200000), text: 'Requirement note' }] })
  expect(result.unreadable_relations).toBe(1)
})
it('serves one page of comments with the reference that continues the list', async () => {
  fakeCli({ comments: { '123': Array.from({ length: 25 }, (_, index) => ({ id: `c${index}`, content: `comment ${index}`,
    creator: { id: 'user-2' }, gmtCreate: 1762045200000 })) } })
  const first = await yunxiaoRead(commands, 'yunxiao/wi/123/comments/1') as { messages: { id: string; text: string }[]; total: number; next_resource: string | null }
  expect(first).toMatchObject({ total: 25, next_resource: 'yunxiao/wi/123/comments/2' })
  expect(first.messages).toHaveLength(20)
  expect(first.messages[0]).toMatchObject({ id: 'c0', text: 'comment 0' })
  const second = await yunxiaoRead(commands, 'yunxiao/wi/123/comments/2') as typeof first
  expect(second).toMatchObject({ total: 25, next_resource: null })
  expect(second.messages).toHaveLength(5)
  expect(second.messages[0]).toMatchObject({ id: 'c20', text: 'comment 20' })
})
it('raises when a read fails instead of reporting a work item with no material', async () => {
  const aliyun = vi.spyOn(commands, 'aliyun').mockRejectedValue(new Error('StatusCode: 404 Not Found'))
  await expect(yunxiaoRead(commands, 'yunxiao/wi/123')).rejects.toThrow('StatusCode: 404')
  aliyun.mockResolvedValue('nonsense')
  await expect(yunxiaoRead(commands, 'yunxiao/wi/123')).rejects.toThrow('not recognized')
  aliyun.mockResolvedValue({ workitem: { id: '123' } })
  await expect(yunxiaoRead(commands, 'yunxiao/wi/123')).rejects.toThrow('no title')
  aliyun.mockResolvedValue({ workitem: printed('123') })
  await expect(yunxiaoRead(commands, 'yunxiao/wi/123')).rejects.toThrow('not recognized')
})
it('takes the organization from the receiving rules when given, and refuses to guess without either source', async () => {
  const aliyun = fakeCli({ workitems: { '123': printed('123') } })
  const { file } = await loadConfig(configPath)
  await yunxiaoRead(commands, 'yunxiao/wi/123', file)
  expect(aliyun.mock.calls[0]![1]).toEqual(YUNXIAO.workitem('org-yaml', '123'))
  // A GitHub-only installation has no Codeup account to read the organization from.
  const githubOnly = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const spy = vi.spyOn(githubOnly, 'aliyun')
  await expect(yunxiaoRead(githubOnly, 'yunxiao/wi/123')).rejects.toThrow('Codeup account')
  expect(spy).not.toHaveBeenCalled()
})
it('reads the work item as the trigger’s thread: the description first, then a page of comments', async () => {
  fakeCli({ workitems: { '123': printed('123', { description: '<p>Login fails</p>' }) },
    comments: { '123': Array.from({ length: 22 }, (_, index) => ({ id: `c${index}`, content: `comment ${index}`,
      creator: { id: index === 1 ? 'robot-1' : 'user-2', ...index === 1 ? { userType: 'system' } : {} }, gmtCreate: 1762045200000 })) } })
  const trigger = commentTrigger({ id: 'c1', body: 'also on Safari', author: 'user-2', human: true, at: millis(1762045200000),
    modifiedAt: millis(1762045200000) }, workitemOf(printed('123')), 'agent-1')!
  const first = await yunxiaoThreadContext.read(commands, trigger, 'thread', undefined, { configPath })
  expect(first.messages[0]).toEqual({ id: 'wi:123', from: 'workitem', at: millis(1762045200000), text: 'Item 123\n\nLogin fails',
    url: workitemUrl('123') })
  expect(first.messages).toHaveLength(21)
  expect(first.messages[1]).toMatchObject({ id: 'c0', from: 'user-2', text: 'comment 0' })
  // A comment by a system account is marked `bot`, so it can never authorize work on its own.
  expect(first.messages[2]).toMatchObject({ id: 'c1', bot: true })
  expect(first.next).toBe('2')
  expect(first.status).toBe('workitem_thread')
  const second = await yunxiaoThreadContext.read(commands, trigger, 'thread', '2', { configPath })
  expect(second.messages).toHaveLength(2)
  expect(second.messages[0]).toMatchObject({ id: 'c20' })
  expect(second.next).toBeUndefined()
  // The description is the thread's root, and the parent a comment answers.
  const root = await yunxiaoThreadContext.read(commands, trigger, 'root', undefined, { configPath })
  expect(root.messages).toEqual([first.messages[0]])
  expect(await yunxiaoThreadContext.read(commands, trigger, 'parent', undefined, { configPath })).toMatchObject({ status: 'workitem' })
  expect(yunxiaoThreadContext.messageId(trigger)).toBe('c1')
  expect(yunxiaoThreadContext.messageId({ ...trigger, meta: { workitemId: '123' } })).toBe('wi:123')
})
it('refuses a thread read without a trigger’s work item or without the receiving rules that name the organization', async () => {
  const aliyun = vi.spyOn(commands, 'aliyun')
  const trigger = { id: 't', source: 'yunxiao', threads: [], actor: { source: 'yunxiao', id: 'u' }, human: true,
    at: millis(1762045200000), text: '', meta: {} }
  await expect(yunxiaoThreadContext.read(commands, trigger, 'thread', undefined, { configPath })).rejects.toThrow('work item trigger')
  await expect(yunxiaoThreadContext.read(commands, { ...trigger, meta: { workitemId: '123' } }, 'thread', undefined, {}))
    .rejects.toThrow('no configuration file')
  expect(aliyun).not.toHaveBeenCalled()
})
