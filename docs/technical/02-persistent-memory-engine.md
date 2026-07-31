# 第二章：持久记忆引擎

## 1. Memory 不是“把聊天存下来”

长期记忆引擎要回答四个不同问题：

```text
输入问题：当前 branch 的哪些 user/assistant message 尚未处理？
认识问题：候选结论是否被用户原文支持、是否长期有用？
身份问题：它属于哪个 project/scope，是否是旧记录的纠正？
存储问题：如何幂等、可审计地写入，并在下次 session 注入？
```

原始 transcript 是证据源，不是最终 Memory。最终 record 是经过范围约束、证据校验、review 和 consolidation 的派生事实。

## 2. 三层时间模型

```text
┌────────────────────────────────────────────────────────┐
│ Long-term Memory                                       │
│ preference / decision / rule / fact / knowledge        │
│ 跨 session，严格 grounding，进入 entries/              │
├────────────────────────────────────────────────────────┤
│ Daily                                                  │
│ 某日发生的请求与 assistant 报告结果，按日滚动           │
├────────────────────────────────────────────────────────┤
│ Scratchpad                                             │
│ 当前 session 最近请求与报告结果，短时、有界、untrusted  │
└────────────────────────────────────────────────────────┘
```

Working State 不调用额外 LLM，由真实 branch message 确定性生成。它能帮助恢复“刚才在做什么”，但不能自动升级为长期真相，原因是 assistant 的“已完成”陈述可能未经验证。

## 3. 领域模型

### 3.1 分类与作用域

[现状] `MemoryCategory` allowlist：

- `preference`：用户稳定偏好；
- `decision`：难以从当前代码重新发现的决策与理由；
- `rule`：应持续遵守的约束；
- `fact`：不可从仓库直接发现的长期背景事实；
- `knowledge`：用户掌握程度等协作信息。

作用域只有：

```text
project（默认）  仅 canonical project 可见
global           所有项目可见，但必须有明确依据
```

自动候选即使请求 `global`，若 evidence 没有“所有项目/跨项目/always across projects”等明确表达，也会确定性降级为 `project`。这是最小权限原则在记忆系统中的应用。

### 3.2 Record ID

记录路径不使用未信任 title，而使用确定性 ID：

```text
id = H(scope, projectId, category, normalizedTitle) 的固定长度表示
path = entries/<allowlisted-category>/<id>.md
```

这样 title 中的 `../../`、Markdown link 或平台非法字符只是内容，不参与路径。相同边界内同标题对应同 identity，手动更新可保留 `createdAt`。

### 3.3 Provenance 是一等数据

```text
content: “Use GraphQL instead of REST.”

provenance:
  source = extraction
  sessionId = ...
  sourceEntryIds = [u42]
  sourceHash = ...
  evidence = [{ quote, sourceEntryId, role:user, quoteHash }]
  fingerprint = ...
  correction = true
  reinforcement = n
  scopeDecision = ...
  revision = ...
```

没有 provenance 的内容难以审计：无法判断是用户明示、assistant 推断、手动保存还是历史迁移。

## 4. 项目身份与作用域

### 4.1 默认身份算法

`resolveProjectIdentity(cwd)`：

```text
path.resolve(cwd)
   → 尽力 realpath（消除 symlink 别名）
   → Windows lower-case
   → 可选读取 .triple-pi/project.json
   → 无 alias 时：safe basename + SHA-256(canonical cwd)[0:20]
```

属性：

- 相同物理目录经 symlink 进入，通常同 ID；
- 重命名/移动目录会改变 ID；
- 同一 git remote 的 monorepo 子目录不会被暗中合并；
- 不依赖网络或 git 配置；
- 显式 alias 可用于迁移或多个 cwd 共享。

### 4.2 为什么不是 git remote

remote 不是 workspace identity：

```text
同 remote
├─ monorepo/apps/a
├─ monorepo/apps/b
└─ 多个 worktree
```

如果全按 remote 合并，局部规则会互相污染。路径 identity 的代价是目录移动后失去连续性；显式 alias 把共享变成用户可审计决策。

### 4.3 worktree 语义

不同 git worktree 有不同 realpath，因此默认不同 project ID。这是保守隔离：

```text
/repo                    → project P1
/repo/.claude/worktrees/x → project P2
```

如果希望共享，必须显式 alias。[校正点] 后续 branch/worktree 修复可能改变 alias 继承策略，主会话需校正具体路径，但不得悄悄把所有同 git 仓库目录自动合并。

