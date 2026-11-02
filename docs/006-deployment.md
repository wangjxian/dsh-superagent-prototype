# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent account on the hosting platform.** The agent comments, pushes branches and opens change requests as this account: a GitHub user account through a `gh` CLI signed in only as that account, or a yunxiao account through an `aliyun` wrapper holding a Codeup access token. Configure at least one; with both, the agent delivers to GitHub and the Codeup account only supplies the workspace variables.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later for GitHub, and the Aliyun CLI (`aliyun`) for Codeup. Source CLI fields must point to `gh`, `aliyun` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository the agent may push to: on github.com, or in the Codeup organization whose workspace you configure. GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Agent yunxiao (Codeup) account

1. Use a yunxiao account that may push to the repositories of the organization's workspace, and give it a personal access token with Codeup write access. dsh-superagent keeps that token in the macOS keychain and reads it only for the one `aliyun` process that needs it:

   ```sh
   security add-generic-password -s dsh-superagent-yunxiao -a <organization id> -w
   ```

   The command asks for the token and stores it under the organization's id; add `-U` to replace a token later.

2. Install the Aliyun CLI and give the agent a wrapper that reads that token:

   ```sh
   cat > ~/.local/bin/aliyun-agent <<'EOF'
   #!/bin/sh
   token=$(/usr/bin/security find-generic-password -s dsh-superagent-yunxiao -w) || exit 1
   ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN="$token" exec aliyun "$@"
   EOF
   chmod +x ~/.local/bin/aliyun-agent
   aliyun-agent devops base-get-user-by-token
   ```

   The last command prints the account the token belongs to, which is how setup reads it. The token never enters dsh-superagent's own environment: setup and the worker's forwarding script read the keychain entry inside the process that calls the CLI.

3. Add the operator's SSH key to Codeup under **个人设置 → SSH 公钥**. Workers push over SSH: the agent's git configuration rewrites `https://codeup.aliyun.com/` to `git@codeup.aliyun.com:`, and setup checks that the key is accepted.

4. Keep the clones in one workspace directory, an absolute path such as `/home/me/src/codeup`. Every repository in it whose remote is on `codeup.aliyun.com` may be delivered, and each repository a Ticket involves gets a worktree under the Ticket's directory.

The Codeup card then takes the wrapper, the organization id, that workspace and, optionally, the commit email. Phase one carries the account and the workspace only: requests still arrive from GitHub or Feishu, no work item starts a Ticket on Codeup, and the Aliyun CLI subcommands and their flags are gathered in `src/infra/yunxiao.ts` for calibration against a real organization: `--source-branch` and `--content` on the merge request calls, the pagination of `codeup-list-branches` and the commit count `codeup-get-compare` reports are the likeliest differences, and changing that one file is enough.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the git hooks in `worker-hooks`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Codeup, set the `aliyun` wrapper, the organization id and the workspace directory; with both GitHub and Codeup configured, the agent delivers to GitHub. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. The yunxiao Source takes the path of its receiving-rule file, which is described below.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   On Codeup the Ticket's branch comes from the Ticket's instructions, and the worktree is added from the checkout in the workspace:

   ```sh
   git -C "$DSH_SUPERAGENT_WORKSPACE/<repository>" worktree add -b "bugfix/<yymmdd>-<description>-$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" master
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the disclosure line, review bots, the commit author and the auto-merge condition, which applies to GitHub only.

### Yunxiao work items

The yunxiao Source turns work items assigned to the agent into Tickets. Its receiving rules live in one YAML file, `~/.config/dsh-superagent/yunxiao.yml` unless the Source's card names another path. The Source rereads the file before every poll: a file it cannot validate reports a health error and the last valid rules keep working, and a missing file leaves the Source paused until it is written. The file's digest is part of the Policy version, so changing it discards evaluations in flight.

```yaml
organization: "62cf7f0b487c500c27f70f94"   # must match the Codeup account's organization
workspace: "/home/me/src/codeup"           # the workspace the Codeup account delivers from
pollSeconds: 60

projects:
  - id: "451f7a12a18505b8a200ff1fd0"       # a project's id, which is also its row in the Policy
    intake: triage                          # triage or direct; phase two does not act on it yet
    types:
      - category: Bug                       # 缺陷、线上故障
        receive: ["28", "30"]               # 待确认、再次打开: statuses a Ticket may start in
        started: "100010"                   # 处理中
        verified: "29"                      # 已修复
      - category: Task                      # 任务
        receive: ["100005"]
        started: "100010"
        verified: "100014"
