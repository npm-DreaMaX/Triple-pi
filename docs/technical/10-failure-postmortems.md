# Triple-pi 故障复盘：从“能跑”到“可证明地不撒谎”

> 本文不是功能清单，而是一组基于当前源码、测试与提交历史重建的工程复盘。
>
> 文中的“旧实现”主要指 `82fb526` 统一整改之前的实现；“当前实现”指本文编写时的 `main`。凡是历史提交无法直接证明的动机，均按“推断”表述；凡是当前仍未闭合的缺口，会明确写成“遗留问题”，而不会把设计意图冒充为已实现保证。

## 0. 先定义复盘方法：什么才算一次真正的修复

Agent 系统最危险的故障通常不是崩溃，而是**把失败显示成成功、把推测保存成事实、把部分覆盖显示成完整覆盖**。因此每个问题都用同一套模板分析：

1. **症状**：用户或评测能看到什么。
2. **不变量**：系统本来必须永远满足什么。
3. **根因**：哪一层把不同语义压扁、遗漏或错误排序。
4. **旧测试为何漏掉**：测试替身、断言粒度或样本构造有什么盲区。
5. **修复**：代码如何恢复不变量。
6. **回归**：什么测试才能防止问题换一种形式回来。
7. **通用经验**：可迁移到其他 Agent、异步任务和本地存储系统的原则。

复盘时尤其区分三类状态：

- **业务空结果**：管线成功执行，结论确实为空，例如“没有值得保存的记忆”。
- **覆盖不完整**：只审查了部分输入，不能推出整体通过。
- **基础设施失败**：模型、解析、Git、存储或调度失败，根本没有形成业务结论。

如果三者共享同一个 `[]`、`false` 或 `success`，fake success 几乎必然发生。

---

## 1. Working State contract：把助手自述误当成已验证事实

### 症状

早期 Working State 使用 `currentRequest` 与 `latestOutcome`，并把生成的 Working State 直接拼入 system prompt。字段名 `latestOutcome` 很容易被读取方理解成“任务真实完成结果”，而它实际上只是最近一条 assistant 消息的文本。若 assistant 声称“测试已通过”但没有真正运行测试，下个 turn 会把这个自述继续带入上下文。

旧 checkpoint 的校验也只检查外层 `version/sourceHash/lastEntryId/branchLeafId`，嵌套 `state` 没有深校验。手工修改、旧版本残留或损坏数据可能被渲染进上下文。

### 必须维护的不变量

1. Working State 是**派生、临时、不可信**的上下文，不是 durable memory。
2. `assistantReportedOutcome` 只代表 assistant 的报告，不代表外部世界已验证。
3. 任意从磁盘或 session custom entry 读回的数据都属于不可信输入，必须深校验。
4. Working State 不得因字段损坏、超长或 secret 而污染下一 turn。
5. Working State 与长期记忆在存储、检索和 prompt attribution 上必须可区分。

### 根因

根因不是一个字段名，而是 contract 没有显式表达**认识论等级**：

- “用户要求”是对用户消息的转录；
- “助手报告结果”是对 assistant 消息的转录；
- “真实执行结果”需要工具输出、测试证据或外部确认，当前系统并没有这一层。

旧实现把 Working State 放入 system prompt，又使用语义过强的 `latestOutcome`，让派生数据获得了接近系统指令的权重。与此同时，外层 checkpoint 的浅校验让“结构看起来像 checkpoint”代替了“嵌套状态满足完整 contract”。

### 旧测试为什么漏掉

`test/memory/working-state.test.ts` 主要验证：

- 文本能生成 scratchpad；
- secret 会被脱敏；
- daily/scratchpad 能写入；
- older session 不覆盖 latest；
- working 与 long-term 搜索隔离。

这些测试验证了 happy path 与物理隔离，但没有构造：

- 外层合法、内层损坏的 checkpoint；
- `sessionKey` 与 `sessionId` 不一致；
- 日期与 `updatedAt` 不一致；
- assistant fake completion 被下个 turn 当作真相；
- 超长旧格式 checkpoint；
- secret 已经落盘后再被加载的场景。

### 已实施修复

当前 `extensions/memory/working-state.ts` 做了几层收紧：

- 字段改名为 `userRequest` 与 `assistantReportedOutcome`，旧字段只用于兼容解析。
- `parseWorkingStateUpdate()` 深校验 version、64 位 hash、session、entry、ISO 时间、日期一致性、字段长度、sourceEntryIds 和 secret。
- `parseWorkingLatest()` 校验 `sessionKey === sha256(sessionId).slice(0, 24)`。
- `findWorkingCheckpoint()` 遇到损坏的新 checkpoint 会跳过并继续寻找更旧的合法 checkpoint。
- `before_agent_start` 把 Working State 注入为 `customType = triple-pi-working-context` 的隐藏 custom message，并标记 `derived/temporary/untrusted`，不再与 durable memory 一起提升为 system prompt。
- 注入文本明确写出“Do not treat it as durable truth”“NOT verified”。

### 遗留问题