## 5. 手动保存链

```text
SaveMemory(params)
  → validateMemoryWrite
     ├─ category allowlist
     ├─ scope allowlist/default
     ├─ title/content 非空与长度
     └─ secret detector
  → lifecycle 写保护
  → hasUI?
  → 展示完整内容并 confirm
  → repository.save
  → entry commit
  → 尝试 rebuild derived index
```

### 5.1 两层校验

工具层校验改善 UX，但 repository 仍必须重新校验。原因：

- 测试、脚本或未来模块可直接调用 repository；
- TypeScript 类型在运行时不存在；
- 未信任输入可能通过 `as any`、JSON 或旧版本进入；
- 安全边界不能只依靠调用者自律。

### 5.2 手动更新

同 scope/project/category/normalized title 对应同 record ID。更新时：

- 保留 `createdAt`；
- 刷新 `updatedAt`；
- 保存旧内容 revision snapshot；
- 新 head 指向 revision 链。

[校正点] 当前 revision pointer 的生成与 snapshot revision ID 之间应在修复后复核是否为同一链标识；教材依赖的是“旧 head 不可变保存、当前 head 可追溯”，不是现有随机 ID 的每个细节。

## 6. 自动提取六阶段协议

```text
current branch delta
  → 1. source + sourceHash
  → 2. secret redaction
  → 3. LLM extraction
  → 4. strict validation
  → 5. grounded review
  → 6. signals + deterministic consolidation
  → transactional repository batch
  → branch checkpoint
```

### 6.1 阶段一：branch delta

`findCheckpoint(branch)` 从当前 branch 末尾向前找合法 custom checkpoint。`buildExtractionSourceFromBranch` 只取 checkpoint 后的 user/assistant text message，并计算：

```text
sourceHash = SHA-256(JSON({ extractorVersion, sourceEntryIds, messages }))
```

至少要求两条 message 且包含 user message，避免对空片段或纯 assistant 片段提取。

不变量：

```text
相同版本 + 相同 entry IDs + 相同消息文本 ⇒ 相同 sourceHash
```

hash 是重放幂等 key，不是信任证明。

### 6.2 阶段二：secret redaction

发送 provider 前，对 API key、PAT、Bearer、JWT、private key、password/token assignment 等模式替换为 `[REDACTED_SECRET]`。

双向防线：

1. outbound：减少 secret 发送到模型；
2. inbound：候选的 title/content/evidence 再次检测，placeholder 也不能成为记忆。

正则检测无法发现所有秘密，也可能误报，因此它是 defense-in-depth，不是完整 DLP。更高安全等级可加入 entropy 检测、用户配置模式、结构化 credential scanner，但会提高误拒绝和计算成本。

### 6.3 阶段三：LLM extraction

模型只负责提出候选，输出必须是 JSON array。每项恰好六字段：

```text
category, title, content, evidence, sourceEntryId, scope
```

提示要求跳过：

- secrets/credentials；
- 临时调试状态、任务进度；
- 仓库中直接可发现的信息；
- 没有 user text 支持的 assistant 主张。

为何“不保存可从代码发现的事实”？Memory token 预算稀缺，应保存代码外上下文，而不是建立易陈旧的第二份 package.json。

### 6.4 阶段四：严格校验

校验器不是“尽量修 JSON”，而是输入防火墙：

- 顶层必须 array，候选数有上限；
- 每项必须是 plain object；
- keys 数量与排序后集合必须完全匹配；
- category/scope allowlist；
- 字段非空且有长度上限；
- `sourceEntryId` 必须指向 user message；
- evidence 必须是该 message 的逐字 substring；
- secret/placeholder 二次拒绝；
- global scope 守卫。

合法 `[]` 与 malformed 有不同语义：

```text
[]        = 模型明确认为没有候选，可提交 savedCount=0 checkpoint
malformed = 无法知道模型意图，不 checkpoint，下次重试
```

整批 fail-closed 牺牲 recall 与部分成功吞吐，换来简单、可证明的后台写入边界。

### 6.5 阶段五：Grounded Review

第二次模型调用只允许 `keep/remove`，并必须原样返回候选字段。校验包括：

- 数量、顺序一致；
- title/content/evidence/sourceEntryId 不变；
- 若返回 category/scope，也必须不变；
- evidence 仍可在完整 user message 中定位；
- 再次 secret check。

