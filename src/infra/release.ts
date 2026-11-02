/**
 * The release branch a Codeup merge request targets: the previous day's release until it has merged back into the base
 * branch, then the day's own release, cut from the base branch when it is missing. The day is Asia/Shanghai's rather than the
 * host's local one, and the merge-back check reads commits rather than the clock, because releases merge back at no fixed
 * hour (one merged back at 18:04, another at 10:21).
 */
import { z } from 'zod'
import type { CodeupRepository } from '../deployment.ts'
import { YUNXIAO } from './yunxiao.ts'

/** The calendar a release day is named after: the organization's, never the host's own zone. */
const RELEASE_TIME_ZONE = 'Asia/Shanghai'
/** The branches releases are cut from and merge back into, in the order a repository's own branches decide between them. */
const BASE_BRANCHES: readonly string[] = ['master', 'main']
const RELEASE_BRANCH = /^release\/(\d{8})$/
const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: RELEASE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The Asia/Shanghai calendar day of `now` as `yyyymmdd`, the form a release branch is named after. */
export function releaseDay(now: Date = new Date()): string {
  const parts = Object.fromEntries(SHANGHAI_DAY.formatToParts(now).map(part => [part.type, part.value]))
  return `${parts.year}${parts.month}${parts.day}`
}
/** The release branch of a `yyyymmdd` day. */
export const releaseBranch = (day: string): string => `release/${day}`
/** The `yyyymmdd` day of a release branch name, or undefined for another branch. */
export const releaseBranchDay = (name: string): string | undefined => RELEASE_BRANCH.exec(name)?.[1]

/** The yunxiao calls the target-release rule makes; `Commands` supplies them through its `aliyun` method. */
export interface YunxiaoCaller { aliyun(argv: readonly string[]): Promise<string> }

const BranchName = z.union([z.string(), z.looseObject({ name: z.string() })])
const BranchReport = z.union([z.array(BranchName),
  z.looseObject({ result: z.array(BranchName).nullish(), branches: z.array(BranchName).nullish() })])
/** The JSON payload of a CLI report, which may follow a banner line the CLI prints first. */
function payload(text: string): unknown {
  const at = text.search(/[{\[]/)
  try { return JSON.parse(text.slice(Math.max(0, at))) } catch { throw new Error('The yunxiao CLI printed no JSON report') }
}
/**
 * Branch names of a `codeup-list-branches` report, by whichever shape the CLI prints: an array, or an object holding the
 * array under `result` or `branches`. The shape is a calibration point of a real installation, so both are read here.
 */
export function branchNames(text: string): string[] {
  const report = BranchReport.parse(payload(text))
  const entries = Array.isArray(report) ? report : report.result ?? report.branches
  if (!entries) throw new Error('The codeup-list-branches report names no branches')
  return entries.map(entry => typeof entry === 'string' ? entry : entry.name)
}
const CompareReport = z.looseObject({
  aheadBy: z.union([z.number(), z.string()]).nullish(),
  totalCommit: z.union([z.number(), z.string()]).nullish(),
  commits: z.array(z.unknown()).nullish(),
})
/**
 * How many commits `to` holds that `from` does not, from whichever count a `codeup-get-compare` report fills: the CLI's
 * explicit counts first, then the commit list it returned. Zero means `to` has merged back into `from`.
 * @throws Error when the report names no count, which a wrong flag or a changed API makes worth surfacing rather than guessing.
 */
export function aheadCount(text: string): number {
  const report = CompareReport.parse(payload(text))
  const counts = [report.aheadBy, report.totalCommit, report.commits?.length].map(value => typeof value === 'string' ? Number(value) : value)
  const count = counts.find((value): value is number => typeof value === 'number' && Number.isInteger(value))
  if (count === undefined) throw new Error('The codeup-get-compare report names no commit count')
  return count
}

/** The branch a change should target, and the evidence the rule used to say so. */
export interface TargetRelease {
  /** The branch a merge request targets, such as `release/20261101`. */
  target: string
  /** Which rule produced the target. */
  basis: 'previous' | 'today' | 'today-created' | 'requested'
  /** The previous release branch, when the repository has one. */
  previous?: string
  /** Whether the release the rule checked has merged back into the base branch: the previous one, or the one a caller named. */
  mergedBack: boolean
  /** The base branch releases are cut from: `master`, or `main` when the repository has no `master`. */
  base: string
  /** Commits that checked release holds that the base branch does not; absent when there is nothing to check. */
  ahead?: number
}
export interface TargetReleaseInput {
  organization: string
  repository: CodeupRepository
  caller: YunxiaoCaller
  /** The instant to compute the target at; Asia/Shanghai decides the day. */
  now?: Date
  /** A release branch a person or the work item named, which wins over the computed one and must exist. */
  requested?: string
}
/**
 * Computes the release branch a merge request of `repository` targets right now. A caller asks on every merge request rather
 * than reusing an earlier answer, because a release merges back at an hour the rule cannot predict.
 * @throws Error when a report cannot be read, or when a named release is not a branch of the repository.
 */
export async function targetRelease(input: TargetReleaseInput): Promise<TargetRelease> {
  const { organization, repository, caller } = input
  const day = releaseDay(input.now)
  const names = branchNames(await caller.aliyun(YUNXIAO.branches(organization, repository.id)))
  const base = BASE_BRANCHES.find(name => names.includes(name)) ?? BASE_BRANCHES[0]!
  const releases = names.filter(name => releaseBranchDay(name) !== undefined).sort((a, b) => a.localeCompare(b))
  // The previous release is the latest one dated before today; the day a release carries never changes after its creation.
  const previous = releases.filter(name => releaseBranchDay(name)! < day).at(-1)
  // A named release wins over the computed one, but only a branch that exists can be delivered to.
  if (input.requested !== undefined && !names.includes(input.requested)) {
    throw new Error(`${input.requested} is not a branch of ${repository.path}; a named release must exist`)
  }
  // Whichever release is in play, the compare says whether it has merged back, which is what makes it published.
  const checked = input.requested ?? previous
  const ahead = checked ? aheadCount(await caller.aliyun(YUNXIAO.compare(organization, repository.id, base, checked))) : undefined
  const mergedBack = ahead === 0
  const evidence = { ...(previous ? { previous } : {}), mergedBack, base, ...(ahead !== undefined ? { ahead } : {}) }
  if (input.requested !== undefined) return { target: input.requested, basis: 'requested', ...evidence }
  // A release that has not merged back is still unpublished, so it stays the target however late the day runs.
  if (previous && !mergedBack) return { target: previous, basis: 'previous', ...evidence }
  const today = releaseBranch(day)
  if (names.includes(today)) return { target: today, basis: 'today', ...evidence }
  // The host creates the branch it computed: a worker's CLI is restricted to pushes on bugfix/ and feat/ branches.
  await caller.aliyun(YUNXIAO.createBranch(organization, repository.id, today, base))
  return { target: today, basis: 'today-created', ...evidence }
}
