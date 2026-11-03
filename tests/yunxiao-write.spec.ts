/** The yunxiao write-back: the result comment a finished ticket leaves, the status it moves the work item to, and refusals. */
import { describe, expect, it, vi } from 'vitest'
import type { Assignment, ReportState, Ticket } from '../src/core/index.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { AGENT_COMMENT } from '../src/infra/yunxiao.ts'
import { isAgentComment, workitemChannel } from '../src/sources/yunxiao-trigger.ts'
import { YunxiaoFileSchema } from '../src/sources/yunxiao-config.ts'
import { resultComment, targetStatus, writeBack, type WriteBackInput } from '../src/sources/yunxiao-write.ts'
import { testCodeup, testDeployment } from './fixtures/deployment.ts'

/** A deployment whose code hosting is Codeup, which is the account the yunxiao CLI acts for. */
const codeup = testDeployment({ github: undefined, codeup: testCodeup() })
/** The receiving rules a write-back reads: the verified status of each category it may move to. */
const file = YunxiaoFileSchema.parse({ organization: 'org-1', workspace: '/tmp/dsh-superagent-workspace',
  projects: [{ id: 'proj-1', intake: 'direct', types: [
    { category: 'Bug', receive: ['28', '30'], started: '100010', verified: '29' },
    { category: 'Task', receive: ['100005'], started: '100010', verified: '100014' },
  ] }] })
/** The Trigger meta of a work item ticket, as `yunxiaoRef` reads it. */
const meta = { workitemId: '123', category: 'Bug', projectId: 'proj-1' }
/** What a worker reported: its state, and the structured outcome the result comment renders. */
const reported = (result: Record<string, unknown> = {}, state: ReportState = 'ready'): NonNullable<Assignment['report']> =>
  ({ state, summary: '', at: '2026-11-02T10:00:00Z', result: { qa: { repository: 'repo-1', pipeline_id: '11', run_id: '2', main_flow_passed: true, evidence: 'QA main flow passed', verified: true }, ...result } })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'one', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, scope: 'proj-1',
    actor: { source: 'yunxiao', id: '62cf7f1d' } },
  channels: [workitemChannel('123')], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'yunxiao:123:0', triggerIds: ['yunxiao:123:0'] }, ...overrides,
})
/** A ticket that ended with `report` as the latest thing its worker said. */
const ended = (report: Assignment['report'] = undefined): Ticket => ticket({
  ended: { at: '2026-11-02T11:00:00Z', by: 'executor', outcome: 'completed' },
  assignments: report ? [{ id: 'a1', state: 'ended', createdAt: '', report }] : [],
})
/** The argv of one `aliyun` call, as the channel and the write-back build it. */
const argv = (call: readonly unknown[]): string[] => call[0] as string[]
/** The handling status of a comment, which is its first line. */
const first = (text: string): string => text.split('\n')[0] ?? ''

