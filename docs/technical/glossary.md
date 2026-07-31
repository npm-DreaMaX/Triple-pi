# Triple-pi 技术术语表

本文按当前代码中的对象、事件、类型和不变量定义术语。符号名保留源码拼写，中文解释描述其运行时语义。凡“设计目标”与“当前可观测行为”不同，均单独注明，避免把类型可表达范围误写成已经成立的性质。

---

## 一、符号阅读约定

| 记号 | 含义 |
|---|---|
| `A → B` | A 完成后进入 B，或数据从 A 流向 B；不表示二者在同一事务中 |
| `A 依赖 B` | A 的结果成立需要 B 先成立 |
| `x ? y : z` | 条件选择 |
| `NUL` | 哈希输入中的零字节分隔符；公式中写作文本 `NUL`，不嵌入真实控制字符 |
| `I(condition)` | 条件成立时为 1，否则为 0 |
| `null` | 数学上未定义或当前无观测；不等于 0 |
| `undefined` | TypeScript 可选字段未提供 |
| `fail-closed` | 边界失败时拒绝发布状态，而不是猜测成功 |

本文中“权威数据”指能够独立重建派生视图的数据；“发布点”指外部可据此判断一次操作已提交的标志；“快照”指任务启动时冻结的输入值，不等于文件系统快照。

---

## 二、系统边界与模块

### Triple-pi

基于 Pi Agent Runtime Extension API 组合的跨 Session Memory 与只读代码审查系统。统一入口为 `extensions/index.ts`，Memory 与 Reviewer 共享 repository 接线，但运行模型和职责不同。

### Memory extension

注册 Memory 工具和生命周期处理器的模块，入口为 `registerMemoryExtension()`。核心职责：

```text
session 生命周期
  → 项目身份与冷热状态
  → prompt / Working State 注入
  → agent_settled 后的自动提取
  → repository 持久化
```

### SubAgent Reviewer

面向 Git 变更的隔离审查会话。生产路径包括 Git 收集、Memory 检索、chunk 构造、独立 session、严格 JSON parser、finding 聚合和 worktree 不变性检查。

### 记忆候选评审器

`extensions/memory/extraction/review.ts` 中的 `reviewCandidates()`。它评审自动提取候选，只允许 `keep` 或 `remove`。它不是 SubAgent Reviewer；前者保护记忆写入，后者审查代码 diff。

### Repository

`FilesystemMemoryRepository`。文件系统 Memory 的主要边界，负责验证后的保存、列表、搜索、prompt 索引、Working State、reinforcement、幂等 manifest、生命周期、修订快照、锁和原子写。

### 权威 entry

`entries/<category>/<record-id>.md`。单条 Memory 的权威表示，由 JSON metadata comment 和 Markdown body 组成。健康 entry 可以在 `MEMORY.md` 缺失或损坏时继续读取。

### 派生索引

`MEMORY.md`。由 entries 遍历重建的便利索引，不是提交真值。索引重建失败时，已经成功写入的权威 entry 仍可视为保存成功。

### Working State

从当前分支对话确定性派生的临时状态，包括 scratchpad 和 daily。它不调用模型，与长期 Memory 物理分离，并以 `derived`、`temporary`、`untrusted` 标记注入。

### Recorded Eval

用预定义 FIFO 模型输出替代真实模型、但保留真实 pipeline 接线的确定性评估。它证明 plumbing，不证明模型自然语言能力。

### Live Eval

显式配置真实模型后运行的 opt-in 评估。应独立报告语义质量、基础设施失败、模型、commit、运行次数和 trace。

### Reviewer Pilot

对 with-memory 与 without-memory 条件进行配对比较的模型实验。使用真实 `SubAgentManager` 会话路径，但不等于完整 `review_current_changes` 端到端路径；当前 pilot 的 Memory 注入、coverage 记录和输出位置均有自身边界。

---

## 三、项目身份与作用域

### `ProjectIdentity`

项目身份对象：

```ts
interface ProjectIdentity {
  id: string;
  cwd: string;
  displayName: string;
  aliased: boolean;
  aliasPath?: string;
}
```

### canonical cwd

`path.resolve(cwd)` 后尽量执行 `realpathSync()` 的规范路径。Windows 上再转为小写。符号链接路径与真实路径因此通常映射为同一项目。

### 自动项目 ID

未配置 alias 时：

```text
digest = first20hex(SHA-256(canonicalCwd))
id = safeDisplayName(canonicalCwd) + "-" + digest
```

`displayName` 来自 basename，过滤为字母、数字、点、下划线和连字符，最多 48 字符。

### 项目 alias

项目根 `.triple-pi/project.json` 中符合模式的 `projectId`。模式为：

```text
^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$
```

alias 存在且合法时，ID 不再从 cwd 哈希导出。

### `MemoryScope`

```ts
type MemoryScope = "global" | "project";
```

### project scope

仅当前 `ProjectIdentity.id` 可见，存储于：

```text
projects/<project-id>/entries/
```

### global scope

跨项目可见，存储于：

```text
global/entries/
```

Global 不跟随单个项目进入 cold 或 archived。

### requested scope

调用方或模型最初请求的作用域。在 automatic extraction 当前调用链中，候选在进入 coordinator 前可能已经被降级，因此 provenance 未必保留模型最初请求值。

### resolved scope

通过自动作用域守卫后实际用于持久化的作用域。

### automatic scope guard

`resolveAutomaticScope(candidateScope, evidenceText)`：

```text
candidateScope = project
  → project

candidateScope = global → evidence 命中跨项目表达
  → global

candidateScope = global → evidence 未命中跨项目表达
  → project
```

它用于自动提取。manual save 的显式 global 不经过同样的 evidence 降级逻辑。

### explicit cross-project evidence

证据中明确表示“所有项目”“跨项目”“全局”“every project”“for all repositories”等跨项目范围。匹配由固定中英文正则完成，不是语义分类器。

### `ScopeDecision`

```ts
interface ScopeDecision {
  requested: MemoryScope;
  resolved: MemoryScope;
  reason:
    | "user-confirmed-manual"
    | "explicit-cross-project-evidence"
    | "missing-cross-project-evidence"
    | "default-project";
  evidence?: MemoryEvidence;
}
```

类型允许表示 manual confirmation 和 global 降级原因；当前 automatic coordinator 的实际写入通常只产生其可达子集。

### 当前 scope provenance 边界

`validateCandidates()` 先执行 automatic scope guard，`buildScopeDecision()` 后执行。若模型请求 global 但证据不足，coordinator 可能只看到已经变成 project 的 candidate，最终落盘：

```text
requested = project
resolved = project
reason = default-project
```

因此 `missing-cross-project-evidence` 在正常当前路径中难以观测。该现象是信息保留边界，不应改写成“模型从未请求 global”。

---

## 四、Memory 对象与类型

### `MEMORY_RECORD_SCHEMA_VERSION`

当前记录 schema 版本为 `2`。它是单条 record schema，不必与整个存储布局版本相同。

### `MemoryCategory`

```ts
type MemoryCategory =
  | "preference"
  | "decision"
  | "rule"
  | "fact"
  | "knowledge";
```

### preference

用户的交互或实现偏好。是否 global 仍取决于明确作用域或自动 scope guard，category 本身不授权跨项目传播。

### decision

已经确定的方案选择，例如认证方式或架构取舍。

### rule

可执行约束，例如必须运行的检查、禁止的实现方式。

### fact

稳定项目事实，不应是从 repository 可直接发现的临时内容。

### knowledge

可复用知识或约定。Working State 验证时可能借用 `knowledge` category 进入共享 validator，但 Working State 本身不因此变为长期 knowledge record。

### `MemoryRecord`

```ts
interface MemoryRecord {
  schemaVersion: 2;
  id: string;
  category: MemoryCategory;
  scope: MemoryScope;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}
```

### record ID

```text
first32hex(
  SHA-256(scope + NUL + projectId + NUL + category + NUL + lower(normalizedTitle))
)
```

标题只作为哈希数据，不直接作为文件路径。相同 scope、projectId、category 和规范化标题映射为同一 head record。

### normalized title

首尾 trim，并将连续空白压缩为单空格。record ID 使用 locale lowercase 后的标题。

