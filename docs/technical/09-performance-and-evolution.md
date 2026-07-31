# 09. 性能与演进：复杂度、预算、背压与决策门

> **校正声明**：本章按“缺陷修复后的目标语义”撰写。常数阈值、默认 chunk 大小、并发度、Memory 搜索上限、生命周期天数、trace 字段和 runtime 能力必须由最终源码与基准测试校正。复杂度公式用于建立推理模型，不代表未经测量的性能承诺。

## 1. 性能不是“越快越好”

Agent 系统至少有五个互相牵制的目标：

```text
质量 Q
延迟 L
成本 C
可靠性 R
安全性 S
```

优化不是单目标最小化：

```text
maximize Utility = wQ*Q + wR*R + wS*S - wL*L - wC*C
```

权重由产品风险决定。为了省 100ms 而跳过 worktree 快照，可能降低安全性；为了提高 recall 注入全部 Memory，可能增加 token、延迟和 prompt 污染。

推荐先定义硬约束，再优化：

```text
Safety invariants: 不可违反
Reliability SLO:   failure/timeout 上限
Quality gates:     F1/NRR/worst case
Budgets:           latency/token/memory
```

---

## 2. 端到端成本模型

一次 Reviewer 请求的墙钟时间可近似拆为：

```text
T_total = T_git + T_snapshot_before + T_search + T_chunk
        + T_sessions + T_merge + T_snapshot_after + T_cleanup
```

若 chunk 串行：

```text
T_sessions_serial = Σ(i=1..N) (T_create_i + T_model_i + T_parse_i)
```

若并发度为 `k`：

```text
T_sessions_parallel ≈ scheduling_overhead
  + max over worker lanes (Σ assigned T_i)
```

理想同耗时任务下：

```text
T ≈ ceil(N/k) * T_chunk_session
```

实际受 provider 限流、共享 CPU、磁盘和连接池影响，不会线性加速。

### 2.1 Token 成本

设：

- `N`：chunk 数；
- `P`：每请求固定 prompt + tool schema；
- `M_i`：第 i 块注入的 Memory；
- `D_i`：第 i 块 diff；
- `O_i`：输出 token。

则：

```text
InputTokens ≈ Σ(P + M_i + D_i)
            = N*P + ΣM_i + ΣD_i
TotalTokens ≈ InputTokens + ΣO_i
```

即使总 diff 不变，N 增大也会重复支付固定前缀。因此 chunk 预算太小会导致成本放大。

---

## 3. Git 采集复杂度

### 3.1 Diff 命令

设 tracked 文件总大小 `F`，实际变化 `Δ`。Git diff 的实际性能依赖对象缓存、rename detection、算法和文件类型；工程上不能简单声称 `O(Δ)`。可使用保守模型：

```text
T_git = cost(index/worktree scan) + cost(diff changed content)
```

优化方向：

- 避免多次重复执行同一 Git 命令；
- 不启用不必要的 rename 深度检测；
- `--no-ext-diff` 防外部 helper；
- 输出字节上限与 deadline；
- 一次 NUL 安全枚举 untracked；
- binary 早检测，避免加载全文。

### 3.2 未跟踪文件

若 untracked 文件数 `U`、总大小 `B_u`：

```text
枚举路径: O(U)
读取正文: O(B_u)
排序:     O(U log U)
```

真正风险是 `B_u` 无界。应先 `lstat` 与预算规划，再读取：

```pseudo
for path in untrackedPaths:
  metadata = lstat(path)
  reject special files
  if totalBytes + metadata.size > maxTotalBytes:
    mark skipped/partial
  else:
    read bounded content
```

`stat.size` 不能完全防 sparse file、压缩/生成内容和读时变化，因此 read 本身也需要硬上限。

---

## 4. Snapshot 复杂度与演进

### 4.1 全树内容 hash

设文件数 `F_n`、总字节 `B`：

```text
walk: O(F_n)
hash: O(B)
sort metadata: O(F_n log F_n)
space: O(F_n) metadata
```

前后两次就是约 `2*O(B)`，在大型 monorepo 可能比模型请求前处理更慢。

### 4.2 可选策略

| 策略 | 成本 | 检测能力 | 风险 |
|---|---:|---|---|
| `git diff --stat` | 低 | 很弱 | 同大小修改、untracked 漏检 |
| Git porcelain status | 低-中 | tracked/untracked 状态 | 不证明内容相同 |
| 只 hash 计划读取文件 | 中 | 输入集合强 | Reviewer 可能读额外文件 |
| 全 root 内容 hash | 高 | 最终态强 | 大仓库成本 |
| 只读 mount/OS sandbox | 启动有成本 | 强制完整性 | 平台复杂度 |
| fs watcher + hash | 中 | 过程事件 | watcher 丢事件/平台差异 |