describe('the result comment', () => {
  it('states the handling first, then only the sections the result filled, and ends with the agent marker', () => {
    const text = resultComment(ticket(), reported({ status: '已修复', root_cause: '缓存键没有带上租户 id',
      changes: ['app：缓存键加租户 id', 'lib：补回归用例'], verification: 'QA 上按复现步骤验证通过' }))
    const expected = ['已修复', '根因：缓存键没有带上租户 id', '修改内容：\n- app：缓存键加租户 id\n- lib：补回归用例',
      '验证证据：QA 上按复现步骤验证通过', AGENT_COMMENT]
    expect(text).toBe(expected.join('\n\n'))
    // Nothing the result did not fill is written: an empty section would say the agent had nothing to report.
    expect(resultComment(ticket(), reported())).toBe(['待验证', AGENT_COMMENT].join('\n\n'))
  })
  it('writes a comment the Source\'s own poll reads as the agent\'s, not as a person\'s message', () => {
    // The poll skips a comment carrying the marker, so the agent never answers its own result comment.
    expect(isAgentComment(resultComment(ticket(), reported({ status: '已修复', verification: 'QA 通过' })))).toBe(true)
  })
  it('reads a report that declared no status by its state, and a ticket that reported nothing by how it ended', () => {
    expect(first(resultComment(ticket(), reported({ verification: 'QA 通过' })))).toBe('已修复')
    expect(first(resultComment(ticket(), reported({ root_cause: 'x' })))).toBe('待验证')
    expect(first(resultComment(ticket(), reported({}, 'blocked')))).toBe('阻塞')
    expect(first(resultComment(ticket(), reported({}, 'failed')))).toBe('阻塞')
    expect(first(resultComment(ticket(), reported({}, 'dropped')))).toBe('无需修改')
    // A ticket that ended while its worker was still working claims no fix.
    expect(first(resultComment(ticket(), reported({}, 'progress')))).toBe('阻塞')
    expect(first(resultComment(ticket(), reported({}, 'waiting')))).toBe('阻塞')
    expect(first(resultComment(ticket({ ended: { at: '', by: 'executor', outcome: 'dropped' } }), undefined))).toBe('无需修改')
    expect(first(resultComment(ticket({ ended: { at: '', by: 'executor', outcome: 'completed' } }), undefined))).toBe('待验证')
    // The formatter answers for a ticket a person stopped too, though the write-back writes nothing for one (see below).
    expect(first(resultComment(ticket({ ended: { at: '', by: 'human', outcome: 'stopped' } }), undefined))).toBe('阻塞')
  })
  it('downgrades a claimed fix without verification evidence, and keeps the other declared handlings', () => {
    // The team's rule: 已修复 must carry the verification; without it the item is reported as waiting for verification.
    expect(first(resultComment(ticket(), reported({ status: '已修复' })))).toBe('待验证')
    expect(first(resultComment(ticket(), reported({ status: '已修复', verification: 'QA passed', qa: undefined })))).toBe('待验证')
    expect(first(resultComment(ticket(), reported({ status: '已修复', verification: 'QA passed', qa: { verified: true } })))).toBe('待验证')
    expect(first(resultComment(ticket(), reported({ status: '已修复', verification: 'QA 通过' })))).toBe('已修复')
    const confirm = reported({ status: '待确认', root_cause: '需要确认是否改默认值' })
    expect(first(resultComment(ticket(), confirm))).toBe('待确认')
    expect(first(resultComment(ticket(), reported({ status: '无需修改' })))).toBe('无需修改')
    // A word outside the team's vocabulary falls back to what the report itself says.
    expect(first(resultComment(ticket(), reported({ status: 'fixed' })))).toBe('待验证')
  })
  it('renders a result field written as a record or a list', () => {
    const text = resultComment(ticket(), reported({ changes: [{ repository: 'app', summary: '修复缓存' }],
      verification: ['QA 上按复现步骤验证通过', 'QA 复现确认'] }))
    expect(text).toContain('修改内容：\n- repository：app；summary：修复缓存')
    expect(text).toContain('验证证据：QA 上按复现步骤验证通过 QA 复现确认')
  })
  it('lists SQL files by name and never a statement\'s body', () => {
    const text = resultComment(ticket(), reported({ verification: 'QA 通过',
      sql: [{ file: 'db/migrate/001_add_index.sql', database: 'axo', statement: 'ALTER TABLE orders ADD INDEX i (id)' },
        'db/002_backfill.sql', 'ALTER TABLE orders ADD COLUMN c int;'] }))
    expect(text).toContain('SQL 文件（正文见仓库）：\n- db/migrate/001_add_index.sql\n- db/002_backfill.sql')
    expect(text).not.toContain('ALTER TABLE')
  })
})