### `MemoryProvenance`

记录来源和提取链信息：

```ts
interface MemoryProvenance {
  source: "manual" | "extraction";
  sessionId?: string;
  sourceEntryIds?: string[];
  sourceHash?: string;
  fingerprint?: string;
  score?: number;
  reinforcement?: number;
  correction?: boolean;
  evidence?: MemoryEvidence[];
  scopeDecision?: ScopeDecision;
  revision?: RevisionPointer;
  revisionOf?: string;
}
```

`revisionOf` 已弃用，应使用 `revision.previousRevisionId`。

### manual provenance

`source="manual"`。由显式工具调用、用户确认和 repository save 形成。通常不含自动提取 evidence。

### extraction provenance

`source="extraction"`。通常携带 sessionId、sourceEntryIds、sourceHash、fingerprint、score、reinforcement、correction、evidence 和 scopeDecision。

### `MemoryEvidence`

```ts
interface MemoryEvidence {
  quote: string;
  sourceEntryId: string;
  role: "user";
  quoteHash: string;
}
```

### evidence quote

指定 user entry 中的逐字、区分大小写子串。不是改写摘要、向量相似度或 assistant 转述。

### quote hash

```text
first16hex(SHA-256(evidenceText))
```

用于紧凑标识，不替代 quote 和 sourceEntryId 的落地验证。

### `MemoryRevision`

```ts
interface MemoryRevision {
  schemaVersion: 2;
  revisionId: string;
  recordId: string;
  title: string;
  content: string;
  provenance: MemoryProvenance;
  createdAt: string;
  capturedAt: string;
}
```

保存更新前 head 的不可变快照。

### `RevisionPointer`

```ts
interface RevisionPointer {
  revisionId: string;
  previousRevisionId?: string;
}
```

它表达链引用意图。当前实现中 pointer ID 与实际 snapshot ID 的一致性需要实测，不能只根据类型断言链必然可遍历。

### head

`entries/.../<record-id>.md` 中的当前版本。更新相同 ID 时，旧 head 先形成 revision snapshot，再覆盖 head。

### revision traversal

两种遍历方式：

1. `listRevisions(recordId, cwd)`：枚举 project revision 目录并按 capturedAt 升序排序；
2. `getRevision(recordId, revisionId, cwd)`：按真实 revision ID 定位单个 snapshot。

沿 head pointer 追链属于第三种方式，但必须先验证 pointer 与落盘 snapshot 对齐。

### V1 compatibility

读取 schemaVersion 1 的 record 时，在内存中升级为 V2 形状，补空 evidence，并使 scopeDecision/revision 为 undefined。它是读取兼容，不等于立即重写磁盘。

### `MemorySearchResult`

```ts
interface MemorySearchResult {
  record: MemoryRecord;
  snippet: string;
  archived: boolean;
}
```

搜索是 title 与 content 上的 locale lowercase substring，不是 embedding 或全文索引。

### `MemoryPrompt`

```ts
interface MemoryPrompt {
  prompt: string;
  count: number;
  project: ProjectIdentity;
}
```

`count` 是可见 records 总数；prompt 受条数和字符预算截断，实际注入行数可能小于 count。

### `ProjectMemoryMetadata`

项目生命周期 metadata：projectId、displayName、cwd、status、lastActiveAt、archivedAt。

### `ProjectLifecycleState`

```ts
type ProjectLifecycleState =
  | "new"
  | "hot"
  | "cold"
  | "archive-due"
  | "archived";
```

### 生命周期边界

```text
inactivity → 30 days             → hot
30 days < inactivity → 90 days  → cold
inactivity > 90 days             → archive-due
物理移入 archive 后              → archived
```

实现使用严格大于，因此正好 30 天仍 hot，正好 90 天仍 cold，超过边界 1ms 才转换。

### activity

由 active session 路径刷新 `lastActiveAt`，不是任意 Memory write 都代表真实用户活动的抽象事件。

### archive

在写锁内把 project metadata 标为 archived，并将项目目录 rename 到 `archive/projects/<id>/`。默认 list/search/prompt 不包含 archived project records；可显式 includeArchived 读取。

---

## 五、提取 source、candidate 与 pipeline

### `ExtractionMessage`

```ts
interface ExtractionMessage {
  entryId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
```

只提取 message entry 的文本块，空文本、工具块和其他 entry 类型不进入 source message。

### `ExtractionCheckpoint`

```ts
interface ExtractionCheckpoint {
  version: 1;
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
  savedCount: number;
}
```

它记录分支增量进度。合法空提取也可以推进 checkpoint；失败不应推进。

### `MEMORY_CHECKPOINT_TYPE`

custom session entry 类型：

```text
triple-pi-memory-checkpoint
```

### `EXTRACTOR_VERSION`

当前 source/checkpoint 提取器版本为 `1`。sourceHash 输入包含该版本，以便版本变化影响幂等身份。

### `ExtractionSource`

```ts
interface ExtractionSource {
  messages: ExtractionMessage[];
  sourceEntryIds: string[];
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
}
```

### source delta

当前 branch 中 checkpoint 之后的 entries。如果 checkpoint ID 在当前 branch 找不到，则从整个 branch 构建，而不是从未知位置切片。

### source 有效性

至少两条文本 message，且至少一条 user message；否则 `buildExtractionSourceFromBranch()` 返回 undefined。

### source hash

```text
SHA-256(JSON.stringify({
  version: EXTRACTOR_VERSION,
  sourceEntryIds,
  messages
}))
```

它同时受消息 ID、角色、内容、时间戳和顺序影响。

### `ExtractionSnapshot`

```ts
interface ExtractionSnapshot {
  cwd: string;
  sessionId: string;
  branch: SessionEntry[];
  branchLeafId: string | null;
  lastProcessedEntryId?: string;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  reviewerEnabled?: boolean;
}
```

scheduler 后台任务使用该不可变语义快照，避免随后读取可变 context。

### `ExtractedCandidate`

```ts
interface ExtractedCandidate {
  category: MemoryCategory;
  title: string;
  content: string;
  evidence: string;
  sourceEntryId: string;
  scope: MemoryScope;
}
```

### candidate schema

Provider 返回 JSON array，每项必须且只能包含六个字段。顶层最多 10 项；title 最多 120 字符、content 最多 2000、evidence 最多 500。

### `CandidateValidationError`

模型输出无法通过 JSON、数组边界、严格字段、类型、长度、evidence 或 secret 检查时抛出的错误。

### strict validation

当前 candidate validation 的合取条件：

```text
合法 JSON array
→ 数量 → 10
→ 每项恰好六字段
→ category 合法
→ title/content/evidence 非空且有界
→ sourceEntryId 对应 user message
→ userMessage.content.includes(evidence)
→ scope 合法并经过自动解析
→ 不含 placeholder 或 secret
```

任一候选失败会使整批抛错。

### redaction

Provider 调用前，以固定 secret regex 将命中的文本替换为 `[REDACTED_SECRET]`。随后 Provider 输出仍接受二次 secret 检测。

### placeholder rejection

candidate evidence 或 content 含 `[REDACTED_SECRET]` 时拒绝。模型不能把脱敏占位符当作可持久化事实依据。

### `ExtractionProviderInput`

包含 model、modelRegistry、messages 和 AbortSignal。Provider 认证从 registry 获取，tools 为空数组。

### `extractCandidateJson()`

模型边界函数：解析认证和 provider，构造带 `<message>` 标签的 transcript，调用 `streamSimple()`，仅接受 `stopReason="stop"`，拼接 text blocks 返回 raw JSON 字符串。

### valid empty extraction

Provider 正常返回 `[]`，表示本 source 没有 durable candidate。结果为 `no-candidates`，可以生成 checkpoint。这不同于 provider 异常、非 JSON 或 validation failure。

### `ExtractionRunResult`

```ts
interface ExtractionRunResult {
  checkpoint?: ExtractionCheckpoint;
  savedCount: number;
  status: "saved" | "no-source" | "no-candidates" | "aborted";
  telemetry?: ExtractionTelemetry;
}
```

provider、validation、review 或 commit 异常不包装进该 status union，而是向上抛出。