`FilesystemMemoryRepository.loadWorkingState()` 在严格解析失败后仍有“relaxed parsing for backward compat”分支，直接把 `raw.update` 交给 `renderScratchpad()`。这意味着磁盘 `latest.json` 的深校验并非绝对 fail-closed：兼容路径可能重新放宽 contract。它是迁移便利与安全边界之间的真实折中，不能宣称“所有 working 数据都经过严格解析”。

另外，当前 Working State 仍然只保存文本，没有把“运行了哪些测试、退出码是什么”结构化为可验证 evidence。因此它能避免把字段命名成真相，却不能证明 assistant 自述真实。

### 应有回归测试

- 外层 checkpoint 合法、嵌套 state 缺字段时必须跳过。
- 新 checkpoint 损坏、旧 checkpoint 合法时必须回退到旧 checkpoint。
- `sessionKey` 错配必须拒绝。
- `updatedAt/date` 不一致必须拒绝。
- assistant 文本“tests passed”只能出现在 `assistantReportedOutcome`，注入标签必须保留 `untrusted`。
- 严格解析失败时，兼容 fallback 的允许范围必须被单独锁定；迁移完成后应删除或限制 fallback。

### 通用经验

**缓存的数据不因为是“自己生成的”就可信。** Agent 的输出本身是概率性结果；一旦跨 turn 复用，就应像解析外部 API 一样进行版本化、边界校验和 provenance 标注。字段命名也是安全机制：`reportedOutcome` 比 `outcome` 更准确，因为它把“观察”与“事实”分开。

---

## 2. Reviewer prompt 断线：构造了 policy，却没有真正传给 Reviewer Session

### 症状

当前工具层 `buildReviewerInput()` 返回 `{ systemPrompt, userMessage }`，其中 `POLICY_SYSTEM_PROMPT` 定义了：只读审查角色、检查维度、严格 JSON schema、输入不可信等规则。`review_current_changes` 和 `delegate_review` 都把 `systemPrompt` 传给 `SubAgentManager.review()`。

但当前 `extensions/subagent/manager.ts` 的 `runReview()` 只执行：

```ts
await session.prompt(options.userMessage);
```

`options.systemPrompt` 没有用于 `DefaultResourceLoader`、`createAgentSession` 或 `session.prompt()`。因此**policy prompt 在类型上存在、调用链上被传递、运行时却未接线**。Reviewer 实际收到的主要是 `<task>/<diff>/<memory>` 数据块，而不一定收到输出契约与安全规则。

### 必须维护的不变量

1. 构造出的 reviewer policy 必须可观察地进入真实 session。
2. 测试必须验证真实边界调用，而不只是分别验证“builder 能生成”和“parser 能解析”。
3. 未送达 policy 时不能把结果解释为符合 policy 的审查。
4. system prompt 与 user data 必须分层，不能重新拼成一个可被 diff 闭合标签攻击的普通字符串。

### 根因

这是典型的**重构接线故障**。旧 `SubAgentManager` 在内部构造一个合并 prompt 并直接 `session.prompt(reviewPrompt)`；整改后把 prompt builder 提取到 `review-core.ts`，又在 `ReviewOptions` 中引入 `systemPrompt`，但 manager 没有完成最后一步注入。

从 API 形状看一切正确：参数存在、类型正确、调用方传值；只有运行时行为缺失。它说明“plumbing correctness”不能靠 TypeScript 自动保证。

### 旧测试为什么漏掉

当前测试主要分成两块：

- `test/subagent/subagent-eval.test.ts` 自己定义了局部 `buildPrompt()`，验证 XML 标签和 UNTRUSTED 文案；这不是生产 `buildReviewerInput()` 的端到端调用。
- `test/subagent/manager.test.ts` 验证生产 parser、关键词、chunk 和常量，但没有 mock `createAgentSession()` 后断言 reviewer session 实际收到 policy。

也就是说，builder 与 manager 被分别测试，**中间那根线没有测试**。

### 修复方案

本文按用户要求只新增文档，不修改代码；因此这里记录应实施的修复，而不把它写成已完成：

1. 通过 Pi Runtime 支持的正式机制把 `POLICY_SYSTEM_PROMPT` 设置为 reviewer session 的 system prompt；如果 SDK 不支持 per-session override，应由 resource loader 或 agent session 配置注入，而不是静默丢弃。
2. 若只能使用单消息入口，也应构造一个不可歧义的顶层 prompt，并明确承认它不具备真正 system-role 隔离。
3. 删除未使用参数是不够的；那只会让断线更显眼，却不会恢复 policy。
4. 增加 manager 级集成测试，捕获 `session.prompt`/session config 的真实输入，断言 policy 与 user data 都送达且角色正确。

### 回归测试

- 使用 mock session 捕获最终系统上下文，必须包含 `OUTPUT FORMAT` 和 `SECURITY NOTICE`。
- 恶意 diff 包含 `</diff>`、伪造 system prompt、Markdown fence 时，只能出现在编码后的 user data。
- 删除 `systemPrompt` 注入应使测试立即失败。
- 不允许测试复制一份 prompt builder；必须调用生产 `buildReviewerInput()`。