describe('multi-repository write-back evidence', () => {
  const qa = () => ({ verified: true, main_flow_passed: true, evidence: '联合登录和保存场景通过', repositories: [
    { repository: 'app', pipeline_id: '11', run_id: '3', main_flow_passed: true, evidence: 'frontend QA passed', commit: 'a'.repeat(40) },
    { repository: 'service', pipeline_id: '22', run_id: '4', main_flow_passed: true, evidence: 'backend QA passed', commit: 'b'.repeat(40) },
  ] })
  it('records every repository and the joint test, then allows the single work item to finish', () => {
    const report = reported({ qa: qa(), verification: 'QA 联调通过' })
    const text = resultComment(ticket(), report)
    expect(text).toContain('app：流水线 11 #3 通过（aaaaaaa）')
    expect(text).toContain('service：流水线 22 #4 通过（bbbbbbb）')
    expect(text).toContain('QA 主流程验收通过')
    expect(targetStatus(ended(report), file.projects[0]!.types[0])).toBe('29')
  })
  it('summarizes recorded checks and links instead of copying raw logs or full SHA lines', () => {
    const value = { ...qa(), environment: 'https://qa.example.test', test_command: 'pytest integration', test_output: 'RAW_QA_SECRET_LOG\n'.repeat(200) }
    Object.assign(value.repositories[0]!, { qa_branch: 'qa', qa_commit: 'c'.repeat(40), merge_request: 3,
      merge_request_url: 'https://codeup.aliyun.com/org/app/change/3',
      unit_tests: { command: 'unittest', commit: 'a'.repeat(40), output: 'Ran 6 tests in 1s\nRAW_UNIT_LOG' } })
    const text = resultComment(ticket(), reported({ qa: value, verification: 'RAW_VERIFICATION_LOG\n'.repeat(200) }))
    expect(text).toContain('app：单测 6 项通过；流水线 11 #3 通过（qa ccccccc）；MR !3 https://codeup.aliyun.com/org/app/change/3')
    expect(text).toContain('QA 环境：https://qa.example.test')
    expect(text).not.toMatch(/RAW_|pytest integration|unittest|a{40}|c{40}/)
    expect(text.length).toBeLessThan(700)
  })
  it('shows trusted repository names while retaining numeric repository identity', () => {
    const value = qa()
    Object.assign(value.repositories[0]!, { repository: '7643728', repository_name: 'test-agent' })
    Object.assign(value.repositories[1]!, { repository: '7644238', repository_name: 'test-agent-service' })
    const text = resultComment(ticket(), reported({ qa: value, verification: 'QA 联调通过' }))
    expect(text).toContain('test-agent：流水线 11 #3 通过')
    expect(text).toContain('test-agent-service：流水线 22 #4 通过')
    expect(text).not.toMatch(/7643728|7644238/)
    expect(value.repositories.map(item => item.repository)).toEqual(['7643728', '7644238'])
  })
  it.each(['component failed', 'joint test failed', 'empty scope', 'duplicate repo'])('does not mark fixed when %s', reason => {
    const value = qa()
    if (reason === 'component failed') value.repositories[1]!.main_flow_passed = false
    if (reason === 'joint test failed') value.main_flow_passed = false
    if (reason === 'empty scope') value.repositories = []
    if (reason === 'duplicate repo') value.repositories[1]!.repository = 'app'
    const report = reported({ qa: value, status: '已修复', verification: 'QA 通过' })
    expect(first(resultComment(ticket(), report))).toBe('待验证')
    expect(targetStatus(ended(report), file.projects[0]!.types[0])).toBeUndefined()
  })
  it.each(['progress', 'failed'] as const)('does not trust a verified flag in a %s report', state => {
    const report = reported({ qa: qa(), status: '已修复', verification: 'QA 通过' }, state)
    expect(targetStatus(ended(report), file.projects[0]!.types[0])).toBeUndefined()
  })
})

describe('the target status', () => {
  const [bug, task] = file.projects[0]!.types
  it('moves only a fixed ticket, to the verified status its category configures', () => {
    expect(targetStatus(ended(reported({ status: '已修复', verification: 'QA 通过' })), bug)).toBe('29')
    expect(targetStatus(ended(reported({ status: '已修复', verification: 'QA 通过' })), task)).toBe('100014')
    // A claim without evidence is not a fix, and the other handlings change no status at all.
    expect(targetStatus(ended(reported({ status: '已修复' })), bug)).toBeUndefined()
    expect(targetStatus(ended(reported({}, 'blocked')), bug)).toBeUndefined()
    expect(targetStatus(ended(reported({}, 'dropped')), bug)).toBeUndefined()
    // A category whose rule is gone has no status to move to.
    expect(targetStatus(ended(reported({ status: '已修复', verification: 'QA 通过' })))).toBeUndefined()
  })
})

