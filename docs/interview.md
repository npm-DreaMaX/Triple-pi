# Triple-pi 面试准备

## 30 秒项目介绍

"我给 Coding Agent 做了一个跨 Session 的 Memory 系统和 Agent 隔离审查系统。Agent 在对话结束后自动提取项目规则和偏好，下次启动时能记住。同时给 Agent 加了一个只读的代码审查能力，能检查 git 变更是否符合项目规则。"

## 2 分钟项目介绍

"项目基于 Pi Agent Runtime 的 Extension 体系，不修改底层源码。两个模块：

Memory 模块：Agent 启动时通过 `before_agent_start` 生命周期把项目记忆注入 prompt。Agent 休息时通过 `agent_settled` 触发自动提取——从对话中调用 LLM 提取候选、做完 secret 脱敏、evidence 逐字校验、Grounded Review 二次审核、去重合并后写入本地 Markdown 文件。每步失败都 fail-closed，不损失稳定性。还有一套生命周期状态机（30天冷态 / 90天归档），防止旧上下文污染。

Reviewer 模块：用 Pi 的 `createAgentSession` 创建一个完全隔离的只读 Session。工具白名单只有 read/grep/find/ls，代码级限制不是 prompt 约束。`Promise.race` 硬超时保证调用方在 deadline 后必返回。输出是严格校验的结构化 JSON。

验证分三层：确定性单元测试（无网络/零成本）做 CI 门；Recorded Eval 验证全链路接线；Live Eval 用真实 LLM 测量模型质量。Live Eval 是 opt-in 的，不猜模型不静默触网。"

## 简历 Bullets

1. 设计并实现了基于 Pi Extension API 的跨 Session 持久记忆系统，通过 `before_agent_start` 生命周期注入项目规则/偏好/决策，支持手动保存（用户确认写盘）和自动提取（secret redaction -> strict validation -> grounded review -> consolidation 六步管线，每步 fail-closed），文件级原子写入（temp+rename）和进程级文件锁实现并发安全。

2. 实现了隔离的只读代码审查 SubAgent，使用 `createAgentSession` 创建独立 Session，工具白名单（read/grep/find/ls）在代码级而非 prompt 级别限制，`Promise.race` 硬超时保护，严格结构化 JSON 输出校验，自动 git diff + Memory 检索实现上下文感知审查。

3. 建立了三层评估体系：确定性单元测试（无网络依赖/零成本）作为 CI 发布门，Recorded Eval 验证全链路接线正确，Live Eval（opt-in，需显式配置模型）用真实 LLM 测量统计指标（mean F1 / variance / worst F1 / FP rate / noise rejection rate）。

4. 设计了 30/90 天生命周期状态机（hot/cold/archive），基于 SHA-256(cwd) 的项目隔离策略避免了 monorepo 场景下的记忆污染，使用 proper-lockfile 进程锁 + temp+rename 原子写入 + 事务回滚（补偿事务）保证并发安全。

## 面试必问：做项目过程中遇到什么问题，怎么解决的

这是字节面试最高频的行为问题。以下是真实踩过的坑、怎么发现的、怎么修的。

### 问题 1：Reviewer 说"未发现问题"，实际是 JSON 解析失败了

**发现过程**：写 Demo 的时候发现 Reviewer 偶尔返回"未发现问题"，但 diff 明显有问题。加了日志才发现 Reviewer 输出的 JSON 格式不对，`parseReviewOutput` 返回了内部 status `"failed"`，但外层 `SubAgentManager.review()` 把这个 `"failed"` 包装成了 `"success"`，空 findings 被解释成"没有发现任何问题"。

**根源**：`manager.ts` 里外层 SubagentResult.status 写死为 `"success"`，没有把 parse/schema 失败传播出去。

**修复**：把返回值改成判别联合——`success | parse-failed | schema-failed | timeout | provider-failed | worktree-changed`，每种都有独立的 failure kind。parse 失败绝不再显示"未发现问题"。

### 问题 2：Live Eval 的 noise case 在 provider 崩溃时仍然 F1=1

**发现过程**：跑 Live Eval 发现 noise-only case 永远是满分。追进去看 `live-runner.ts`，发现 `runExtraction()` 抛异常后 catch 把 trace 标成 `commit-failed`，但继续从空 repository 读数据、算指标——noise case 期望也是零条，空 repository 也是零条，完美匹配，F1=1。