### 通用经验

**未使用参数是架构断线的烟雾报警器。** 对 LLM 系统尤其如此：prompt 并不是普通字符串常量，而是运行时安全策略。测试必须跨过 provider/session 边界验证“模型真正看到了什么”。

---

## 3. Fake success：解析失败被包装成“未发现问题”

### 症状

历史实现中，`parseReviewOutput()` 能返回内部 `status: "failed"`，但外层 manager 始终构造 `SubagentResult.status = "success"`。空 findings 随后被 UI 格式化为“未发现问题”。这是一种比 crash 更严重的故障：系统没有完成审查，却给出了通过语义。

`docs/interview.md` 已记录该历史事故。当前 manager 已改为 `ReviewResultUnion`，能区分 `parse-failed/schema-failed/provider-failed/timeout/aborted`。

### 必须维护的不变量

- `passed` 只能来自成功解析且 schema 一致的 reviewer 输出。
- 空 findings 只表示“成功审查且未发现问题”，不能表示“没有输出”“解析失败”或“某 chunk 失败”。
- partial coverage 不能升级为 complete pass。
- failure kind 必须保留到最终 UI/调用者，不得在中间层重新压扁。

### 根因

根因是多层状态模型不一致：parser 有三态，manager 只有 success/failed/timeout，formatter 又用 findings 是否为空推断是否通过。每经过一层，失败信息就少一部分，最后只剩 `[]`。

### 旧测试为什么漏掉

旧测试直接测试了一份复制的 `parseReviewOutput` 逻辑，却没有走“parser → manager → formatter”全链路。即使 parser 正确返回 failed，也无法发现 manager 把它包装成 success。

这是“测试实现副本”的典型危害：副本能证明测试里的函数正确，不能证明生产接线正确。

### 已实施修复

- `parseReviewerOutput()` 返回判别联合 `ParseSuccess | ParseFailure`。
- manager 将 parse/schema/provider/session/timeout/abort 分开返回。
- formatter 针对各 failure kind 输出不同错误，不再在 direct review 路径把 parse failure 显示为通过。
- schema 增加一致性校验：`passed` 不得携带 findings，`issues_found` 不得为空。

### 当前仍存在的二次 fake success

`review_current_changes` 的 chunk orchestration 又把 manager 结果转换成局部 `parseOk`：失败 chunk 被变成 parse failure交给 `aggregateFindings()`；聚合后无论是否有失败，都会创建：

```ts
status: "success"
summary: aggregated.findings.length === 0 ? "未发现问题" : ...
```

若所有 chunk 都失败，`coverage` 是 `partial`，但 summary 仍可能是“未发现问题”，最终走 `formatSuccessResponse()`。这说明 direct path 的修复没有完全传播到 multi-chunk path。

### 应有修复与回归

- 聚合结果必须至少区分 `complete-pass`、`complete-issues`、`partial`、`failed`。
- `parsedChunks === 0` 必须是 failed，不得产生“未发现问题”。
- `0 < parsedChunks < totalChunks` 只能返回 partial，并在首行明确“不能判定整体通过”。
- 所有 chunk 成功且所有结果 passed，才能输出完整通过。
- 增加真实 orchestrator 测试：单 chunk parse failure、全部 failure、部分 failure、timeout 后 late success。

### 通用经验

**不要从空数组推导成功。** 成功应由显式状态证明，数组只是成功结果的 payload。任何 fan-out/fan-in 架构都需要在聚合时保留失败集合，而不是只聚合成功 payload。

---

## 4. Staged + unstaged：同一个文件的两层改动被错误去重

### 症状

Git 允许同一个文件同时存在 staged 与 unstaged 修改。当前 `collectGitChanges()` 先加入 staged 版本，再处理 unstaged；但对 unstaged 使用：

```ts
if (!changes.some((c) => c.path === file && c.status === "staged")) {
  changes.push(...unstaged...)
}
```

因此同一路径一旦有 staged entry，unstaged diff 会被丢弃。Reviewer 看到的是 index 与 HEAD 的差异，而不是完整 working tree 状态；开发者刚改但未 stage 的修复/缺陷可能完全不在审查输入中。

### 必须维护的不变量

1. 审查“当前未提交改动”时，输入必须覆盖 staged、unstaged、untracked 三类。
2. 同一路径处于多个 Git 状态时，不能仅按 path 去重。
3. coverage 必须基于实际纳入的 diff，而不是 `git status` 中出现过的文件数。
4. 若产品语义是“只审 commit candidate”，则必须明确只审 staged，而不是名为 current changes 却隐式丢掉 unstaged。

### 根因

数据模型把 `ChangeFile.status` 设计成单值联合，而 Git 对单个路径的状态本质是二维的 index/worktree 状态。实现试图避免重复文件，却把“同路径的两个不同 diff”误当成重复数据。

### 旧测试为什么漏掉

`test/subagent/manager.test.ts` 和 `test/subagent/subagent-eval.test.ts` 使用一个 staged 文件和另一个 unstaged 文件。它们证明排序能处理两种状态，却没有构造**同一路径同时 staged + unstaged**的真实 Git 仓库。

