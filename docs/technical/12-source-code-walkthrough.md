# Triple-pi 源码导读：从一次用户请求到记忆提交与代码审查

> 本章以最终 TypeScript 实现为事实来源。阅读时建议同时打开 `extensions/index.ts`、`extensions/memory/`、`extensions/subagent/` 与对应测试。目标不是背函数名，而是能从事件、状态和不变量出发，独立推导每条生产路径。

## 1. 总入口：一个 Repository，两套能力

统一入口在 `extensions/index.ts`：

```text
triplePiExtension(pi)
  ├─ createMemoryRepository()
  ├─ registerMemoryExtension(pi, repository)
  └─ registerSubagentExtension(pi, repository)
```

关键设计是 Memory 与 Reviewer 共享同一个 `FilesystemMemoryRepository` 实例。因此 Reviewer 查询的项目规则与 Memory 写入的是同一份权威数据，不存在第二套同步协议。

Pi Runtime 负责 Agent loop、模型/provider、Session、Extension lifecycle 和基础工具；Triple-pi 负责：

- 记忆的数据模型、验证、提取、审查、合并和持久化；
- Git 变更收集、Memory 检索、Reviewer 编排和结果聚合；
- 评测与故障语义。

这条边界是面试中必须首先说清楚的原创性边界。

---

## 2. 一次普通用户请求

### 2.1 Pi 组装基础上下文

用户输入后，Pi 创建 user message，并在模型调用前触发 `before_agent_start`。Triple-pi 的 handler 位于 `extensions/memory/index.ts`。

输入包括基础 system prompt；输出契约是：

```ts
{
  systemPrompt?: string;
  message?: {
    customType: string;
    content: string | ContentBlock[];
    display: boolean;
    details?: unknown;
  };
}
```

注意单个 extension handler 返回的是 `message` 单数。Pi 的 `ExtensionRunner` 才会把多个 handler 的 message 聚合成 messages。曾经把聚合层 API 误用到 handler 层，导致 Working State 没有进入真实上下文；对应复盘见 `10-failure-postmortems.md`。

### 2.2 长期 Memory 注入 system prompt

handler 计算模型上下文窗口对应的字符预算，调用：

```text
repository.buildPrompt(cwd)
  → 解析 project identity
  → 读取 project/global records
  → 排序和预算裁剪
  → 生成“标题索引”
```

它不把所有正文都塞进 system prompt。模型需要细节时调用 `SearchMemory`。这样控制首轮上下文成本，也使检索行为可观测。

最终：

```text
modifiedSystemPrompt = baseSystemPrompt + persistentMemoryIndex
```

### 2.3 Working State 注入 custom message

Working State 是近期、派生、临时且不可信的状态。它不进入高权限 system prompt，而是作为隐藏 custom message 注入：

```ts
{
  customType: "triple-pi-working-context",
  content: workingPrompt,
  display: false,
  details: {
    derived: true,
    temporary: true,
    untrusted: true,
    ...
  }
}
```

Pi 的 `convertToLlm` 会把可用的 custom message 转成 provider 能看到的 user context。`display:false` 表示它不应作为普通用户消息展示。

不变量：

1. 长期 Memory 是持久但仍需按来源理解的背景；
2. Working State 不能拥有 system authority；
3. Working State 不能自动升级为长期事实；
4. 两者都必须遵守预算。

真实契约由 `test/memory/extension.integration.test.ts` 等测试覆盖，而不只是直接检查手写对象。

---

## 3. 手动保存 Memory

主路径位于 `extensions/memory/index.ts` 的 `SaveMemory` 工具。

```text
模型调用 SaveMemory
  → 参数保持原样进入 validateMemoryWrite
  → category/title/content/scope/secret/size 校验
  → 检查项目 lifecycle
  → UI 展示完整保存内容并确认
  → repository.save()
  → 返回 record id/scope/category
```

### 3.1 为什么非法 scope 不能“纠正”为 project

只有 `undefined` 可以默认成 project；`foo`、空字符串、大小写错误必须拒绝。如果静默归一化，调用错误会被隐藏，用户确认的也不再是模型真正提交的参数。

