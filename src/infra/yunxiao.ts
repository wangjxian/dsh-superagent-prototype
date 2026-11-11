/**
 * The yunxiao (Aliyun DevOps) CLI vocabulary: the keychain entry its token lives in, the `aliyun devops` subcommands
 * dsh-superagent calls with their flags, and the error format the CLI prints. Flags are kebab-case forms of the OpenAPI
 * parameters and are gathered here so calibrating them against a real installation changes one file.
 *
 * The token never travels in a command's own environment: DSH removes credential-shaped variables from subprocesses, so
 * each call reads the keychain entry inside its own shell (`tokenCommand`) or forwarding script.
 */
import { escapeRegExp } from './text.ts'

/** Keychain generic-password service holding the yunxiao access token (`security add-generic-password -s <service> -a <organization> -w`). */
export const YUNXIAO_KEYCHAIN = 'dsh-superagent-yunxiao'
/** The variable the Aliyun CLI reads the yunxiao access token from. */
export const YUNXIAO_TOKEN_VARIABLE = 'ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN'
/** Absolute path of the macOS keychain tool, which workers cannot reach through PATH because it is blocked there. */
export const SECURITY = '/usr/bin/security'
/** Exit status of a shell that could not read the keychain entry, so setup can name that problem instead of a signed-out CLI. */
export const TOKEN_MISSING_STATUS = 78
/** Marker of the token failure message, which setup maps to its own problem code. */
export const TOKEN_MISSING = 'dsh-superagent: no yunxiao token in the keychain'
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
/**
 * The shell body that exports the token for one yunxiao process: setup runs it through its probe, and the workers' forwarding
 * script runs the same lines, so the token reaches neither dsh-superagent's environment nor a worker's.
 * @param security - the keychain tool, which tests stand in for; production uses the real one.
 */
export function tokenScript(service = YUNXIAO_KEYCHAIN, security = SECURITY): string {
  const missing = `${TOKEN_MISSING} (service ${service})`
  return `token=$(${security} find-generic-password -s ${shellQuote(service)} -w 2>/dev/null) || { echo ${shellQuote(missing)} >&2; exit ${TOKEN_MISSING_STATUS}; }; `
    + `[ -n "$token" ] || { echo ${shellQuote(missing)} >&2; exit ${TOKEN_MISSING_STATUS}; }; export ${YUNXIAO_TOKEN_VARIABLE}="$token"; `
}
/** A shell command that runs `cli` with `args` and the keychain token in its environment. */
export const tokenCommand = (cli: string, args: readonly string[]): string => `${tokenScript()}exec ${shellQuote(cli)} ${args.map(shellQuote).join(' ')}`
/** The argument list a probe or the forwarding script runs to call the yunxiao CLI with the token in place. */
export const tokenArgv = (cli: string, args: readonly string[]): string[] => ['sh', '-c', tokenCommand(cli, args)]