此外测试直接构造 `ChangeFile[]`，没有执行生产 `collectGitChanges()`，因此无法发现采集阶段已经丢数据。

### 修复方案

可选设计有两种：

- 保留两个 entry，以 `(path, status)` 为身份；review prompt 明确标注 index diff 与 worktree diff。
- 将一个路径建模为 `{stagedDiff?, unstagedDiff?, untrackedContent?}`，格式化时分别输出。

不应简单拼接后丢掉来源，因为 reviewer 可能需要判断“修复只存在于 unstaged，实际 commit 仍有 bug”。

### 回归测试

在临时 Git 仓库中：

1. 创建文件并 commit；
2. 修改第一处并 `git add`；
3. 再修改第二处但不 stage；
4. 调用生产 `collectGitChanges()`；
5. 断言两个 hunk 都进入 reviewer 输入，且来源标签正确。

还应覆盖 staged rename + unstaged edit、staged delete、路径带空格和非 ASCII 字符。

### 通用经验

**不要用业务主键消除状态机中的多维事件。** 同一实体在不同层的变更不是重复；它们可能代表不同发布边界。

---

## 5. Oversize / skipped：分片存在不等于覆盖完整

### 症状

当前 `buildReviewChunks()` 以 12,000 字符为目标分片，但当单个文件本身超过上限时，会直接创建一个超过上限的 chunk。代码只在“当前 chunk + 新文件”溢出时换 chunk，不会拆单文件。

binary/unreadable 文件会进入 `skipped`，但工具层只解构 `{ chunks, skipped }`，后续并未把 `skipped` 纳入 final coverage 或用户输出。如果所有文件都 skipped，结果被映射为 `status: no-changes`，把“有变更但无法审查”错误表示成“没有变更”。

### 必须维护的不变量

- 任一 chunk 都不得超过声明的硬上限，除非显式标记 oversize。
- skipped、binary、unreadable、truncated 必须降低 coverage。
- “没有变更”与“有变更但不可审查”必须是不同 failure kind。
- complete coverage 必须证明所有目标字节或所有目标 hunk 被纳入。

### 根因

分片算法按文件作为不可分割单元，却把 `maxCharsPerChunk` 命名和文档写成硬上限。coverage 的计算又只看 chunk parse 成功数，不看采集阶段被跳过的文件。

### 旧测试为什么漏掉

- 大文件测试只断言“产生至少两个 chunk”，没有断言 `every(chunk.charCount <= max)`；两个 15KB 文件在 10KB 上限下会产生两个 15KB chunk，测试仍通过。
- skipped 测试只验证 `buildReviewChunks().skipped` 有值，没有走最终 formatter。
- 没有测试 binary-only changes 应返回什么 failure kind。

### 修复方案

- 按 hunk 或安全文本边界拆分单个大文件；每段保留 path/status/part 序号。
- 无法安全拆分时，标记 `oversize` 并返回 partial/failed，而不是悄悄发送超大 prompt。
- coverage 输入应包含 `totalFiles/reviewedFiles/skippedFiles/truncatedChars`。
- binary-only 应返回 `unreviewable-changes`，不是 `no-changes`。
- final summary 必须列出 skipped 路径与原因。

### 回归测试

- 单文件 30KB、上限 10KB：所有 chunk 不超过上限且内容无丢失，或显式 oversize failure。
- 混合 text + binary：coverage 必须 partial。
- 全 binary：不得返回 no-changes/pass。
- unreadable 与 deleted file 分开处理；删除 diff 本身可审，不应因文件读取失败自动 skipped。

### 通用经验

**Coverage 是输入层指标，不是模型输出层指标。** 所有模型调用都成功，也不代表所有输入都被审查。分片系统必须从采集、切片到聚合全程做 conservation accounting。

---

## 6. Scheduler stale pending / offset：旧分支任务在新 generation 中复活

### 症状

调度器允许一个 in-flight extraction 和一个 latest-wins pending snapshot。树切换时 `bumpGeneration()` 增加 generation 并 abort 当前任务，但当前实现保留 pending。旧 pending 会在 current task 的 `finally()` 中被重新 `start()`；新调用读取的是**新的 generation**，于是旧分支 snapshot 可能以新 generation 身份继续执行。

offset 继承同样有问题：当新的 snapshot 到来时，只有“已经存在 pending”才尝试处理 offset，而且把新 snapshot 的 `lastProcessedEntryId` 设为旧 pending 的 offset，而不是刚完成任务的 checkpoint `lastEntryId`。第一次 pending 没有继承；多次 pending 可能继续携带 stale/undefined offset。

### 必须维护的不变量

1. snapshot 的分支身份与 generation 在入队时冻结，不能重派时重新取得合法身份。
2. tree switch 后，旧分支 pending 不得执行或提交。
3. 同一分支连续 settled 时，下一个 delta 的起点必须是前一成功 checkpoint。
4. 失败不得推进 offset；成功 offset 不得丢失。
5. 不应通过原地 mutation 修改调用方 snapshot。

### 根因