# A requirement (Req) is never received: it is read as the work item's related context.
release:                                    # read and validated; the host uses it from phase three
  pattern: "release/{yyyymmdd}"
  trunk: master
  timezone: Asia/Shanghai
  mergeType: ""
pipelines:
  allowPrefixes: ["qa-", "pre-"]
approver:
  feishuOpenId: ""
```

Statuses are ids, not names: they are shared across the organization and may be numbers or hexadecimal strings, so write every one of them as a string. The file holds no credential. Unknown keys and duplicate keys are refused, so a typo fails the validation instead of being ignored.

A poll searches each configured project for work items whose `gmtModified` moved since the last poll, in every receive status, and opens a Ticket for one assigned to the agent. A work item that was verified or closed and comes back to a receive status starts a new repair cycle, which opens a new Ticket. Comments of a work item with a live Ticket, or with a Ticket that still follows it, arrive as follow-ups; a comment the agent wrote carries a hidden marker and is skipped. Reassigning a work item away from the agent is recorded but does not stop its Ticket yet.

When a Ticket ends, the host writes one result comment on its work item — the state, the root cause, the changes and the verification evidence, never a statement's body — and moves the work item to the type's `verified` status when the work item is 已修复. A workflow that refuses that move keeps the comment and reports the refusal in the Source's health; a Ticket a person stopped writes nothing back.

### Merging a change request

A worker delivers a branch and its merge request; it never merges. Merging is the host's, and only after the approver confirms the target release in a Feishu direct message. The worker asks with `orchestrator_request_merge` once its work is self-reviewed, and the host:

1. Reads each merge request of the Ticket and checks the conditions: it is open, has no conflict, its CI passed, and no review comment waits for an answer. It computes the target release again with the same rule the worker used.
2. Sends one Feishu direct message listing every merge request, with the work item's serial and title, the merge request's link, the suggested release and why, the lines changed, the CI result and the commit's short SHA, and asks for an answer to that message.
3. Parses the answer itself, never through a model: `同意`, `合` or `ok` merges into the suggested release; `改 20261102` or `改 release/20261102` moves the delivery to that release; any other text is a rejection whose words go back to the worker as a note.
4. Before merging, checks that the answer came from the approver, answers that message, that the merge request's latest commit is the one the message named, and that the release has not merged back into the trunk since. One failed check means no merge, and the reason is answered in the same conversation.

A merged merge request does not end the Ticket: it keeps following it for its messages, and the Ticket ends with its own ready report once the work is verified. When the delivery has to move — because the previous release merged back before the merge, or because the approver named another release — the host tells the worker, which creates `<branch>-to-release-<date>` from its branch, merges the target release into it, resolves the conflicts, opens a new merge request and closes the old one; the new merge request is confirmed again.

The approver is `approver.feishuOpenId` in the receiving rules. When that is empty, the first direct message the approver sends the bot binds them, so a deployment can start without it. The confirmation message must be answered by replying to it: a direct message that answers nothing else is ordinary conversation.

### Deploying and verifying on PRE

After the host merges a change request it tells the Ticket so, and the worker deploys and verifies on PRE itself: it finds the environment's pipeline by name — a `qa-` one for QA and a `pre-` one for PRE, such as `pre-axo-manager-x64` — starts it, follows the run, and reads a failed task's log. A defect in the change is fixed and delivered again; an occasional failure is retried. `qa-` and `pre-` pipelines are the only ones a worker may start or retry: the forwarding script reads the pipeline's name first and refuses everything else, including `prod-` and `prod-pre-`, with a message that points at `orchestrator_request_pipeline`. That tool asks the approver in a Feishu direct message, and the host starts the pipeline itself when they agree.

Once PRE is deployed, the worker reproduces the original problem there and verifies the fix, then reports ready with the verification it ran. The host then moves the work item to its verified status, comments the result, and the Ticket ends. A verification that fails, or a person writing on the work item, in Feishu or on the merge request, brings the Ticket back to its worker.

A deployment that needs a statement run on PRE waits for the SQL approval of a later phase; a worker never runs SQL on PROD, and no pipeline of a PROD environment is started by anyone but a person.

### Statements on QA, PRE and PROD

A ticket that changes data carries its statements with the merge request, each with a title, the target database, whether it runs before or after the deployment, the statement, the statement that undoes it, and a read-only query answering 1 or 0 that shows whether it took effect. The result comment names the files only.

QA statements the worker runs itself and records. A PRE statement waits: the worker asks with `orchestrator_sql_approval`, the host sends the approver a Feishu direct message listing every statement in full with its target database, rollback and check query, and the worker runs them only after the approver agrees. The approval is bound to the statement's content and target: a changed statement needs a new approval, and the same statement runs once per target. A statement whose outcome is unclear, such as a timeout after it was sent, is not retried; the worker checks and reports, and a person decides. A PROD statement is never run by a worker, and no configuration makes it one.

The worker reads the environment's database credentials from 1Password itself; they are never in the receiving rules, the settings or a log. This confirmation is a convention held by the worker's instructions: a deployment that needs a hard boundary keeps the PRE credentials in a vault the worker cannot read.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `codeup` | The Codeup account: its CLI, the organization and the workspace. It receives nothing in phase one, so it reports no polling |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:codeup`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI. Codeup's has `cli`, `organization`, `workspace` and `commitEmail`; it receives nothing in phase one. Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the hosting accounts and the agent's push access: the GitHub repository, or the Codeup workspace's repositories, whose token it reads from the keychain. It writes the worker environment, and checks that git uses only the agent credentials for github.com, rewrites Codeup addresses to SSH, and runs the hooks dsh-superagent writes. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI where a GitHub account is configured; `aliyun` is a forwarding script where a Codeup account is configured; `lark-cli` runs the bot's CLI; `security` always fails, so no worker reads the keychain; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and Codeup HTTPS addresses to `git@codeup.aliyun.com:`, points `core.hooksPath` at `<stateDir>/worker-hooks`, and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.
- **Hooks** in `<stateDir>/worker-hooks`: the `pre-push` hook admits only `refs/heads/bugfix/*` and `refs/heads/feat/*` and refuses a branch deletion, so a worker cannot push a release branch; the other hooks run the repository's own hook of the same name, which `core.hooksPath` would otherwise hide.
- **The `aliyun` forwarding script** runs the real CLI only for what a worker needs: the read-only `base-get-user-by-token`, `codeup-get-*`, `codeup-list-*`, `projex-get-*`, `projex-list-*`, `projex-search-*`, `flow-get-*` and `flow-list-*`; a merge request whose source branch is `bugfix/` or `feat/`; and a merge request comment, to which it appends the hidden marker and the line saying an agent posted it. Merging, approving, deleting, branch protection, work-item writes, pipeline runs and application or package management are refused: the host performs them, or a later phase does. Phase one runs no pipeline.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