**根源**：没有区分"管道根本没成功运行"和"运行成功但结果为空"。exit code 只看 semantic metrics，不管 pipeline status。

**修复**：exit 2 = 任何管道失败（认证/provider/存储），exit 1 = 语义不匹配，exit 0 = 全部通过。并单独测试了 noise case 的所有失败模式。

### 问题 3：分支切换后旧分支的 extraction 仍然被提交

**发现过程**：读自己的 `ExtractionScheduler` 代码时注意到 `bumpGeneration()` 只增加 generation 不清空 pending。如果树切换前有 snapshot 在 pending 队列里，等当前 task 结束后 finally 会以新 generation 重新启动它——但它的内容属于旧分支。

**根源**：checkpoint commit 只检查 generation 是否匹配，不检查 sessionId 或 branchLeafId。

**修复**：job 显式携带 generation + sessionId + branchLeafId，checkpoint commit 三重校验；tree switch 同时 abort 当前任务并清空 pending。

### 问题 4：多关键词搜索其实只是一个长 substring 查询

**发现过程**：跑 Demo 的时候加了一行 `console.log(keywords)`，发现输出是 `"payment checkout condition"` — 一个空格连接的字符串。然后 `repository.search()` 把这个字符串当整体做 substring 匹配。如果 Memory 正文里只有 "timeout"，永远不会被 "payment checkout condition" 命中。

**Demo 能跑因为 Demo 自己逐个关键词搜了**。生产代码没有。

**根源**：`extractKeywords` 返回空格连接的字符串，然后只调用一次 `repository.search()`。

**修复**：改为每个 term 独立搜索、record ID 去重、优先级排序（类型名 > 符号名 > task 词 > 文件路径 > 兜底词），上限 15 词。

### 问题 5：std::npm run setup` 之后 Reviewer 根本不存在

**发现过程**：我想给项目加一个端到端测试——安装、然后调用 `review_current_changes`。结果发现安装后只有 Memory 工具，没有 Reviewer。追了一下 `install-extension.mjs`，它只 symlink 了 `extensions/memory`。

**根源**：Memory 和 Reviewer 是两个独立的 Extension，没有统一入口，也没有共享 repository。

**修复**：新建 `extensions/index.ts` 作为统一入口，创建唯一的 repository 同时传给 Memory 和 Reviewer。安装脚本改为安装整个 `extensions/` 目录。

### 面试时怎么讲

不用五个都讲。面试官问"遇到什么问题"时，挑一个你印象最深的展开——建议用**问题 1 或问题 2**，因为它们是"看起来功能正常但其实有隐蔽 Bug"，最能体现排查能力。

结构：
- 先说我做了什么（一句话）
- 然后说我发现什么不对劲（具体现象）
- 接着说我怎么排查的（代码路径、日志、假设、验证）
- 最后说怎么修的和验证

---

## STAR 故事

### STAR 1：Evidence Grounding 解决了自动记忆可信度问题

**情境**：旧系统自动提取的记忆经常包含 LLM 幻觉——提取的 evidence 引用在原始对话中根本不存在。如果一条错误记忆被持久化，会在后续所有 Session 中反复污染 Agent 决策。

**任务**：设计一个机制保证每一条自动记忆都有真实的对话依据。

**行动**：我在 strict validation 步骤中增加了 evidence 逐字校验——LLM 提取的 evidence 字段必须是 user message 中的逐字子串，assistant 内容不能做证据。同时把 reviewer 的权限限制为只能 keep/remove，禁止改写任何字段，避免二次调用引入新的幻觉内容。写入采用 temp+rename 原子操作配合事务回滚（备份恢复），防止半写残留。

**结果**：现在每条自动记忆都有一条可追溯到原始用户消息的证据引用。确定性测试和 Recorded Eval 验证了这个机制在所有 case 上正确工作。这是一个 precision-first 的设计——宁可漏存（下次可重试），不能存错（跨 session 污染）。

### STAR 2：项目隔离策略避免 Monorepo 污染

**情境**：大厂 monorepo 里有几十个共享同一个 git remote 的子项目。如果按 git remote 做身份标识，后端项目的规则会污染前端项目的记忆。

**任务**：设计一个不需要用户配置、开箱即用的项目隔离方案。

**行动**：我改用 cwd（当前工作目录）做项目身份——SHA-256(realpath(cwd)) 取前 20 个 hex 字符作为 stable ID。不同工作目录自动不同身份。`realpathSync` 处理符号链接场景。SearchMemory 和 `buildPrompt` 只搜索当前项目目录 + global 共享目录，物理隔离。