### `ExtractionTelemetry`

记录 candidate/review/save/create/replace/skip 数量以及 extraction、review、consolidation latency。它不同于 eval `ExtractionTrace`；后者 schema 更宽，live runner 当前只填充其中一部分字段。

### idempotent extraction

`extractions/<project-id>/<sourceHash>.json` 存在时，同 source 视为已经发布，coordinator 在 Provider 调用前短路，并产生 savedCount=0 checkpoint。

### extraction manifest

一次 `saveExtractionBatch()` 的幂等发布标志，含 sourceHash、projectId、recordIds、committedAt。按设计在批量权威写入之后最后写入。

### signal scoring

根据 candidate、evidence 和历史 reinforcement 计算 fingerprint、score、reinforcement、correction。它是 consolidation 的确定性输入。

### semantic fingerprint

对候选稳定特征的 SHA-256 标识，用于相同语义信号去重。当前测试验证标题词序变化不改变 fingerprint；不要推导为通用语义 embedding。

### reinforcement

同 fingerprint 的重复支持计数。更新位于 repository 写锁内，避免并发增量丢失。

### correction

evidence 命中明确更正表达时为真，例如 `Actually ... instead` 或“更正”。普通否定规则不自动视为 correction。

### consolidation

候选与现有 records 的确定性计划，动作通常为：

```text
create：新建
replace：有 grounded correction 时替换边界内现有记录
skip：重复 fingerprint 等无需重写
```

不跨 category 去重；replacement ID 必须属于相同 scope/category/project 边界。

### reserved target

单批 consolidation 中已经被一个 replace plan 占用的 existing record ID。后续 candidate 不再使用同一 target，避免批内多写同一路径。

---

## 六、事件与生命周期

### `session_start`

会话启动事件。Memory extension：

1. 恢复 branch Working State checkpoint；
2. 计算 project lifecycle；
3. archive-due 时归档；
4. cold 时请求 UI 恢复确认；
5. hot/恢复后 mark active。

无 UI 的 cold project 采用 fail-closed：不注入 project Memory。

### `before_agent_start`

每次 Agent 启动前的上下文构造事件。返回值可包含：

```ts
{
  systemPrompt?: string;
  messages?: any[];
}
```

长期 Memory 进入 systemPrompt，Working State 进入 custom message。

### prompt budget

```text
workingCharBudget = max(1000, min(8000, floor(contextWindow × 0.2)))
memoryCharBudget  = max(2000, min(12000, floor(contextWindow × 0.3)))
```

Working State 内部再按 scratchpad 60%、daily 40% 分配。

### `triple-pi-working-context`

Working State custom message 类型。旧的相同 customType 会先过滤，再注入当前值，避免累积。

### `agent_settled`

Agent 本轮稳定后触发：

1. 热项目才继续；
2. 从 branch 构建 Working State 并保存；
3. 构造 `ExtractionSnapshot`；
4. 交给 scheduler 后台提取；
5. 成功 checkpoint 通过 `appendEntry()` 追加。

### `session_tree`

会话树切换事件。当前处理：

```text
scheduler.bumpGeneration()
→ 从新 branch 恢复 Working State checkpoint
→ 更新 latest working pointer
```

它会 abort current extraction，但当前 `bumpGeneration()` 不清 pending。

### `session_shutdown`

会话关闭事件。删除当前 session 的 branch Working State 缓存，并等待 scheduler shutdown，最多约 1 秒。

### branch

`sessionManager.getBranch()` 返回的当前叶节点路径。source 只遍历当前 branch，不扫描放弃的兄弟分支。

### branch leaf ID

snapshot 创建时的当前 leaf 标识。checkpoint commit guard 将 job 与 snapshot 的 branchLeafId 对比；该比较不替代 generation guard。

### branch-local checkpoint

只从当前 branch 倒序查找的 Memory custom checkpoint。分支切换后，新 branch 使用自身可见 checkpoint 计算增量。

### Working State checkpoint

独立于长期 Memory checkpoint 的 custom entry，携带派生 state。tree switch 时用于恢复该 branch 的临时上下文。

---

## 七、Scheduler 对象与交错

### `ExtractionScheduler`

单飞调度器：一个当前 `task`、一个 `AbortController`、一个 pending snapshot 槽、一个 generation 计数器。

### `SchedulerJob`

```ts
interface SchedulerJob {
  generation: number;
  sessionId: string;
  branchLeafId: string | null;
  snapshot: ExtractionSnapshot;
}
```

### active task

当前 `runExtraction()` promise。`isRunning` 只由 `task !== undefined` 推导。

### pending snapshot

有 active task 时，最新 `start()` 输入存入单个槽。后续 start 覆盖前一个 pending，不形成 FIFO 队列。

### generation

tree switch、cancel 或 shutdown 时递增的逻辑世代。运行 job 捕获启动时 generation；完成时必须仍与 scheduler 当前 generation 相同才能 append checkpoint。

### cooperative cancellation

`AbortController.abort()` 只发出信号。Provider 或文件操作需要主动观察 signal；底层工作不保证立即停止。

### checkpoint commit guard

当前完成路径的合取条件：

```text
result.checkpoint 存在
→ job generation = current generation
→ job.sessionId = snapshot.sessionId
→ job.branchLeafId = snapshot.branchLeafId
→ signal 未 aborted
```

其中 sessionId 和 branchLeafId 是 job 从同一 snapshot 复制后再与该 snapshot 比较，主要安全力量来自 generation 和 abort；不能据此推导 scheduler 当前外部 context 仍是同 session/branch。

### `start()`

无任务时立即创建 controller/job 并运行。已有 task 或 abort handle 时，只更新 pending。

### `cancel()`

```text
generation++
abort current
pending = undefined
currentJob = undefined
```

用于取消并阻止 pending 重启。

### `bumpGeneration()`

```text
generation++
abort current
```

当前不清 pending。tree switch 使用它，因此旧 pending snapshot 可能在 current finally 后以新 generation 启动。

### `shutdown()`

递增 generation、清 pending/currentJob、abort current，并等待当前 task 或 1000ms。它保证调用方有时间上界，不保证底层任务物理停止。

### scheduler interleaving 真值表

| 序列 | current checkpoint | pending 是否启动 | 关键原因 |
|---|---|---|---|
| `start(A) → resolve(A)` | 可提交 | 无 | generation 未变且未 abort |
| `start(A) → start(B) → resolve(A)` | A 可提交 | B 启动 | finally 消费 pending |
| `start(A) → start(B) → start(C) → resolve(A)` | A 可提交 | C 启动 | pending 单槽，C 覆盖 B |
| `start(A) → cancel() → resolve(A)` | 不提交 | 无 | generation 变化、abort、pending 清空 |
| `start(A) → start(B) → cancel() → resolve(A)` | 不提交 | 否 | cancel 清 pending |
| `start(A) → bumpGeneration() → resolve(A)` | 不提交 | 无 | generation 变化且 abort |
| `start(A) → start(B-old) → bumpGeneration() → resolve(A)` | A 不提交 | B-old 可能启动 | bump 不清 pending；finally 调 start |
| `start(A) → start(B) → shutdown()` | A 不提交 | B 不启动 | shutdown 清 pending |
| `start(A-hangs) → shutdown()` | 不提交 | 无 | 约 1 秒上界返回 |

### stale pending

tree switch 前生成、仍保存在 pending 槽中的 snapshot。即使 current checkpoint 被 generation guard 阻止，stale pending 的“执行资格”仍需单独约束。提交安全不等于启动安全。

### deferred race test

用手工可控 promise 决定 `runExtraction()` 完成时刻的确定性测试。它比随机延迟和重复跑更适合证明 interleaving。

### scheduler diagnostics

`onDiagnostics()` 注册失败回调。Extraction 异常会以 stage=`extraction`、code=`EXTRACTION_FAILED` 通知；diagnostics 自身异常被吞掉，不能破坏 scheduler finally。

---

## 八、文件系统、锁与事务

### repository root

默认：

```text
$TRIPLE_PI_MEMORY_ROOT
```

若未设置：

```text
~/.triple-pi/memory-v1
```

测试和实验应显式使用临时 root。

### repository write lock