### 3.2 Manual scope provenance

用户确认后的记录携带 `ScopeDecision`：

```text
requested = 用户/模型请求的 scope
resolved  = 最终写入 scope
reason    = user-confirmed-manual（显式确认）或 default-project
```

这使“记录为什么是 global”成为可审计事实，而不是只从最终字段猜测。

### 3.3 Repository save

`repository.save()` 做共享 validator、防 secret、project identity、write lock、revision snapshot、head write、metadata 与派生 index rebuild。

权威数据是 entry 文件；`MEMORY.md` 是可重建派生索引。索引失败不能否定已经成功的权威 entry commit。

---

## 4. Agent settle 后的自动提取

### 4.1 为什么使用 `agent_settled`

`agent_settled` 表示当前自动 retry、compaction、queued continuation 已完成。若在普通 `agent_end` 抽取，可能保存一个尚未稳定的中间状态。

handler 首先构造 Working State，然后构造不可变 `ExtractionSnapshot`：

```ts
{
  cwd,
  sessionId,
  branch,
  branchLeafId,
  lastProcessedEntryId,
  model,
  modelRegistry
}
```

Snapshot 必须不可依赖以后会变化的 live session 状态。

### 4.2 Scheduler 接管并发

`ExtractionScheduler` 同时只运行一个 active job，并保留最多一个 latest pending。关键状态：

```text
Idle
  └─ start(A) → Active(A)

Active(A)
  └─ start(A2) → Active(A) + Pending(A2)

Active(A)+Pending(A2)
  └─ start(A3) → Active(A) + Pending(A3)
```

同 lineage 的 pending 在 A 成功后继承 A checkpoint 的 `lastEntryId`，防止重复处理已经成功提交的消息区间。

Tree switch 时：

- generation 增加；
- active abort；
- 旧 pending 清空；
- 旧 promise 即使晚到也不能 append checkpoint；
- tree switch 之后新入队的 snapshot 属于新 generation，可在旧任务 settle 后运行。

测试通过 deferred promise 精确控制 interleaving，见 `test/memory/extraction-scheduler.test.ts`。

### 4.3 Extraction source

`buildExtractionSourceFromBranch()` 从 branch 与 checkpoint 之间构建增量 source，并计算 source hash。Repository 的 manifest 以 source hash 实现幂等：相同 source 成功发布后不重复写。

### 4.4 Secret redaction

在发送给 extraction LLM 之前先 redaction。安全顺序必须是：

```text
原会话 → redaction → LLM extraction → validator → persistence
```

而不是先发给模型再过滤结果。后者已经泄露了 secret。

### 4.5 Candidate extraction 与 requested/resolved scope

LLM 输出候选的原始 scope 记为 `requestedScope`。确定性 guard 计算 `resolvedScope` 和 `ScopeDecision`。

示例：

```text
模型请求 global
证据只说“这个项目”
→ requested = global
→ resolved  = project
→ reason    = missing-cross-project-evidence
```

保存原始 requested 是 provenance 正确性的必要条件。否则安全降级发生了，但审计记录看起来像模型从未请求 global。

### 4.6 Grounded Review

第二次模型调用只允许 `keep/remove`。它不能重写 candidate 的标题、正文、证据或 scope decision。原因：如果 Reviewer 可以“顺便修正”候选，它本身会成为第二个未经 grounding 的生成器。

### 4.7 Signals 与 consolidation

每个保留候选计算 fingerprint、reinforcement、correction 等信号，再执行确定性 consolidation：

```text
无相似记录 → create
相同/近似且无 correction → skip
明确 correction 且边界一致 → replace
```

实际存储边界使用 resolved scope。

---

## 5. Extraction batch commit

核心位于 `extensions/memory/repository.ts` 的 `saveExtractionBatch()`。

### 5.1 Prepare 阶段

在任何权威写发生前，构造完整 write plan：

```text
revision snapshots
head records
reinforcement state
project metadata
extraction manifest
```

然后读取每个 target 的原始状态：

```ts
{ existed: boolean; bytes?: string }
```

不能用单个 `undefined` 混淆“不存在”和“读取失败”。