- generation 绑定在“开始执行”而不是“入队”。
- pending 只存 `ExtractionSnapshot`，没有 enqueue generation/branch ancestry。
- offset propagation 分散在 `start()` 的入队分支与 `.then()` 中，状态转移不是一个原子步骤。
- 注释曾声称 tree switch 会清 pending，但实现 `bumpGeneration()` 没有清理，设计与代码漂移。

### 旧测试为什么漏掉

当前仓库没有独立的 scheduler 测试文件。coordinator 测试验证单次 `runExtraction()`，extension integration 也没有用可控 deferred promise 构造：

- in-flight A；
- pending A2；
- tree switch B；
- A 迟到完成；
- finally 重派 A2。

没有这个交错，generation race 永远不会出现。

### 修复方案

- 队列元素使用不可变 `SchedulerJob {generation, sessionId, branchLeafId, snapshot}`。
- `bumpGeneration()` 必须清除所有不属于新树的 pending；若要保留，必须证明 pending 是新分支祖先，而不是只比 sessionId。
- in-flight 成功时，在锁定的状态转移中生成下一 snapshot，并把 checkpoint `lastEntryId` 写入下一 job；不要原地 mutate 外部对象。
- commit gate 校验 generation、session、branch identity、abort，以及必要时 leaf ancestry。
- 对 pending 采用明确策略：latest-wins、FIFO 或 coalescing，不能靠偶然覆盖。

### 回归测试

使用 deferred provider 精确控制完成顺序：

- A running，A2 pending，切 B，A 完成：A/A2 均不得在 B 提交。
- 同分支连续三次 settled：第二次 source 从第一次 checkpoint 后开始，第三次从第二次后开始。
- 第一次失败：pending 必须从旧 checkpoint 重试，不得跳过失败 delta。
- shutdown 后迟到 resolve：不得 append checkpoint。

### 通用经验

**Generation counter 只有在任务出生时绑定才有意义。** 如果 stale 任务能在重新调度时领取新 generation，它就像过期令牌被重新签发。异步调度的正确性必须用交错测试，而不是普通 await happy path。

---

## 7. Metadata rollback：备份发生在副作用之后

### 症状

`saveExtractionBatch()` 希望用 backup → write → reverse rollback 实现补偿事务。但当前流程在构建完整 backup set 之前先调用了一次：

```ts
await this.writeActiveMetadataUnlocked(project);
```

随后才读取 `project.json` 作为 backup；此时读到的已经是新 metadata。真正 write phase 又写一次 metadata。若后续 manifest 写失败，rollback 恢复的是“第一次新写入”的值，而不是事务开始前的值。

如果事务前没有 `project.json`，rollback 分支只在 `prevMeta !== undefined` 时恢复，也不会删除事务中新建的 metadata。

### 必须维护的不变量

- staging/plan 阶段无副作用。
- 所有将被修改的权威文件必须在第一次写前备份。
- 原先不存在的文件回滚后仍应不存在。
- manifest 必须最后发布；manifest 失败时，entries、revision、reinforcement、metadata 都恢复。

### 根因

`writeActiveMetadataUnlocked()` 同时承担“计算 metadata”与“写文件”两个职责。调用方只是想准备 metadata，却提前产生副作用。补偿事务最容易被这种 command/query 混合破坏。

### 旧测试为什么漏掉

repository 测试覆盖并发、索引失败、collision、reinforcement，但没有 fault injection：无法让第 N 次 `atomicWrite()`、manifest write 或 metadata write 确定失败，也没有比较事务前后的整棵目录树。

### 修复方案

- 提取纯函数 `buildActiveMetadata(previous, project, now)`。
- 在任何写入前枚举 write set，读取所有 backup。
- write phase 只执行一次 metadata write。
- rollback 对 `undefined` backup 执行删除，对有值 backup 执行恢复。
- 将 rollback errors 记录到持久 diagnostics；当前接口虽然定义 `rollbackFailureCount`，但 `buildDiagnostics()` 固定返回 0，尚未闭合。

### 回归测试

- manifest write 故障：新 entry/revision/reinforcement/project.json 全部恢复。
- 原来无 project.json：回滚后必须不存在。
- 原来有旧 lastActiveAt：回滚后字节级一致。
- rollback 自身某一步失败：原始错误仍保留，并附带 rollbackErrors，diagnostics 增量可观察。

### 通用经验

**补偿事务的第一条规则是：备份之前不能写。** 若 helper 名叫 `getOrCreate`、`ensure`、`writeActive...`，就应默认它有副作用，不能出现在 staging 阶段。

---

## 8. Scope provenance：先归一化，后审计，导致“用户请求过 global”被抹掉

### 症状

自动提取允许模型提出 `scope: global`，但只有 evidence 明确表达跨项目时才保留 global；否则应降级为 project，并记录：

- requested = global
- resolved = project
- reason = missing-cross-project-evidence

当前 `validateCandidates()` 先调用 `resolveAutomaticScope()`，然后把 `candidate.scope` 覆盖成 resolved scope。coordinator 后续 `buildScopeDecision(candidate.scope, evidence)` 接收到的已经是 project，于是 provenance 只能记录 `requested: project, reason: default-project`。原始请求被不可逆抹掉。

