# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; aliyun --version; dsh --version
gh api user --jq .login
security find-generic-password -s dsh-superagent-yunxiao >/dev/null 2>&1 && echo yunxiao-token-present
ls "${XDG_CONFIG_HOME:-$HOME/.config}"/dsh-superagent/yunxiao.yml 2>/dev/null && echo yunxiao-rules-present
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, GitHub CLI 2.48+ for GitHub, the Aliyun CLI for Codeup, and DSH within the `engines.dsh` range of `package.json`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** the `gh api user` result is the operator's own GitHub login, used as the recommendation in question 6.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Hosting platform.** Where does the code live: GitHub, Yunxiao Codeup, or both? [GitHub, unless the team delivers to Codeup.] With both, the agent delivers to GitHub and the Codeup account only supplies the workspace. Phase one takes requests from GitHub or Feishu either way: no Codeup work item starts a Ticket yet.
2. **Repository.** On GitHub: which github.com repository should the agent work on, as `owner/name`? On Codeup: which yunxiao organization, and which absolute workspace directory holds the clones the agent may deliver from?
3. **Agent account.** Which account will the agent act as: a GitHub user account, or a yunxiao account with a Codeup access token? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step.
4. **Requests.** Should the agent take requests from GitHub only, or also from Feishu chats? [GitHub only, unless the team works in Feishu.]
5. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.
6. With Codeup: **which work items should it take?** Which projects (by name), and for each, which categories — a defect (缺陷) or a task (任务) — in which statuses it should start work, and which statuses mean 处理中 and 已修复 or 已完成. [The projects where the team already assigns work to the agent account, defects in 待确认 and 再次打开, tasks in 待处理; 处理中 for both; 已修复 for a defect and 已完成 for a task.] Read the ids with `aliyun-agent devops projex-get-workitem-workflow`, and write them into the rules file below.

**Policy: who may ask for work.**

7. **On GitHub.** Which GitHub logins may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
8. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

9. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
10. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
11. **Auto-merge.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/` on GitHub, and `bugfix/` for a defect or `feat/` for a task on Codeup;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitation as the agent account, run `auth login` for each wrapper, and for Feishu create and publish the bot app and run the `config init` command with its secret. On Codeup, the operator also adds the Codeup access token to the keychain with the `security add-generic-password` command of that section, and the operator's SSH key to Codeup. Wait until the operator says it is done, then check each login with `<wrapper> api user --jq .login`, and on Codeup with `aliyun-agent devops base-get-user-by-token`.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. Clone the repository of question 2 if question 8 asked for a new clone. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the `github` Source or the `codeup` Source (both, if the team uses both), the `feishu` Source if used, the `policy` block with the allowed lists (for Feishu, look up the chat ids with the bot's CLI first), and the `executor` block with a prepare command from the answer to question 9. With Codeup, also write the yunxiao rules file from the answer to question 6 — `~/.config/dsh-superagent/yunxiao.yml` as the Yunxiao work items section of `docs/006-deployment.md` shows, its organization matching the Codeup account's — and save the `yunxiao` Source with that path, whose Policy section then lists one row per project. Then save the prompts with the commit identity of question 9 and the auto-merge answer of question 10 in Delivery requirements. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`. The yunxiao subcommands and their flags are gathered in `src/infra/yunxiao.ts`; a first run against a real organization may need to calibrate one against the CLI's own help, and only that file changes. The likeliest differences are `--source-branch` and `--content` on the merge request calls, the pagination of `codeup-list-branches`, and the commit count `codeup-get-compare` reports.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository, or mention the bot in a Feishu chat when Codeup is the only hosting platform. A Ticket appears on the overview within about a minute. With the yunxiao Source, assign a work item of a configured project and status to the agent account instead: the Ticket starts from it, its comments reach the Ticket, and when the Ticket ends the agent comments the result on the work item and moves it to 已修复 or 已完成. On Codeup the worker pushes a `bugfix/` or `feat/` branch and opens a merge request against the release the host computes; the host merges it once the approver confirms that release in Feishu, and the worker then deploys to PRE through the `pre-` pipeline, verifies the fix there and reports ready, which ends the Ticket and moves the work item to 已修复 or 已完成. A pipeline whose name is not `qa-` or `pre-` needs the approver's confirmation through `orchestrator_request_pipeline`, and no `prod-` pipeline is ever a worker's.
- Approvals: when a worker asks the host to merge, the agent sends the approver a Feishu direct message naming the merge request and the target release. Answer it by replying to that message: `同意` merges, `改 20260801` moves the delivery to that release, and any other words are a rejection the worker reads. Fill `approver.feishuOpenId` in the receiving rules, or send the bot one direct message first, which binds that account as the approver.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