`proper-lockfile` 在 repository root 上取得独占锁：

```text
realpath=true
retries=20
minTimeout=10ms
maxTimeout=100ms
stale=10000ms
```

写操作串行化；读操作不持锁。

### reader consistency

读者不持 repository lock，依赖每个 entry 的 temp+rename：单个文件层面看到完整旧版或完整新版。批量多个文件之间不提供读隔离快照。

### `atomicWrite()`

```text
mkdir parent 0700
chmod parent 0700
write same-directory .tmp mode 0600
rename tmp → target
chmod target 0600
finally rm tmp
```

### 可见性原子性

同一文件系统中 rename 通常使 target 切换原子可见。它不等于断电持久性，也不保证跨多个 target 的原子视图。

### crash durability

当前没有 `fsync(temp)`、`fsync(parent directory)`。断电后最新写可能丢失。不得宣称“完全防崩溃”。

### compensation transaction

`saveExtractionBatch()` 的批量模式：建立备份、按序写入、失败后逆序恢复。它是应用层补偿，不是数据库 ACID transaction。

### staged write

事务内部待写对象的内存表示，不是 Git staged。包括 revision content 和 head record。

### backup

目标写入前读取的旧字符串；新文件以 `undefined` 表示。rollback 时旧字符串恢复，新文件删除。

### transaction fault points

以下为逻辑故障点；实际 `atomicWrite` 调用序号应由无故障事件日志确定。

| 故障点 | 正向动作 | 失败后的核心不变量 |
|---|---|---|
| F0 | 输入/category/title/content/replacement 边界校验 | 不产生任何权威写 |
| F1 | revision snapshot 写入 | 无 manifest；新 revision 应删除或不存在 |
| F2 | 第一个 head entry 写入 | 已覆盖 head 恢复；无 manifest |
| F3 | 后续 head entry 写入 | 前面 heads 逆序恢复；无半批发布 |
| F4 | reinforcement 写入 | entries 和 revision 尽量恢复；旧 reinforcement 恢复 |
| F5 | project metadata 写入 | 旧 project.json 恢复；无 manifest |
| F6 | manifest 写入 | 前序权威文件已写但必须 rollback，避免 source 无法重试 |
| F7 | index rebuild | 事务已发布；index 失败可忽略，entries 仍权威 |
| R1 | rollback 删除新文件失败 | 原始异常保留，追加 rollbackErrors |
| R2 | rollback 恢复旧文件失败 | 原始异常保留，追加 rollbackErrors |
| R3 | metadata/manifest rollback 失败 | 可诊断为补偿不完整，不得宣称原子批次 |

### write order

设计上的发布顺序：

```text
revision snapshots
→ head entries
→ reinforcement
→ project metadata
→ manifest LAST
→ derived index rebuild
```

当前代码在正式 write phase 前还有 metadata 相关调用，fault injection 必须观测实际调用序列。

### reverse rollback

对 `writeOrder` 逆序执行：旧内容存在则 atomicWrite 恢复，不存在则 rm。随后单独处理 project.json 和 manifest 备份。

### `rollbackErrors`

rollback 自身的错误数组，动态附加到原始 error。调用方需要保留原始触发错误，同时检查补偿是否完整。

### manifest last

只有所有前序目标成功后才写 extraction manifest。它是幂等 publish point，而不是数据库 commit log。

### index failure tolerance

`MEMORY.md` 是派生索引，重建异常被忽略。权威 entry 保存成功不因 index 失败而回滚。

### corrupt record tolerance

list 遍历时，单个损坏 record 被跳过，不隐藏健康 records。diagnose 路径可统计 corruptRecordCount。

### archive consistency retry

部分 read 路径在读取前后检查 archived path 是否变化；若位置改变则重试一次。它缩小 rename 与读取的竞态窗口，但不是无限重试或事务快照。

---

## 九、Working State 类型

### scratchpad

当前或最新 session 的派生临时摘要，包含 user request 与 assistant reported outcome。按 session hash 存放，并受字符上限约束。

### daily

按日期聚合的 Working State 更新。超长时保留尾部内容，以当前日期标题重新构造。

### working manifest

`working-manifests/<project-id>/<sourceHash>.json`，用于同 source 的 Working State 幂等判断。

### latest pointer

`working/latest.json`，指向按 `updatedAt` 排序后的最新 update。较旧 session 后到写入时不应覆盖更新的 latest 语义。

### temporary context

Working State 的信任标签。它可供 Agent 延续当前工作，但不得自动当成 durable truth 或直接升级为长期 Memory。

### long-term/working isolation

`repository.search()` 不搜索 Working State；`searchWorkingState()` 单独处理 scratchpad/daily。冷态 project 可以隐藏 Working State，而 global long-term 仍可见。

---

## 十、Reviewer Git 对象

### `ChangeFile`

```ts
interface ChangeFile {
  path: string;
  status: "staged" | "unstaged" | "untracked";
  diff: string;
  content?: string;
  binary: boolean;
  unreadable: boolean;
  skipped: boolean;
}
```

### staged

`git diff --cached --no-ext-diff` 产生的 `HEAD → index` 变化。

### unstaged

`git diff --no-ext-diff` 产生的 `index → working tree` 变化。

### untracked

`git ls-files --others --exclude-standard -z` 返回的未跟踪路径。

### 同文件 staged + unstaged 边界

当前 collector 先加入 staged path，再处理 unstaged；若同路径已有 staged 项，unstaged 项整个跳过。因此原始 Git 的双层变化不会作为两个 `ChangeFile` 保留。

### binary detection

读取文件 Buffer 后检查是否含 NUL byte。命中即 `binary=true`、`skipped=true`。这是启发式，不是 MIME 检测。

### unreadable

当前路径无法读取时为真，同时 skipped。删除文件也可能表现为 unreadable，需结合 diff 解释。

### `CollectGitChangesResult`

```ts
type CollectGitChangesResult =
  | { ok: true; changes: ChangeFile[] }
  | {
      ok: false;
      kind: "not-a-git-repo" | "git-failed" | "timeout" | "no-changes";
      error: string;
    };
```

### Git 排序

collector 构造顺序为 staged、unstaged、untracked。后续 chunk 构建保持 staged 优先语义。

### Git timeout

collector 的 Git 子进程有 timeout 和 10MiB maxBuffer。错误被映射到 `timeout` 或 `git-failed`，但不同层可能进一步折叠 failure kind。

---

## 十一、Reviewer prompt 与 chunk

### `ReviewInput`

```ts
interface ReviewInput {
  task: string;
  diff: string;
  memory?: string;
  changes: ChangeFile[];
  chunks: ReviewChunk[];
}
```

### `ReviewChunk`

```ts
interface ReviewChunk {
  chunkId: string;
  files: string[];
  content: string;
  charCount: number;
}
```

### chunk budget

默认目标为 12000 字符。当前按整个 file 内容分组，不拆单个超大文件或 hunk，因此单 chunk 可超过目标上限。

### skipped file

binary、unreadable 或显式 skipped 的 ChangeFile 不进入正常 review chunk。当前 aggregate coverage 不自动因 skipped 文件降为 partial。

### search terms

从 task、路径、diff 类型名、符号和内容提取的独立关键词。按优先级和去重限制搜索 Memory，避免把多个词拼成一个长 substring 查询。

### relevant Memory

Reviewer 检索到的当前 project/global Memory 子集。排序考虑 title hit、hit terms、category、scope、updatedAt。它是审查背景，不是 diff 内的可信指令。

### prompt hardening

task、diff、memory 放在 XML 标签中，并转义 XML 特殊字符；diff 与 memory 被明确标记为 untrusted/background。代码级 tool allowlist 仍是主要写权限边界。

### 当前 system prompt 接线边界

`buildReviewerInput()` 返回 policy system prompt 与 user message；`ReviewOptions` 也包含 systemPrompt。但当前 `SubAgentManager.review()` 创建 session 和调用 prompt 时未明确使用该字段。不得把“构造了 policy string”直接写成“独立 reviewer session 已注入该 system prompt”。

### finding dedup key

```text
first24hex(SHA-256(
  file + NUL + (line ?? 0) + NUL +
  lower(trim(description)).slice(0, 80)
))
```