/** How many branches one `codeup-list-branches` page asks for: the CLI's largest page, as a repository keeps hundreds. */
export const BRANCH_PAGE_SIZE = 100
/** The merge type a merge request merges with when the receiving rules name none: a merge commit, Codeup's own default. */
export const DEFAULT_MERGE_TYPE = 'no-fast-forward'
/** The original comparison and line a reply to an inline review comment must retain. */
export interface InlineComment { filePath: string; lineNumber: number; fromPatchSet: string; toPatchSet: string }
/** Subcommands dsh-superagent calls, by purpose, with the flags this installation expects. */
export const YUNXIAO = {
  /** The account the token belongs to. */
  user: () => ['devops', 'base-get-user-by-token'],
  /** One repository, with the caller's permission on it; the API takes the full path URL-encoded in place of the id. */
  repository: (organization: string, path: string) =>
    ['devops', 'codeup-get-repository', '--organization-id', organization, '--repository-id', encodeURIComponent(path)],
  /** One page of a repository's branches, narrowed to the names containing `search` when it is given. */
  branches: (organization: string, repositoryId: string, page: number, search?: string) =>
    ['devops', 'codeup-list-branches', '--organization-id', organization, '--repository-id', repositoryId, '--page', String(page),
      '--per-page', String(BRANCH_PAGE_SIZE), ...search ? ['--search', search] : []],
  /** Creates a branch from another. */
  createBranch: (organization: string, repositoryId: string, branch: string, source: string) =>
    ['devops', 'codeup-create-branch', '--organization-id', organization, '--repository-id', repositoryId, '--branch', branch, '--ref', source],
  /** How many commits `to` is ahead of `from`; zero means `to` has merged back into `from`. */
  compare: (organization: string, repositoryId: string, from: string, to: string) =>
    ['devops', 'codeup-get-compare', '--organization-id', organization, '--repository-id', repositoryId, '--from', from, '--to', to],
  /** The latest merge requests merged in a repository, newest first, which shows whether a release ever received one. */
  mergedChangeRequests: (organization: string, repositoryId: string) =>
    ['devops', 'codeup-list-change-requests', '--organization-id', organization, '--project-ids', repositoryId, '--state', 'merged',
      '--order-by', 'updated_at', '--sort', 'desc', '--per-page', '100'],
  /** One merge request. */
  changeRequest: (organization: string, repositoryId: string, localId: number) =>
    ['devops', 'codeup-get-change-request', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId)],
  /** A merge request's patch sets: the latest `MERGE_SOURCE` one names its head commit and the id its CI checks are read by. */
  patchSets: (organization: string, repositoryId: string, localId: number) =>
    ['devops', 'codeup-list-change-request-patch-sets', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId)],
  /** One file's content of a repository at `ref`. */
  fileBlobs: (organization: string, repositoryId: string, path: string, ref: string) =>
    ['devops', 'codeup-get-file-blobs', '--organization-id', organization, '--repository-id', repositoryId, '--file-path', path, '--ref', ref],
  /** One page of one category's work items of a project matching `conditions`, a condition-group JSON string. */
  searchWorkitems: (organization: string, query: { category: string; spaceId: string; conditions: string; page: number; perPage: number }) =>
    ['devops', 'projex-search-workitems', '--organization-id', organization, '--category', query.category, '--space-id', query.spaceId,
      '--conditions', query.conditions, '--page', String(query.page), '--per-page', String(query.perPage), '--order-by', 'gmtModified', '--sort', 'asc'],
  /** One work item, with its description, status, assignee and category. */
  workitem: (organization: string, id: string) => ['devops', 'projex-get-workitem', '--organization-id', organization, '--id', id],
  /** Every comment of a work item in one report. */
  workitemComments: (organization: string, id: string) =>
    ['devops', 'projex-list-workitem-comments', '--organization-id', organization, '--id', id],
  /** Writes a comment as the agent account. */
  createWorkitemComment: (organization: string, id: string, content: string) =>
    ['devops', 'projex-create-workitem-comment', '--organization-id', organization, '--id', id, '--content', content],
  /** Changes fields of a work item; `status` is the only one dsh-superagent writes. */
  updateWorkitem: (organization: string, id: string, body: unknown) =>
    ['devops', 'projex-update-workitem', '--organization-id', organization, '--id', id, '--biz-body', JSON.stringify(body)],
  /** The work items related to one by `relationType`, such as `PARENT` or the `ASSOCIATED` requirement it serves. */
  workitemRelations: (organization: string, id: string, relationType: string) =>
    ['devops', 'projex-list-workitem-relation-records', '--organization-id', organization, '--id', id, '--relation-type', relationType],
  /** The workflow of a work item in its project: the statuses it may take, by id. */
  workitemWorkflow: (organization: string, id: string, projectId: string) =>
    ['devops', 'projex-get-workitem-workflow', '--organization-id', organization, '--id', id, '--project-id', projectId],
  /** The activity log of a work item, which names who changed it. */
  workitemActivities: (organization: string, id: string) =>
    ['devops', 'projex-list-workitem-activities', '--organization-id', organization, '--id', id],
  /** Opens a merge request. */
  createChangeRequest: (organization: string, repositoryId: string) =>
    ['devops', 'codeup-create-change-request', '--organization-id', organization, '--repository-id', repositoryId],
  qaChangeRequest: (organization: string, repositoryId: string, source: string, target: string) =>
    ['devops', 'codeup-create-change-request', '--organization-id', organization, '--repository-id', repositoryId,
      '--source-project-id', repositoryId, '--target-project-id', repositoryId, '--source-branch', source, '--target-branch', target,
      '--title', `${source} → ${target} QA integration`],
  openChangeRequests: (organization: string, repositoryId: string, page: number) =>
    ['devops', 'codeup-list-change-requests', '--organization-id', organization, '--project-ids', repositoryId,
      '--state', 'opened', '--page', String(page), '--per-page', '100'],
  mergeQaChangeRequest: (organization: string, repositoryId: string, localId: number) =>
    ['devops', 'codeup-merge-change-request', '--organization-id', organization, '--repository-id', repositoryId,
      '--local-id', String(localId), '--merge-type', 'no-fast-forward', '--remove-source-branch', 'false'],
  /** Writes a comment on a merge request. */
  createChangeRequestComment: (organization: string, repositoryId: string, localId: number, patchSet: string, content: string, parent?: string, inline?: InlineComment) =>
    ['devops', 'codeup-create-change-request-comment', '--organization-id', organization, '--repository-id', repositoryId,
      '--local-id', String(localId), '--comment-type', inline ? 'INLINE_COMMENT' : 'GLOBAL_COMMENT', '--draft', 'false', '--resolved', 'false',
      '--patchset-biz-id', patchSet, '--content', content, ...parent ? ['--parent-comment-biz-id', parent] : [],
      ...inline ? ['--file-path', inline.filePath, '--line-number', String(inline.lineNumber),
        '--from-patchset-biz-id', inline.fromPatchSet, '--to-patchset-biz-id', inline.toPatchSet] : []],
  /** Every comment of a merge request in one report. */
  changeRequestComments: (organization: string, repositoryId: string, localId: number) =>
    ['devops', 'codeup-list-merge-request-comments', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId)],
  /** The CI checks of one patch set of a merge request, which `patchSets` names. */
  changeRequestChecks: (organization: string, repositoryId: string, localId: number, patchSet: string) =>
    ['devops', 'codeup-list-change-request-ci-check-list', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId),
      '--patch-set-biz-id', patchSet],
  /** Merges a merge request; the host runs it alone, after a person confirmed the target release. */
  mergeChangeRequest: (organization: string, repositoryId: string, localId: number, mergeType: string) =>
    ['devops', 'codeup-merge-change-request', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId),
      '--merge-type', mergeType],
  /** Closes a merge request without merging; the host closes the one a retarget replaced, once its replacement merged. */
  closeChangeRequest: (organization: string, repositoryId: string, localId: number) =>
    ['devops', 'codeup-close-change-request', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId)],
  /** The pipelines of the organization, which a worker searches by name for the environment it deploys to. */
  pipelines: (organization: string) => ['devops', 'flow-list-pipelines', '--organization-id', organization],
  /** One pipeline, with the name whose prefix decides whether a worker may run it. */
  pipeline: (organization: string, pipelineId: string) =>
    ['devops', 'flow-get-pipeline', '--organization-id', organization, '--pipeline-id', pipelineId],
  /** The runs of a pipeline, newest first, which is how a worker finds the run its change started. */
  pipelineRuns: (organization: string, pipelineId: string, status?: 'RUNNING') =>
    ['devops', 'flow-list-pipeline-runs', '--organization-id', organization, '--pipeline-id', pipelineId,
      ...status ? ['--status', status, '--per-page', '1'] : []],
  latestPipelineRun: (organization: string, pipelineId: string) =>
    ['devops', 'flow-get-latest-pipeline-run', '--organization-id', organization, '--pipeline-id', pipelineId],
  /** One run with its jobs and their states. */
  pipelineRun: (organization: string, pipelineId: string, runId: string) =>
    ['devops', 'flow-get-pipeline-run', '--organization-id', organization, '--pipeline-id', pipelineId, '--pipeline-run-id', runId],
  /** A run's task log, which tells a code failure from an occasional one. */
  pipelineJobLog: (organization: string, pipelineId: string, runId: string, jobId: string) =>
    ['devops', 'flow-get-pipeline-job-run-log', '--organization-id', organization, '--pipeline-id', pipelineId, '--pipeline-run-id', runId, '--job-id', jobId],
  /** Starts a run of a pipeline. */
  createPipelineRun: (organization: string, pipelineId: string, params?: Record<string, unknown>) =>
    ['devops', 'flow-create-pipeline-run', '--organization-id', organization, '--pipeline-id', pipelineId,
      ...params ? ['--params', JSON.stringify(params)] : []],
  /** Retries a failed task of a run. */
  retryPipelineJob: (organization: string, pipelineId: string, runId: string, jobId: string) =>
    ['devops', 'flow-retry-pipeline-job-run', '--organization-id', organization, '--pipeline-id', pipelineId, '--pipeline-run-id', runId, '--job-id', jobId],
  /** Reruns a task of a run from the start. */
  rerunPipelineJob: (organization: string, pipelineId: string, runId: string, jobId: string) =>
    ['devops', 'flow-rerun-pipeline-job-run', '--organization-id', organization, '--pipeline-id', pipelineId, '--pipeline-run-id', runId, '--job-id', jobId],
  /** Changes a merge request's title or description; Codeup cannot move one to another target branch. */
  updateChangeRequest: (organization: string, repositoryId: string, localId: number, fields: { title?: string; description?: string }) =>
    ['devops', 'codeup-update-change-request', '--organization-id', organization, '--repository-id', repositoryId, '--local-id', String(localId),
      ...fields.title !== undefined ? ['--title', fields.title] : [], ...fields.description !== undefined ? ['--description', fields.description] : []],
} as const
/** Subcommands that only read, as shell globs: `Commands.aliyun` retries them, and the workers' forwarding script lets them through. */
export const READ_ONLY_GLOBS: readonly string[] = ['base-get-*', 'codeup-get-*', 'codeup-list-*', 'projex-get-*', 'projex-list-*',
  'projex-search-*', 'flow-get-*', 'flow-list-*']