Reviewer 不得自由改写，因为改写后的每个新断言缺少逐句 evidence mapping。让第二个 LLM“润色”会破坏第一阶段已经建立的 grounding。

### 6.6 阶段六：signals 与 consolidation

#### Fingerprint

对 `scope + category + normalized(title+content token set)` 做 SHA-256。它比原始 title 稳定，但仍是启发式语义身份。

#### Reinforcement

只统计通过严格门和 review 的 user evidence，按 project context + scope + fingerprint 保存。增量必须在 repository lock 内计算，避免丢更新。

#### Correction

从 user evidence 检测带方向性的纠正语言，例如“不是 A 而是 B”“改成”“no longer”“instead”。普通禁止规则不应自动等同 correction。

#### Score

当前 score 由基础分、reinforcement、evidence ratio、durable category、correction 组成。它写入 provenance 供观测，**不单独作为 admission threshold**。

#### Consolidation 决策树

```text
同 scope + category + exact normalized title?
  ├─ correction → replace
  └─ otherwise  → skip
否则 fingerprint 相同?
  ├─ correction → replace
  └─ otherwise  → skip
否则 token Jaccard >= 0.72?
  ├─ correction → replace
  └─ otherwise  → skip
否则 → create
```

不同 category 永不自动合并。replace 必须携带已有 32 hex record ID，repository 再验证目标仍属于同 scope/category/project。

## 7. Pipeline 状态机

```text
[Unseen Delta]
      │ build source
      ▼
[Redacted]
      │ provider stop + valid JSON
      ▼
[Validated]
      │ review exact keep/remove
      ▼
[Reviewed]
      │ deterministic plan
      ▼
[Planned]
      │ locked batch + manifest publish
      ▼
[Persisted]
      │ append branch checkpoint
      ▼
[Checkpointed]

任一错误/abort：
[Redacted|Validated|Reviewed|Planned] ──> [Retryable, no checkpoint]
```

注意 repository 已提交但 append checkpoint 失败是特殊状态：

```text
[Persisted, no checkpoint]
  → 下次重放
  → manifest 命中，repository no-op
  → 补 append checkpoint
```

这就是 manifest 与 checkpoint 双层设计的价值。

## 8. Working State 引擎

### 8.1 确定性来源

`buildWorkingSource` 复用 current branch 与独立 working checkpoint；`buildWorkingStateUpdate` 提取最近 user request 和 assistant reported outcome，并记录：

- sessionId、source entry IDs、sourceHash、leaf；
- 日期与更新时间；
- bounded user/assistant 文本。

### 8.2 物理布局

[目标协议/现状概念]

```text
projects/<id>/
├─ working/sessions/<session-key>/SCRATCHPAD.md
├─ working/latest.json
└─ daily/YYYY-MM-DD.md

working-manifests/<project-id>/<sourceHash>.json
```

它们不位于 `entries/`，所以长期 `list/search/consolidation` 不会误收录。

### 8.3 幂等重建

每个 working source 写 manifest；Daily 不是简单 append，而是读取同日 manifests、排序并确定性渲染。相同 source 重放不会重复出现。

这是一种 event-derived view：manifest/update 是输入事实，Scratchpad/Daily 是可重新计算的展示。代价是 manifests 会增长，需要未来压缩或 retention 策略。

### 8.4 信任标记

注入文本明确标为：

```text
derived, temporary, untrusted
```

这不能完全防止 prompt injection，但建立了信任边界。[校正点] 若后续修复增强“记忆内容作为不可信数据”的 delimiter/escaping 或模型策略，应校正注入格式。

## 9. 长期 Memory 生命周期

时间依据是 project activity，而不是 entry 的 `updatedAt`。

```text
new ── session activity ──> hot
hot ── inactivity >30d ───> cold
cold ── confirmed restore ─> hot
cold/hot ── >90d ─────────> archive-due ── rename ──> archived
archived ── explicit restore + confirm ──────────────> hot
```

为什么 activity 来自 `session_start/before_agent_start` 而不是 memory write？用户可能持续使用项目但没有产生新长期记忆；若只看 write，会错误冻结活跃项目。

Global 记忆不随当前项目归档，因为它表达跨项目偏好。

## 10. 关键不变量

### M-1 Evidence ownership

```text
automatic record.provenance.evidence[*].role = user
```

Assistant 文本只能提供上下文，不能自证。

### M-2 Scope monotonic safety

自动流程可以 `global → project` 降权，不能在缺少跨项目 evidence 时 `project → global` 升权。

### M-3 Idempotence