重复 finding 合并 chunkIds，并保留最高 severity。

### severity order

```text
high > medium > low
```

---

## 十二、Reviewer 类型与 failure union

### `SubagentRole`

当前仅：

```ts
type SubagentRole = "reviewer";
```

### `ReviewFindingSeverity`

```ts
type ReviewFindingSeverity = "low" | "medium" | "high";
```

### `ReviewStatus`

```ts
type ReviewStatus = "passed" | "issues_found";
```

### `ReviewFinding`

```ts
interface ReviewFinding {
  severity: ReviewFindingSeverity;
  file?: string;
  line?: number;
  description: string;
}
```

strict parser 要求 provider 输出中的 file 为 string、line 为正整数、description 非空。类型层可选不等于任意值都能通过 parser。

### `SubagentTask`

包含 task ID、role、prompt、workingDirectory、timeoutMs 和可选 relevantMemoryIds。

### `SubagentResult`

兼容结果对象，含 status、summary、findings、changedFiles、durationMs、toolCalls、error 以及可选 failureKind、coverage、telemetry。主调用方应优先判别 `ReviewResultUnion.kind`。

### `ReviewerFailureKind`

```ts
type ReviewerFailureKind =
  | "git-failed"
  | "session-create-failed"
  | "provider-failed"
  | "parse-failed"
  | "schema-failed"
  | "timeout"
  | "aborted"
  | "worktree-changed"
  | "no-changes";
```

### `ReviewResultUnion`

```ts
type ReviewResultUnion =
  | { kind: "no-changes"; message: string }
  | { kind: "success"; result: SubagentResult }
  | { kind: "partial"; result: SubagentResult }
  | { kind: "git-failed"; error: string }
  | { kind: "session-create-failed"; error: string }
  | { kind: "provider-failed"; error: string }
  | { kind: "parse-failed"; error: string; raw: string }
  | { kind: "schema-failed"; error: string; raw: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "worktree-changed" };
```

### failure union 真值表

| kind | 是否有 review findings | 是否有 raw | 语义 |
|---|---|---|---|
| `no-changes` | 否 | 否 | 没有可审查变化，不是 passed |
| `success` | 可以有或没有 | 否 | 所需审查调用成功 |
| `partial` | 可以有或没有 | 否 | 只完成部分覆盖 |
| `git-failed` | 否 | 否 | Git 收集失败 |
| `session-create-failed` | 否 | 否 | 隔离 session 无法创建 |
| `provider-failed` | 否 | 否 | 模型/provider 调用失败 |
| `parse-failed` | 否 | 是 | 输出不是可解析 JSON 或为空 |
| `schema-failed` | 否 | 是 | JSON 可解析但 schema/一致性非法 |
| `timeout` | 否 | 否 | deadline 到达，调用方先返回 |
| `aborted` | 否 | 否 | parent 或本地 signal 取消 |
| `worktree-changed` | 结果不可信 | 否 | 审查前后工作树快照不一致 |

### no changes 与 passed

`no-changes` 表示没有审查输入；`passed` 表示存在输入且审查成功、findings 为空。二者不能合并。

### parse failed

原始输出不是 JSON、空输出或 fence 外有无关文本等语法层失败。

### schema failed

JSON 结构违反 top-level 字段、status、summary、findings、severity、line 或状态一致性。

### provider failed

模型调用错误。不能包装成 `success` + 空 findings，否则会产生虚假“未发现问题”。

### worktree changed

只读审查前后的 Git status 或 changed-path hash 不一致。无论 findings 内容如何，结果都应视为隔离失败。

### failure folding

多 chunk orchestration 当前可能将具体 timeout/provider/schema 等失败折叠成 `parse-failed` 的统一 chunk failure。类型系统能表达细粒度 failure，不代表每个上层都完整保留它。

### all chunks failed 边界

当前聚合层可产生 partial、空 findings；工具格式化若把 partial 当一般成功，可能输出“未发现问题”。调用方审计时必须同时检查 coverage 和 failedChunks，不能只看 findings.length。

---

## 十三、严格 Reviewer parser

### `ParseReviewResult`

```text
ParseSuccess | ParseFailure
```

ParseFailure 的 failure 实际由 parser 产生 `parse-failed` 或 `schema-failed`。

### top-level schema

只允许：

```text
status
summary
findings
```

多余 top-level 字段拒绝。

### status/findings 一致性

```text
status = passed       → findings.length = 0
status = issues_found → findings.length > 0
```

### finding schema 边界

finding 的已知字段会做类型校验；当前 parser 对 finding 对象的额外字段未执行与 top-level 同等的 unknown-key 拒绝。

### markdown fence

允许整个 JSON 被 ` ```json ... ``` ` 包裹。fence 外额外 prose 不属于合法输出。

### raw output

parse/schema failure 保存原始文本，供诊断；它可能含模型输出，持久化前应考虑敏感信息策略。

---

## 十四、只读隔离与工作树证明

### isolated reviewer session

通过 `createAgentSession()`、`SessionManager.inMemory()` 和禁用 extensions/skills/templates/themes/context files 的 resource loader 创建。

### tool allowlist

只注册：

```text
read
grep
find
ls
```

没有 bash、write、edit。只读性质来自代码级工具集合，不只来自 prompt。

### 允许工具测试边界

仅在测试中重新声明相同 allowlist 并不证明真实 session registry 一定一致。强验证应实例化 manager 或拦截 createAgentSession 入参。

### hard timeout

`Promise.race` 让调用方在 timeoutMs 后得到 timeout。随后请求 session abort/dispose，但底层 provider 请求可能继续，结果被丢弃。

### parent abort

父 `AbortSignal` 传播到 reviewer 调用。timeout 和 parent abort 是不同 failure kind。

### worktree snapshot

生产 snapshot 包括：

```text
git status --porcelain=v1 原始字符串
每个 status path 的 git hash-object
```

### snapshot comparison

以下任一变化即 worktree-changed：

```text
status 文本不同
文件 hash key 数不同
任一 path hash 不同
```

### snapshot 边界

它围绕 Git status 中出现的路径。未被 status 表示的外部文件系统、副作用或系统资源不在该证明范围内。

### pilot snapshot 边界

Reviewer Pilot 的 `git diff --stat` 和未跟踪文件检查弱于生产 snapshot。不得把 pilot 的 worktreeSnapshot 字段等同于生产不变性证明。

### tool call count

当前 manager 扫描 assistant messages，统计含至少一个 `tool_use` block 的消息数。单条消息中多个 tool blocks 仍可能计为 1，因此它不是严格的工具调用块总数。

---

## 十五、Coverage 真值表

### `ReviewCoverage`

```ts
type ReviewCoverage = "partial" | "complete";
```

它是二元标签，不是百分比。

### manager-level coverage

单次 `SubAgentManager.review()` 当前按传入 `chunkCount`：

```text
chunkCount → 1 → complete
chunkCount > 1 → partial
```

### aggregate coverage

`aggregateFindings()` 当前按 chunk 解析结果：

```text
complete → totalChunks > 0 → failedChunks = 0
partial  → totalChunks = 0 → failedChunks > 0
```

### Coverage 综合真值表

| 输入条件 | manager-level | aggregate-level | 备注 |
|---|---|---|---|
| 0 chunk | 通常不应调用；若 chunkCount=0 则 complete | partial | 两层定义不一致 |
| 1 chunk，成功 | complete | complete | 一致 |
| 1 chunk，失败 | failure union，无成功 coverage | partial | aggregate 保留失败统计 |
| 2 chunk，全部成功 | partial | complete | 明确不一致 |
| 2 chunk，1 成功 1 失败 | 各单调用依 chunkCount 参数而定 | partial | 应检查 failedChunks |
| N chunk，全部失败 | 无成功结果 | partial | partial 不表示至少有一项成功 |
| 有 skipped 文件，所有生成 chunk 成功 | 不直接感知 skipped | complete | skipped 当前不使 aggregate 降级 |
| 单个文件大于字符上限 | 可仍为 1 chunk/complete | complete | budget 不是硬上限 |

### `ReviewerTelemetry`

