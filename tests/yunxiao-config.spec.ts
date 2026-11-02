/** The yunxiao receiving rules: strict YAML validation, the defaults of blocks phase two does not consume, the Policy hash, and the lookups polling makes. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { DEFAULT_CONFIG_PATH, expandPath, loadConfig, MissingRulesError, projectOf, receiveStates, typeOf, YunxiaoFileSchema,
  type YunxiaoFile } from '../src/sources/yunxiao-config.ts'

/** The file the deployment writes, as the design's example renders it. */
const RULES = `organization: "org-1"
workspace: "/tmp/workspace"
pollSeconds: 120
projects:
  - id: "proj-1"
    intake: triage
    types:
      - category: Bug
        receive: ["28", "30"]
        started: "100010"
        verified: "29"
      - category: Task
        receive: ["100005"]
        started: "100010"
        verified: "100014"
release:
  pattern: "release/{yyyymmdd}"
  trunk: master
  timezone: Asia/Shanghai
  mergeType: squash
pipelines:
  allowPrefixes: ["qa-", "pre-"]
approver:
  feishuOpenId: ou_approver
`
/** The same rules with another key order, a comment, and a different quoting style: a policy-neutral edit. */
const REORDERED = `# the same rules, written differently
workspace: /tmp/workspace
organization: org-1
pollSeconds: 120
approver:
  feishuOpenId: ou_approver
pipelines:
  allowPrefixes: [qa-, pre-]
release:
  mergeType: squash
  timezone: Asia/Shanghai
  trunk: master
  pattern: release/{yyyymmdd}
projects:
  - intake: triage
    id: proj-1
    types:
      - category: Bug
        receive: ["28", "30"]
        started: "100010"
        verified: "29"
      - category: Task
        receive: ["100005"]
        started: "100010"
        verified: "100014"
`
const dirs: string[] = []
/** Writes `text` to a fresh temporary file and returns its path. */
function tempFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yunxiao-config-'))
  dirs.push(dir)
  const path = join(dir, 'yunxiao.yml')
  writeFileSync(path, text)
  return path
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('yunxiao receiving rules', () => {
  it('reads the rules, and fills the defaults of the blocks a later phase consumes', async () => {
    const { file, hash } = await loadConfig(tempFile(RULES))
    expect(file).toEqual({
      organization: 'org-1', workspace: '/tmp/workspace', pollSeconds: 120,
      projects: [
        { id: 'proj-1', intake: 'triage', types: [
          { category: 'Bug', receive: ['28', '30'], started: '100010', verified: '29' },
          { category: 'Task', receive: ['100005'], started: '100010', verified: '100014' },
        ] },
      ],
      release: { pattern: 'release/{yyyymmdd}', trunk: 'master', timezone: 'Asia/Shanghai', mergeType: 'squash' },
      pipelines: { allowPrefixes: ['qa-', 'pre-'] }, approver: { feishuOpenId: 'ou_approver' },
    })
    expect(hash).toBe(key(JSON.stringify(file)))
    // A file that names only what phase two reads still validates, with the other blocks defaulted rather than required.
    const minimal = YunxiaoFileSchema.parse({ organization: 'org-1', workspace: '/tmp/workspace',
      projects: [{ id: 'proj-1', intake: 'direct', types: [{ category: 'Bug', receive: ['28'], started: '100010', verified: '29' }] }] })
    expect(minimal).toMatchObject({ pollSeconds: 60, release: { pattern: 'release/{yyyymmdd}', trunk: 'master', timezone: 'Asia/Shanghai', mergeType: '' },
      pipelines: { allowPrefixes: ['qa-', 'pre-'] }, approver: { feishuOpenId: '' } })
  })
  it('hashes the validated file, so a reformat or a reordered key is not a policy change and a changed status is', async () => {
    const first = await loadConfig(tempFile(RULES))
    const reordered = await loadConfig(tempFile(REORDERED))
    expect(reordered.file).toEqual(first.file)
    expect(reordered.hash).toBe(first.hash)
    const changed = await loadConfig(tempFile(RULES.replace('receive: ["28", "30"]', 'receive: ["28"]')))
    expect(changed.hash).not.toBe(first.hash)
  })
  it('rejects an unknown key, naming the field, so a misspelled rule cannot silently receive nothing', async () => {
    const path = tempFile(RULES.replace('    intake: triage', '    intak: triage'))
    await expect(loadConfig(path)).rejects.toThrow(/invalid/)
    const message = await loadConfig(path).catch((error: unknown) => String(error))
    expect(message).toContain('intak')
    expect(message).toContain('projects[0]')
  })
  it('rejects a file without a project, a duplicated project, a duplicated category, and an empty receiving list', async () => {
    const base = { organization: 'org-1', workspace: '/tmp/workspace' }
    const type = { category: 'Bug', receive: ['28'], started: '100010', verified: '29' }
    const reject = (file: Record<string, unknown>, pattern: RegExp) => expect(() => YunxiaoFileSchema.parse(file)).toThrow(pattern)
    reject(base, /projects/)
    reject({ ...base, projects: [] }, /at least one project/)
    reject({ ...base, projects: [{ id: 'proj-1', intake: 'triage', types: [type] }, { id: 'proj-1', intake: 'triage', types: [type] }] },
      /A project is listed once/)
    reject({ ...base, projects: [{ id: 'proj-1', intake: 'triage', types: [type, { ...type, verified: '30' }] }] }, /A category is listed once/)
    reject({ ...base, projects: [{ id: 'proj-1', intake: 'triage', types: [{ ...type, receive: [] }] }] }, /at least one receiving status/)
    reject({ ...base, projects: [{ id: 'proj-1', intake: 'sometimes', types: [type] }] }, /intake/)
  })
  it('expands a leading ~ to the home directory and leaves any other path alone', () => {
    expect(DEFAULT_CONFIG_PATH).toBe('~/.config/dsh-superagent/yunxiao.yml')
    expect(expandPath('~/x.yml')).toBe(join(homedir(), 'x.yml'))
    expect(expandPath('~')).toBe(homedir())
    expect(expandPath('/etc/yunxiao.yml')).toBe('/etc/yunxiao.yml')
    expect(expandPath('relative/yunxiao.yml')).toBe('relative/yunxiao.yml')
  })
  it('reports a file that is not there yet as missing, and one that is not YAML as invalid, both naming the resolved path', async () => {
    const missing = join(homedir(), 'dsh-superagent-no-such-directory', 'yunxiao.yml')
    await expect(loadConfig('~/dsh-superagent-no-such-directory/yunxiao.yml')).rejects.toBeInstanceOf(MissingRulesError)
    await expect(loadConfig('~/dsh-superagent-no-such-directory/yunxiao.yml')).rejects.toThrow(missing)
    const broken = tempFile('organization: [unclosed\n')
    await expect(loadConfig(broken)).rejects.toThrow(/not valid YAML/)
    await expect(loadConfig(broken)).rejects.toThrow(broken)
    // A file that parses but is not the rules shape is a validation error, not a YAML one.
    await expect(loadConfig(tempFile('just a string\n'))).rejects.toThrow(/invalid/)
  })
  it('looks up a project, its categories, and every receiving status of the project', async () => {
    const { file } = await loadConfig(tempFile(RULES))
    const project = projectOf(file, 'proj-1')
    expect(project?.intake).toBe('triage')
    expect(projectOf(file, 'proj-2')).toBeUndefined()
    expect(typeOf(project!, 'Bug')?.verified).toBe('29')
    expect(typeOf(project!, 'Task')?.started).toBe('100010')
    expect(typeOf(project!, 'Req')).toBeUndefined()
    // Both categories are received, in file order and without duplicates.
    expect(receiveStates(project!)).toEqual(['28', '30', '100005'])
    const shared: YunxiaoFile = { ...file, projects: [{ ...project!, types: [{ ...typeOf(project!, 'Bug')!, receive: ['28', '28'] }] }] }
    expect(receiveStates(shared.projects[0]!)).toEqual(['28'])
  })
})
