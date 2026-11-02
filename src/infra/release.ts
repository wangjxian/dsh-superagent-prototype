/**
 * The release branch a Codeup merge request targets: the previous day's release until it has merged back into the base
 * branch, then the day's own release, cut from the base branch when it is missing. The day is Asia/Shanghai's rather than the
 * host's local one, and the merge-back check reads commits rather than the clock, because releases merge back at no fixed
 * hour (one merged back at 18:04, another at 10:21).
 */
import { z } from 'zod'
import type { CodeupRepository } from '../deployment.ts'
import { escapeRegExp } from './text.ts'
import { BRANCH_PAGE_SIZE, YUNXIAO } from './yunxiao.ts'

/** Where a delivery goes, as the receiving rules state it; the defaults are the team's convention. */
export interface ReleaseRules { pattern: string; trunk: string; timezone: string; mergeType: string }
export const DEFAULT_RELEASE: ReleaseRules = { pattern: 'release/{yyyymmdd}', trunk: '', timezone: 'Asia/Shanghai', mergeType: '' }
/** The branch releases are cut from when neither the rules nor the repository name one. */
const FALLBACK_TRUNK = 'master'
/** How many pages of release branches a target computation reads, so a listing that never ends cannot spin. */
const MAX_BRANCH_PAGES = 20
const PLACEHOLDER = '{yyyymmdd}'
/** The day formatters, one per zone the rules name, so a round with many merge requests formats a day once. */
const DAY_FORMAT = new Map<string, Intl.DateTimeFormat>()
const dayFormat = (timezone: string): Intl.DateTimeFormat => {
  const existing = DAY_FORMAT.get(timezone)
  if (existing) return existing
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  DAY_FORMAT.set(timezone, format)
  return format
}
/** The branch pattern as a matcher, the placeholder becoming the day's capture group. */
const branchMatcher = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split(PLACEHOLDER).map(part => escapeRegExp(part)).join('(\\d{8})')}$`)

/** The calendar day of `now` in the rules' zone as `yyyymmdd`, the form a release branch is named after. */
export function releaseDay(now: Date = new Date(), rules: ReleaseRules = DEFAULT_RELEASE): string {
  const parts = Object.fromEntries(dayFormat(rules.timezone).formatToParts(now).map(part => [part.type, part.value]))
  return `${parts.year}${parts.month}${parts.day}`
}
/** The release branch of a `yyyymmdd` day. */
export const releaseBranch = (day: string, rules: ReleaseRules = DEFAULT_RELEASE): string => rules.pattern.replace(PLACEHOLDER, day)
/** The `yyyymmdd` day of a release branch name, or undefined for another branch. */
export const releaseBranchDay = (name: string, rules: ReleaseRules = DEFAULT_RELEASE): string | undefined => branchMatcher(rules.pattern).exec(name)?.[1]

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
const MergedReport = z.union([z.array(z.looseObject({ targetBranch: z.string().nullish() })),
  z.looseObject({ result: z.array(z.looseObject({ targetBranch: z.string().nullish() })).nullish() })])
/** The target branches of a `codeup-list-change-requests` report of merged merge requests. */
export function mergedTargets(text: string): string[] {
  const report = MergedReport.parse(payload(text))
  return (Array.isArray(report) ? report : report.result ?? []).flatMap(item => item.targetBranch ? [item.targetBranch] : [])
}
/** The prefix a branch search is narrowed by: whatever the pattern puts before the day, such as `release/`. */
export const releaseSearch = (rules: ReleaseRules = DEFAULT_RELEASE): string => rules.pattern.split(PLACEHOLDER)[0] ?? ''
/** Every release branch of a repository, read page by page: a repository keeps more branches than one page holds. */
async function releaseBranches(caller: YunxiaoCaller, organization: string, repositoryId: string, rules: ReleaseRules): Promise<string[]> {
  const names: string[] = []
  const search = releaseSearch(rules)
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const found = branchNames(await caller.aliyun(YUNXIAO.branches(organization, repositoryId, page, search)))
    names.push(...found)
    if (found.length < BRANCH_PAGE_SIZE) break
  }
  return names
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
  /**
   * Whether the release the rule checked has merged back into the base branch: the previous one, or the one a caller named.
   * Nothing ahead of the base is not enough, as a release nothing merged into yet holds nothing either; it must also have
   * received a merge request.
   */
  mergedBack: boolean
  /** The base branch releases are cut from: the repository's default branch, else `master`. */
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
  /** The receiving rules' release section: branch pattern, trunk and zone. Defaults to the team's convention. */
  release?: ReleaseRules
  /**
   * Whether the host may create the day's release when it is missing. A caller that only asks where a delivery should go
   * passes false: creating a branch is a change nothing asked for, and the merge that needs it creates it.
   */
  create?: boolean
}
/**
 * Computes the release branch a merge request of `repository` targets right now. A caller asks on every merge request rather
 * than reusing an earlier answer, because a release merges back at an hour the rule cannot predict.
 * @throws Error when a report cannot be read, or when a named release is not a branch of the repository.
 */
export async function targetRelease(input: TargetReleaseInput): Promise<TargetRelease> {
  const { organization, repository, caller } = input
  const rules = input.release ?? DEFAULT_RELEASE
  const day = releaseDay(input.now, rules)
  const names = await releaseBranches(caller, organization, repository.id, rules)
  // A trunk the rules name wins over the repository's default branch, which is what a second trunk is configured for.
  const base = rules.trunk || repository.defaultBranch || FALLBACK_TRUNK
  const releases = names.filter(name => releaseBranchDay(name, rules) !== undefined).sort((a, b) => a.localeCompare(b))
  // The previous release is the latest one dated before today; the day a release carries never changes after its creation.
  const previous = releases.filter(name => releaseBranchDay(name, rules)! < day).at(-1)
  // A named release wins over the computed one, but only a branch that exists can be delivered to.
  if (input.requested !== undefined && !names.includes(input.requested)) {
    throw new Error(`${input.requested} is not a branch of ${repository.path}; a named release must exist`)
  }
  // Whichever release is in play, the compare says whether it has merged back, which is what makes it published.
  const checked = input.requested ?? previous
  const ahead = checked ? aheadCount(await caller.aliyun(YUNXIAO.compare(organization, repository.id, base, checked))) : undefined
  const mergedBack = ahead === 0 && mergedTargets(await caller.aliyun(YUNXIAO.mergedChangeRequests(organization, repository.id))).includes(checked!)
  const evidence = { ...(previous ? { previous } : {}), mergedBack, base, ...(ahead !== undefined ? { ahead } : {}) }
  if (input.requested !== undefined) return { target: input.requested, basis: 'requested', ...evidence }
  // A release that has not merged back is still unpublished, so it stays the target however late the day runs.
  if (previous && !mergedBack) return { target: previous, basis: 'previous', ...evidence }
  const today = releaseBranch(day, rules)
  if (names.includes(today)) return { target: today, basis: 'today', ...evidence }
  // A read-only caller is told where the delivery would go; the merge that needs the branch creates it.
  if (input.create === false) return { target: today, basis: 'today', ...evidence }
  // The host creates the branch it computed: a worker's CLI is restricted to pushes on bugfix/ and feat/ branches.
  await caller.aliyun(YUNXIAO.createBranch(organization, repository.id, today, base))
  return { target: today, basis: 'today-created', ...evidence }
}