```ts
interface ReviewerTelemetry {
  totalChunks: number;
  parsedChunks: number;
  failedChunks: number;
  worktreeChanged: boolean;
}
```

### telemetry 当前边界

manager 成功路径初始化 parsedChunks/failedChunks 后未必更新为实际值；aggregate telemetry 更接近多 chunk 的真实 parse 统计。使用 coverage 时应注明来源。

### complete coverage 不变量

理想定义应回答“全部计划审查输入是否成功处理”。当前 aggregate 的 `complete` 只证明全部生成的 chunks 解析成功，不证明 binary/unreadable/skipped 文件已审查，也不证明单个超大 chunk 未被截断或 provider 实际阅读完整。

### partial coverage

至少一个计划 chunk 失败或没有 chunk。它不是 findings 质量等级，也不保证至少一个 chunk 成功。

### coverage 与 success

```text
findings=[] → 不推出 passed
partial → 不推出有有效审查
complete → 不推出没有 skipped source
```

必须联合判断 result kind、telemetry、skipped 列表和 findings。

---

## 十六、Eval case 与 observation

### `ExpectedMemory`

评估期望槽，包含 category、scope、titleIncludes、contentIncludes、evidenceIncludes、sourceEntryId。

### `EvalCase`

包含 id、description、user、assistant、expected、forbidden。它同时定义输入 transcript、期望 Memory 和不得持久化内容。

### ground truth

EvalCase.expected 和 forbidden 形成的标注。它是指标基准，不自动代表生产 validator 的全部不变量。

### `EvalObservation`

```ts
interface EvalObservation {
  id: string;
  caseId: string;
  run: number;
  group?: string;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  noiseRejected?: boolean;
  precisionUndefined?: boolean;
  failures: string[];
  infraFailure?: boolean;
}
```

它是 summary 的最小事实输入。

### `EvalEvidenceV1`

版本化报告契约：metadata、observations、由 observations 计算的 summary 和 perCase breakdown。

### observation-first

先保存每次 case/run/group 原始观测，再计算 summary。禁止独立填写无法由 observations 重算的平均指标。

### `InstrumentationMeta`

commitSHA、Node、model、reviewer toggle、dirty、submoduleSHA、caseHash、promptHash 等复现元数据。

### `ExtractionTrace`

一次 extraction run 的结构化追踪快照，包含输入规模、candidate/review/save 数、阶段延迟、token、failure 字段和总状态。

### trace status

```ts
"success"
| "no-source"
| "validation-failed"
| "review-failed"
| "commit-failed"
| "aborted"
| "infra-failure"
```

### trace 当前填充边界

schema 中存在 candidate、review、分阶段 latency/token 等字段，不代表 live runner 当前都从生产 pipeline 完整回填。零值可能表示未仪表化，而不一定表示该阶段真实为零。

### `TraceSummary`

对 traces 计算 success rate、candidate 统计、review filter ratio、latency percentile、token 均值和 status counts。

### percentile 定义

当前 trace summary：

```text
p95 = sorted[floor(N × 0.95)]
p99 = sorted[floor(N × 0.99)]
```

索引越界时回退到最后元素。报告需注明该定义，避免与 nearest-rank 库混用。

---

## 十七、Eval 匹配与公式

### one-to-one matching

每个 expected 最多匹配一个 record，每个 record 最多匹配一个 expected。当前算法按 expected 顺序，选择第一个尚未使用且满足条件的 record，属于 greedy。

### `matchesExpected()`

当前合取条件：

```text
record.category = expected.category
→ record.scope = expected.scope
→ title 包含全部 titleIncludes，忽略大小写
→ content 包含全部 contentIncludes，忽略大小写
→ provenance.source = extraction
→ sourceEntryIds 包含 expected.sourceEntryId
→ sessionId 为非空字符串
→ sourceHash 为 64 位小写十六进制
```

### evidence eval 边界

匹配后：

```text
provenance.evidence 不存在或为空
  → 当前视为 grounding 可通过

存在 evidence quotes
  → 至少一条 quote 是 testCase.user 的逐字子串
```

当前不直接检查 `ExpectedMemory.evidenceIncludes`。因此生产 strict validation 与 eval matching 的 evidence 强度不同。

### true positive

成功占用 expected slot，且未因 forbidden contamination 降级的 record 数。

### false negative

```text
FN = expected.length - matchedExpectedCountAfterDemotion
```

### unmatched record

未被一对一匹配占用的 record。每条 unmatched record 基础计一个 FP。

### forbidden contamination

record title/content 含 case forbidden term。一个 matched record 被污染时从 TP 降级；forbidden 还产生 prediction-level penalty。

### forbidden prediction-level penalty

若至少一个非 TP record 含 forbidden：

```text
forbiddenPenalty = 1
```

不按 term 数或 record 数叠加。

### false positive

```text
FP = unmatchedRecordCount + I(anyForbiddenHitOutsideFinalTP)
```

### Precision

```text
P = TP / (TP + FP)
```

边界：

```text
TP + FP = 0 → P = null
TP = 0 且 FP > 0 → P = 0
```

### Recall

在 `evaluateRecords()` 中：

```text
R = TP / expected.length
expected.length = 0 → R = null
```

等价正例写法为 `TP/(TP+FN)`。

### F1

```text
F1 = 2PR / (P + R)
```

边界：

```text
P = null 或 R = null → F1 = null
P = 0 且 R = 0       → F1 = 0
```

### false discovery rate

```text
FDR = FP / (TP + FP)
```

分母为 0 时 null。它与“有 FP 的 case 占比”不同。

### noise case

`expected.length=0` 的 case。

### noise rejection

```text
noiseRejected =
  expected.length = 0
  → TP = 0
  → FP = 0
```

per-case P/R/F1 保持 null，不伪造 1。

### noise FP rejection

noise case 上 `FP=0` 的布尔值。正例 case 上为 null。

### `caseFPIncidence`

unmatched records 的去重标题列表，用于定位。它不完整编码 forbidden penalty 来源，也不必包含被 demote 的 matched record。

### failures 数组

人类可读失败描述。当前主要由 forbidden 路径填充；普通 FP/FN 不保证进入 failures。因此：

```text
failures.length = 0
```

不推出 `FP=0 → FN=0`。

### Eval per-case 真值表

| expected | predicted | TP | FP | FN | P | R | F1 | noiseRejected |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 0 | 0 | 0 | 0 | 0 | null | null | null | true |
| 0 | 1 普通项 | 0 | 1 | 0 | 0 | null | null | false |
| 1 | 0 | 0 | 0 | 1 | null | 0 | null | false |
| 1 | 1 正确项 | 1 | 0 | 0 | 1 | 1 | 1 | false |
| 1 | 1 错误项 | 0 | 1 | 1 | 0 | 0 | 0 | false |
| 1 | 2：1 正确+1 额外 | 1 | 1 | 0 | 0.5 | 1 | 2/3 | false |
| 3 | 1 正确项 | 1 | 0 | 2 | 1 | 1/3 | 0.5 | false |

注意 `expected=1,predicted=0` 时 Precision 为 null，F1 也按实现为 null，而不是自动填 0。

---

## 十八、Summary 公式与边界

### all-observation macro

`computeSummary()` 在汇总层把 `noiseRejected=true` 的观测视作 P=R=F1=1，再与其他可定义值做 macro。该约定只属于 summary，不改变 per-case null。

### positive macro

排除 `noiseRejected=true` 后计算 positivePrecision、positiveRecall、positiveF1。

### mean

```text
mean(x) = → x→ / N
```

### F1 variance

当前使用总体方差：

```text
varianceF1 = →(F1→ - meanF1)² / N
```

不是除以 `N-1` 的样本方差。

### worst/best F1

非空 F1 集合的 min/max；空集时当前 summary 返回 0。

### infra failure count

`infraFailure===true` 的 observations 数。

### semantic failure count

```text
count(failures.length > 0 → !infraFailure)
```

它取决于 failures 数组，不直接从 FP/FN 推导。

### failure rate

```text
semanticFailureCount / totalObservations
```

空 observations 时为 0。

### noise rejection rate

当前 `noiseObs` 仅由 `noiseRejected===true` 选出，再计算其中 TP=FP=0 的比例。因此 noise 失败观测不会进入该分母；这是 observation schema 缺少 expectedCount 带来的边界。