演进决策应由威胁模型与测量驱动。若完整性是硬要求，优先 OS 只读；若本地可信单用户且仓库巨大，可采用 watcher + 关键文件 hash，但必须诚实标注残余风险。

### 4.3 增量 Merkle 思路

长期运行可维护目录 Merkle tree：

```text
rootHash
├─ srcHash
│  ├─ a.ts hash
│  └─ b.ts hash
└─ testHash
```

单文件变化只重算路径上的节点，理想更新 `O(log F_n)` 加文件 hash。但首次构建仍 `O(B)`，还要处理 rename、symlink、watcher 丢事件与进程外修改。对一次性 Reviewer，复杂实现可能不划算。

---

## 5. Chunking 复杂度与预算选择

### 5.1 基础算法

稳定排序变更：`O(C log C)`，C 为 ChangeFile 数；线性打包：`O(D)`，D 为总字符；因此：

```text
T_chunk = O(C log C + D)
```

若输入已按稳定顺序采集，可避免再次排序，降为 `O(D)`。

### 5.2 Chunk 大小的 U 型权衡

```text
chunk 太小：N 大 -> 重复前缀、请求开销、跨块关联丢失
chunk 太大：单请求慢、超时风险、模型注意力稀释、输出截断
```

目标预算不是固定“12KB 就最佳”，而应由：

```text
模型上下文
固定 prompt 长度
Memory 长度
预期输出 headroom
provider latency curve
finding recall curve
```

共同决定。

### 5.3 自适应预算

```pseudo
available = contextBudget
  - systemTokens
  - toolSchemaTokens
  - memoryTokens
  - outputReserve
  - safetyMargin

chunkBudget = clamp(charsFromTokenEstimate(available), minChunk, maxChunk)
```

字符/token 比对中文、代码、JSON 不同。若 runtime/provider 提供 token count，应优先使用真实 tokenizer；否则用保守估计并通过 trace 校正。

### 5.4 Overlap

Hunk 边界加入 overlap 可减少跨块上下文丢失：

```text
Chunk 1: lines 1..200
Chunk 2: lines 181..380
```

若 overlap 比例 `r`，输入放大约：

```text
effectiveDiffTokens ≈ D / (1-r)
```

`r=0.1` 时约 1.11D。Overlap 必须与 finding 去重共同设计。

---

## 6. Memory 搜索复杂度

若 repository 中记录数 `R`，查询 term 数 `K`，平均文本长度 `L`，朴素 substring 搜索：

```text
O(K * R * L)
```

再排序候选 `H`：

```text
O(H log H)
```

小型本地 Memory 足够简单可靠；不要过早引入向量数据库。

### 6.1 先做的低成本优化

1. 规范化文本只做一次并缓存；
2. term 去重与上限；
3. category/project scope 提前过滤；
4. 命中数达到候选上限时是否早停，要保持排序语义；
5. 按 record ID 去重；
6. 只把 top-K 注入 prompt。

### 6.2 Inverted Index 演进

建立 token -> record IDs：

```text
build: O(total corpus tokens)
query: O(K + postings merge)
update: 与变更记录 token 数近似线性
```

适合记录增长后，但中文分词、camelCase/snake_case、substring 语义会改变。需要用现有 eval 验证 recall 不回退。

### 6.3 Embedding/Vector Search 决策

不要因为“Agent 项目”就默认向量化。引入向量搜索的条件：

```text
- substring recall 在真实 query 上成为主要瓶颈；
- corpus 足够大，线性扫描影响 SLO；
- 可以接受 embedding 成本与隐私边界；
- 有离线 eval 证明质量增益；
- 有版本迁移和重建索引方案。
```

向量搜索引入：模型漂移、索引版本、近邻参数、数据出境和不可解释命中。可先用 hybrid：确定性 lexical 候选 + 小范围语义 rerank。

---

## 7. 并发与背压

### 7.1 有界并发

```ts
const limit = createLimiter(k);
const results = await Promise.all(
  chunks.map((chunk) => limit(() => reviewChunk(chunk))),
);
```

不能 `Promise.all` 无界发出所有请求。并发度 `k` 受：

- provider RPM/TPM；
- 本地连接数；
- 每请求输入 token；
- 内存；
- 用户 deadline。

### 7.2 Little 定律

稳定系统中：

```text
L = λW
```

其中 L 为系统平均在途任务数，λ 为到达率，W 为平均停留时间。若 provider 变慢而仍保持输入速率，队列必增长。需要：