describe('the write-back', () => {
  const setup = () => {
    const commands = new Commands(() => codeup, {}, new AbortController().signal)
    const aliyun = vi.spyOn(commands, 'aliyun').mockResolvedValue('')
    const input = (overrides: Partial<WriteBackInput> = {}): WriteBackInput =>
      ({ commands, file, ticket: ended(), meta, agent: '62cf7f1d', ...overrides })
    return { aliyun, input }
  }
  it('posts the result comment and then moves the work item to its verified status', async () => {
    const { aliyun, input } = setup()
    const fixed = ended(reported({ status: '已修复', root_cause: '缓存键漏了租户', verification: 'QA 通过' }))
    expect(await writeBack(input({ ticket: fixed }))).toEqual({ written: true, status: '29' })
    const comment = argv(aliyun.mock.calls[0]!)
    expect(comment.slice(0, 4)).toEqual(['devops', 'projex-create-workitem-comment', '--organization-id', 'org-1'])
    expect(comment).toContain('123')
    expect(comment.at(-1)).toContain('已修复')
    expect(comment.at(-1)).toContain(AGENT_COMMENT)
    // The status transition names the id the receiving rules configured, as the CLI's `--biz-body` JSON.
    expect(aliyun.mock.calls[1]![0]).toEqual(['devops', 'projex-update-workitem', '--organization-id', 'org-1', '--id', '123',
      '--biz-body', '{"status":"29"}'])
  })
  it('writes in the organization its receiving rules name', async () => {
    const { aliyun, input } = setup()
    await writeBack(input({ file: { ...file, organization: 'org-9' } }))
    expect(aliyun.mock.calls[0]![0]).toContain('org-9')
  })
  it('keeps the comment and reports the refusal when the workflow will not move the item', async () => {
    const { aliyun, input } = setup()
    aliyun.mockResolvedValueOnce('')
      .mockRejectedValueOnce(commandError({ stderr: 'StatusCode: 400\nData: {"message":"The workflow does not allow this transition"}' }))
    const fixed = ended(reported({ status: '已修复', verification: 'QA 通过' }))
    const result = await writeBack(input({ ticket: fixed }))
    expect(result.written).toBe(true)
    expect(result.status).toBeUndefined()
    expect(result.problem).toContain('The workflow refused the move to 29 for 62cf7f1d')
    expect(result.problem).toContain('The workflow does not allow this transition')
    expect(aliyun).toHaveBeenCalledTimes(2)
  })
  it('writes the comment alone when the ticket ended without a fix', async () => {
    const { aliyun, input } = setup()
    expect(await writeBack(input({ ticket: ended(reported({}, 'dropped')) }))).toEqual({ written: true })
    expect(aliyun).toHaveBeenCalledTimes(1)
    expect(argv(aliyun.mock.calls[0]!).at(-1)).toContain('无需修改')
  })
  it('writes the comment alone when the receiving rules no longer configure the category', async () => {
    const { aliyun, input } = setup()
    expect(await writeBack(input({ ticket: ended(reported({ status: '已修复', verification: 'QA 通过' })),
      meta: { workitemId: '123', category: 'Requirement', projectId: 'proj-1' } }))).toEqual({ written: true })
    expect(aliyun).toHaveBeenCalledTimes(1)
  })
  it('writes nothing for a ticket a person stopped', async () => {
    const { aliyun, input } = setup()
    const stopped = ticket({ ended: { at: '2026-11-02T11:00:00Z', by: 'human', outcome: 'stopped' },
      assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: reported({}, 'progress') }] })
    // A deliberate stop has no word among the five handlings, and 阻塞 would tell colleagues the work is blocked.
    expect(await writeBack(input({ ticket: stopped }))).toEqual({ written: false })
    expect(aliyun).not.toHaveBeenCalled()
  })
  it('writes nothing for a ticket that did not come from a work item', async () => {
    const { aliyun, input } = setup()
    expect(await writeBack(input({ meta: {} }))).toEqual({ written: false })
    expect(aliyun).not.toHaveBeenCalled()
  })
  it('settles with a problem when the work item no longer takes comments', async () => {
    const { aliyun, input } = setup()
    aliyun.mockRejectedValueOnce(new CliError('workitem not found', 404))
    const result = await writeBack(input())
    // Nothing will ever be written there, so the write-back settles instead of failing every poll.
    expect(result.written).toBe(false)
    expect(result.problem).toContain('The work item 123 no longer takes comments: workitem not found')
    expect(aliyun).toHaveBeenCalledTimes(1)
  })
  it('lets a temporary failure through so the caller retries the whole write-back', async () => {
    const { aliyun, input } = setup()
    aliyun.mockRejectedValueOnce(new CliError('InternalError', 500))
    await expect(writeBack(input())).rejects.toThrow('InternalError')
  })
})