### precision/recall 配对边界

当前 `computeSummary()` 对 precision 先过滤 null，但 recall 数组不进行同样过滤，随后按数组索引计算 F1。在含中间 null precision 的观测序列中，P/R 可能错位。技术报告应优先保存 raw observations，并用明确同一 observation 的 P/R 重算。

### Live Eval false positive rate

当前 live runner 的相关指标语义为：

```text
有至少一个 FP 的 observation 数 / observation 总数
```

它不是 FDR，也不是 `→FP/→predictions`。

### Reviewer Pilot recall

```text
matched expected labels 总数 / expected labels 总数
```

非 success run 仍把 expected 放入分母，按漏检处理。

### Reviewer Pilot clean FP rate

当前分子可能是 clean observations 上的 FP findings 总数，分母是 clean observation 数，语义更接近每观测平均 FP 数，理论上可大于 1。

---

## 十九、Failure taxonomy 与退出码

### infrastructure failure

模型未配置、认证失败、provider 不可用、环境/网络问题等使评估无法执行的失败。

### pipeline/infra failure

提取、review 或 commit 管线没有得到合法完成结果。即使最终 repository 为空且 noise ground truth 也为空，也不能计为正确拒绝。

### semantic failure

管线成功执行，但输出与 ground truth 不一致，例如 FP/FN 或 forbidden persistence。

### 退出码优先级

```text
存在 infra/pipeline failure → exit 2
否则存在 semantic failure → exit 1
否则                       → exit 0
```

即：

```text
infra > semantic > pass
```

### 当前 semantic detection 边界

如果 live runner 依据 `metrics.failures.length` 判断语义失败，而普通 FP/FN 未写入 failures，则可能出现指标错误但 exit 0。验收应直接检查 FP/FN/F1，不只检查退出码。

### fail-open

边界失败后继续使用空结果或默认成功。例如 provider 失败后读取空 repository，把 noise case 计为正确。该模式在精度优先的 Memory pipeline 中应避免。

### fail-closed

边界失败后不写记录、不发布 manifest、不推进 checkpoint，并显式传播失败。合法空集除外，因为它是成功决策，不是边界失败。

---

## 二十、Installer 与符号链接术语

### `PI_CODING_AGENT_DIR`

安装器目标 agent 根目录的环境变量。未设置时使用 `~/.pi/agent`。

### extension source

当前仓库的 `extensions/` 目录。

### extension target

```text
<agentDir>/extensions/triple-pi
```

应为指向 extension source 的目录 symlink。

### legacy target

```text
<agentDir>/extensions/memory
```

旧的 memory-only 安装位置。cleanup 只删除该路径为 symlink 的情况。

### launcher source

当前仓库 `bin/trip`。

### launcher targets

按顺序尝试：

```text
~/.local/bin/trip
~/bin/trip
```

### `lstat`

检查链接对象本身的类型，不跟随最终链接。用于区分 symlink 与普通文件/目录。

### `realpath`

解析符号链接后的 canonical path。extension 幂等检查比较 target 和 source 的 realpath。

### broken symlink

symlink 对象存在，但目标不存在。`lstat` 成功，`realpath` 失败。当前 extension 安装器会 unlink 后重建。

### non-symlink refusal

extension target 若为普通文件或目录，安装器拒绝覆盖并 exit 1。这是保护用户数据的边界。

### lexical containment

仅从 `path.resolve()` 后的字符串判断 target 位于 root 下。

### canonical containment

解析父目录符号链接后，物理 target 仍位于 canonical root 下。当前安装器未对 parent realpath 做 containment 检查。

### parent symlink traversal

`agentDir/extensions` 本身是 symlink 时，向其下创建 `triple-pi` 会落到链接指向的物理目录。target 字符串看似在 agentDir 下，但实际写入位置可能不同。

### installer idempotency

正确 extension/launcher symlink 已存在时重复运行不改变对象。错误 symlink、broken symlink 与 non-symlink 的策略需分别验证。

### HOME isolation

只设置 `PI_CODING_AGENT_DIR` 不会隔离 launcher 写入。安装器测试还需要确保 `homedir()` 指向临时主目录，或在容器/一次性用户中运行。

---

## 二十一、性能术语

### benchmark

在固定环境、输入规模和 commit 下重复测量某条路径，同时验证结果正确性。

### warm-up

正式采样前执行若干轮，使模块加载、JIT 和页缓存初步稳定。warm-up 数据不混入正式样本。

### cold path

首次模块加载、首次目录创建或冷文件页下的路径。它与 warm distribution 应分开报告。

### sample

一次统计观测。微操作可在一个 sample 内循环多次，再除以次数，减少计时分辨率影响。

### throughput

```text
ops/s = completedOperations / elapsedSeconds
```

必须同时检查完成结果数和数据不变量。

### latency

单个操作从开始到完成的时长。文件系统路径包含锁等待、I/O、rename、chmod 和 index 工作。

### median

排序后 50% 位置，用于代表典型延迟。

### p95

95% 样本不超过的观测位置。必须声明使用 `floor(N×0.95)`、nearest-rank 或插值中的哪一种。

### mean

对离群点敏感。不能只报告 mean 而隐藏锁竞争长尾。

### max

最慢样本，只用于诊断异常；单次 max 不稳定，不应代替 p95/p99。

### correctness sentinel

benchmark 后执行的结果断言，例如最终 record 数、无 `.tmp`、幂等 replay 不改 updatedAt。没有 sentinel 的性能结果可能是在错误路径上得到的。

### CPU path

source hash、candidate JSON validation、metrics 和 finding aggregation 等主要在内存中执行的路径。

### filesystem path

repository save/list/search/prompt/index/revision 等涉及真实临时文件系统的路径。

### lock contention

多个 writer 竞争 repository write lock 的等待。`Promise.all` 发起并发不等于内部并行提交。

### replay fast path

manifest 已存在后返回空结果的幂等短路。它不能与首次完整 commit 混为同一操作分布。

### workload size

至少包括消息数、字符数、candidate 数、record 数、chunk 数和并发度。性能结论必须绑定规模。

---

## 二十二、常用不变量

### M1：项目隔离

```text
project record 可见 → query cwd 解析到同 projectId
```

Global 除外。

### M2：证据落地

```text
extraction record 可提交
→ evidence.sourceEntryId 对应 user
→ user content 包含 evidence quote
```

### M3：secret 双门

```text
Provider 前 redaction
→ Provider 后 candidate secret/placeholder rejection
```

### M4：幂等

```text
manifest(sourceHash) 存在
→ 同 source 不重写 entries
```

### M5：checkpoint

```text
pipeline 合法完成 → checkpoint 可推进
pipeline 抛错       → checkpoint 不推进
```

合法 `[]` 属于前者。

### M6：单文件可见性

读者不应看到半写 entry；temp+rename 提供单 target 切换。

### M7：批量发布

manifest 最后写。manifest 不存在时，不应把 source 视为成功发布。

### M8：索引非权威

`MEMORY.md` 缺失或损坏不能隐藏健康 entries。

### S1：单飞

scheduler 同一时刻最多一个 active extraction task。

### S2：旧 generation 不发布

generation 变化或 signal aborted 后，旧 current job 不 append checkpoint。

### S3：tree switch 无旧 pending

这是所需安全性质；当前 `bumpGeneration()` 不清 pending，因此需实验验证并可能不成立。

### R1：只读工具边界

Reviewer session registry 不含写工具。

### R2：失败不伪装成功

provider/parse/schema/timeout/worktree-changed 不应格式化为 passed 或“未发现问题”。上层聚合当前存在需审计的边界。

### R3：coverage 与 findings 独立

空 findings 只有在成功且 coverage 语义足够时才能解释为未发现问题。

### E1：observation 可重算

summary 必须能由 raw observations 重算。

### E2：infra 不计语义正确

pipeline 未运行成功时，空预测不能成为 noise rejection。

### E3：null 不伪造

数学未定义值保持 null；summary 若赋予 noise=1，必须明确是汇总约定。

### I1：安装器不覆盖 extension 普通对象