### 必须维护的不变量

- enforcement 使用 resolved scope；审计同时保留 requested 与 resolved。
- downgrade 不能伪装成“从未请求 global”。
- record 的物理位置必须由 resolved 决定。
- reviewer 不能改变 requested/resolved。

### 根因

归一化函数返回单一 `MemoryScope`，而不是一个带 provenance 的 decision。数据在安全决策处被压缩，后续再也无法重建原因。

### 旧测试为什么漏掉

pipeline 测试验证 project candidate 与 evidence grounding，没有断言“模型请求 global 但证据不足”的 record provenance。coordinator 测试也只检查 source/session/hash、score/fingerprint/reinforcement。

### 修复方案

- validation 返回 `{...candidate, requestedScope, scope: resolvedScope, scopeDecision}`，或让 `resolveAutomaticScope` 返回完整 decision。
- reviewer schema验证 resolved scope 与 candidate 一致；requested scope 不交给 reviewer改写。
- repository 保存时验证 `provenance.scopeDecision.resolved === record.scope`。

### 回归测试

覆盖三种矩阵：

1. requested project → resolved project → default-project；
2. requested global + 明确跨项目 evidence → resolved global；
3. requested global + 普通项目 evidence → resolved project + missing-cross-project-evidence。

### 通用经验

**安全归一化不能销毁原始意图。** 审计日志至少需要 input、decision、reason、effective value 四部分；只存 effective value 无法解释为什么系统做了这个决定。

---

## 9. Revision pointer：生成了 UUID，但没有形成可遍历的链

### 症状

系统同时保存 head record 与 immutable revision snapshot，但当前存在多套独立 UUID：

- coordinator 为 replace plan 预生成 provenance revision pointer；
- repository 构造 record 时再次覆盖 `provenance.revision`；
- revision snapshot 又生成第三个 `revisionId` 作为文件名和 snapshot ID。

这些 ID 没有稳定对应关系。尤其当 existing record 没有旧 revision pointer 时，repository 的覆盖逻辑可能把 coordinator 生成的 first revision pointer改回 `undefined`。即使有 pointer，head 的 `previousRevisionId` 指向旧 head pointer，也不一定等于刚写入 snapshot 的 `revisionId`。

结果是“磁盘上有 revision 文件”和“head 上有 revision pointer”分别存在，但未必构成可沿 pointer 遍历的链。

### 必须维护的不变量

1. 替换前的 head snapshot 必须有唯一 revisionId。
2. 新 head 的 `previousRevisionId` 必须精确指向该 snapshot，或采用明确定义的相反方向。
3. 每次 replace 只有一个组件分配链 ID。
4. rollback 时 snapshot 与 head 一起恢复。
5. `listRevisions/getRevision` 与 head pointer 使用同一 identity model。

### 根因

revision ownership 没有单一来源。coordinator 负责业务 plan，repository 负责物理事务，两层都尝试“顺手补齐”revision，导致 pointer 被覆盖。

### 旧测试为什么漏掉

当前 repository 测试只验证 same-title 更新保留 `createdAt`，没有：

- 连续三次替换后遍历 revision chain；
- 断言 head.previousRevisionId 对应真实 snapshot 文件；
- batch replace 与 manual save 使用相同语义；
- rollback 后不存在孤儿 revision。

### 修复方案

建议 repository 成为 revision ID 的唯一 owner：

1. 读取 previous head；
2. 生成 `snapshotRevisionId`；
3. 以该 ID 写 previous snapshot；
4. 新 head 的 `revision.previousRevisionId = snapshotRevisionId`；
5. 新 head 自身是否需要 `revisionId`，必须定义清楚：若 head 不是 immutable revision，就不应伪造一个无法读取的 ID。

另一种模型是 event chain，但也必须让每个 pointer 指向真实可读取对象。

### 回归测试

连续更新 v1 → v2 → v3：

- listRevisions 返回 v1、v2；
- v3 head 指向 v2 snapshot；
- v2 snapshot 能继续指向 v1（若 schema 定义链式 pointer）；
- 所有 ID 对应实际文件；
- 故障回滚后无 orphan snapshot。

### 通用经验

**UUID 不等于版本链。** 版本链需要 identity ownership、方向定义、引用完整性和事务边界。没有可达性测试的 pointer 只是 metadata 装饰。

---

## 10. Metrics：把“没有预测”伪造成满分，以及汇总数组错位

### 症状

历史 Live Eval 中，provider 失败后 repository 为空；noise case 的 expected 也为空，于是旧指标给出 F1=1。基础设施失败被伪装成“正确拒绝噪声”。

当前 `evaluateRecords()` 已把 noise case 的 precision/recall/F1 设为 null，并单独输出 `noiseRejected`。Live runner 也用 exit 2 表示 infra/pipeline failure。

但 `eval/evidence.ts::computeSummary()` 仍有潜在数组错位：它先过滤掉 null precision，再用过滤后数组的索引读取未同步过滤的 recall。若 observations 中间有 precision undefined 的正样本，后续 precision 会配到错误的 recall。全量 `precisions` 与 `recalls` 也有同类问题。