**结果**：相同代码 clone 到不同路径 → 不同项目 ID → 完全隔离。monorepo 的 `packages/backend` 和 `packages/frontend` 天然分离。200+ 测试覆盖了穿越、特殊字符和并发场景。

### STAR 3：Live Eval 的退出码策略揭露了旧测试的虚假通过

**情境**：旧 Eval 宣称 "10/10 全通过"，但实际上是 category-only 断言、默认 tolerance=1 覆盖 FN，且 provider 错误返回空结果被误判为"正确判断无记忆"。

**任务**：建立一个不会产生虚假通过的 Eval 体系。

**行动**：我把退出码分成三层——infra 错误（网络/认证失败）exit 2、语义错误（模型输出不符合 ground truth）exit 1、全通过 exit 0。Noise case 的 expected=0 且 predicted=0 时单独标记 noiseRejected，不混入 positive macro 指标。每个 case 的 expected 字段精确匹配 category/scope/title/content/evidence，双向一对一匹配防止一条记录匹配多个预期。

**结果**：Live Eval 现在每次运行都记录模型名、commit SHA、Node 版本、dirty flag、submodule SHA 和 case/prompt hash，结果可完全复现。任何基础设施错误都独立退出，不会伪装成正确结果。

## 字节高频追问

### Node Event Loop / 异步取消

Q: 后台提取任务怎么取消？

A: 用 AbortController + AbortSignal。`agent_settled` 创建 snapshot 时绑定 signal，传给 `runExtraction()`。如果 session 切换或 `session_shutdown` 触发，调用 `controller.abort()`。Provider 调用 `streamSimple({ signal })`，文件系统操作前检查 `signal.aborted`。注意：AbortController 只触发协作式取消，不能强制停止正在进行的 HTTP 请求。当前实现是"调用方在超时后先返回，底层请求继续但结果被丢弃"。

### 原子写入 / Crash Consistency

Q: 原子写入能防断电吗？

A: 不能完全防断电。Temp + rename 提供的是可见性原子性——其他进程永远不会看到半写文件。但 `writeFile(temp)` 的内容可能还在内核缓冲区，断电后丢失。完整的持久化需要 `writeFile` -> `fsync(temp)` -> `rename` -> `fsync(parent dir)`。对本地 Coding Agent 来说，最坏情况是断电丢失一条记忆，下次重试即可。增加 fsync 会增加延迟但对几十 KB 的 Markdown 文件影响有限，是下一步可做的改进。

### Git Staged / Unstaged

Q: Reviewer 怎么处理 staged 和 unstaged 的区别？

A: `collectGitChanges()` 分别调用 `git diff --cached`（staged）和 `git diff`（unstaged），以及 `git ls-files --others --exclude-standard`（untracked）。Staged 变更排在最前面。构建 review chunks 时按 staged > unstaged > untracked 排序，同文件 staged + unstaged 各自独立。Reviewer 看到的是纯文本 diff，不区分 staged/unstaged，由 prompt 中的标签说明变更来源。

### LLM Strict Parsing

Q: LLM 输出不是 JSON 怎么办？