```text
queue bound
admission control
timeout/cancellation
retry budget
user-visible overload
```

### 7.3 重试风暴

所有 chunk 遇到 429 后同步重试会形成 thundering herd。采用：

```text
exponential backoff + jitter
Retry-After honor
per-run retry budget
shared rate limiter
```

但 Reviewer 总 deadline 是硬约束：剩余时间不足一次有意义重试时，应返回 partial/timeout，而不是发起注定超时的请求。

### 7.4 公平性

一个超大 review 不应占满全局并发。可按 review run 分配配额或 round-robin chunk scheduling，避免小请求饥饿。

---

## 8. Timeout 预算分配

只有总 timeout `T` 时，不应让第一阶段吃完全部预算：

```text
T = T_git + T_snapshot + T_search + T_model + T_merge + T_cleanup + margin
```

动态 deadline：

```ts
const deadline = monotonicNow() + timeoutMs;
function remainingMs() {
  return Math.max(0, deadline - monotonicNow());
}
```

每阶段接收剩余预算，而不是各自重新获得完整 timeout。

### 8.1 为什么用 monotonic clock

系统时间可能被 NTP/用户调整。duration/deadline 应使用 monotonic clock；ISO wall clock 只用于日志时间戳。

### 8.2 Soft 与 Hard Deadline

```text
soft deadline: 停止启动新 chunk，等待已在途完成
hard deadline: 调用方返回 timeout/partial，并 abort 在途
```

这比到 hard deadline 才突然取消全部任务更容易获得有用 partial coverage。

---

## 9. Memory 提取管线性能

设消息数 `S`、总字符 `X`、候选数 `Q`、现有记录 `R`：

```text
source collection/redaction: O(X)
JSON parse/schema:          O(Q)
evidence substring check:  naive O(Q*X)
review provider:            model-dependent
consolidation naive:        O(Q*R*L)
commit:                     O(changed bytes + lock wait)
```

### 9.1 Evidence 检查

候选少时 `String.includes` 简单可靠。若 Q/X 增长，可：

- 只在 user messages 拼接文本中检查；
- 预规范化一次；
- 多 pattern 使用 Aho-Corasick，复杂度约 `O(X + matches)`；
- 但必须保留逐字语义，不能因 normalization 改变 evidence 定义。

### 9.2 Consolidation

所有候选与所有记录两两比较是 `O(QR)`。演进：

```text
先按 project/scope/category 分桶
再按规范化 title/token 建索引
只在候选桶内比较
```

任何优化都必须保留确定性与 replace/skip 的业务顺序。

### 9.3 Batch Commit

逐条锁/写会放大 I/O：

```text
Q * (lock + read + write + unlock)
```

批处理在单一锁内规划并一次性写可降低开销，但临界区更长。目标是锁内只做必要 read-modify-write，把模型调用放在锁外。

---

## 10. 缓存

### 10.1 可以缓存什么

- 不变 system prompt；
- 稳定 tool schema；
- 规范化 Memory 索引；
- project identity；
- Git 基线 metadata；
- recorded eval fixture。

### 10.2 不能盲目缓存什么

- working tree diff；
- 未跟踪文件列表；
- branch/session-dependent Memory；
- provider auth 状态；
- worktree snapshot。

缓存 key 必须包含所有语义输入。错误 key 比无缓存更危险。

### 10.3 Prompt Prefix Cache

若 provider/runtime 支持前缀缓存，固定内容应在前、动态 chunk 在后：

```text
stable tools -> stable system -> stable policy -> memory? -> diff chunk
```

但每个 chunk 的 Memory 不同会在其后使缓存失效。具体缓存 API 和是否适用于 Pi provider 必须由最终源码校正，不应把 Claude Messages API 的缓存语义直接假定为 Pi Runtime 通用契约。

---

## 11. 观测性

### 11.1 必要 latency 分解

```text
gitLatencyMs
snapshotBeforeMs
searchLatencyMs
chunkBuildMs
sessionCreateMs
modelLatencyMs per chunk
parseMs
mergeMs
snapshotAfterMs
cleanupMs
totalLatencyMs
```

只记录 total 无法定位瓶颈。

### 11.2 Token 与规模

```text
source chars/messages
change files/statuses/binary/skipped
total diff chars
chunk count/chars/tokens
memory candidates/injected
input/output/cache tokens
findings before/after dedup
coverage ratios
```

### 11.3 高基数字段

不要把绝对路径、session ID、trace ID 直接做 metrics label，会造成时序数据库 cardinality 爆炸。它们适合 trace/log 字段；metrics label 使用有限枚举：failure kind、coverage、status、provider family。