### 必须维护的不变量

- infra failure 不参与语义成功判定。
- `0/0` precision 是 undefined，不是 1。
- noise rejection 与 positive F1 分开汇总。
- precision 与 recall 必须来自同一 observation pair。
- summary 必须可从 raw observations 确定性重算。

### 根因

第一类根因是把“空集合等价”当成管线成功；第二类根因是先分别过滤指标再按数组位置配对，破坏 observation identity。

### 旧测试为什么漏掉

历史测试偏重 category/内容匹配，没有注入 provider failure 并检查 exit code。当前 `metrics.test.ts` 很好地锁定了 null/noise/forbidden，但 `computeSummary()` 的测试覆盖不足，没有构造 `[defined, undefined, defined]` 的交错序列验证配对。

### 已实施修复

- per-case noise 指标独立表达；
- forbidden 命中可把 matched record 从 TP 降级；
- positive macro 排除 noise；
- Live Eval 无模型、认证失败、provider 不可用或 extraction 异常使用 exit 2；
- 报告记录 commit、dirty、submodule、model、case/prompt hash。

### 仍需修复

- `computeSummary()` 应按 observation 逐项构造 `{precision, recall, f1}`，再过滤完整 tuple，不能分别过滤数组。
- infra observations 应明确排除语义 macro，而不是只计数。
- noise case 有 FP 时仍属于 noise case，只是 rejection=false；不能因为 `noiseRejected !== true` 就混入 positive observations。
- runner 当前异常后仍计算 metrics 并打印可能的语义符号；报告应把该 observation 标为 infra-invalid，避免读者误用其 F1。

### 回归测试

- provider failure + noise expected=0：exit 2，不能计入成功率。
- observation 序列中间 precision undefined：后续 F1 必须仍与自身 recall 配对。
- noise with FP：计入 noise rejection denominator，不进入 positive macro。
- raw summary 重算必须字节级一致。

### 通用经验

**指标的第一职责不是好看，而是不说谎。** undefined 应保留为 null；失败样本应标 invalid；汇总必须保持 observation identity。一个漂亮但混入 infra failure 的 F1 比没有 F1 更危险。

---

## 11. Installer 覆盖：安装成功了 Memory，但 Reviewer 根本没被安装

### 症状

旧安装脚本只把 `extensions/memory` symlink 到 Pi agent 目录。源码里虽然存在 Reviewer 扩展，但标准 setup 后运行时只加载 Memory，`review_current_changes` 根本不存在。

这是一类部署接线故障：开发仓库中的功能不等于用户安装后的功能。

### 必须维护的不变量

- 标准安装路径必须加载产品声明的所有扩展能力。
- Memory 与 Reviewer 必须共享同一 repository，否则 reviewer memory search 与 memory extension 可能观察不同根目录/实例。
- 安装器必须幂等、能修复 broken symlink、拒绝覆盖普通目录。
- 迁移旧链接时不能删除不属于本项目的用户路径。

### 根因

功能按目录独立开发，安装器沿用 memory-only 时代的 source path。没有统一 extension entry，也没有 install → runtime registration 的端到端验证。

### 旧测试为什么漏掉

旧 installer 测试只断言目标 symlink 存在且幂等；目标本身就是 `extensions/memory`，所以测试与错误实现完全一致。它没有断言 Reviewer tool 注册。

### 已实施修复

- `extensions/index.ts` 成为统一入口。
- 入口创建一个 repository，同时传给 `registerMemoryExtension` 与 `registerSubagentExtension`。
- installer 攁为链接整个 `extensions/` 到 `extensions/triple-pi`。
- 测试覆盖幂等、broken symlink、普通目录拒绝和 legacy memory symlink 迁移。

### 遗留问题

当前测试仍停在文件系统链接层，没有启动真实 Pi loader 并断言 `SaveMemory/SearchMemory/review_current_changes/delegate_review` 四个工具均注册。安装器后来还增加了 global launcher，但 `test/scripts/install-extension.test.ts` 没有隔离 HOME，也没有断言 launcher 目标；测试可能触碰开发者真实 `~/.local/bin`，且无法证明 Windows 脚本安装行为。

### 回归测试

- 隔离 HOME、PI_CODING_AGENT_DIR 与 PATH；安装后启动最小 loader，枚举工具。
- 断言 Memory 与 Reviewer 收到同一 repository 实例或观察同一写入。
- legacy symlink 只有指向本项目时才迁移；不能无条件删除任意用户 `extensions/memory` symlink。
- Linux/macOS/Windows launcher 分别验证。

### 通用经验

**部署产物才是产品。** 单元测试源码目录不能证明安装后的 runtime graph。插件系统至少需要一次“安装 → 加载 → 枚举能力”的 smoke test。

---

## 12. No-env：无显式环境配置时必须失败得清楚，而不是猜模型或碰真实 HOME

### 症状

