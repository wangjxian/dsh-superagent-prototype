# 云效沙箱实测结果（更新于 2026-11-03）

**当前状态：新工作项 SIQB-5 已完成真实双工程联测并自动回写“已修复”。前端 MR、后端 direct 各真实触发一次冲突，仅在 SIQB-5-qa 解决；两个开发分支均保持单个本工单提交。旧 MR !4 已 CLOSED，替代 !5 已 MERGED；两流水线仅新增 #9/#7，重试及服务重启后仍复用原运行。本机常驻 QA 按实际构建提交部署，前后端 HTTP 主流程通过，最终评论显示仓库名。最新完整检查74文件、1562用例、类型检查和构建通过。累计改动随本轮 feat/yunxiao-integration 本地提交保存，原型分支不推送。旧 SIQB-4 污染历史仍保留，不能直接发版。**

执行范围：云端仅 `test-agent`、`test-agent-service` 两个沙箱仓库和项目 `ef26d3d0f9c77de54a9a1c5105`。本仓库累计代码、测试及文档本地提交，不推送；不做可选 SQL 阶段。

以下按日期保留历史记录。旧 release/MR/PRE 或 Flow branchMode 结果不代表当前固定 QA 分支流程，最新结果见文末。

| 阶段/步骤 | 结果 | 证据 | 发现的问题 | 修复 |
| --- | --- | --- | --- | --- |
| 0 / 分诊提问 | 通过（本地） | `tests/runtime.spec.ts` 新增 7 个用例，覆盖 observe、已有工单、缺少/无效 audit、无实施意图，以及设计未定/目标未定后的审批重投和接单 | 所有 triage ignore 都会问审批人 | `src/app/runtime.ts` 校验方向，只问实施意图明确但方向未定的请求 |
| 0 / 改投过期 | 通过（本地） | `tests/merge.spec.ts`、`tests/yunxiao-mr.spec.ts` 新增过期改投后关闭旧 MR、轮询只提醒新 MR 的用例 | 删除旧记录会丢失关闭依据 | `src/app/merge.ts` 保留 `replaced`；`src/sources/yunxiao-mr.ts` 跳过旧 MR，过期目标不再继承 |
| 0 / 完整检查 | 通过 | `LC_ALL=C pnpm check`：72 文件、1445 用例通过（含接单解析修复后复跑），类型检查和构建通过 | 原有缺失令牌测试读取了真实钥匙串，失败输出包含令牌；本地检查日志已脱敏，工具输出无法撤回，已告知用户建议更换令牌 | `tests/environment.spec.ts` 改为显式模拟钥匙串读取失败 |
| A / 重启前基线 | 通过 | `scripts/dsh-superagent status` 返回 0；`GET tickets` 为 0；SQLite 只读计数确认审批记录为 0；master/release 均为 `4f25b1d37ef622224e0fd505ef9b3b76cadd581d` | 有一条既存飞书消息因 `not_a_member` 被忽略；不是测试新建工单 | 无 |
| A / 重启后基线 | 通过 | 新进程 23258；`status` 返回 0，所有启用组件 ready、errors 为空、setup 为 null；工单和等待审批记录仍为 0；仓库 id 7643728，MR 列表为空 | 无 | 无 |
| B / CLI 护栏 | 通过 | 合并、Projex 写入、master 开 MR、security 均退出 1 且命中预期提示；分支列表正常读取 | 无 | 无 |
| B / 推送护栏 | 通过 | release/dsh-guard-test 被 pre-push 拦截；bugfix/dsh-guard-test 推送成功，随后用宿主 git 删除并确认远端已不存在 | 无 | 无 |
| C2 / 首次接单 | 失败，已修复待复测 | Source 连续三轮失败：`Unexpected non-whitespace character after JSON at position 1494`；CLI 同参数搜索能返回 SIQB-1 | 公共 JSON 解析从首个 `{` 截取，破坏顶层非空数组 | `src/infra/commands.ts` 保留最外层 `[`，`tests/commands.spec.ts` 增加空数组、非空数组、带前导日志数组用例 |
| C2 / 解析复测 | 通过 | 修复后重启，Source ready，读取 1 个工作项并收到 1 个 Trigger；完整检查 1445 用例通过 | 接单名单 `policy.sources` 完全为空，工作项被 `not_a_member` 忽略 | 仅加入已核对的云效账号 `62cf7f1d29d72730d9acc32d`，保留其他设置；通过正式 requeue API 重投同一 Trigger |
| C2 / 接单与状态 | 通过 | 工单 `26d8b13ad6ca6281ab386b0e30eb090b`，worker Session `worker-26d8b13ad6ca6281ab386b0e30eb090b`；飞书接单消息 `om_x100b61b3ce3e64a0c3c2d2d1f62860a`；工作项状态 100010 | 无 | 无 |
| C3 / 开 MR | 部分通过，暂停 | [MR !1](https://codeup.aliyun.com/62cf7f0b487c500c27f70f94/test-agent/change/1) 已关联 SIQB-1，目标 release/20261101 正确；仍为 TO_BE_MERGED | 工作项类别及 worker 环境均为 Bug，但分支是 `feat/261102-readme-hello-SIQB-1`，应为 bugfix 前缀 | 已暂停并停止测试服务；未改名、未关闭 MR，等待用户回复 |
| C4 / 评审回流 | 通过 | Chrome 普通评论 `e7ab7623543f453a924cf2549e46c0ba`、行内评论 `ab2302b92726492c9c91490512812b0d`；worker 推送 `cbdf7b1` 和 `79bae09`，分别补上 review feedback received 和空行 | 富文本 JSON 容器未正确转成 Markdown，但 worker 成功理解并处理 | 记录待修 |
| D / 旧提交审批 | 通过 | 用户客户端引用旧确认 `om_x100b61b3ca4f50acc1c95ff0e059612` 回复同意；机器人消息 `om_x100b61b3dba7d8acc0baa6294b5725f` 明确拒绝：最新 79bae094 不等于已确认 61a69a22；MR 未合并 | 无 | 无 |
| 暂停保护 | 已停止服务 | POST executor/pause 后确认 paused=true，但当时 running=1；随后 scripts/dsh-superagent stop 成功，status 显示 pids=[]、manually_stopped=true | 暂停只禁止后续调度，不取消正在运行的 worker；处理意外写入时仅暂停不足以保证马上停写 | 本轮正常停止服务，保留现场 |
| E / 流水线准备 | 未创建 | Chrome 打开新建模板选择后已取消；未启动任何流水线 | 无 | 等待恢复测试 |
| C1 / 新建缺陷 | 通过 | Chrome 创建 `SIQB-1`，id `9c135df80b2f7a8b4e5d9843ee`；项目 yedou-test，负责人夜斗，状态 28；描述明确只改 test-agent README | 无 | 无 |
| A / 飞书可操作性 | 通过（只读） | 飞书客户端已登录，机器人名称与 `GET state` 及 bot info 一致：汪嘉贤的飞书 CLI | CLI 没有用户身份，继续用客户端进行用户回复 | 无需开启用户 CLI 授权 |

## 恢复交接（历史，已由 QA 流程替代）

- 服务已停止，持久化 `paused=true`。分支规则及现场已修复；本次等待的是同一 MR 普通评审回复两次修复后仍失败的处理决定，未经回复不做第三次修复。
- 工单 `26d8b13ad6ca6281ab386b0e30eb090b`；工作项 SIQB-1（Bug），id `9c135df80b2f7a8b4e5d9843ee`，状态“处理中”。
- 沙箱替换 MR !2：`SIQB-1` → `release/20261101`，关联原工作项，仍未合并；当前提交 `79bae094`。旧 MR !1 及原分支保留，尚未关闭或删除。
- 旧合并确认 `om_x100b61b3ca4f50acc1c95ff0e059612` 记录为 confirmed，指向旧提交 `61a69a223aa1a0e7778fd6611b155e851782057c`；该回复因提交变化被拒绝。恢复后需重新检查并申请新确认，不能把它当成当前提交的审批。
- 飞书私聊 `oc_1c7c224805bee5e14a1b5af4478dcffc`，审批人 open_id 已与规则一致核对；无需用户 CLI 授权。
- 本地政策只新增了已核对的云效账号夜斗，policy revision=1；eval.mode 保持 observe，项目保持 direct。
- 截图：[MR 暂停现场](../.artifacts/yunxiao-paused-MR1-20261102.png)、[缺陷创建](../.artifacts/yunxiao-C1-20261102.png)。

## 待修（历史，当前状态见文末）

- 分支偏差已修复：用户最终要求编号独立为分支名；已通过真实分支 SIQB-1 / MR !2 验证，后续收尾时处理旧 MR。
- `richText` 尚不识别真实返回的 JSON 字符串容器 `htmlValue/jsonMLValue`，普通/行内评论会携带容器文本；本轮均成功回流，按小问题累计。
- 合并确认标题重复工作项编号（SIQB-1 SIQB-1），按小问题累计。
- worker 将无 PRE 流水线解释成不适用，而计划期待阻塞；目前尚未合并、尚未收尾，需要恢复后核对，不算已通过 C6。
- 暂停接口不取消已有 worker；本轮已通过正常停止服务防止继续写入。

## 尚未覆盖（原 MR 计划，当前状态见文末）

- C3 已按最终无前缀规则修正；C5 最新提交的真实合并、C6 PRE 与结果写回；D 的驳回/改投/冲突/改派/重开；E 流水线；F 分诊。
- SQL 阶段 G 可选，本轮不执行。
- `eval.mode` 切到 auto 仍按计划先问用户。

## 本轮代码改动

本轮追加两处已知修复及对应测试、公共 CLI 顶层数组解析修复及 3 个用例、测试钥匙串隔离修复、计划措辞修正；保留接手时已有改动。未提交或推送本仓库代码。沙箱仓库存在本次测试授权的 worker 分支、三个提交和 MR !1，尚未合并。

完整检查最终结果：72 个测试文件、1445 个用例通过，类型检查与构建通过；随后仅调整注释和结果文档，git diff --check 通过。

安全记录：原有测试失败曾在工具输出中带出云效令牌，本地检查日志已脱敏；一次读取启动日志还包含本机 Web 访问凭据。工具输出无法撤回，服务现已停止。建议更换云效令牌，恢复时重建本机 Web 访问凭据；本记录不保留任何秘密值。

当前工作区 `git diff --stat`（含接手前未提交改动；两份新增文档尚未跟踪，不在该统计中）：

```text
 docs/006-deployment.md         |   4 +-
 prompts/admission.md           |   1 +
 src/app/merge.ts               |  93 +++++++++++++++----
 src/app/runtime.ts             |  47 +++++++++-
 src/infra/commands.ts          |   2 +-
 src/kv.ts                      |   4 +-
 src/sources/yunxiao-mr.ts      |   2 +-
 src/sources/yunxiao-trigger.ts |  26 ++++--
 src/sources/yunxiao.ts         | 124 +++++--------------------
 tests/commands.spec.ts         |   6 ++
 tests/environment.spec.ts      |   3 +-
 tests/merge.spec.ts            | 127 ++++++++++++++++++++------
 tests/runtime.spec.ts          |  44 +++++++++
 tests/yunxiao-mr.spec.ts       |   8 ++
 tests/yunxiao.spec.ts          | 200 ++++++++++-------------------------------
 15 files changed, 377 insertions(+), 314 deletions(-)
```

## 2026-11-02 分支规则续测

- 用户最终要求：分支只用云效工作项编号，无前缀；Bug 和 Task 一致。其他来源沿用原规则。
- 修改：两份 worker skill、`src/infra/environment.ts` 的共享分支检查（push 与开 MR）、说明文档与实测计划。宿主已有绑定逻辑支持裸编号，新增用例验证编号及改投分支不会绑定到其他编号工单。
- 检查：`LC_ALL=C pnpm check` 通过：72 文件、1449 用例，类型检查与构建通过。
- Chrome 在沙箱 MR !1 新增修正要求，要求保留内容与提交，用 `SIQB-1` 新开替换 MR，并重新申请飞书确认；原分支和 MR 暂保留。

- 恢复启动时发现两条 MR 评审回复积压：发送器仅支持工作项地址，报 `Missing yunxiao work item id`。按阻塞处理，仍保持 paused=true；已为 MR 地址新增发送、补齐评论参数、校验仓库范围及补发去重。新增 4 个用例，完整检查最终为 1453 用例通过。重启后需验证积压回复补发成功且不重复。

- worker 已推送无前缀分支 `SIQB-1`，当前提交仍为 `79bae094e3d9662253befb2bb70c339cf1e34714`；创建并绑定 [替换 MR !2](https://codeup.aliyun.com/62cf7f0b487c500c27f70f94/test-agent/change/2)，目标仍为 release/20261101，工作项关联不变。旧分支、MR !1 尚未关闭。
- MR 回复首次修复后遇到真实接口 400：父评论与回复的 comment_type 必须一致。已从评论规范化层保留行内比较、路径、行号，补发时按父评论类型及原始 patch set 回复，禁止猜测缺失上下文。新增行内与缺失上下文用例，完整检查 1455 用例通过。当前 paused=true，待重启复测补发。

- 实机护栏检查：直接给已安装 pre-push hook 输入模拟推送引用，不产生远端写入；SIQB-1、SIQB-1-to-release-20261103 放行，feat/SIQB-1、bugfix/SIQB-1、release/20261101、master 均拒绝。
- 第二次回复修复实测：行内回复补发成功（父评论 ab2302b92726492c9c91490512812b0d，新增子评论 f4603af310a54ad5aa7eb3ad76b9dfde）；近期普通评论的回复也成功。剩余旧普通评论的回复仍被拒绝：`related biz Id must be same with parent comment`，没有产生该条回复的写入。
- 剩余 receipt：`545442e30aa72d70976a30a965aa057b`，父评论 `e7ab7623543f453a924cf2549e46c0ba`（MR !1）。其 `related_patchset.patchSetBizId=9f53a211c4c54c248abaa513bfd369ed`，代码却按普通评论选择了最新 `a98d33d0a29a45ed800efe84bf563b6c`，与父评论版本不一致。已明确定位，未进行第三次修复。
- 下一次获准后的最小修法：评论规范化时保留每个父评论的 `related_patchset.patchSetBizId`；凡有 parent 的回复统一沿用该版本，仅独立评论才选最新源版本。保留既有行内路径/行号/比较信息及稳定 marker，补一个“旧版本普通父评论、当前有新版本”的用例，然后以同一个 receipt 重试，核对不重复。
- MR !2 等待飞书确认消息 `om_x100b61bc14c360acde840dd252d094a`（commit 79bae094，目标 release/20261101），本轮未回复、未合并。
- 最终状态：`scripts/dsh-superagent stop` 成功，自动恢复暂停；本仓库没有提交或推送。完整检查 1455 个用例通过，后续只改了文档与 skill 描述。

## QA 流水线集成流程（替代 MR/PRE）

- 新流水线：[qa-test-agent-integration / 5362874](https://flow.aliyun.com/pipelines/5362874/current)，仅连接 test-agent 沙箱仓库，复用已有 Codeup 服务连接；没有创建新凭据。
- 分支模式：baseBranch=master、keepIntegrationAreaBranch=true；既有分支 qa-existing@21b14a5a8bfd1d73a285dc973974103ce40ca7d5，qa-conflict@6c5a78f8b4fe11a086edae282a71124b01fb8b7b。
- 运行 #1：真实分支管理器成功集成已有分支；QA 阶段因官方镜像 Python 版本较旧、不含 ThreadingHTTPServer 而失败。改用标准库 HTTPServer，三组本地脚本自检（基线成功、交付成功、丢失旧内容失败）通过。
- 运行 #2：完整 SUCCESS，两个已有分支均保留。该基线还未集成 SIQB-1，不计作交付验收。
- 代码改为 QA 工具读取云上 branchRepoInfo 全量集合再追加当前分支、保存实际运行及提交，并阻止 worker 直接启动流水线或新建 MR。旧合并确认失效，工作项不再轮询旧 MR 的改投。
- 已通过 Chrome 在 SIQB-1 工作项评论写入新的集成、真实冲突与 QA 验收要求，要求保留所有已有分支与 MR。

- QA 流程实现完整检查通过：73 个测试文件、1472 用例，类型检查和构建通过。已覆盖旧 MR 确认停用、禁止新 MR/直接启动、保留集成列表、拒绝运行中/生产/未知配置、失败/丢分支/新提交/无真实 QA 证据不允许完成。准备恢复工单实测。


## QA 冲突联测最终结果

| 步骤 | 真实结果与证据 |
| --- | --- |
| 制造冲突 | SIQB-1 推送 a8116ca7292105598b95a297e0194efa21153212，README 与 qa-conflict 改同一行。运行 #3 的分支管理器报 README.md 内容冲突，日志为 `Merge conflicted, job paused`，QA 作业未启动。 |
| 解决冲突 | worker 在 SIQB-1 合入 qa-conflict，保留 delivery-qa-line、existing-qa-line 两个独立标记行，保留旧文件与 hello 内容，推送 454b884c2079f3f60695d98bfc335c922d7ade16。 |
| 挂起恢复 | 云效冲突运行实际仍为 RUNNING，不能只等 FAIL。补上宿主恢复：确认是本工单启动的同一运行、启用冲突动作且开发分支已有新提交后，仅停止该次冲突任务一次，等运行终止后重新集成。真实运行 #3 随后变为 FAIL。 |
| 保留分支重跑 | 宿主读取 #3 的全量 branchRepoInfo，保留 qa-existing、qa-conflict、SIQB-1 并启动 #4。没有清空集成区，没有推送临时 release 分支。 |
| 集成通过 | #4 于 21:36:40 启动，整体 SUCCESS。分支管理器完成输出 COMMIT_INFO：SIQB-1@454b884、qa-conflict@6c5a78f、qa-existing@21b14a5 全为 INTEGRATED。 |
| QA 主流程 | QA 作业 547782560 实际检查旧标记文件、双方 README 标记、hello 恰好一次，并启动 HTTP 服务 GET /README.md，21:37:17 返回 HTTP 200 且内容一致，输出 QA_MAIN_FLOW_PASS。 |
| 完成与回写 | 宿主复核实际完成输出、原分支集合和当前远端提交后，21:37:55 工单 completed，result.qa.verified=true；21:38:45 云效 SIQB-1 状态为已修复（29），结果评论含真实 QA 证据。 |

实际云返回的请求输入可能没有 commitId、仍标 UN_INTEGRATED，因此完成校验改读分支管理器完成输出 COMMIT_INFO，不能拿请求输入当合并成功证据。另补最新运行编号的持久化检查，避免旧响应覆盖刚追加的分支；当前工具只接受单一分支集成仓库的 QA 流水线。Flow 没有条件启动接口，共享流水线的外部写入仍需串行。

### 最终远端分支核对

| 分支 | 最终 SHA | 结果 |
| --- | --- | --- |
| master | 4f25b1d37ef622224e0fd505ef9b3b76cadd581d | 未改写 |
| release/20261101 | 4f25b1d37ef622224e0fd505ef9b3b76cadd581d | 未改写 |
| feat/261102-readme-hello-SIQB-1 | 79bae094e3d9662253befb2bb70c339cf1e34714 | 保留原提交 |
| qa-existing | 21b14a5a8bfd1d73a285dc973974103ce40ca7d5 | 保留原提交且仍在集成集合 |
| qa-conflict | 6c5a78f8b4fe11a086edae282a71124b01fb8b7b | 保留原提交且仍在集成集合 |
| SIQB-1 | 454b884c2079f3f60695d98bfc335c922d7ade16 | 仅此开发分支新增修复提交 |

旧 MR !1、!2 仍未合并；新流程没有新建 MR，也没有触发旧审批合并。Flow 自动生成的运行 release 分支作为历史保留。

### 检查与当前待修

- `LC_ALL=C pnpm check`：73 个测试文件、1479 个用例全部通过，类型检查和构建通过。覆盖真实云返回形状、完成输出核验、保留全部分支、自己挂起冲突的恢复及防止重复停止、拒绝停止别的工单/未改提交/无冲突运行、拒绝过期最新运行数据、拒绝多仓库分支源。
- JSON 富文本容器已修；MR 旧评论回复的 patchSet 已修，积压错误已清空。上述历史待修不再作为当前阻塞。旧 MR 标题重复和 PRE 交付规则随本工作项流程取消而不适用。
- 已按最终代码检查结果重启服务，保留工单和 QA 运行记录；未提交、未推送本原型仓库。沙箱分支提交与 QA 流水线属于本轮授权的实际操作。
- 当前无已知主流程阻塞。未覆盖真实业务系统 QA、可选 SQL、分诊审批、改派/重开等独立场景；eval.mode 仍为 observe，没有自动切换 auto。

证据：[真实冲突截图](../.artifacts/yunxiao-qa-run3-conflict-20261102.png)、[成功集成及保留分支截图](../.artifacts/yunxiao-qa-run4-success-20261102.png)、[工作项已修复截图](../.artifacts/yunxiao-SIQB-1-fixed-20261102.png)、[脱敏冲突日志](../.artifacts/yunxiao-qa-run3-conflict.log)、[脱敏 QA 主流程日志](../.artifacts/yunxiao-qa-run4-main-flow.log)。


## 多工程仓库支持（实现与本地回归）

用户补充一个工作项可能涉及多个工程后，已修复原先只核验单一仓库证据的完成门禁。本节为本地实现和自动验证，前面的云端 #3/#4 实测仍仅代表 test-agent 单仓库。

- `orchestrator_qa_integrate` 必须携带完整 `repositories` 清单，同时指定当前 `repository` 和它的 `pipeline_id`；各工程都使用同一个工作项编号作为开发分支，各自走分支模式流水线。云效原生只允许一条流水线的一个代码源开启分支模式，依据见[官方文档](https://help.aliyun.com/zh/yunxiao/user-guide/pipeline-sources)。
- 完整仓库清单先持久化，后续调用可以增加但不能缩小；尚未启动的工程也不能漏掉。每个工程的原集成分支、运行和受测提交分别记录，不以其他工程的成功替代。
- `result.qa.repositories` 必须恰好覆盖全部涉及工程，每个工程均有真实 QA 证据；外层 `main_flow_passed/evidence` 记录全部部署版本上的联合主流程测试。单仓库旧格式仍能读取，但不能替代多仓库的完整证据。
- 完成时逐库读取实际成功运行和分支管理器完成输出，复核原分支保留、当前提交与受测提交一致；读完所有运行后再次检查全部提交，验收期间范围或集成记录变化则拒绝完成。
- 检查其他已配置工作区仓库的同编号远端分支，发现漏报就纳入必须验收清单并持久化；读取失败不能当作没有分支。自动发现后即使该分支消失，也不会自动取消这个工程的验收。
- 修复一个工程后，仅该工程需要新运行，其他工程当前提交未变时可沿用成功记录；随后必须重新做联合 QA。工作项只写回一条汇总结果，列出全部仓库、运行、提交和联合验证。
- 非 ready 的进度/失败报告即使携带 verified 标志，也不能把工作项写为已修复。

自动验证：两个工程的不同原集成分支全部保留；全部通过才 ready；第二个工程未启动、失败、冲突、提交变化、丢分支、证据遗漏/重复、缺少联合 QA、范围在验收中变化均拒绝或继续等待；冲突恢复只停止第二个工程自己的运行；修复只重跑受影响工程。工具到真实工单引擎的回归确认：第二个运行失败时工单仍 open，全部成功后才 completed，并保存宿主核验的全部提交。结果评论与状态流转同时覆盖多工程证据。

最终 `LC_ALL=C pnpm check`：73 个测试文件、1505 用例全部通过，类型检查和构建通过，`git diff --check` 通过。已按新构建重启服务，持久化的已结束工单和旧成功运行保留。本仓库未提交、未推送。

未覆盖：第二个云端沙箱仓库及真实跨工程应用 QA。本次没有增加真实业务仓库或新的外部写入范围；仅当前已配置工作区的仓库可以交付和检查。Flow 无条件启动接口，共享流水线外部启动仍须串行。


## 双工程云端实测最终结果（SIQB-2）

本轮按用户“实际测试”授权新增私有服务沙箱 test-agent-service。测试仍限定在两个沙箱仓库、yedou-test 项目和本轮 QA 流水线；没有操作真实业务、数据库或生产环境。

| 对象 | 实际值 |
| --- | --- |
| 工作项 | [SIQB-2](https://devops.aliyun.com/projex/workitem/326be9b8a5bbf04d07dc710a36)，Bug，自动已修复 29 |
| 内部工单 | 4be1b554ffc106a856862331ce553d14；同一工作项仅 1 张工单，没有重复接单 |
| 客户端仓库 | test-agent / 7643728，开发分支 SIQB-2，提交 51ec500ecde84d43b72a5d7347cde4abc5a32b36 |
| 服务端仓库 | test-agent-service / 7644238，开发分支 SIQB-2，修复后提交 5b6d3a5ecb20a752a9f98a1f2ffaa1cee9c8c5d0 |
| 客户端集成 | [5362874 #5](https://flow.aliyun.com/pipelines/5362874/current)，SUCCESS，实际集成提交 89608be803bd4193022c488870382f7d82e8c395 |
| 服务端集成 | [5363213 #3](https://flow.aliyun.com/pipelines/5363213/current)，SUCCESS，实际集成提交 1c568ecf42e3829de7a90b32ca2e9abce16b2e5b |
| 联合 QA | [5363216 #3](https://flow.aliyun.com/pipelines/5363216/current)，SUCCESS，云端运行两份固定集成版本的真实客户端和服务端 |

### 实际执行与拒绝证据

1. 服务端基线 #1 保留 qa-existing、qa-conflict 后通过。master=6b0753c9ba67522cf86947d93e7a62f2d8434e8e；qa-existing=1a56b919d3e997478815b409164d1e135a502bba；qa-conflict=04aa9546d23c771bbc3e6688efb12dcdedb98e0d。
2. worker 在两个 SIQB-2 分支实现客户端/服务端协议2，服务端首次提交为 813d99f2b2f85d375b09eac31e8f730c36e78885。客户端 #5 成功且保留 qa-existing、qa-conflict、SIQB-1、SIQB-2。
3. 只提交客户端证据的受控 ready 探测被拒绝：`QA evidence must cover every work-item repository exactly once; required: 7643728, 7644238`。实际工单仍 working。
4. 服务端 #2 在 README.md 产生真实内容冲突，日志为 `Merge conflicted, job paused`。此时客户端已成功，服务端 QA 未启动，云效工作项仍为处理中 100010。全清单带 main_flow_passed=false 时 schema 拒绝；改为 true 的负向测试仍被宿主云状态检查拒绝：`QA pipeline has not completed successfully; keep the work item open`。
5. worker 仅在服务端 SIQB-2 合入 qa-conflict，保留 delivery-service-line、existing-service-line 两行及旧标记文件；推送 5b6d3a。宿主仅停止服务端自己的挂起 #2，再启动 #3 成功。客户端仍复用 #5，没有重跑。
6. 联合 #1 因脚本硬编码 /root/workspace/client_repo，在 HTTP 执行前报目录不存在，不能算协议负向通过。真实 runner 使用动态 WORK_SPACE 路径。已修复 YAML，使用两份实际集成提交做本地真实 HTTP 自检，运行完整检查并重启服务，仓库清单、两份运行和提交记录均保留。
7. 联合 #2 固定新客户端集成版本与旧服务端 master，实际请求返回协议1，客户端抛出 `ValueError: unsupported protocol 1 ... expected 2`，运行 FAIL；工单仍 open/working。
8. 联合 #3 固定两个成功集成版本，在云端核验完整 SHA。22:22:41 实际日志：HTTP 200 / hello qa user / protocol 2，HTTP 200 / hello 跨仓库 / protocol 2，未知路由 HTTP 404，最后输出 `JOINT_QA_MAIN_FLOW_PASS`；整个运行 SUCCESS。
9. worker 读取联合日志后于 22:23:19 报告 ready，宿主逐库复核成功运行、原集成集合和当前开发提交，将两份 commit 与 verified=true 存入结果后完成工单。22:24 轮询自动写回一条结果评论，列出两个仓库、流水线、提交和联合验证，并流转至已修复 29。Chrome 和云端 API 均已核验。

### 保留检查与最终现场

- 客户端已有 10 条远端分支、服务端基线已有 4 条远端分支均存在且 SHA 未改变；活动开发分支 SIQB-2 按预期推进。两个 master、qa-existing、qa-conflict 以及客户端旧 feat/SIQB-1/release 历史均未改写。
- 客户端仍只有 MR !1、!2，均为 TO_BE_MERGED；服务端 MR 列表为空。没有新建、合并或关闭 MR。
- `LC_ALL=C pnpm check` 再次通过：73 文件、1505 用例，类型检查和构建通过；`git diff --check` 通过。服务当前运行，启用组件 ready，effect 错误 0；已结束工单、完整两仓库范围和 QA 记录保留。
- 最终云端 YAML：[服务端集成](fixtures/yunxiao-qa-service-integration.yml)、[固定双版本联合 HTTP](fixtures/yunxiao-qa-joint-http.yml)。联合配置使用运行时 WORK_SPACE，不能假设代码永远位于 /root/workspace/<source>。
- 证据：[服务端真实冲突截图](../.artifacts/yunxiao-multirepo-service-conflict-20261102.png)、[旧协议真实拒绝截图](../.artifacts/yunxiao-multirepo-joint-run2-protocol-rejected-20261102.png)、[联合成功截图](../.artifacts/yunxiao-multirepo-joint-run3-success-20261102.png)、[工作项已修复截图](../.artifacts/yunxiao-multirepo-SIQB-2-fixed-20261102.png)。
- 脱敏日志：[冲突](../.artifacts/yunxiao-multirepo-service-run2-conflict.log)、[协议负向](../.artifacts/yunxiao-multirepo-joint-run2-negative.log)、[联合正向](../.artifacts/yunxiao-multirepo-joint-run3-positive.log)；[门禁实际报告](../.artifacts/yunxiao-multirepo-negative-gates.json)、[分支保留快照](../.artifacts/yunxiao-multirepo-branch-preservation.json)、[最终结构化报告](../.artifacts/yunxiao-multirepo-final-report.json)。

范围限制：这是两个沙箱工程之间的真实云端 HTTP 联测，不代表 AXO 等真实业务系统已完成验收；SQL、生产发布、分诊/改派等独立场景未执行。共享流水线外部启动仍须串行。本原型仓库改动仍未提交、未推送。


## 按用户真实工作流程实现并实测（SIQB-3）

流程已固定为：工作空间中识别本工作项涉及的全部工程 → 全部工程本地单元测试通过 → 每个工程发布自身固定的 QA 流水线 → QA 集成环境已部署版本和业务主流程实测 → 完成一个工作项并添加汇总评论。

### 本轮代码

- `orchestrator_qa_prepare` 登记完整 projects（repository、pipeline_id、unit_test_command）及共同 QA 环境，使用 worker 的 subprocess 环境实际执行本地单测；记录干净工作树中的提交及输出。任何工程失败均禁止全部发布，新增提交需要重新本地测试全部涉及工程；项目/流水线对应关系固定。
- `orchestrator_qa_integrate` 只允许把已本地受测的提交发布到该项目指定 QA 流水线，继续保留原有集成分支。新发布使旧 QA 环境测试记录失效。
- `orchestrator_qa_test` 必须在全部项目流水线成功后执行，实际运行 QA 环境测试命令，传入共享环境地址和完整项目发布快照。ready 必须有对应这组实际发布版本的成功执行记录，不能只填通过标志。
- 完成评论新增各工程本地单元测试命令、提交、输出，以及 QA 集成环境、测试命令和实际结果；所有工程统一完成，不在单个工程先成功时收尾。

### 实际验证

工作项：[SIQB-3](https://devops.aliyun.com/projex/workitem/de0c00f59af660a24e661ee7f2)，内部工单 894a04b36054c39fe69b2d9f6a1cf45b。只操作 test-agent 和 test-agent-service 两个既有沙箱，两个开发分支均为 SIQB-3。

| 阶段 | 实际结果 |
| --- | --- |
| 单测失败门禁 | 服务端单测正常通过后，受控输出 CONTROLLED_UNIT_FAILURE 并 exit 9；prepare 失败且 tested=false。客户端和服务端两次 integrate 均被拒绝，流水线仍为旧 #5/#3，没有发起新发布。 |
| 全部本地单测 | 重新执行正常 prepare：客户端 6/6、服务端 4/4 通过，分别绑定提交 486cc6ac0e3bdb455cf77743c85cdc7df8b9ae23 和 0c0b36d23d2bf981ae3e4ba8ded2d414b07574c6。 |
| 客户端发布 | 5362874 #6 SUCCESS，保留 qa-existing、qa-conflict、SIQB-1、SIQB-2 并追加 SIQB-3；实际发布集成提交 4986e4a846b42d7147a2123391f032cb47971bf1。 |
| 服务端发布 | 5363213 #4 SUCCESS，保留 qa-existing、qa-conflict、SIQB-2 并追加 SIQB-3；实际发布集成提交 29c60153ed8efb2a8e1568505c4e1d0eac370f3d。 |
| QA 实际部署 | 本轮沙箱采用拉取式发布代理：订阅各自 QA 流水线成功版本，将实际发布提交自动部署为两个独立常驻进程。客户端于 23:04:54、服务端于 23:05:01 更新；共同入口 http://127.0.0.1:54541。不是在集成测试脚本内启动临时服务器。 |
| 未测试不能完成 | 两流水线成功后、尚未执行 qa_test 时，ready 探测被拒绝：Test the deployed QA integration environment with orchestrator_qa_test after ALL project publications。 |
| QA 环境实测 | 23:05:27 宿主实际执行 python3 tests/qa_integration.py，HTTP 读取 /__qa/deployments，对两工程 repository/commit/pipelineId/runId 逐一匹配；经前端 /greet 真正调用后端，空格和中文姓名返回协议2；未知路径404，输出 QA_DEPLOYED_MAIN_FLOW_PASS。 |
| 完成与评论 | 23:05:39 工单 completed；23:06 云效自动回写已修复29。确认仅有1张内部工单、1条包含本地6/4测试结果和实际QA输出的最终汇总评论。 |

本轮未新建或运行第三条联合流水线，旧 5363216 仍停留在历史 #3。工作空间两个项目分别对应一条 QA 流水线，测试在共同的常驻 QA 集成环境中完成。客户端原有12条、服务端原有7条远端分支均保留且 SHA 未变化。未新增/合并 MR。

### 实测发现并修复的宿主阻塞

第一次 prepare 在真正执行本地单测前，直接向 Store.set 传 undefined 清理 qaTest，导致 SQLite 抛 Provided value cannot be bound to SQLite parameter 2；异常发生在 try/finally 之外，测试锁残留。此时没有发生任何流水线发布，不能把它当受控单测失败验证。

已改用 Store.delete，锁内存储操作进入 try/finally；QA 测试失效清理移到发起流水线写入之前。新增真实 SQLite 回归，覆盖失败后再次 prepare、发布与环境测试、重开数据库读取、存储异常后释放锁。完整检查通过并重启服务后，从本地单测步骤恢复，随后所有负向和正向流程均真实完成。

最终 `LC_ALL=C pnpm check`：73 个测试文件、1513 用例通过，类型检查与构建通过；git diff --check 通过，服务无 effect 错误。本原型代码未提交、未推送。

证据：[本地失败门禁](../.artifacts/qa-workflow-unit-gate-proof.json)、[宿主实际 QA 执行记录](../.artifacts/qa-workflow-actual-test-proof.json)、[最终结构化结果](../.artifacts/qa-workflow-final-report.json)、[原分支保留](../.artifacts/qa-workflow-branch-preservation.json)、[工作项完成及评论截图](../.artifacts/qa-workflow-SIQB-3-completed.png)、[QA 中实际部署版本截图](../.artifacts/qa-workflow-deployed-versions.png)。QA 环境及版本记录在 .artifacts/qa-workflow-environment/；本轮部署订阅轮询已停止，两个 QA 服务仍保留可访问，未留下持续云端查询。

未覆盖真实业务系统、SQL 或生产发布。本轮的常驻集成环境仅绑定本机127.0.0.1，是隔离的沙箱验收环境；真实项目应使用其既有 QA 发布流程和环境入口。


## 2026-11-03 固定 QA 分支、MR / 直接合并及冲突实测

工作项：[SIQB-4](https://devops.aliyun.com/projex/bug/f1327a07dcf76f0ca28e453435)，内部工单 932031f3d9b46ec1bc1e2d1c66633066。两个工程开发分支均为裸编号 SIQB-4；各工程的 QA 流水线代码源固定为 qa，已移除 branchMode。当前自动接单仍仅 Bug，Task 配置保持停用。

实现位置：src/app/qa.ts、src/infra/commands.ts、src/infra/environment.ts、src/infra/yunxiao.ts、src/kv.ts、执行工具、结果评论、两份 worker skill、部署说明及沙箱流水线 YAML。

- prepare 真实运行全部项目单测，并固定工程、流水线、QA 分支和共享环境的对应关系。
- integrate 只合入已受测的工作项提交；支持直接合并和原生 MR。保留原 QA 头及开发提交的历史，不强推、不删除源分支。冲突先在开发分支解决，再重测所有工程后重试。
- 合并后才触发普通 QA 流水线；验证 run.sources 的实际 qa checkout，而非旧分支管理器输入。
- 所有项目成功后，真实执行共享 QA 环境测试；对开发提交、QA 提交、运行号和完整项目集校验。测试成功后才允许完成工作项并写汇总评论。

| 验证项 | 实际结果 |
| --- | --- |
| 全部本地单测 | 前端6/6、后端4/4；冲突修复后通过 prepare 再次执行全部单测。 |
| 真实冲突及写入边界 | 后端首次 integrate 返回 QA merge conflict。随后的实际回读确认 qa 仍为 7deee48355061162564786e68cf5fd99fb715d1f，流水线仍为原 #4 SUCCESS，没有启动新构建。 |
| 开发分支修复 | 将 origin/qa 合入 SIQB-4，保留 existing-qa-change 和 workitem-change 两行，提交 e20f58f293e0d6bb2f6e37f15445bf9f9973a1e4；重测、推送后继续。 |
| 前端 MR 模式 | [MR !3](https://codeup.aliyun.com/62cf7f0b487c500c27f70f94/test-agent/change/3) 已 MERGED，SIQB-4 → qa，保留源分支。开发提交 7660ab570338cb56721bf29e444a654448f89cf0；QA 提交 b05ac06b2dc1006c6e0bf1ba9e67824103021239。 |
| 后端直接合并 | 正常非强制 push，QA 合并提交 9186b26674f81e071746054dfbef1991b873c26e；独立验证旧 QA 头和受测开发提交均为其祖先。 |
| 两项目普通流水线 | 5362874 #7、5363213 #5 均 SUCCESS；原生 sources 均为 qa、isBranchMode=false，实际构建 SHA 与上述 QA 提交逐一一致。 |
| 常驻 QA 部署 | 独立沙箱发布代理按成功运行的实际 QA 提交建立常驻服务，前端 http://127.0.0.1:28741，后端 http://127.0.0.1:28742。每个 /__qa/version 均匹配仓库、开发提交、QA提交、流水线及运行号。 |
| 真实 HTTP 主流程 | 宿主执行 python3 tests/qa_integration.py，经前端调用后端，验证空格/中文姓名、协议3及404，并对 expected.qaCommit 与实际 integration_commit 严格匹配，输出 QA_DEPLOYED_MAIN_FLOW_PASS。 |
| 完成与回写 | 10:52:51 内部工单 completed，10:53:35 云效已修复29；回读和 Chrome 均确认只有1条包含两工程本地单测、QA分支/提交、MR链接、流水线及实际QA输出的最终评论。 |
| 既有分支 | 前端原14条、后端原9条远端分支均存在且 SHA 不变；仅新增各自 qa 和 SIQB-4，本轮允许更新这两个新分支。旧 MR !1/!2 未操作。 |

收尾修复：QA 测试工具现在与 prepare/integrate 一样支持仓库名称、路径或 ID；对同一受测开发提交重试失败流水线时保留已有 MR 证据。新增/调整行为用例后，LC_ALL=C pnpm check 通过：73文件、1495用例、类型检查及构建。重启后又以仓库名称 test-agent 调用真实 testQa，在同一常驻 QA 环境复测通过；没有为此重复合并或启动流水线。

服务已重启，paused=false，云效/Codeup及各运行组件 ready；未发生错误外部写入。仅停止本轮临时云端发布轮询器，两个实际 QA 服务仍保留，回读版本健康。

证据：[冲突与未推进回读](../.artifacts/fixed-qa-20261103/conflict-proof.json)、[分支及实际构建证据](../.artifacts/fixed-qa-20261103/delivery-proof.json)、[宿主主流程测试](../.artifacts/fixed-qa-20261103/actual-main-flow-proof.json)、[仓库名称实测回归](../.artifacts/fixed-qa-20261103/repository-name-retest.json)、[最终结构化结果](../.artifacts/fixed-qa-20261103/final-report.json)、[工作项回写核对](../.artifacts/fixed-qa-20261103/writeback-proof.json)、[完成截图](../.artifacts/fixed-qa-20261103/workitem-completed.png)。前后远端分支快照也保存在同目录。

边界：本轮是真实云效合并/流水线，加本机常驻沙箱服务的集成验收，不涉及正式业务 QA、SQL 或生产。沙箱 YAML 执行云端单测并产生可发布的成功版本；实际本机发布由独立代理完成。正式项目需要其自己的 QA 部署步骤和环境入口，不能只复制这个单测 fixture 代替部署。受保护分支的人工审批/合并限制没有实测，不会绕过平台限制。Codeup 合并 API 不支持 expected-source-SHA 参数，MR 合并期间需串行更新开发分支；若发现变化，宿主拒绝后续 QA 运行和完成。

## 2026-11-03 用户复核后的流程修正

重新只读检查了沙箱：test-agent 的旧 SIQB-4 比 master 多13个提交，test-agent-service 多12个提交，且旧 worktree 仍占用原分支。这证明旧冲突处理指引会污染后续发版来源。保留这些历史和 worktree，不通过强制改写掩盖问题；旧 SIQB-4 不应直接合入 release/master。

| 问题 | 当前实现 | 验证 |
| --- | --- | --- |
| 开发分支污染 | 从受测开发提交建立 <编号>-qa，目录为 <工单目录>/.qa/<仓库>；只在那里合 QA、解决冲突。prepare 记录并测试开发与候选，integrate 合入受测候选。开发分支不变。 | 真实裸仓库制造冲突，确认第一次不推 QA/不启流水线；候选解决后，开发 HEAD 不变、比 master 仅多1个本工单提交且不包含 QA 独有提交。 |
| 共享 QA 推进导致失效 | QA 当前头与实际受测构建包含开发/候选提交即可。qa_test deployments 可选后续实际发布运行。 | 真实 Git 后续两次同事提交仍可验收；成功构建若只含开发、不含冲突解决提交则拒绝；不因同事 QA 推进重复发布。 |
| 工单重开 | 复用原 Ticket/执行目录；重开/重试启动提示和 skill 不再无条件 worktree add -b。 | 真实 Git 工作树在工单完成、留下未提交内容再重开后，目录、分支、HEAD、注册关系均不变，prepare 不重复，脏改动保留。 |
| 非快进与主机入口 | 钩子拒绝非快进和删除，只允许编号及编号-qa；去掉环境变量放行。主机显式 --no-verify 做普通非强制 QA push。 | 真实 Git 中 force/force-with-lease 回退均被钩子阻止；主机普通非快进 push 同样被 Git 拒绝；伪造旧环境变量不再放行。 |
| 自动代码源触发 | 在任何外部写入前拒绝非空 source triggerEvents，包括 push、MR 完成事件。宿主不修改项目触发策略。 | 配置回归确认不推 QA、不创建运行；手动流水线正常。没有宣称支持自动触发。 |
| 合并/运行回包丢失 | 写前持久化交付意图，原生合并前记录 MR。后续运行按实际构建和包含关系认领。 | 创建运行后故意丢失回包，重试只认领原运行，不重复启动，MR 链接保留；失败运行正常重试。 |
| QA MR 评审 | 待评审 MR 即绑定原工作项，ends=false，不进入旧 release 改投逻辑。 | 模拟原生字段的评审评论只投递一次，进入原工单，不新开工单、不因 MR 合并提前完成。 |
| 评论与非修复结论 | 评论只写简短结论、单测结果、短提交、MR/运行及环境；原始输出留内部。明确非修复状态不调用修复 QA 门禁，也不写成已修复。 | 评论中不含原始输出；无需修改/待确认/待验证/阻塞的 ready 均不误触 QA 验证。 |
| 超时和网络 | prepare/test 的 timeout_ms 可设1秒至24小时。每个涉及仓库一次批量 fetch 后本地判断祖先；不再 ls-remote 扫所有仓库。 | 指定超时实际传入运行层；遗漏的本地工单 worktree 会被发现，未涉及仓库没有网络调用。 |

清理了未调用的 stopPipelineJob、旧 receipt branches/stopping、无用 head 参数、旧 shim 文案和工作项改投分支放行。可选联合兼容 fixture 改用固定 qa 和客户端协议常量，不再固定旧 Flow release/SHA；它不代替常驻环境验收。两份 skill、部署说明、测试清单和本计划均已同步；用户已明确不处理 rev 101 方案文档。

最终检查：LC_ALL=C pnpm check，74测试文件、1510用例通过，类型检查与构建通过，git diff --check 通过。证据：[完整检查日志](../.artifacts/qa-hardening-20261103/pnpm-check.log)、[验证范围](../.artifacts/qa-hardening-20261103/verification.json)、[旧分支只读核对](../.artifacts/qa-hardening-20261103/old-branch-evidence.json)。本轮没有云效仓库/工单写入，也没有重新进行云效端到端或真实受保护 MR 审批；相应回归使用原生返回结构和真实本地 Git。

服务端 master/release 分支保护未变更。钩子只是防误操作，仍能被同机同权限进程绕过；实际安全边界须在 Codeup 按项目配置。原型代码仍未提交、未推送。

## 2026-11-03 后续复核与 release/qa 切换

- 远端跟踪刷新改用带 + 的 refspec。真实 Git 回归覆盖 QA 退回 master 后的明确验收拒绝及重新集成；远端开发分支被手动改写时，缓存刷新成功并提示先对齐工作树、重新 prepare，而非盲目推送旧提交。这里的 + 仅更新本地跟踪缓存，不放开推送历史重写。
- 共享交付提示把评审署名的历史重写规则限定为 GitHub。Codeup 只在新实质提交署名，无新代码则记入报告；新提交必须重测和发布。默认提示与 Codeup skill 一致，提示长度检查仍使用原预算。
- 切换 <编号>-qa MR 时先建立或复用替代 MR，再核对并关闭本工单原开发 MR，确认原生状态已关闭才标记 superseded。原 follow 关闭但保留历史，不再轮询或发旧提醒。覆盖关闭回包丢失后的重读、不重复创建/关闭，以及关闭未生效时不继续合并。QA 冲突提示明确要求保持开发分支不变。
- 宿主结果补充可信 repository_name，评论显示 test-agent 等名称；内部仍以规范仓库 ID 做校验。数字仓库 ID 的回归用例确认不会再直接显示编号。

两个沙箱仓库均从当前 qa 建立 release/qa；前端原16条、后端原11条远端分支的 SHA 全部保持不变。两条流水线代码源已更新，旧 qa 分支保留，未修改旧历史联合流水线。

| 工程 | 流水线 | 原生运行结果 | 实际源分支 | 实际构建提交 |
| --- | --- | --- | --- | --- |
| test-agent | 5362874 #8 | SUCCESS | release/qa，isBranchMode=false | b05ac06b2dc1006c6e0bf1ba9e67824103021239 |
| test-agent-service | 5363213 #6 | SUCCESS | release/qa，isBranchMode=false | 9186b26674f81e071746054dfbef1991b873c26e |

固定目标迁移后，一个已结束沙箱工单的旧 QA 计划/验收缓存已失效，以便重开时针对 release/qa 重新 prepare。原值先备份到应用状态目录的0600文件，历史报告、远端提交及工作项评论保留；没有改写旧结果来假装新目标已验收。

最终 LC_ALL=C pnpm check：74文件、1519用例通过，类型检查及构建通过；git diff --check 通过。原型代码未提交、未推送。这里的原生流水线仅验证 release/qa checkout 和项目构建/单测；MR 清理、通知及分支重写行为由本地回归覆盖，没有声称重新完成整个云效工作项链路或重新部署 QA 应用。

证据：[分支保留](../.artifacts/qa-release-qa-20261103/branches.json)、[配置切换](../.artifacts/qa-release-qa-20261103/configuration.json)、[原生运行](../.artifacts/qa-release-qa-20261103/pipeline-runs.json)、[验收缓存迁移](../.artifacts/qa-release-qa-20261103/cache-migration.json)、[完整检查日志](../.artifacts/qa-release-qa-20261103/pnpm-check.log)、[验证范围](../.artifacts/qa-release-qa-20261103/verification.json)。服务重启后的运行状态和生效提示另记录于同目录 service-proof.json。

## 2026-11-03 QA 目标空闲迁移与索引回收

- 产品 skill 使用“例如 release/qa”，实际目标仍从 YAML 读取。说明 Codeup 的 release/* 保护也可能覆盖 release/qa；direct 需要该 QA 分支的推送权限，或选择 merge-request 并满足原生审批。本轮不修改服务端权限，release/{yyyymmdd} 发版识别逻辑未改。
- prepare 检测到目标变化后，查询受影响工程的运行中构建、最新/已记录构建及旧 QA MR。确认空闲才采用新目标，重跑全部本地单测，并使旧 receipt、交付意图和 QA 环境测试缓存失效。历史报告保留，不再要求人工备份清 KV。
- 运行中构建、排队/未完成运行、开放或状态不明的 MR 会阻止迁移；报错给出流水线/MR 和等待、取消或关闭后重新 prepare 的步骤。状态读取失败时不改旧计划。用例覆盖活跃运行列表、旧 receipt 对应运行仍在执行、MR 关闭后的重试及无权限/服务异常。
- 删除无人调用的 YUNXIAO.branch。MR 轮询删除 superseded、关闭/失联、孤立或归属无效的索引，保留 Ticket、follow 和历史游标；当轮退役集合防止旧快照继续轮询。真正待评审的索引即使工单以非修复结论结束也保留，不凭 receipt 推断原生 MR 已关闭。

迁移实测使用独立 SQLite 状态库，复用 SIQB-4 的旧 qa 发布信息和原沙箱工作树，只读查询真实云效运行/MR 状态，真实执行客户端6项、服务端4项单测。prepare 自动采用 release/qa 并清除独立库中的旧验收；未改实际服务库、工作树、云效工单、分支或权限。

完整检查：LC_ALL=C pnpm check，74文件、1533用例通过，类型检查及构建通过，git diff --check 通过。证据：[实际 prepare 迁移](../.artifacts/qa-idle-target-20261103/live-prepare-proof.json)、[完整检查](../.artifacts/qa-idle-target-20261103/pnpm-check.log)、[验证范围](../.artifacts/qa-idle-target-20261103/verification.json)。服务重启状态记录在同目录 service-proof.json。没有重新执行云效完整工单链路或受保护分支推送/审批；代码未提交、未推送。

## 2026-11-03 新工作项 SIQB-5：双模式冲突完整联测

[SIQB-5](https://devops.aliyun.com/projex/bug/bb8162e0f3465c11dc9cfaeb5e) 由已登录 Chrome 新建，覆盖同一工作项下两个工程。内部 Ticket 为 0ffb9ad9b7014760ac39fe009abb9bc8；前端选择 merge-request，后端选择 direct。两条流水线均使用 YAML 固定源 release/qa、isBranchMode=false，无自动触发器。

| 检查 | 实际结果 |
| --- | --- |
| 两模式真实冲突 | 两仓库先在 QA 增加 existing-qa-change，再由干净开发分支增加同名文件 workitem-change。前端 MR 和后端直接合并各返回一次实际 add/add 冲突；两次冲突和候选单测均早于任何新流水线启动。 |
| 开发分支纯净 | 两端 SIQB-5 都从各自 master 新建，只多一个本工单提交，无 merge 提交。新增文件均为本工单验收程序、测试、marker 和 .gitignore，master 原文件未改；冲突前后开发 HEAD 未变，开发 marker 只有 workitem-change。 |
| QA-only 冲突解决 | 两端只在 .qa/<仓库> 工作树的 SIQB-5-qa 分支合入 release/qa 并解决。候选与最终 QA 均保留两个 marker；最终 QA 同时包含开发和候选提交，开发不包含候选及 QA-only 历史。开发单测各18项，候选前端24项、后端22项通过。 |
| 原生 MR 替换 | [旧 MR !4](https://codeup.aliyun.com/62cf7f0b487c500c27f70f94/test-agent/change/4) 的 SIQB-5 → release/qa 已 CLOSED；[替代 MR !5](https://codeup.aliyun.com/62cf7f0b487c500c27f70f94/test-agent/change/5) 的 SIQB-5-qa → release/qa 已 MERGED。旧 MR 原生关闭时间早于替代 MR 合并时间，历史保留。 |
| 每工程一次流水线 | 原生列表基线为前端 #8、后端 #6。本工单仅新增前端5362874 #9、后端5363213 #7，均 SUCCESS。重复 integrate 和服务重启后的再次调用均返回相同运行号；完成后独立回读列表，仍只各增加一次。 |
| 实际 QA 测试 | 独立发布器按成功运行实际 checkout 提交部署本机常驻前后端，非 worker 临时启动。宿主执行 python3 tests/qa_acceptance.py，验证实际跨服务 HTTP、空格/中文姓名、404、两组件双 marker，以及两个部署的 repository/pipeline/run/integration_commit，输出 QA_DUAL_CONFLICT_MAIN_FLOW_PASS。 |
| 完成写回 | 宿主自动结束 Ticket 并将工作项置29“已修复”。最终结果评论24024868中 QA 集成行显示 test-agent、test-agent-service，无数字仓库 ID 代替名称。另有一条联测维护说明24023304，最终结果评论仅一条。 |
| 其他分支 | 对比两仓库全部远端分支基线，除预期推进 release/qa、新增 SIQB-5 和 SIQB-5-qa 外，既有分支 SHA 全部不变，包括旧 qa、SIQB-1 至 SIQB-4 及旧发布分支；无删除、强推或旧污染历史改写。 |

| 仓库 | 开发提交 | QA-only 候选 | 实际构建/部署 QA 提交 |
| --- | --- | --- | --- |
| test-agent | 4ee8feb4e5d952fcf32d65e403948f832e42c3ae | 33feafcd294066291cd55faadaa8d140dba48b14 | 44181a4a4ea9b4f7ba3a776f2da338536b77da55 |
| test-agent-service | ecd28bfd11ce185bd449b747580b4db79f3db551 | 75cdc3804714ac2f7939d3776a3d87017c9a7d0d | af6c61496ca702e3be582fec1314141b6af84332 |

本轮暴露并修复的核心问题：无 QA-only 候选时 prepare 返回两个值为 undefined 的可选属性，DSH 拒绝非 lossless JSON 回包；首次两次工具调用失败，不能计作通过。正常暂停、停止宿主后，改为省略不存在的字段，增加 JSON 往返及字段缺失回归。完整 LC_ALL=C pnpm check：74文件、1562用例、类型检查和构建通过；重启保留同一 Ticket 和 #9/#7，维护说明被 Source 接收后恢复，真实 DSH 无候选 prepare 回包成功，再重做含候选 prepare、复用运行和 QA 实测，通过后才完成本轮验收。

提交前审查同时修复了本地发现的故障窗口：不明确的创建运行结果保留待核实标记，读取滞后/失败不再创建第二次；已知运行号优先恢复，明确4xx拒绝可更正后重试。新修复周期原子失效旧 QA 计划/验收，同周期重试保留新证据。分诊问题经持久 Effect 发送，审批重读工作项、类别/负责人/状态/周期，读取失败保留重试，单问题并发回复只结算一次。上述均有回归覆盖；本轮真实联测只验证正常重复调用及重启复用，未在云端注入丢包、并发审批或重开故障。

本轮临时发布轮询器已停止；QA 服务 http://127.0.0.1:28841 和 http://127.0.0.1:28842 仍常驻且版本回读健康。宿主 paused=false、健康项无错误。所有累计代码、测试、YAML 和文档在 feat/yunxiao-integration 本地提交；不推送原型分支，其他聊天新增的 loop/ 保持原样、不纳入提交。

未覆盖：真实受保护分支的拒绝/人工审批（未改 Codeup 权限）、自动触发器的云端运行（本地门禁覆盖）、同事后续 QA 构建的实际部署（包含判断有本地回归）。本机 QA 沙箱验收不代表商业环境或生产业务验收，旧 SIQB-4 仍不可直接发版。

本地证据：[原生 MR 与运行](../.artifacts/qa-live-dual-conflict-20261103/native-proof.json)、[完成及最终 checkout](../.artifacts/qa-live-dual-conflict-20261103/completion-proof.json)、[分支纯净与保留](../.artifacts/qa-live-dual-conflict-20261103/branch-proof.json)、[冲突/启动时序](../.artifacts/qa-live-dual-conflict-20261103/sequence-proof.json)、[真实工具回包](../.artifacts/qa-live-dual-conflict-20261103/qa-tool-events.json)、[服务收尾](../.artifacts/qa-live-dual-conflict-20261103/service-proof.json)、[云效完成评论截图](../.artifacts/qa-live-dual-conflict-20261103/SIQB-5-completed.png)。这些 .artifacts 文件只留本机；上表原生链接、运行号、提交和状态随文档提交供回读。
