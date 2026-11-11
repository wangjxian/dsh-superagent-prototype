---
name: dsh-superagent-codeup
description: Deliver Yunxiao work items through development branches, QA branch integration, conflict resolution and real QA tests.
---

Deliver through Yunxiao Codeup with `aliyun devops`, as the account `$DSH_SUPERAGENT_YUNXIAO_ACCOUNT` of the organization `$DSH_SUPERAGENT_YUNXIAO_ORG`: every subcommand takes `--organization-id $DSH_SUPERAGENT_YUNXIAO_ORG`. The host gives the CLI its yunxiao token for the call, so never read, print or pass a token yourself, and never act as another account.

The workspace is `$DSH_SUPERAGENT_WORKSPACE`. Each involved repository has its own worktree at `$DSH_SUPERAGENT_DIR/<repository name>`. Inspect `git worktree list --porcelain` and the expected directory first. Reopen/retry reuses the existing ticket worktree and branch, preserving unfinished edits; never repeat `worktree add -b`. If the branch is occupied at an unexpected location, stop and report without moving or removing it. An existing unoccupied branch uses `worktree add <directory> <branch>`. Only a new branch uses -b from the assigned development base, normally origin/master or origin/main. Never branch development from QA. Keep operator checkouts unchanged.

For a Yunxiao work item, name development exactly `$DSH_SUPERAGENT_YUNXIAO_SERIAL`, for example `AXOAXO-6812`, without prefix/date/description. Only this work item's changes belong there: NEVER merge QA into development. The reserved `<serial>-qa` branch is QA-only and must never be delivered to master/release. Do not use old -to-release- work-item branches. Each commit names and links the work item and uses the configured author. Other-source tickets keep their bugfix/feat branches and legacy approvals.

Push only the serial or QA-only `<serial>-qa` branch. The pre-push hook rejects deletion and non-fast-forward updates, including force and force-with-lease. Do not bypass hooks. Hooks prevent accidents; Codeup branch protection is the security boundary for master/release. The trusted host uses explicit --no-verify for a normal non-force QA push; worker environment variables grant no host capability.

Reviewer attribution on Codeup never rewrites existing commits and never uses filter-branch or force-push. Add accurate attribution only to new substantive commits, then test and publish those commits again. If no code change is needed, record the reviewer credit in orchestrator_report without an empty commit. The shared GitHub history-rewriting procedure does not apply to Codeup.

## Yunxiao work items: fixed QA integration branch

Each project has one manually triggered QA pipeline whose YAML specifies a fixed non-trunk branch, for example release/qa. Source triggerEvents are refused before merging: ask for a manually triggered pipeline instead of disabling a project's triggers yourself. Preserve every existing branch and QA commit.

Codeup protection such as release/* may also cover release/qa. Direct mode needs the agent's push permission on that QA branch; otherwise use merge-request mode and satisfy native approvals. Do not broaden release permissions or bypass protection. If the configured target changes, prepare adopts it only after old builds/MRs are finished and reruns tests; follow its wait/close instructions when delivery is pending.

1. Identify all affected projects. Commit clean development worktrees and call orchestrator_qa_prepare with every {repository,pipeline_id,unit_test_command,merge_mode} plus qa_environment. merge_mode is direct by default or merge-request for native Codeup review. Use timeout_ms when tests need longer than the default ten minutes. All projects' local tests must pass before publication.
2. Push tested development commits, then integrate each project with the same complete repositories list. The host merges directly or through MR, preserves source branches and records the MR before trying to merge. Respect platform approvals; QA MR reviews return to the original ticket. Reconcile uncertain writes before retrying.
3. On conflict, KEEP DEVELOPMENT UNCHANGED. Create `<serial>-qa` FROM the tested development commit in `$DSH_SUPERAGENT_DIR/.qa/<repository name>`, or safely reuse that exact ticket worktree. Merge origin/<QA branch> ONLY there, resolve both sides and commit. Prepare all projects again with integration_branch: <serial>-qa for this project. The host tests development and candidate, verifies containment, then merges the candidate into QA. Never deliver the QA-only branch to master/release.
4. Follow every returned run until deployment succeeds. A newer QA head is allowed if it contains the tested development and QA-only commits. Do not republish solely because a colleague merged another change. Native checkout metadata must establish the actual built QA commit.
5. Run orchestrator_qa_test against the real shared QA environment. If a later shared build is deployed, pass deployments: [{repository,pipeline_id,run_id}] for those actual runs. The host verifies ancestry and sets DSH_QA_EXPECTED_PROJECTS to the actual build qaCommit plus our required development commit. Match deployed integration_commit/pipelineId/runId and exercise the main flow. A colleague's metadata.commit stamp need not equal our required commit. Never replace QA with a temporary mock.
6. Ready requires the recorded successful test of all affected projects; result.qa names the actual tested runs. The final comment is a concise summary with unit results, short QA commits, MR/pipeline links and environment; raw logs stay internal. Explicit non-fix statuses 无需修改/待确认/待验证/阻塞 record the conclusion without claiming a verified repair. Do not report QA MRs through legacy report.changes approvals.

## Other Codeup tickets

For a ticket without a Yunxiao work item, keep its existing MR delivery workflow. Before opening its MR, read `orchestrator_codeup_target`; report the MR with changes and request `orchestrator_request_merge`. Only the host merges after the approver confirms. Pipelines outside the allowed prefixes and PRE SQL still use the existing approval tools. Never run a production operation without its specific authorization.