### 11.4 不采集敏感内容

性能 trace 默认保存长度、hash、计数，不保存 diff、prompt 和 raw output。需要原文时使用受控 debug artifact。

---

## 12. 基准测试方法

### 12.1 Microbenchmark

适用：

- chunk builder；
- keyword extraction；
- repository search；
- parser；
- snapshot hash。

要先 warm up，避免 JIT 与文件缓存误差；报告分布和输入规模。

### 12.2 Macrobenchmark

使用代表性 repo fixture：

```text
small:  10 files / 10KB diff
medium: 1k files / 500KB diff
large:  100k files / mixed binary/untracked
```

运行真实 Git/fs 与 faux provider，隔离模型网络噪声；然后单独 live latency benchmark。

### 12.3 Profiling 顺序

```text
measure -> identify dominant term -> optimize -> regression eval
```

不要先重写成复杂并发或索引再寻找收益。性能优化必须同时重跑语义和安全测试。

### 12.4 基准环境

记录：CPU、磁盘/WSL、Node、Git、文件系统、冷/热 cache、runtime SHA、commit dirty 状态。WSL 与原生 Linux 的 filesystem latency 可能显著不同。

---

## 13. 演进决策框架

每个提案写成 ADR 式决策表：

```text
问题：当前哪项指标/不变量不满足？
证据：trace、profile、eval、incident
候选：至少两个，包括“不改变”
收益：质量/延迟/成本
风险：安全、复杂度、迁移
可逆性：能否回退？
门：上线前后指标阈值
```

### 13.1 何时并发 chunk

**引入条件**：N 经常 >1，模型 latency 主导，总时延不满足 SLO，provider 有余量。

**不引入条件**：多数 N=1、限流紧、结果顺序/共享 session 状态复杂。

**发布门**：

```text
p95 latency 改善 >= target
provider failure/429 不增加
semantic F1/coverage 不回退
总 token 不显著增加
```

### 13.2 何时复用一个 AgentSession

复用可能降低创建开销和前缀成本，但引入跨 chunk 上下文污染、工具状态共享和错误传播。

```text
独立 session/chunk:
  + 隔离强、并发容易、失败局部
  - 创建和固定 prompt 重复

单 session 多 chunk:
  + 可能缓存/上下文复用
  - 后块受前块影响、历史增长、难并发
```

Reviewer 更看重独立性时，除非基准显示创建成本显著且有契约保证，否则不要轻易复用。

### 13.3 何时引入增量审查

根据文件 content hash 缓存已审查 chunk，可跳过未变化内容。但 finding 可能依赖：

- task；
- Memory；
- 相邻文件；
- model/prompt/parser 版本；
- staged/unstaged 来源。

缓存 key 至少：

```text
hash(chunk content, task, relevant memory, model, prompt version,
     parser version, review policy, git source)
```

漏一项会产生 stale finding 或漏审。

### 13.4 何时做 daemon/长期进程

优点：索引、runtime 和模型 registry 热启动。风险：状态泄漏、内存增长、升级和 crash recovery。只有 session 创建/索引启动成本在真实 trace 中显著时再考虑。

---

## 14. 数据与 schema 演进

### 14.1 Memory Schema

持久化记录要有 `schemaVersion`。迁移原则：

```text
read old -> validate -> pure transform -> validate new -> atomic write
```

迁移前备份，失败不覆盖；迁移必须幂等，支持 dry-run 与统计报告。

### 14.2 Trace Schema

新增字段应向后兼容；删除/改名需要 trace version。Summary 代码不能把缺失 token 当真实 0 而不区分“未采集”。目标类型可用：

```ts
number | null   // null = unavailable
```

否则旧 trace 会拉低平均 token。

### 14.3 Failure Taxonomy 演进

新增 failure kind 是 API 变化。必须同步：

- 判别联合；
- formatter/UI；
- metrics label；
- recorded fixture；
- live exit logic；
- docs。

保留 `unknown` 只作为版本兼容入口，内部应尽早规范化。

---

## 15. 兼容性与回滚

### 15.1 Runtime API 升级

使用 adapter 隔离 Pi Runtime 漂移：

```ts
interface ReviewerSessionPort {
  run(input: ReviewerPrompt, signal: AbortSignal): Promise<SessionOutput>;
  dispose(): Promise<void>;
}
```

adapter 内调用真实 `createAgentSession`。但契约测试必须针对 adapter + 真实 runtime，不能只测 port fake。

### 15.2 双读/双写

Memory schema 迁移可短期双读，尽量避免长期双写：双写增加部分失败与一致性状态。更安全路径：