extension target 为 non-symlink 时拒绝。

### I2：canonical containment

这是安全审计要求；当前 parent symlink 路径需要额外检查，不能仅依赖 path.resolve。

---

## 二十三、命令速查

### 基线

```bash
node --version
git --version
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
```

### 类型检查与全量测试

```bash
npm run typecheck
npm test
```

### Memory 定向测试

```bash
npx vitest run test/memory/extraction-source.test.ts
npx vitest run test/memory/extraction-pipeline.test.ts
npx vitest run test/memory/extraction-coordinator.test.ts
npx vitest run test/memory/repository.test.ts
npx vitest run test/memory/signals-consolidation.test.ts
npx vitest run test/memory/working-state.test.ts
npx vitest run test/memory/extension.integration.test.ts
npx vitest run test/memory/extension-lifecycle.integration.test.ts
```

### Reviewer 定向测试

```bash
npx vitest run test/subagent/manager.test.ts
npx vitest run test/subagent/subagent-eval.test.ts
```

### Eval 定向测试

```bash
npx vitest run test/eval/metrics.test.ts
npx vitest run test/eval/trace.test.ts
npm run eval:recorded
```

### Recorded Eval

```bash
npm run eval
npm run eval:recorded
```

二者当前等价，均运行 `vitest run test/eval`。

### Live Eval

```bash
TRIPLE_PI_EVAL_MODEL=provider/model \
TRIPLE_PI_EVAL_RUNS=5 \
TRIPLE_PI_EVAL_RESULTS_DIR=/absolute/path/outside/repo \
npm run eval:live
```

可选关闭候选 reviewer：

```bash
TRIPLE_PI_EVAL_REVIEWER=false
```

### Reviewer Pilot

```bash
TRIPLE_PI_REVIEWER_PILOT_MODEL=provider/model \
npm run eval:reviewer-pilot
```

当前输出位置固定在 `eval/results/reviewer-pilot-summary.json`；在一次性 worktree/副本中运行或事后清理，避免污染工作树。

### Memory status/reset

```bash
npm run memory:status
npm run memory:reset:dry-run
npm run memory:reset
```

reset 前应先使用 dry-run 并确认 `TRIPLE_PI_MEMORY_ROOT`。

### 安装器

```bash
PI_CODING_AGENT_DIR=/absolute/temp/agent \
node scripts/install-extension.mjs
```

安全实验还必须隔离 Node `homedir()`，不能只隔离 agent dir。

### Git 三视图

```bash
git diff --cached --no-ext-diff
git diff --no-ext-diff
git ls-files --others --exclude-standard -z
```

### Git 状态与 snapshot 辅助

```bash
git status --porcelain=v1
git status --short
git hash-object -- <path>
git diff --stat
```

### scope 快速验证

```bash
node --experimental-strip-types --input-type=module -e '
import { resolveAutomaticScope } from "./extensions/memory/validation.ts";
console.log(resolveAutomaticScope("global", "Across all my projects, use pnpm."));
console.log(resolveAutomaticScope("global", "Use pnpm in this repository."));
console.log(resolveAutomaticScope("global", "所有项目都使用 pnpm。"));
'
```

预期：

```text
global
project
global
```

### coverage 快速验证

```bash
node --experimental-strip-types --input-type=module -e '
import { aggregateFindings } from "./extensions/subagent/review-core.ts";
const ok = { ok: true, review: { status: "passed", summary: "ok", findings: [] } };
const bad = { ok: false, failure: "parse-failed", error: "bad", raw: "" };
console.log(aggregateFindings([]).coverage);
console.log(aggregateFindings([{ chunkId: "c1", result: ok }, { chunkId: "c2", result: ok }]).coverage);
console.log(aggregateFindings([{ chunkId: "c1", result: ok }, { chunkId: "c2", result: bad }]).coverage);
'
```

预期：

```text
partial
complete
partial
```

### 临时实验根

```bash
export LAB_ROOT="$(mktemp -d)"
export TRIPLE_PI_MEMORY_ROOT="$LAB_ROOT/memory"
printf '%s\n' "$LAB_ROOT"
```

结束：

```bash
rm -rf "$LAB_ROOT"
git status --short
```

---

## 二十四、常见误述校正

| 误述 | 精确说法 |
|---|---|
| “搜索是语义检索” | 当前 repository 搜索是忽略大小写的 substring 匹配 |
| “global 由模型决定” | 自动 global 必须有明确跨项目 evidence，否则降为 project |
| “assistant 内容可以佐证用户意图” | 自动 Memory evidence 只能来自指定 user entry |
| “空结果就是成功拒绝” | 只有 pipeline 成功的合法空集才是；infra failure 不是 |
| “所有失败都在 result status 中” | extraction 的若干失败向上抛出；Reviewer 使用独立 failure union |
| “多 chunk 一律 partial” | manager 层如此；aggregate 层全部成功时为 complete |
| “complete 表示所有变更都审查” | 当前 aggregate 不把 skipped files 纳入 coverage |
| “12KB 是硬上限” | 当前不拆单个超大 file，chunk 可超过上限 |
| “staged 与 unstaged 都完整保留” | 同一路径 staged 优先，unstaged 项当前被去重跳过 |
| “工具调用数是 tool_use block 总数” | 当前统计含 tool_use 的 assistant message 数 |
| “temp+rename 保证断电不丢” | 只提供单文件可见性原子性，当前无 fsync 持久性保证 |
| “批量写是 ACID” | 当前是备份加逆序恢复的补偿事务 |
| “manifest 是完整事务日志” | 它是 sourceHash 幂等发布点，不是恢复日志 |
| “revision pointer 一定可遍历” | 必须验证 pointer ID 与实际 snapshot ID 一致 |
| “Eval 精确检查 evidenceIncludes” | 当前 matchesExpected 不直接使用该字段 |
| “failures 为空表示 FP/FN 都为零” | 普通 FP/FN 当前不一定产生 failure 字符串 |
| “trace 的零值都是真实零” | live instrumentation 当前可能未完整填充部分字段 |
| “设置 PI_CODING_AGENT_DIR 就完全隔离安装器” | launcher 仍使用 homedir；还需隔离 HOME/用户 |
| “path.resolve 防止 symlink 逃逸” | 它不解析父目录 symlink；需 canonical containment |
| “Reviewer 只读因为 prompt 要求只读” | 主要保证来自代码级 read/grep/find/ls allowlist 与 snapshot 检查 |

---

## 二十五、最小判定清单

### 判断一次 automatic Memory 是否可信

```text
[ ] source 来自当前 branch delta
[ ] provider 前已脱敏
[ ] candidate schema 严格通过
[ ] evidence 指向 user 且逐字存在
[ ] provider 输出无 secret/placeholder
[ ] reviewer 未改写候选
[ ] consolidation 边界合法
[ ] batch commit 成功
[ ] manifest 最后发布
[ ] checkpoint 只在有效 generation 提交
```

### 判断一次 Reviewer “未发现问题”是否可解释

```text
[ ] Git 收集成功且确实有 changes
[ ] skipped 文件已单独说明
[ ] 所有计划 chunks 都成功
[ ] provider 未失败、未超时、未取消
[ ] JSON parse/schema 成功
[ ] coverage 来源和定义明确
[ ] failedChunks=0
[ ] worktree snapshot 未变化
[ ] findings 为空
```

### 判断一份 Eval 报告是否可复现

```text
[ ] commit SHA 与 dirty 状态
[ ] Node、模型、运行参数
[ ] case/prompt hash
[ ] raw observations
[ ] infra 与 semantic 分开
[ ] null 边界未伪造
[ ] summary 可由 observations 重算
[ ] trace 未仪表化字段有说明
```

### 判断一个 benchmark 是否可比较

```text
[ ] 相同 commit 与 Node major/minor
[ ] 相同文件系统类别
[ ] 相同输入规模与并发度
[ ] warm/cold 分开
[ ] 样本数足够
[ ] median/p95 定义一致
[ ] correctness sentinel 通过
[ ] replay 与首次提交分开
```

这四组清单分别约束数据可信、审查可信、评估可信和性能可信。任何一组缺项，都应缩小声明范围，而不是用“整体通过”替代缺失证据。