Live Eval 如果没有 `TRIPLE_PI_EVAL_MODEL`，任何自动猜模型行为都会产生两类风险：静默网络调用与不可复现结果。当前 runner 在启动最前面检查模型 spec，无值或格式错误时 exit 2，明确写出 opt-in 用法。

另一侧，installer test 总是通过 `PI_CODING_AGENT_DIR` 指向临时目录，但保留 `{...process.env}`，并未覆盖“关键 env 不存在”的默认路径行为；launcher 安装使用真实 `homedir()`，也没有独立临时 HOME contract。

### 必须维护的不变量

- Live Eval 无 model env 时不得创建 runtime、查认证或发网络请求。
- 缺配置属于 infra/config failure，退出码为 2，不是 semantic failure。
- 测试不能依赖开发机已有 API key、HOME、PATH 或全局安装。
- 默认路径行为必须在隔离 HOME 中验证。

### 根因

环境变量经常被当作测试样板，而不是输入 contract。使用 `{...process.env}` 会把 CI/开发机的隐式凭证和路径带进测试，使测试只在“有环境”时通过。

### 旧测试为什么漏掉

- Live runner 是进程级脚本，普通 import 会触发 `process.exit`，因此容易被排除在单元测试外。
- installer helper 有意保留整个环境，未清除相关变量。
- 没有网络调用 spy 来证明 guard 在 runtime 初始化之前执行。

### 已实施与应补回归

已实施：Live Eval 顶层 opt-in guard、RUNS 边界校验、初始化失败 exit 2。

应补：

- 子进程以最小 env 运行 `eval:live`，断言 exit 2、stderr 指引、无 results 文件、无网络。
- 仅设置错误格式 model，同样 exit 2。
- installer 在临时 HOME 且无 `PI_CODING_AGENT_DIR` 时，目标应为 `<temp-home>/.pi/agent`；测试后无真实 HOME 副作用。
- 明确哪些 provider auth env 由 Pi ModelRegistry 解析，不在 Triple-pi 中猜测。

### 通用经验

**No-env 是一等测试场景。** 如果软件宣称 opt-in，就必须证明“什么都不配时什么都不会发生”。环境继承是隐藏依赖，也是评测可复现性的敌人。

---

## 13. Reviewer policy schema：严格 parser 修了输出，但输入/运行时 contract 仍可能漂移

### 症状

历史 parser 会容忍未知字段、把未知 severity 降级为 medium、接受任意 number line。这样看似“鲁棒”，实际会把协议违规悄悄归一化为有效 finding。

当前生产 parser 已严格限制字段、status、severity、正整数 line 和 status/findings 一致性，这是正确方向。但工具层仍保留一个未使用的局部 `parseReviewOutput()` helper，且 chunk path 人工重建 parse-like result，形成双实现漂移风险。

### 不变量

- reviewer 输出只能由一个生产 parser 定义。
- schema failure 是 failure，不做宽松修复。
- 所有入口（delegate 与 current changes、single 与 chunk）使用同一 parser 语义。

### 根因

为了方便 glue code，在 orchestration 层重新塑造 parser 输出；最终又产生“看起来同类型、实际不同 contract”的对象。

### 旧测试漏因

测试大量覆盖生产 parser，但没有禁止工具层出现第二套 parser，也没有对两个入口做等价性测试。

### 修复与回归

删除局部 parser 与 `as any` 适配；manager 返回的 union 直接进入 typed aggregator。TypeScript exhaustive switch 应覆盖所有 failure kind。用同一错误输出分别跑 delegate 和 chunk 路径，结果 failure kind 必须一致。

### 通用经验

**严格协议只能有一个权威解析器。** 一旦出现第二份“差不多”的适配代码，fake success 会从缝隙中回来。

---

## 14. 总结：这些事故背后的共同模式

| 表面问题 | 深层模式 | 正确方向 |
|---|---|---|
| Working State 被当真 | provenance/认识论等级缺失 | derived、temporary、reported、deep validation |
| Reviewer prompt 断线 | builder 与 runtime 边界未测 | 捕获真实 session 输入 |
| fake success | failure 被压成空 payload | 判别联合端到端保真 |
| staged+unstaged 丢失 | 多维状态被 path 去重 | 保留 index/worktree 两层 |
| oversize/skipped | coverage 只看成功 chunk | 输入守恒与 skipped accounting |
| stale pending | generation 绑定太晚 | enqueue-time identity |
| offset 错位 | 状态转移分散且原地 mutation | 不可变 job + 单点推进 |
| metadata rollback 失效 | staging 阶段提前写 | 先完整备份，再第一次写 |
| scope provenance 丢失 | effective value 覆盖 input | requested/resolved/reason |
| revision pointer 断链 | 多层分配 identity | repository 单一 ownership |
| metrics 虚高 | infra 与 semantic 混算 | invalid observation + null |
| installer 漏功能 | 源码图不等于部署图 | install-load smoke test |
| no-env 未测 | 隐式环境依赖 | 最小 env 子进程测试 |

最终原则可以压缩成一句话：

> **不要把“没有观察到错误”写成“证明了成功”；先证明输入完整、策略送达、执行成功、输出合法，再允许业务层说 passed。**