### 5.2 Apply 阶段

严格顺序：

```text
revisions
  → heads
  → reinforcement
  → project metadata
  → manifest（最后）
```

Manifest 是 publish point。只要它不存在，同 source 后续可以重试；它存在表示此前权威写都已完成。

### 5.3 Rollback 阶段

失败后按已应用 journal 的逆序恢复：

```text
原来存在 → 原字节写回
原来不存在 → 删除新文件
```

Metadata 和 manifest 不能有特殊、不完整的 rollback 分支。即使 atomic rename 已成功而 chmod 抛错，journal 也必须能删除新出现的 publish marker。

Rollback 自己失败时，保留原始错误并附加 rollback errors；不能让次生错误覆盖首要原因。

### 5.4 Revision chain

Revision ID 由 repository 单一负责。Coordinator 不生成存储层 UUID。

替换时：

```text
旧 head snapshot → revision file Rn
新 head pointer → previousRevisionId = Rn
```

文件 ID、snapshot 内 ID 和 head pointer 必须一致，才能通过 `getRevision()` 遍历。

故障注入测试在每个 write stage 抛错，并比较事务前后完整路径与字节集合。

---

## 6. 一次 `review_current_changes`

### 6.1 Git 三棵树

```text
HEAD  --staged-->  Index  --unstaged-->  Working Tree
                                \
                                 \-- untracked
```

同一文件可以同时有 staged 和 unstaged patch，它们是两个不同差分，不可按路径去重。

### 6.2 采集

`collectGitChanges()`：

- 验证 Git repo；
- 分别收集 staged、unstaged、untracked；
- 使用机器可解析、NUL 分隔路径；
- Git 非零退出传播为 git failure；
- delete 虽然工作树文件不存在，只要 diff 可用仍可审查；
- binary/真正 unreadable 进入 skipped reason。

真实 Git fixture 覆盖同文件双层修改、rename、delete、binary、空格与 Unicode。

### 6.3 Worktree snapshot

审查前后各取确定性 snapshot。它是 defense in depth；主要写隔离仍来自 Reviewer session 根本没有 write/edit/bash 能力。

必须准确表述其保证：

- 能发现最终状态变化；
- 不能证明过程中从未发生“写后恢复”；
- 同进程只读工具隔离不等于 OS sandbox；
- 读工具仍有 confidentiality/availability 风险。

### 6.4 Memory retrieval

从 task、路径、符号和 diff 提取有限关键词，检索 repository，去重并排序后生成相关项目规则背景。Memory 搜索失败不必阻止通用 review，但必须在 telemetry/输出中诚实说明是否命中。

### 6.5 Hard-bounded chunks

Review unit 优先按 change/file/hunk 切分。超大 hunk 再按行，单行仍过大则按字符硬切。最终不变量：

```text
∀ chunk: chunk.charCount <= maxCharsPerChunk
```

Segment header 带 ordinal/total，避免模型误认为片段是完整文件。

### 6.6 Reviewer Session

每个 chunk 创建独立 in-memory AgentSession：

```text
DefaultResourceLoader
  systemPrompt = POLICY_SYSTEM_PROMPT
  noExtensions/noSkills/noContextFiles = true

Tools = read, grep, find, ls
SessionManager = inMemory
```

能力层限制和 policy 层提示分工：

- 工具白名单决定“能做什么”；
- system prompt 决定“应如何审查、怎样输出”；
- prompt 不是安全沙箱；
- capability allowlist 也不自动解决 read 越界或资源耗尽。

### 6.7 Strict parse

模型最终输出经过 production parser：顶层字段、status、summary、findings 以及 passed/issues_found 一致性全部检查。

```text
invalid JSON ≠ passed
schema failure ≠ no findings
provider timeout ≠ clean review
```

### 6.8 Aggregation

每个 chunk outcome 保留真实 kind 与 telemetry。聚合规则：

| 条件 | 结果 |
|---|---|
| 全计划 chunk 成功、无 skipped | success + complete |
| 至少一个成功，但有失败/skipped | partial |
| 零成功 | failed/timeout/aborted 等真实失败 |
| worktree changed | fail closed |