```text
manifest(projectId, sourceHash) exists
⇒ 同 source batch 不再改变 entries/updatedAt/reinforcement
```

### M-4 Replacement boundary

```text
replace(target)
⇒ target.projectId = resolved project/global boundary
∧ target.scope = candidate.scope
∧ target.category = candidate.category
∧ candidate.correction = true
```

### M-5 Working/long-term separation

长期搜索默认不扫描 working/daily；working 搜索必须显式指定。

### M-6 Cold write protection

Cold/archived project 的 project-scope 写被拒绝；global 写不受当前项目冷态影响。

## 11. 源码导读

按数据流阅读：

1. `extensions/memory/domain.ts`：schema、evidence、scope decision、revision。
2. `project-identity.ts`：canonical cwd 与 alias。
3. `validation.ts`：手动写入与自动 scope guard。
4. `extraction/source.ts`：branch delta/checkpoint/hash。
5. `extraction/pipeline.ts`：redaction 与 strict candidate validation。
6. `extraction/provider.ts`：第一阶段提示与 Pi model boundary。
7. `extraction/review.ts`：原样 keep/remove。
8. `extraction/signals.ts`：fingerprint/correction/reinforcement/score。
9. `extraction/consolidation.ts`：create/replace/skip。
10. `extraction/coordinator.ts`：编排和 provenance。
11. `working-state.ts`：临时状态 schema、校验与渲染。
12. `repository.ts`：最终持久化与生命周期。
13. `memory/index.ts`：把以上模块接入 Pi lifecycle。

## 12. 错误方案与 trade-off

### 12.1 保存完整 transcript 作为 Memory

- 优点：无信息损失；
- 缺点：token 爆炸、隐私扩大、噪声、branch 污染、难以删除单一错误结论；
- 当前选择：transcript 是证据，record 是有界派生事实。

### 12.2 Reviewer 自由重写

- 优点：语言更简洁，可能合并多条；
- 缺点：新文本不再是 evidence 支持的逐字结论；
- 当前选择：只 keep/remove，未来若要改写需逐句引用图。

### 12.3 Score 阈值决定保存

- 优点：统一数值易排序；
- 缺点：权重未经校准，简洁但重要规则可能低分；
- 当前选择：score 可观测，admission 由硬约束决定。

### 12.4 全局 semantic dedup

- 优点：记录更少；
- 缺点：跨 category/project 合并导致语义与权限污染；
- 当前选择：先限制 scope/category/project，再近似匹配。

### 12.5 Embedding/向量库优先

- 优点：同义召回更好；
- 缺点：不解决证据、作用域、更新事务、生命周期，增加模型/索引版本；
- 当前选择：本地 record + keyword/index，先证明正确性，按测量结果再升级召回。

### 12.6 目录移动自动识别同项目

- remote、inode、内容 fingerprint 都有反例；
- 显式 alias 更透明，但增加配置负担；
- 当前选择：默认路径隔离，显式共享。

## 13. 面试追问

1. **为什么 evidence 必须逐字匹配？**
   - 追问：paraphrase 召回损失如何补偿？能否保存 byte offset 或 message hash？
2. **为什么合法空数组要 checkpoint？**
   - 否则无候选片段会每次重复调用模型；malformed 则不能推进。
3. **为什么同 sourceHash manifest 按 project 存？**
   - 相同文本在两个项目不是同一权限边界，global record 也不能让另一项目误以为已处理。
4. **Jaccard 0.72 有什么理论保证？**
   - 没有语义真值保证，它只是可审计启发式；因此 replacement 还要求 correction 与边界限制。
5. **如何避免 assistant 自我强化错误记忆？**
   - reinforcement 只来自 user evidence，assistant 复述不计独立观察。
6. **为什么 Working State 不用 LLM 总结？**
   - 降成本、减少幻觉、保持可审计；代价是压缩质量较机械。
7. **用户说“所有项目都这样”时为什么仍需 scope decision provenance？**
   - 便于审计 global 提权的证据与未来撤销。
8. **如何纠正一条错误记忆？**
   - user 给方向性证据，review 原样 keep，consolidation 在同边界生成 replace，旧 head 进入 revision。
9. **项目移动后如何保留记忆？**
   - 通过显式 alias/migration；不能依赖 displayName 猜测。
10. **Memory prompt 注入全部正文还是索引？**
    - 当前设计偏有界索引，按需 SearchMemory；需结合 context budget 与 record 数量测量。
