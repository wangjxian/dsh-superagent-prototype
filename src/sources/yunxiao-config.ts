/** The yunxiao work-item Source's receiving rules: the YAML file a deployment writes, its validation, and the lookups polling makes. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { key } from '../core/index.ts'

/** Where the receiving rules live when the Source's settings name no other path. */
export const DEFAULT_CONFIG_PATH = '~/.config/dsh-superagent/yunxiao.yml'

/**
 * The work-item categories this Source receives; a requirement (Req) is never received, only read as context of the
 * defect or task it belongs to.
 */
const CategorySchema = z.enum(['Bug', 'Task'])
/** A status id: yunxiao ids are all-organization, and some are numeric while others are hexadecimal, so all are strings. */
const StatusId = z.string().trim().min(1, 'A status id is a non-empty string')
const TypeSchema = z.object({
  category: CategorySchema,
  /** The statuses that mean "this work item is ready to be worked on"; being assigned in one of them is the request. */
  receive: z.array(StatusId).min(1, 'A category needs at least one receiving status'),
  /** The status a work item moves to once work starts. */
  started: StatusId,
  /** The status a fixed work item moves to once its fix is verified. */
  verified: StatusId,
}).strict()
export type YunxiaoType = z.infer<typeof TypeSchema>
const ProjectSchema = z.object({
  id: z.string().trim().min(1, 'A project id is a non-empty string'),
  /**
   * How the Source hands a received work item to the agent: `triage` lets the assessment decide whether anything needs a
   * person first, `direct` takes it as work at once. Phase two keeps it for the assessment to read.
   */
  intake: z.enum(['triage', 'direct']),
  types: z.array(TypeSchema).min(1, 'A project needs at least one category')
    .refine(types => new Set(types.map(type => type.category)).size === types.length, 'A category is listed once'),
}).strict()
export type YunxiaoProject = z.infer<typeof ProjectSchema>
/** Where a delivery goes: the release branch a ticket's merge request targets, and how it merges back to the trunk. */
const ReleaseSchema = z.object({
  pattern: z.string().trim().min(1).default('release/{yyyymmdd}'),
  /** The branch releases merge back into; empty takes the repository's default branch. */
  trunk: z.string().trim().default(''),
  timezone: z.string().trim().min(1).default('Asia/Shanghai'),
  mergeType: z.string().trim().default(''),
}).strict()
/** Which pipelines a worker may run; every other one needs a person's approval. */
const PipelinesSchema = z.object({ allowPrefixes: z.array(z.string().trim().min(1)).default(['qa-', 'pre-']) }).strict()
/** The person who confirms a merge request's target release in Feishu. */
const ApproverSchema = z.object({ feishuOpenId: z.string().trim().default('') }).strict()

/**
 * The receiving-rule file, validated strictly so a misspelled key fails loudly instead of silently receiving nothing.
 * `release`, `pipelines` and `approver` are not consumed in phase two, but they are validated here so a file written for a
 * later phase is already known to be well formed.
 */
export const YunxiaoFileSchema = z.object({
  /** The yunxiao organization every projex command runs in. */
  organization: z.string().trim().min(1, 'The organization id is a non-empty string'),
  /** The workspace a worker's repositories come from; the executor uses it, the Source only checks that it is named. */
  workspace: z.string().trim().min(1, 'The workspace is a non-empty string'),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  projects: z.array(ProjectSchema).min(1, 'The file needs at least one project')
    .refine(projects => new Set(projects.map(project => project.id)).size === projects.length, 'A project is listed once'),
  release: ReleaseSchema.default(() => ReleaseSchema.parse({})),
  pipelines: PipelinesSchema.default(() => PipelinesSchema.parse({})),
  approver: ApproverSchema.default(() => ApproverSchema.parse({})),
}).strict()
export type YunxiaoFile = z.infer<typeof YunxiaoFileSchema>

/**
 * The Source's own settings: the path of the receiving-rule file, and an optional interval that overrides the file's.
 * The rules themselves live in the file so a policy change does not have to travel through the panel.
 */
export const YunxiaoConfigSchema = z.object({
  configPath: z.string().trim().min(1).default(DEFAULT_CONFIG_PATH),
  pollSeconds: z.number().int().min(60).max(3600).optional(),
}).strict()
export type YunxiaoConfig = z.infer<typeof YunxiaoConfigSchema>

/**
 * A receiving-rule file that is not there yet. The Source waits for it rather than reporting a broken configuration, so an
 * installation that mounted this Source without writing the file is paused, not failing.
 */
export class MissingRulesError extends Error {}
/** Expands a leading `~` to the home directory, because the settings name the file that way by default. */
export function expandPath(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/**
 * Reads, parses, and validates the receiving rules.
 * `hash` covers the validated file rather than its text, so reformatting or reordering keys that mean nothing to the Source
 * does not read as a policy change; `key` namespaces it like every other hash.
 * @throws an error naming the resolved path and, for an invalid file, each field the schema rejected.
 */
export async function loadConfig(path: string): Promise<{ file: YunxiaoFile; hash: string }> {
  const resolved = expandPath(path)
  let text: string
  try { text = await readFile(resolved, 'utf8') }
  catch (error) {
    const message = `Cannot read the yunxiao receiving rules at ${resolved}: ${messageOf(error)}`
    throw error instanceof Error && 'code' in error && error.code === 'ENOENT' ? new MissingRulesError(message) : new Error(message)
  }
  let data: unknown
  try {
    // Duplicate keys are an error rather than last-one-wins: a project or status written twice is a mistake, not a choice.
    data = parse(text, { uniqueKeys: true })
  } catch (error) { throw new Error(`The yunxiao receiving rules at ${resolved} are not valid YAML: ${messageOf(error)}`) }
  const parsed = YunxiaoFileSchema.safeParse(data)
  if (!parsed.success) throw new Error(`The yunxiao receiving rules at ${resolved} are invalid:\n${z.prettifyError(parsed.error)}`)
  return { file: parsed.data, hash: key(JSON.stringify(parsed.data)) }
}
/** The receiving rule of one project, or undefined when the file does not configure it. */
export function projectOf(file: YunxiaoFile, id: string): YunxiaoProject | undefined {
  return file.projects.find(project => project.id === id)
}
/** The rule of one category within a project; a category the file does not list is not received there. */
export function typeOf(project: YunxiaoProject, category: string): YunxiaoType | undefined {
  return project.types.find(type => type.category === category)
}
/** Every receiving status of a project, deduplicated in file order: a work item in any of them is waiting to be worked on. */
export function receiveStates(project: YunxiaoProject): string[] {
  return [...new Set(project.types.flatMap(type => type.receive))]
}