只有 complete success 且 findings 为空，才允许摘要“未发现问题”。Partial 无 findings 必须明确“未完成审查，不能判断无问题”。

重复 finding 根据稳定 identity 合并，severity 保留最高，记录来源 chunk IDs。总 duration/toolCalls 来自真实 chunk 结果求和，不能硬编码为零。

---

## 7. `delegate_review` 与自动 Review 的区别

`delegate_review` 由调用者提供 task/diff/rules，适合明确输入；`review_current_changes` 负责生产 Git 收集、Memory 检索、chunk、snapshot 和多 chunk aggregation。

二者应复用：

- `buildReviewerInput()`；
- `SubAgentManager`；
- strict parser；
- failure union；
- response formatter。

但自动路径多了 coverage 与工作树一致性责任。

---

## 8. Evaluation 路径

### 8.1 Deterministic tests

验证纯函数、文件系统、Git、scheduler interleaving、transaction rollback。完全离线。

### 8.2 Runtime contract tests

使用 faux provider，但创建真实 AgentSession、ExtensionRunner 和 tool registry。它证明 Working State、system prompt、工具白名单和 tool loop 的生产接线。

### 8.3 Recorded eval

FIFO provider 返回固定输出，验证 extraction/review/repository/metrics wiring。它不证明真实模型质量。

### 8.4 Live eval

显式 opt-in，记录 commit、dirty、submodule SHA、模型、prompt hash、trace、延迟和语义结果。Infra failure 与 semantic failure 必须分开。

指标路径在 `eval/metrics.ts`。若 matched record 含 forbidden 内容，所有污染项都从 TP 降级；prediction-level forbidden FP 最多加一次。

---

## 9. 推荐源码阅读顺序

1. `extensions/index.ts`：共享对象和模块边界；
2. `extensions/memory/domain.ts`：数据结构；
3. `extensions/memory/index.ts`：生命周期与工具入口；
4. `extensions/memory/extraction/source.ts`：增量 source；
5. `pipeline.ts`、`review.ts`、`signals.ts`、`consolidation.ts`；
6. `scheduler.ts`：异步状态机；
7. `repository.ts`：锁、事务、revision、lifecycle；
8. `extensions/subagent/types.ts`：failure/coverage 类型；
9. `review-core.ts`：Git、chunk、parser、aggregate、snapshot；
10. `manager.ts`：真实子 Session；
11. `subagent/index.ts`：工具编排；
12. `eval/metrics.ts` 与 `eval/live-runner.ts`；
13. 对应测试，尤其 scheduler、repository fault injection、真实 Git 与 runtime contract。

阅读每个模块都问四个问题：

1. 权威状态在哪里？
2. 输入中哪些是不可信的？
3. 成功发布点是什么？
4. 失败能否被误解释成成功？

---

## 10. 面试白板：用五分钟讲完整系统

可以按以下结构回答：

1. **边界**：基于 Pi Runtime，不重写 Agent loop；新增 Memory、Reviewer、Eval。
2. **Memory**：agent_settled 增量提取；先 redaction，再 extraction；逐字 evidence；第二次 Reviewer 只 keep/remove；确定性 scope 和 consolidation。
3. **一致性**：文件锁 + temp/rename；batch 使用完整 write journal；manifest-last；revision 可遍历。
4. **并发**：active+latest pending；generation fence；tree switch 清 stale work；checkpoint offset 避免重复处理。
5. **Reviewer**：Git 三棵树完整采集；硬 chunk；独立只读 Session；strict parser；partial/failed 不会伪装 passed；前后 snapshot。
6. **验证**：deterministic、runtime contract、recorded、live 四类证据；明确每层不能证明什么。
7. **局限**：单用户、本地文件、关键词检索、非 OS sandbox、rename 不等于 fsync durability、规模增大后 O(N) 扫描要演进。

如果面试官追问，优先从“不变量”和“失败场景”回答，而不是背诵类名。真正体现工程能力的是：你能说明为什么某种看似方便的做法会产生假成功、数据污染或不可恢复状态，以及测试怎样把这个错误锁死。