A: `parseReviewerOutput` 做了多层保护：1) 去掉 markdown code fence（` ```json ` 包裹）；2) `JSON.parse` 尝试；3) 校验 schema——只允许 status/summary/findings 三个字段，状态必须是 passed/issues_found，summary 不能为空，severity 只能是 low/medium/high，line 必须是正整数；4) 一致性校验——passed 不能有 findings，issues_found 必须有 findings。任何一步失败都返回 ParseFailure 并记录原始文本。

### FP / FN / F1

Q: 怎么定义 FP 和 FN？

A: TP = 一条记录匹配一条 expected（双向一对一）。FN = expected 没被匹配的数量。FP = 多余的记录数 + 最多一次 forbidden 惩罚（所有 forbidden 内容只计一次预测级 FP）。关键规则：如果一条 matched 记录也包含 forbidden 内容，从 TP 降级。Noise case（expected=0）且 predicted=0 时标记 noiseRejected，precision/recall/f1 为 null（不混入 positive macro）。

### 分层 Eval

Q: 为什么不分 E2E 测试搞定？

A: 验证目标不同。确定性测试验证代码逻辑（不依赖 LLM），Recorded Eval 验证全链路接线，Live Eval 验证模型质量。混在一起会导致 LLM 随机性污染确定性测试结果。

### 作用域

Q: Project 和 Global 怎么隔离？

A: 文件系统物理隔离——`projects/<id>/entries/` 和 `global/entries/` 两个不同目录。SearchMemory 默认只搜当前项目 + global。生命周期独立——global 没有冷态/归档，一个冷项目不冻结用户的全局偏好。

## 不可过度声明清单

- "Production-ready" —— 当前是 RC 版本，没有企业级 soak test
- "完全防崩溃" —— temp+rename 不保证断电持久化，多文件"事务"是补偿事务不是 ACID
- "向量级语义理解" —— 搜索是基于关键词子串匹配，不是 embedding
- "100% secret 覆盖" —— 正则检测有遗漏，不覆盖自定义格式
- "多开发者共享" —— 当前是纯单用户设计

## 给字节 Agent 算法/后端工程师岗位的推荐叙事

如果面试官问"这个项目最有价值的部分是什么"，推荐这样回答：

> 我不只是调了个 LLM API。我真正花了时间的地方是：**怎么让 Agent 记住该记住的、忘掉该忘掉的、在不安全的时候什么都不做**。
>
> 自动 Memory 提取有六步管线，每一步失败都 fail-closed — secret 没脱干净就拒绝整批、evidence 不在原文里就拒绝写入、reviewer 想改写内容就 reject。跨 Session 污染的代价比漏存高得多，所以我选了 precision over recall。
>
> Reviewer 也是同样的思路 — 不是让模型"请别写文件"，而是代码级禁掉了所有写工具和扩展加载，审查前后的 worktree SHA-256 必须一致。这种"不信任模型、靠机制保证"的思路是我认为做 Agent 系统最核心的能力。

## 当前系统状态速查（面试前更新）

| 项目 | 值 |
|---|---|
| 全量测试 | 21 文件 / 178 测试 |
| Recorded Eval | 46 条 / 6 文件 |
| TypeScript | strict mode |
| Demo | 离线端到端，不依赖外部 API |
| 模型 | 通过环境变量切换（DeepSeek 兼容 OpenAI / Anthropic 等） |

## 面试必问：跟 Pi 生态已有的 Memory/SubAgent 插件有什么区别

> Pi 生态有 Memory 工具和 SubAgent 模板。但它们解决的是"能不能跑通"——存个文件、起个子会话。我的项目解决的是"生产环境里能不能信任"——不是加了更多安全功能，而是让每个环节都有可验证的正确性。
>
> 比如记忆提取：典型插件是 LLM 输出直接写盘。我是 6 步管线——secret 脱敏、evidence 必须是用户原话逐字子串（不是 assistant 说的）、reviewer 只能 keep/remove 不能改写任何字段、确定性的去重合并、进程锁下原子写入。每一步失败都终止写入。不是"更安全"，是"不会悄悄存错东西"。
>
> Reviewer 也一样。Pi 的 SubAgent 示例是 prompt 写"请只读"。我是代码级禁掉扩展、技能、上下文文件加载——只开放 read/grep/find/ls 四个工具——审查前后做 worktree SHA-256 快照对比。不是"更加隔离"，是"能证明它确实没改任何文件"。
>
> 评测也一样。不是跑一遍截个图。178 个确定性测试、46 条 recorded 全链路测试、opt-in 的 live eval 有三层 exit code——基础设施崩了 exit 2、语义不对 exit 1、全通过 exit 0。noise case 不会因为 provider 崩了就"正确拒绝噪声"。
>
> 规模不大，但每个功能都有可验证的正确性边界。

## 学习路线（仅项目相关）

1. Node.js `fs` 模块：`fs.rename` 原子语义、`fs.chmod` 权限、`fs.realpathSync` 链接解析
2. `proper-lockfile` 跨进程文件锁原理（stale timeout、retry strategy）
3. Pi Agent Runtime 生命周期：`agent_settled` vs `agent_end`、`before_agent_start`、`session_shutdown`
4. `crypto.createHash` SHA-256、`crypto.randomUUID`
5. TypeScript discriminated unions（`ReviewResultUnion`）、模板字符串、never type exhaustive check
6. Vitest fake timers、临时目录测试（`fs.mkdtemp`）、CI 无网络测试策略
7. 补偿事务模式（backup-try-rollback）
8. Git `diff --cached` / `diff` / `ls-files --others` 及其在代码审查中的应用