```text
新版本 reader 先兼容旧 schema
离线/启动迁移
确认后 writer 只写新 schema
最终删除旧 reader
```

### 15.3 Feature Flag

Flag 适合高风险可回滚演进，但会增加测试组合。每个 flag 必须有：owner、默认值、删除日期、两态测试。简单一次性修复不应滥用 flag。

---

## 16. 性能优化的安全边界

以下“优化”默认应拒绝，除非有等价安全证明：

```text
- 为省 I/O 删除 worktree integrity check
- parse 失败时返回空 findings
- provider 超时后继续后台接受结果
- 为减少 token 截断 diff 而不标 partial
- 跨项目共享 Memory cache 且 key 不含 project ID
- 取消锁以提高并发写
- 把 secret 原文写 trace 方便调试
```

性能回归可恢复；安全不变量破坏可能造成用户数据损失或长期污染。

---

## 17. 一个阶段性演进路线

### 阶段 0：建立基线

```text
完整 trace 分解
固定 recorded eval
真实 AgentSession faux tests
live eval metadata
```

### 阶段 1：低风险优化

```text
term 去重/上限
稳定排序减少重复
bounded file reads
有界并发=2 或 3（实验决定）
批量 repository commit
```

### 阶段 2：数据驱动索引

```text
lexical inverted index
incremental normalized text cache
search quality regression gate
```

### 阶段 3：强隔离/大仓库

```text
read-only mount/container
incremental snapshot/Merkle
fair global scheduler
```

### 阶段 4：高级检索

```text
hybrid lexical + semantic rerank
embedding versioning/privacy policy
A/B + holdout 证明收益
```

每一阶段都要求：可回滚、可观测、语义不回退、安全不变量不弱化。

---

## 18. 面试问答

### Q1：Reviewer 的复杂度瓶颈通常在哪里？

**答**：取决于规模。小仓库通常模型 latency/token 主导；大仓库可能是未跟踪文件读取和全树 snapshot；Memory 增长后朴素 `O(KRL)` 搜索可能显著。必须用分阶段 trace 判断，不能凭直觉。

### Q2：为什么 chunk 越小不一定越快？

**答**：chunk 小会增加请求数 N，每块重复 system prompt、tool schema、Memory 和 session 开销；串行时延近似求和，并发又受限流。存在 U 型权衡。

### Q3：并发度应该设多少？

**答**：没有通用常数。由 provider RPM/TPM、单请求 token、deadline、内存和 429 曲线决定。用有界并发扫 k=1,2,4...，以 p95、failure、token 和质量联合选取。

### Q4：什么时候值得引入向量数据库？

**答**：当 corpus 规模或同义 recall 已被测量为主要瓶颈，且有 eval 证明收益能覆盖复杂度、成本、隐私和索引迁移风险时。小型本地 Memory 先用 lexical 更可解释。

### Q5：怎样优化 worktree snapshot？

**答**：先测成本。候选有只读 OS mount、计划读取集合 hash、watcher+hash、Merkle 增量。选择取决于威胁模型；不能简单删除检查。

### Q6：为什么 total timeout 要用 deadline 而不是每阶段 timeout？

**答**：每阶段各拿完整 timeout 会让总时延成倍超过用户预算。单调时钟 deadline 让每阶段只消费剩余预算，并可设置 soft/hard deadline。

### Q7：缓存 reviewer 结果最难的是什么？

**答**：正确 cache key。结果不仅依赖 diff，还依赖 task、Memory、模型、prompt/parser/policy 版本和 Git 来源。漏任何输入都可能错误复用。

### Q8：如何证明一次优化没有伤害质量？

**答**：先冻结实验定义；跑 deterministic/recorded gates；在同 case 上做 paired live experiment；比较质量、coverage、failure、latency/token；保留 raw observations 和可回滚开关。

---

## 19. 最终源码校正清单

- 默认 chunk 字符/令牌预算与最大 chunk 数；
- chunk 串行还是并行、真实并发度与 session 复用；
- Git/file/snapshot 的 timeout 和 byte limits；
- snapshot 实现的真实复杂度与覆盖范围；
- Memory search 的 term 上限、排序和当前复杂度；
- consolidation 与 batch commit 是否在单锁内；
- trace 中缺失 token 被表示为 undefined、null 还是 0；
- p95/p99 的实现是否存在 off-by-one；
- timeout 是否使用单调 deadline；
- provider retry/backoff 是否由 runtime 内部处理；
- lifecycle、schemaVersion 与迁移工具的当前事实；
- 所有阈值必须来自配置/源码或 benchmark，不在本文中虚构为稳定承诺。