/** The same rule as a matcher for a subcommand name, so the two lists cannot drift apart. */
export const READ_ONLY: readonly RegExp[] = READ_ONLY_GLOBS.map(glob => new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`))
/** Whether `command` (the subcommand after `devops`) only reads. */
export const readOnly = (command: string): boolean => READ_ONLY.some(pattern => pattern.test(command))

/**
 * The flag naming a merge request's source branch, which the workers' forwarding script inspects before admitting the call:
 * a worker may only deliver a bugfix/ or feat/ branch, never a release.
 */
export const SOURCE_BRANCH_FLAG = '--source-branch'
/** The flag carrying a merge request comment's body, to which the forwarding script appends `AGENT_COMMENT`. */
export const COMMENT_FLAG = '--content'
/**
 * Appended to a merge request comment a worker writes: a hidden marker the work-item Source of a later phase can scan for, and a
 * visible line telling readers an agent posted it. The visible line is user-facing copy, so it follows the language the team
 * writes merge requests in, like the localized strings of a Source.
 */
export const AGENT_COMMENT = '<!-- dsh-superagent:agent -->\n由智能体代发'

const STATUS = /StatusCode:\s*(\d{3})/i
const DATA = /Data:\s*(\{[\s\S]*)$/
/**
 * Reads the CLI's error report (`StatusCode: 404 … Data: {"message":"…"}`) into a code and message, or returns undefined for
 * output that is not one, which the caller reports as it is.
 */
export function yunxiaoError(stderr: string): { code?: number; message: string } | undefined {
  const status = STATUS.exec(stderr)?.[1]
  const data = DATA.exec(stderr)?.[1]
  let message: string | undefined
  if (data) {
    try {
      const parsed = JSON.parse(data) as { message?: unknown; Message?: unknown; code?: unknown; Code?: unknown }
      const text = parsed.message ?? parsed.Message
      if (typeof text === 'string' && text) message = text
      const code = parsed.code ?? parsed.Code
      if (message && typeof code === 'string' && code) message = `${message} (${code})`
    } catch { /* The report continues without a parsed message. */ }
  }
  if (!status && !message) return undefined
  return { ...status ? { code: Number(status) } : {}, message: message ?? stderr.trim().slice(0, 2000) }
}