With only Codeup configured, requests arrive through Feishu: the worker pushes a `bugfix/` or `feat/` branch to the workspace repository, opens a merge request whose target release the host computes, and reports it; a person merges it on Codeup. No work item starts a Ticket in phase one, and the agent neither merges nor approves.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| `No code hosting account is configured: …` | Fill the GitHub card (repository and CLI) or the Codeup card (aliyun CLI, organization and workspace); one of them is required |
| `The Codeup Source names no aliyun CLI.` or `The aliyun CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The aliyun CLI cannot read its account` | The token does not belong to this organization, or it expired: add the current one to the keychain |
| `dsh-superagent cannot read the yunxiao access token from the keychain` | Add it with `security add-generic-password -s dsh-superagent-yunxiao -a <organization id> -w` |
| `The aliyun CLI did not report the yunxiao account.` | Run the wrapper's `devops base-get-user-by-token` by hand and check the token |
| `The Codeup Source names no organization.` or `… no workspace.` | Set the organization id and the workspace directory on the Codeup card |
| `… is not a directory.` on the Codeup card | Set the workspace to an absolute path that exists |
| `git@codeup.aliyun.com does not accept the operator's SSH key` | Add the key to Codeup under 个人设置 → SSH 公钥 |
| `No repository in … has a codeup.aliyun.com remote this account may push to` | Clone the repositories into the workspace, and give the yunxiao account push access |
| `The aliyun CLI could not read the repository …` | Check the repository id, and that the token may read it |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
