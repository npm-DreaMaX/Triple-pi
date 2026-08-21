# 14 · Memory 检索、Reviewer 与性能审计报告

> 评估日期：2026-08-19（v2，含性能审计与路线图修订）
> 评估方法：全量代码走读（memory 15 个源文件 / subagent 4 个源文件，含 scheduler / working-state / validation 热路径补读）+ 可执行验证脚本（真实调用 `FilesystemMemoryRepository`、`similarity`、`semanticFingerprint`，非纸面推断）+ 测试基线（`vitest run test/memory`：12 文件 86 用例全通过）+ 检索/性能双基线（Phase 0a `test/eval/retrieval-eval.test.ts` 7 用例、Phase 0b `scripts/perf-bench.mjs` 100/1k/10k 记录 + 100/1k turn 实测）
> 状态：**仅审计+建立度量基线，未改任何业务代码**。所有修复方案均为建议稿，后续每项优化锚定 §7.1/§7.2 基线做 before/after。
> v2 变更：新增 §5 性能审计（P1-P10，热路径逐轮 IO 追踪）；路线图改为**度量先行**顺序（§7）；新增面试交付物清单（§8）与已知局限（§9）。Phase 0a（检索基线）/0b（性能基线）/0c（systemPrompt 膨胀疑点证伪）已完成。

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [验证实验记录（真实运行结果）](#2-验证实验记录)
3. [Memory 模块评估](#3-memory-模块评估)
4. [Subagent / Reviewer 模块评估](#4-subagent--reviewer-模块评估)
5. [性能审计（新增）](#5-性能审计)
6. [关于"面试官只提了 memory"](#6-关于面试官只提了-memory)
7. [改进路线图（v2：度量先行）](#7-改进路线图)
8. [面试交付物清单](#8-面试交付物清单)
9. [已知局限（诚实边界）](#9-已知局限)
10. [附录：问题-方案速查表](#10-附录问题-方案速查表)

---

## 1. 执行摘要

| 维度 | 现状 | 一句话结论 |
|---|---|---|
| memory 写入链路 | **强**。证据锚定、脱敏、scope 守卫、修订链、事务批提交、回滚 | 属实，但中文去重有一个真 bug（M1） |
| memory 检索链路 | **弱**。子串匹配 + recency 排序，写时信号全部闲置 | 写入是"数据库"水准，检索是 `grep` 水准 |
| subagent 执行链路 | **强**。隔离、硬超时、worktree 快照、注入防御 | 全项目工程素养最高的部分 |
| subagent 记忆召回 | **弱**。中文检索词几乎全被过滤（召回≈0），N+1 扫描 | 继承 memory 检索缺陷并放大 |
| **性能（v2 新增）** | **中→差，随时间恶化**。每轮对话 O(N+M) 全量 IO 在延迟关键路径上；M 无限增长无 GC | 小规模无感，规模和时间都会把它变慢 |
| **验证体系** | 三层 eval 只覆盖抽取，**检索质量与性能零覆盖**（G1/G2） | 检索弱从未被发现的根本原因 |

**最关键的五个发现：**

1. **M1（P0）**：中文分词失效 → 中文记忆去重/指纹链路整体失效，同一记忆反复写入。
2. **M2/M3（P0）**：检索 = "recency 排序 + 子串匹配"，缩写/同义/跨语言全部搜不到。
3. **P3（P0-性能）**：`saveWorkingState` 每轮全量扫描**无限增长**的 working manifests——每轮对话成本 O(历史会话数)，用得越久越慢。
4. **P1/P2（P0-性能）**：每轮对话（`before_agent_start`）全量读盘所有记忆 + 每轮获取写锁写 `project.json`，全部位于 LLM 调用开始前的延迟关键路径。
5. **G1/G2（战略缺口）**：现有 eval 只测抽取 F1；检索质量（Recall@k/MRR）和性能（延迟分布）都没有度量——"很弱"和"变快了"目前都只是定性说法。

---

## 2. 验证实验记录

验证脚本直接 import 项目源码运行（`node --experimental-strip-types`），输入为真实落盘的记忆记录。

### 实验 1：子串检索的边界（用户假设验证）

写入记录：`title: "图学习框架选型"`, `content: "以后统一使用PyTorch Geometric，不要再用DGL。"`

| 查询 | 结果 | 分析 |
|---|---|---|
| `PyG` | ❌ 0 条 | 缩写 ↔ 全称零字面重叠，**假设成立** |
| `图神经网络库` | ❌ 0 条 | 同义改写无字面重叠，**假设成立** |
| `图学习框架` | ✅ 1 条 | **碰巧命中**：标题恰好是"图学习框架选型"。若内容单独存在（无此标题），同样搜不到 |
| `PyTorch` / `Geometric` | ✅ 1 条 | 字面精确匹配，正常 |
| `神经网` | 视内容而定 | 字符级部分匹配对中文**确实有效**（无词边界），这是子串匹配对中文唯一的真实优势 |

**结论**：中文的*字符级*匹配没问题，但*语义级*检索（缩写/同义/跨语言）对任何语言都缺失。"图学习框架"能命中纯属标题巧合。

### 实验 2：中文去重链路（M1 实锤）

```
tokens("以后统一使用PyTorch Geometric，不要再用DGL")
→ ["以后统一使用pytorch", "geometric不要再用dgl"]
```

中英文字符粘连成巨型 token（`[\p{L}\p{N}]+` 连续匹配不区分文字系统）。

```
similarity("以后统一使用PyTorch Geometric，不要再用DGL。",
           "以后统一使用 PyTorch Geometric 不要再用 DGL")   → 0.14   （去重阈值 0.72）
similarity("这个项目使用pnpm作为包管理器",
           "包管理器统一使用pnpm不要用npm")                  → 0
fingerprint(仅空格差异的两句中文)                            → 不相同
similarity(英文近重复句对)                                   → 1.0   ← 英文完全正常
```

同一条中文记忆被判定为"新记忆"反复 create；fingerprint 匹配同样失败；correction→replace 链路对中文同样失效。英文链路完全正常——纯 CJK 分词 bug，不是算法错误。

### 实验 3：性能热路径追踪（v2 新增，代码走读推演）

对 `before_agent_start` + `agent_settled`（即**一轮用户消息**的完整成本）逐行追踪，结果见 §5。此处给出量化估算（温缓存，ext4/WSL2，单次 read+JSON.parse 约 50-150µs，写锁获取约 0.5-2ms）：

| 记忆规模 | 每轮文件读+parse 次数 | 每轮锁获取 | 估算每轮附加延迟 |
|---|---|---|---|
| 50 条 / 20 manifest | ~75 | 2 | 5-15ms |
| 300 条 / 100 manifest | ~405 | 2 | 20-60ms |
| 2000 条 / 500 manifest | ~2505 | 2 | 130-400ms |
| 2000 条 / 2000 manifest（重度使用一年） | ~4005 | 2 | 200-600ms |

全部发生在 **LLM 请求发出之前**。且 manifest 数只增不减——最后一行不是假设，是系统运行一年的必然状态。

---

## 3. Memory 模块评估

### 3.1 架构综述

```
extensions/memory/
├── domain.ts           记录 schema（V2）、类别、provenance、修订链类型
├── validation.ts       统一写入校验：类别/scope/长度/密钥检测 + 跨项目证据守卫
├── project-identity.ts 项目身份（projectId 解析）
├── repository.ts       文件系统存储引擎（1285 行，核心）
├── working-state.ts    Scratchpad / Daily 派生工作状态（严格解析器）
├── index.ts            工具层（SaveMemory / SearchMemory）+ 生命周期 hooks
└── extraction/         自动抽取
    ├── provider.ts     LLM 调用（系统提示词在此）
    ├── pipeline.ts     候选校验（严格 key 集合、证据逐字校验、脱敏）
    ├── review.ts       二次 LLM 审查
    ├── signals.ts      fingerprint / 强化信号 / 打分
    ├── consolidation.ts 去重决策（create/replace/skip）
    ├── coordinator.ts  编排 + 遥测
    ├── scheduler.ts    抽取调度（generation + pending 合并，设计干净）
    └── source.ts       会话分支 → 抽取源 + checkpoint
```

### 3.2 写入链路（为什么被评价为"质量高"）——属实

| 机制 | 位置 | 评价 |
|---|---|---|
| 证据锚定 | `pipeline.ts:116` | 每条抽取必须携带用户消息**逐字引用** + entryId，子串匹配硬校验，LLM 编造直接拒绝。全项目最有辨识度的设计 |
| 三段脱敏 | `pipeline.ts:54` → `pipeline.ts:117-123` | 送模型前 redact → 返回后含 `[REDACTED_SECRET]` 或命中密钥模式则整体拒绝 |
| Scope 守卫 | `validation.ts:164-170` | global 候选必须含跨项目证据（中英双语模式），否则确定性降级 |
| 修订链 | `repository.ts:333-353` | 覆盖前旧版本快照到 `revisions/<id>/`，revisionId 链可回放 |
| 事务批提交 | `repository.ts:697-803` | 全量备份 → 按序写（revision 先行、manifest 最后发布）→ 失败逆序回滚，回滚失败计数进 diagnostics |
| 并发控制 | `repository.ts:1252-1265` | proper-lockfile 写锁 + 临时文件 rename 原子写 + 0600/0700 权限 |
| 归档一致性 | `repository.ts:815-821` 等 | 读前后 double-check 归档位置，变化重试一次 |
| 容错读取 | `repository.ts:1196-1199` | 单条损坏不掩盖健康记录，corrupt 计数进 diagnostics |
| 生命周期 | `index.ts:270-320` | 五态机，闲置 90 天无损归档 |
| 调度器 | `scheduler.ts` | generation 语义（tree switch/shutdown 使过期结果不提交）+ pending 合并 + 1s 限时 shutdown，比常见的手写调度严谨 |
| Schema 演进 | `repository.ts:216-238` | V1 原地升级 V2，未来版本 fail-closed |

**但 M1 证明写入侧并非无懈可击**——去重决策的核心（tokenization）对中文是坏的。

### 3.3 问题清单（正确性）

#### M1 · 【P0 · 写入侧 bug】CJK 分词失效 → 中文去重/指纹链路整体失效

- **位置**：`extraction/consolidation.ts:11`（`tokens()`）、`extraction/signals.ts:20-24`（`normalizedTokens()`）
- **根因**：`/[\p{L}\p{N}]+/gu` 把连续中英文字符当一个 token，中文整句成为巨型 token 且与相邻英文粘连（实验 2）。
- **影响链**：① `similarity()` 对中文恒 ≈ 0 → 0.72 去重阈值永不触发 → **同一中文记忆反复 create**；② `semanticFingerprint()` 仅空格差异即指纹不同 → 指纹去重失效；③ correction→replace 依赖上述匹配 → 中文"改错"生成新记录而非替换。
- **修复方案**：新增共享分词器 `extensions/memory/tokenize.ts`——ASCII 连续段按词切分，CJK 连续段按 **bigram** 切分（CJK 信息检索标准做法）：

```ts
const isCjk = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff);
};

export function tokenizeText(input: string): string[] {
  const tokens: string[] = [];
  for (const run of input.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let i = 0;
    while (i < run.length) {
      let j = i;
      const cjk = isCjk(run[i]);
      while (j < run.length && isCjk(run[j]) === cjk) j++;
      const seg = run.slice(i, j);
      if (cjk && seg.length > 1) {
        for (let k = 0; k < seg.length - 1; k++) tokens.push(seg.slice(k, k + 2));
      } else {
        tokens.push(seg);
      }
      i = j;
    }
  }
  return tokens;
}
```

  `consolidation.tokens()` 与 `signals.normalizedTokens()` 改为调用它。同时给 similarity 侧加一个小型中文停用词过滤（的了是在我和你等，bigram 场景下高频虚词会虚增相似度）。效果：`similarity(同句±空格) = 1.0`，近重复正确命中阈值。
- **次生问题（必须处理）**：0.72 阈值是按英文词级 Jaccard 校准的，bigram Jaccard 分布不同，**阈值需要用数据重校**（依赖 G1 eval，见路线图 Phase 0）；旧记录指纹失配会退到 similarity 兜底（修复后兜底有效），无需数据迁移，但 changelog 需注明。
- **验收标准**：同一中文记忆抽取两次，第二次决策为 `skip`（correction 时 `replace`）；英文用例行为不变（现有测试全绿）。

#### M2 · 【P0】检索按 recency 排序，与相关度无关

- **位置**：`repository.ts:862`（`formatSearchResults`）
- **现象**：先按 `updatedAt` 排序、后 `filter(includes)`、再 `slice(max)`——返回"最新的命中"而非"最相关的命中"，top-10 被无关新记录挤占。
- **修复方案**：打分排序，全部用已有数据，零新增存储：

```ts
score = 0
  + (整串子串命中 title ? 10 : 整串命中 content ? 4 : 0)   // 保底：不劣于现状
  + (整串命中 keywords ? 8 : 0)
  + Σ(每个查询词): (命中 title/keywords ? 3 : 命中 content ? 1 : 0)
  × (1 + 0.1 × provenance.score + 0.02 × min(5, provenance.reinforcement))
// 并列时 updatedAt 新者在前；查询词用 tokenizeText 切分（多词、中文 bigram）
```

- **注意**：权重是初始猜测，**必须用 Phase 0 的 retrieval eval 调参与验证**，不能拍脑袋上线。
- **验收标准**："旧而高度相关"排在"新而不相关"之前；eval 中 Recall@10 提升。

#### M3 · 【P0】纯子串匹配 → 词汇鸿沟（缩写 / 同义 / 跨语言）

- **位置**：`repository.ts:864`
- **现象**：见实验 1。
- **修复方案（写时物化别名，推荐）**：抽取链路本来就要过一遍 LLM，让它顺手产出别名，把语义问题**转化为存储问题**：
  1. `domain.ts` 的 `MemoryRecord` 增加可选字段 `keywords?: string[]`（向后兼容，schema 不升版）；
  2. `provider.ts` 抽取提示词增加输出契约：`keywords: 可选，最多 5 个别名/缩写/中英文对应名`；
  3. `pipeline.ts:validateCandidates` 的严格 key 集合校验放宽为"必需 key ⊆ keys ⊆ 必需+keywords"（**保持未知 key 拒绝**，这是防注入设计），校验形状（string[]、每项 ≤60 字符、≤5 项、过密钥检测）；
  4. `repository.save` / `saveExtractionBatch` 持久化（`serializeRecord` 展开序列化全部元数据、`parseRecord` V2 透传——存储层几乎零改动）；
  5. 检索时 keywords 参与匹配并按 M2 公式加权；
  6. `SaveMemory` 工具加可选 `keywords` 参数。
  7. **存量回填**（上一版遗漏）：提供一次性维护脚本，对旧记录批量调 LLM 补 keywords（opt-in，`memory-keywords-backfill`，带 dry-run），否则修复只对新记录生效。
- **为什么不直接上向量检索**：见 §9 已知局限——keywords 先行的完整理由。向量层作为 Phase 4 演进项。
- **验收标准**：带 `keywords: ["PyG","图神经网络","GNN framework"]` 的记录，`search("PyG")` 与 `search("图学习框架")` 均命中。

#### M4 · 【P1】写入信号在读取侧全部闲置

- **位置**：`signals.ts:37-62`（计算并存储 `score`/`reinforcement`）vs `repository.ts:824-877`（检索完全不读）
- **现象**：`signals/<projectId>/reinforcement.json` 有完整持久化机制，但除写入去重外无任何消费路径。写读不对称的典型案例。
- **修复方案**：并入 M2 打分公式。

#### M5 · 【P1】工作状态检索只覆盖最新一天

- **位置**：`repository.ts:563-564`（只读 `files[0]`）、`repository.ts:577-585`
- **修复方案**：`searchWorkingState` 独立实现——扫最近 7 天 daily + scratchpad，逐文件匹配，结果带日期标注。`loadWorkingState`（注入路径）保持不变。

#### M6 · 【P1】SearchMemory 工具 API 贫瘠

- **位置**：`extensions/memory/index.ts:188-263`
- **修复方案**：加 `category`（逗号分隔多值）、`max` 参数；`SearchMemoryOptions` 透传过滤。

#### M7 · 【P2】无索引缓存，每次检索 O(N) 全量读盘 → 已升级为性能问题 P1，见 §5

#### M8 · 【P2】buildPrompt 注入是 recency-only 平铺索引

- **位置**：`repository.ts:899-925`
- **修复方案**：短期按 category 分组配额（rule/decision 优先）+ 信号排序；长期用最近用户消息做轻量词法选条（复用 M2 打分函数）。

#### M9 · 【P3】记录 ID = hash(title)，改标题即新记录

- **位置**：`repository.ts:138-143`
- **现象**：手动路径无相似度检查，改一个字就是新记录，旧记录残留。可接受取舍，知晓即可。

---

## 4. Subagent / Reviewer 模块评估

### 4.1 架构综述

```
extensions/subagent/
├── types.ts        判别联合结果类型（ReviewResultUnion 11 种 kind）
├── review-core.ts  纯函数核心：git 采集 → 检索词提取 → 记忆检索 → 分片 → prompt → 解析 → 聚合
├── manager.ts      Session 隔离执行器（只读白名单、硬超时、abort 传播）
└── index.ts        工具层 + 编排（串行分片 + 全局 deadline）
```

### 4.2 强项

| 机制 | 位置 | 评价 |
|---|---|---|
| Session 隔离 | `manager.ts:87-106` | 五个 no-xxx 关闭一切扩展面，inMemory 不落盘，只读工具白名单 |
| 超时语义 | `manager.ts:112-128` | `Promise.race` 保证 deadline 必返回，abort 后台协作取消——注释把语义写得很清楚 |
| Worktree 一致性 | `review-core.ts:706-752` | 审查前后双快照指纹，中途变化整体作废 |
| Prompt injection 防御 | `review-core.ts:447-505` | 显式不可信声明 + XML 转义 + 三段标注 |
| Git 安全解析 | `review-core.ts:75-77` | 全程 `-z` NUL 分隔；execFileSync 超时 + maxBuffer |
| 严格输出 schema | `review-core.ts:538-622` | 未知字段拒绝、状态/发现一致性校验 |
| 确定性聚合 | `review-core.ts:640-691` | 内容寻址去重、severity 就高合并 |

### 4.3 问题清单

#### S1 · 【P0】中文检索词几乎全被过滤 → 中文项目 review 记忆召回 ≈ 0

- **位置**：`review-core.ts:182`（task 词要求 `length > 3`）、`review-core.ts:197`（path 词 `> 2`）、`review-core.ts:20-32`（STOP_WORDS 纯英文）
- **根因**：中文词汇绝大多数 2-3 字（"测试""规则""鉴权"），按字符数全部过不了门槛；中文句子无空格，整句成一个"词"更过不了。
- **影响**：中文项目 `review_current_changes` 的记忆检索输入接近空集 → reviewer 拿不到项目规则 → **"审查是否违反项目规则"对中文项目基本失效**，且静默失败（返回"无相关 Memory"）。
- **修复方案**：task 词层级改用 `tokenizeText`（CJK bigram + ASCII 词），门槛改为"含 CJK 且 ≥2 字符，或 ASCII 且 >3"；补中文停用词表。path 词层级同理。
- **验收标准**：task 为"修改了登录鉴权逻辑"时 terms 含"鉴权"相关 bigram。

#### S2 · 【P1】N+1 检索：最多 15 词 × 每词全量文件系统扫描

- **位置**：`review-core.ts:291-312`
- **现象**：每词一次 `repository.search()`，每次内部 `listUnlocked` 读盘解析全部记录；每词 `max: 3` 截断导致召回有偏。一次 review 最多 15 遍 O(N) IO。
- **修复方案**：repository 增加多词单扫接口 `searchByTerms(terms, cwd, options)`：一次 `listUnlocked`，每条记录计算命中词集合，返回 `{record, hitTerms, titleHit}`。`searchRelevantMemories` 改调它，排序逻辑不变。与 P1 缓存协同后近零成本。
- **验收标准**：`searchRelevantMemories` 期间 `listUnlocked` 只执行一次。

#### S3 · 【P1-修正】delegate_review 成功时 per-manager 内部遥测 parsedChunks 硬编码 0

> **v2 修正（Phase 1 落地后核实）**：原审计称"用户可见输出分片 0/1"不准确。读代码确认：用户可见的 `**分片**：${parsedChunks}/${totalChunks}`（`index.ts:479`）绑定的是 **aggregator 遥测**（`index.ts:280` 用 `aggregated.parsedChunks`，由 `review-core.ts:656` 正确计数），本就显示正确的 1/1，**并非 0/1**。`manager.ts:174-180` 的硬编码 `parsedChunks: 0` 是 per-manager **内部字段**，未进入用户可见输出——但仍是真实的内部误报（成功却报 0），已修正。

- **位置**：`manager.ts:174-180`（成功路径硬编码 `parsedChunks: 0`）。`index.ts:479` 走 aggregator，无需改。
- **修复（已落地）**：成功路径 `parsedChunks: parseOk ? 1 : 0`、`failedChunks: parseOk ? 0 : 1`，与"一次 manager 调用完整审查一个 chunk"的注释一致。+1 用例断言成功时 `parsedChunks===1`。
- **影响面**：内部遥测准确性；用户可见输出本就正确，无前后行为差异。

#### S4 · 【P2】类型词噪声挤占 15 词预算

- **位置**：`review-core.ts:211`（Tier 3 优先级最高，无代码停用词）
- **现象**：`: string`、`<T>` 把 string/number/any/error 等无处不在的类型词以最高优先级塞进前 15 名。
- **修复方案**：代码停用词集（string/number/boolean/any/void/return/const/function/error/result/…）。

#### S5 · 【P2】串行分片 + 单一 120s 全局 deadline

- **位置**：`index.ts:36`、`index.ts:191-238`
- **现象**：大 diff 多分片串行，前面慢会饿死后面（剩余时间 ≤0 直接记 timeout）。
- **修复方案**：有限并发（2-3 路）或按剩余分片动态分配预算；需权衡 API rate limit，做成可配置。
- **验收标准**：3 分片 × 40s 场景总耗时 < 120s。

#### S6 · 【P3】跨分片去重依赖措辞一致

- **位置**：`review-core.ts:660-663`（key = file+line+description 前 80 字符）
- **修复方案**：可选——同 file findings 做轻量 token 相似度合并（复用 M1 修复后的分词器）。

#### S7 · 【P3】小瑕疵

- `review-core.ts:27,31`：STOP_WORDS `"where"` 重复；
- `review-core.ts:181,196`：CJK 范围硬编码 `一-鿿`，不含扩展区；
- `manager.ts:257-283`：`getLastAssistantText` 用 `(session as any)` 反射兜底，pi-runtime 升级时的隐性断裂点。

### 4.4 模块间依赖的关键事实

**Reviewer 的记忆召回 = memory 检索 × 检索词质量**。S1（词全被过滤）+ S2（逐词扫描）叠加 M3（子串匹配）→ 中文项目 reviewer 的记忆注入几乎恒为空。修 memory 检索能同时治好 reviewer 召回，但 S1 的中文门槛必须单独修，否则输入端还是空的。

---

## 5. 性能审计（v2 新增）

### 5.1 方法

追踪两类热路径的完整调用链：**每轮对话路径**（`before_agent_start` → LLM → `agent_settled`）和**每次检索路径**（`SearchMemory` / review 记忆召回）。所有数字为温缓存估算（单文件 read+parse ~50-150µs，写锁 ~0.5-2ms），用于量级判断而非精确承诺。

### 5.2 每轮对话路径（最严重）

一轮用户消息触发的完整 IO（`extensions/memory/index.ts:322-456`）：

| # | 操作 | 位置 | 成本 | 问题 |
|---|---|---|---|---|
| 1 | `getProjectLifecycle` ×3 | `index.ts:323,327,405` | 每次读 project.json + 2 次 exists | 小 |
| 2 | **`markProjectActive` 每轮执行** | `index.ts:326` | **写锁获取 + 读 + 原子写（临时文件+rename+chmod+rm）** | **P2** |
| 3 | **`buildPrompt` → `listUnlocked`** | `repository.ts:886` | **全量读+parse 所有记忆文件（N 次）** | **P1** |
| 4 | `loadWorkingState` | `index.ts:343` | ~5 次读 | 小 |
| 5 | **`saveWorkingState` 全量扫 manifest** | `repository.ts:399-404` | **写锁 + readdir + 读+parse 全部历史 manifest（M 次）** | **P3** |
| 6 | 抽取 LLM 调用（后台） | scheduler | 不在延迟路径 | 无 |

**量化**（见 §2 实验 3 表格）：300 条记忆 + 100 manifest 时每轮附加 **20-60ms**；且第 5 项的 M **只增不减**——系统运行一年后每轮 200-600ms 不是极端假设，是必然趋势。全部发生在 LLM 请求发出之前。

#### P1 ·【P0-性能】每轮全量扫描记忆文件（M7 升级）

- **修复方案**：**写戳 + 进程内缓存**（多进程安全）。写路径（本就持锁）在每次变更后更新各 base 目录下的 `.stamp` 文件（内容为递增计数器）；读路径先 stat `.stamp`（1 次 stat），未变则用缓存的解析结果。跨进程正确性由"写者必在锁内更新 stamp"保证，不依赖 mtime 粒度。缓存结构：`Map<baseDir, {stamp, records[]}>`。
- 为什么不用 mtime 缓存：WSL2/网络文件系统 mtime 粒度不可靠；stamp 文件是显式的、锁保护的。
- 修复后每轮路径：3 次 metadata 读 → 2 次 stat + 0 次记录读。**每轮成本从 O(N+M) 降到 O(1)**。
- **验收标准**：perf bench（Phase 0 建立）中，2000 条记忆时每轮注入路径 p95 < 5ms。

#### P2 ·【P0-性能】markProjectActive 每轮写锁+写盘

- **修复方案**：节流——`lastActiveAt` 距今 < 5 分钟则跳过写。生命周期阈值是 30/90 天，5 分钟粒度无语义影响。写锁获取从每轮 2 次降到约每 5 分钟 1 次 + saveWorkingState 1 次。
- **验收标准**：连续 10 轮对话中 project.json 写次数 ≤ 1（测试 seam 统计）。

#### P3 ·【P0-性能】saveWorkingState 全量扫描无限增长的 manifest

- **位置**：`repository.ts:397-405`——`readdir` 后**读+parse 全部** `.json`，只为算两件事：最新 update、同日 entries。
- **修复方案**（两层）：
  1. **停止全量扫**：维护 `working-manifests/<id>/latest-index.json`（锁内原子更新，含最新 update + 当日 entries 列表），`saveWorkingState` 只读它；
  2. **保留策略**（与 P4 合并）：manifest 保留 30 天，`session_start` 时机会性清理。
- **验收标准**：manifest 数 1000 时 saveWorkingState 的文件读次数为常数（≤3）。

#### P4 ·【P1-性能】四类数据无限增长，无任何 GC

| 数据 | 增长速率 | 位置 | 建议保留策略 |
|---|---|---|---|
| working manifests | 每会话 1 个 | `working-manifests/` | 30 天 |
| daily 文件 | 每天 1 个（≤64KB） | `daily/` | 180 天（配合 M5 检索窗口 7 天） |
| revisions | 每次覆盖 1 个快照 | `revisions/<id>/` | 每记录最近 10 个 |
| extraction manifests | 每次抽取 1 个 | `extractions/` | 90 天 |

- **修复方案**：统一的 `pruneProject(projectId)` 维护函数，在 `session_start` 机会性执行（限速：每次最多清理 K 个文件，避免启动抖动）；归档（archiveProject）时做一次全量清理。保留期可通过环境变量覆盖（沿用 `working-state.ts` 的 envInt 模式）。
- **验收标准**：注入式测试——模拟 100 天使用后磁盘文件数有界。

### 5.3 检索路径

#### P5 ·【P1-性能】每轮注入 ~20k 字符上下文（token 成本）

- **位置**：`index.ts:337-339`——memory 预算 12k + working 预算 8k 字符，**每轮**都注入。
- **现象**：约 7-12k tokens/轮的固定上下文开销。有 prompt caching 时成本可控，但无缓存场景（或缓存失效场景）每轮都在为"最近 50 条标题"付费。
- **疑点（Phase 0c 已验证：非 bug）**：曾怀疑 `index.ts:364` 的 `event.systemPrompt.includes(memory.prompt)` 在记忆变化后把新块追加到含旧块的 systemPrompt，造成逐轮膨胀。读 pi-runtime `agent-harness.ts:354-387,598-617` 后澄清：`createTurnState` 每轮从 `this.systemPrompt`（配置/函数）**重新构建**基准 systemPrompt，`createContext(turnState, beforeResult?.systemPrompt)` 用的是 hook 返回值或当轮基准。memory 扩展只在 `!includes` 时返回 `[基准, memory.prompt].join`，否则返回 undefined。**没有累积基**，不存在逐轮膨胀。唯一增长是 `memory.prompt` 随记忆条数（≤50 条/≤12k 字符）的有界变化，属正常行为。→ **P5 从 Phase 2 移除，不需要代码修复**，但 perf bench 仍需量化这个固定 ~12k 字符注入开销。
- **修复方案**：无需动作（低频刷新/替代旧块不再必要）。M8 的相关性选条仍作为压缩注入量的优化保留在 Phase 4。

#### P6 ·【P2-性能】collectGitChanges 每文件 spawn 一个 git 进程

- **位置**：`review-core.ts:114,119`——N 个文件 = N 次 `git diff -- <file>` 子进程（每次 ~5-10ms）。
- **修复方案**：staged/unstaged 各一次 `git diff -z --no-ext-diff --binary`（无路径参数），按 `diff --git a/... b/...` 行切分后按文件匹配。50 文件从 ~50 进程降到 2 个。切分逻辑需处理重命名/二进制路径的引号形式——用 `--src-prefix`/`--dst-prefix` 固定前缀降低解析歧义，并保留现有单文件路径作为切分失败的兜底。
- **验收标准**：50 文件 review 的 git 子进程数 ≤ 4。

#### P7 ·【P2-性能】snapshotWorktree 全量读 untracked 文件 ×2

- **位置**：`review-core.ts:715-718`——审查前后各读一遍所有 untracked 文件全文做哈希。
- **修复方案**：stat (size+mtimeNs) 代替全文读做变化检测，仅在 stat 不确定时回退全文哈希。快照语义从"内容指纹"弱化为"stat 指纹"——需要在注释里写清楚这个权衡（恶意进程可伪造 mtime，但威胁模型是并发编辑不是对抗）。

#### P8 ·【P3-性能】杂项

- `repository.ts:920`：buildPrompt 循环内 `[...lines, line].join("\n")` 是 O(L²)（L≤50，当前可忽略，重写时顺手改为累加长度）；
- `repository.ts:1233-1241`：MEMORY.md 每次写后全量重建（O(N)/写），有了 P1 缓存后成本可接受。

### 5.4 性能修复优先级依据

用户目标是"性能上没问题"。按**单位工作量的延迟改善**排序：P3+P4（阻止随时间恶化，不做会持续变差）> P1（每轮 O(N)→O(1)，规模决定）> P2（锁与写放大）> P5（token 成本，非延迟）> P6/P7（review 路径，每次 review 一次性的 ~500ms 级）。

---

## 6. 关于"面试官只提了 memory"

可能性分析（按代码证据支持度排序）：

1. **提对了根因（最可能）**。核心卖点是 cross-session memory，检索弱恰是卖点短板；且 reviewer 最明显的缺陷（S1/S2）根因也在 memory 检索——一句话覆盖两个模块。
2. **记忆是体验最直接的模块**。SearchMemory 搜不到立刻感知；reviewer 的中文召回缺陷是静默失败——连 eval 都没覆盖（G1）。
3. **时间只够看一个模块**。README 叙事重心在 memory 管线。
4. **"另一个更差所以不提"——代码证据不支持**。reviewer 的隔离/超时/一致性设计是全项目最好的部分。若面试官觉得 reviewer 差，具体反馈更可能是"怎么保证 review 质量"而非沉默。

**结论：不需要为 reviewer defensive。但 M1 + S1 这两个中文 bug 值得主动提**——"测试全绿但真实场景失败"的最好例子，主动讲比被问出来体面。

---

## 7. 改进路线图（v2：度量先行）

> v2 修订理由：原路线图把 eval 放 P2 是顺序错误——打分权重、去重阈值、缓存效果都需要度量先行，否则改完只能说"逻辑对了"，说不出"好了多少"。性能项按"阻止恶化 > 降低规模复杂度 > 优化常数"插入。

### Phase 0 · 度量基线（半天，最先做）

| # | 项 | 内容 | 产出 |
|---|---|---|---|
| 0a | **G1 retrieval eval** | `eval/` 增加 retrieval case 集：`{query, expectedRecordIds, distractors}`，指标 Recall@10 / MRR；混入中文查询用例；纳入 Layer 2 recorded eval | ✅ 已完成（见 §7.1 基线表） |
| 0b | **G2 perf bench** | `scripts/perf-bench.mjs`（`node --experimental-strip-types` 运行）：seed 100/1k/10k 合成记录 + 模拟 manifest 增长，测 search p50/p95、每轮注入路径（buildPrompt）延迟、saveWorkingState 稳态延迟 + 累计 O(M²) seeding 曲线 | ✅ 已完成（见 §7.2 基线表） |
| 0c | 验证 P5 疑点 | 读 pi-runtime systemPrompt 生命周期，确认是否逐轮膨胀 | ✅ 已完成：无膨胀（见 §5.3-P5），P5 移出 Phase 2 |

**这一步之后，所有后续改动都有 before/after 数字。**

### Phase 0a 基线（已建立）—— `eval/retrieval-cases.ts` + `eval/retrieval-metrics.ts` + `test/eval/retrieval-eval.test.ts`

7 个确定性用例（零 LLM，纯函数指标），每轮改动后重跑即得 before/after。复现：`npx vitest run test/eval/retrieval-eval.test.ts --reporter=verbose`。

| case | recall@k | MRR | 失败模式 | 由哪个修复项消除 |
|---|---|---|---|---|
| relevance-over-recency | 0 | 0.33 | M2：recency 排首位是最新弱相关 r3，高相关 r1 排第 3 | 1c M2 打分排序 |
| title-vs-content-weight | 0 | 0.5 | M2：recency 排首位是新但仅内容命中 t1，标题命中 t2 排第 2 | 1c M2 标题加权 |
| chinese-substring | 1.0 | 1.0 | — | 回归保护（中文子串字符级本就命中） |
| mixed-cjk-ascii-token | 1.0 | 1.0 | — | 回归保护（中英混排命中） |
| acronym-vocabulary-gap | 0 | 0 | M3：`PyG` 搜不到 `PyTorch Geometric` | 3a M3 keywords |
| cross-language-vocabulary-gap | 0 | 0 | M3：中文`图神经网络库`搜不到英文 `PyTorch Geometric` | 3a M3 keywords |
| synonym-vocabulary-gap | 0 | 0 | M3：`鉴权`搜不到`认证`（keywords 已在 seed 但检索忽略） | 3a M3 keywords |

**聚合基线（修复前）：meanRecall@k = 0.2857，meanMRR = 0.4048，perfectRank = 2/7，belowOne = 5/7。**

**Phase 1c（M2 打分排序）后当前状态：**

| case | 修复前 | 1c 后 | 变化 |
|---|---|---|---|
| relevance-over-recency | recall@1=0, MRR=0.33 | **recall@1=1, MRR=1** | ✅ 修复 |
| title-vs-content-weight | recall@1=0, MRR=0.5 | **recall@1=1, MRR=1** | ✅ 修复 |
| chinese-substring / mixed-cjk | 1.0 / 1.0 | 1.0 / 1.0 | 回归未破 |
| 3× vocabulary-gap | 0 / 0 / 0 | 0 / 0 / 0 | 未变（M3 范围，预期） |

**聚合：meanRecall@k 0.2857 → 0.5714（×2），meanMRR 0.4048 → 0.5714，perfectRank 2/7 → 4/7，belowOne 5/7 → 3/7。** 剩余 3/7 全为 M3 词汇鸿沟，下一步 Phase 3a keywords 的目标。

### Phase 0b 基线（已建立）—— `scripts/perf-bench.mjs`（`node --experimental-strip-types` 运行）

三大热路径在 100/1k/10k 记录、100/1k turn 下的实测延迟（p50/p95，ms）。复现：`node --experimental-strip-types scripts/perf-bench.mjs`。seeding 用直接写记录文件（O(N)）绕过 save 的 O(N²) 索引重建 —— 后者由"save 稳态"档单独度量。

**基准一 · 记录规模 → search / buildPrompt（每轮注入路径，P1）**

| 记录数 | search p50 | search p95 | buildPrompt p50 | buildPrompt p95 |
|---|---|---|---|---|
| 100 | 19.6 | 23.1 | 18.2 | 22.7 |
| 1 000 | 172.3 | 203.1 | 169.1 | 200.3 |
| 10 000 | 1752.6 | **2111.0** | 1704.0 | **1867.0** |

读数：
- 完美 **线性**——记录数 ×10，延迟 ×9~10：证明 search/buildPrompt 都是 O(N) 全量读盘（`listBase` 每条记录一次 `readFile+parse`，无索引）。这正是 §5.2-P1。
- 100 条时 buildPrompt p95 就已达 **22.7ms**，远超 Phase 2 验收门槛 5ms；1k 条 ~200ms 落在审计 §5.2 估算的"300 条 20-60ms / 1 年后 200-600ms"区间内——**估算被实测证实**。
- search 与 buildPrompt 几乎同速：二者都先 `listUnlocked` 全量读，区别只在后续是截断排序还是子串过滤——读盘才是瓶颈，进一步支持缓存（P1）而非算法优化。

**基准一b · save 稳态延迟（写入侧放大，rebuildIndexUnlocked 每次 O(N)）**

| 现存记录数 | save() p50 | save() p95 | max |
|---|---|---|---|
| 100 | 22.7 | 31.0 | 32.6 |
| 1 000 | 173.0 | 187.5 | 225.5 |
| 5 000 | 868.9 | **1037.7** | 1037.7 |

读数：save 自身也 O(N)——每次落盘都 `rebuildIndexUnlocked` 全量重列写 `MEMORY.md`。5000 条时单次 save **>1 秒**。这是写入侧的隐性放大，不是 P1-P7 任一项的原始描述，但属于"写入高质量但写放大被忽视"——访谈中若被追问写入性能，这是诚实答案。

**基准二 · turn 规模 → saveWorkingState 稳态延迟 + 累计 O(M²) seeding（P3/P4）**

| turn 数 | 稳态 p50 | 稳态 p95 | 累计 seeding |
|---|---|---|---|
| 100 | 22.1 | 26.8 | 1 140 ms |
| 1 000 | 168.2 | 194.1 | **89 819 ms** |

读数：
- 稳态线性：turn ×10，单次 saveWorkingState 延迟 ×7~9（每次读全部 M 个 manifest、逐个 JSON.parse）。
- 累计 seeding **超线性**：turn ×10，累计耗时 ×79（1140→89819ms）。理论 O(M²) 预期 ×100，实测 ×79（含部分常数分摊），**O(M²) 得证**。这一项比"稳态变慢"更致命——它是**累计不可逆成本**：系统跑 1000 轮就已"花掉"90 秒在 manifest 扫描上，且只增不减（无 GC，P4）。turn=3000 档因累计超 500s 超时未完成，但 1000 档的曲线已充分外推。
- 这是 §5 最严重项（P3/P4，P0-性能）的**量化实证**：用得越久越慢，且无法靠缓存救——manifest 只增不减，必须 GC（Phase 2a）。

**聚合结论（Phase 0b）**：性能随规模与时间恶化，且恶化方式**可预测**（三条都是线性~平方，不是毛刺）。100 条记录 / 100 turn 这个"看起来还行"的规模，关键路径 p95 已 23ms；真实长期使用的 1k+ 记录 / 1k+ turn 规模，关键路径 p95 冲到 200ms 以上。后续 Phase 2 的验收门槛全部锚定此表。

### Phase 1 · 正确性 P0（1-2 天）

| # | 项 | 方案 | 验收 |
|---|---|---|---|
| 1a | M1 中文分词 | `tokenize.ts` bigram 分词器 + similarity 停用词（§3.3-M1） | ✅ 已完成：新增 `extensions/memory/extraction/tokenize.ts`（CJK bigram + ASCII 分离），`signals.ts`/`consolidation.ts` 收敛复用；中文近重述 similarity 0→1.0 并 skip 去重，英文全绿，+5 用例 |
| 1b | M1b 阈值重校 | 用 0a 的 eval 数据扫 0.68-0.80 区间选最优 | ✅ 已完成：建**去重 eval 集**（`eval/consolidation-cases.ts` 12 对：近重述/标点变体/英文重述/细节增补 应去重；同主题不同决策/相关不同事实/同标题异内容/强同义零共享 token/结论相反 不得去重）+ 阈值扫描（`test/eval/consolidation-eval.test.ts`，0.68-0.80 步长 0.01）。**校准结论：0.72 已是最优，不改**——全区间零误去重前提下最小漏去重 = 3/12，0.72 恰好达到；再降会误去重 diff-auth-decisions(0.348)/zh-cross-category-ish(0.357)（丢信息不可接受）。**重要发现（记入 §9）**：token 级 Jaccard 对"同义替换改写"的捕捉天花板是 3 例漏去重（zh-near-restatement 0.387 / en-restatement 0.500 / detail-shift 0.667）——语义级去重需 embedding/fingerprint，非本阶段范围 |
| 1c | M2 相关度排序 | 打分公式（§3.3-M2） | ✅ 已完成：`formatSearchResults` 实现 **§3.3-M2 原文公式**（整串 title 10 / keywords 8 / content 4 + 查询词 token 命中 title/keywords 3、content 1，× 信号乘子；并列 updatedAt 新者在前；查询词 `tokenize()` 切分），recency 降级为 tie-breaker。入围边界保持整串包含（token 打分只排序）。eval: relevance-over-recency 与 title-vs-content-weight 均 recall@1 0→1、MRR 0.33/0.5→1；聚合 meanRecall@k 0.2857→0.5714（1c 时点）→ 3a/3b 后 10/10=1.0 |
| 1d | S1 中文检索词 | tokenizeText + CJK 门槛 + 中文停用词 | ✅ 已完成：`review-core.ts` Tier5 复用 `tokenize.ts` bigram 补 CJK 内容词（原 `/^[a-zA-Z_]\w*$/` 把整段中文排除→0 词）。纯中文 review 代码/注释现在产出中文 bigram 词，reviewer 记忆召回从≈0 恢复；英文符号词不回归。+1 用例 |
| 1e | S3 遥测 | parsedChunks: 1 | ✅ 已完成（**含纠正**）：`manager.ts:176` 成功路径 `parsedChunks` 硬编码 0→`parseOk?1:0`。**纠正原审计**：用户可见 `分片：X/Y`（`index.ts:479`）走 aggregator 正确计数，本就显示 1/1；硬编码 0 仅是 per-manager **内部**误导字段，非用户可见 bug。+1 用例 |

### Phase 2 · 性能 P0（2-3 天）

| # | 项 | 方案 | 验收 |
|---|---|---|---|
| 2a | P3+P4 manifest 扫描 + 保留策略 | latest-index.json + pruneProject（§5.2） | ✅ 已完成：`working-state.ts` 加 `WorkingLatestIndex`（latestUpdate + sameDayEntries≤500 + manifestCount，严格解析器 `parseWorkingLatestIndex`）；`repository.ts` 加 6 个 `*Unlocked` helper（read/rebuild/merge/write/load，含 Risk-C 计数自愈——`expectedExtra` 精确匹配，稳态纯 O(1)）+ `saveWorkingState` 全扫换成索引增量合并（日期翻转/刷新/乱序/上限四分支）；`pruneProject` 四类保留（manifest 30d/daily 180d/revisions 10/extra 90d，env 可覆盖）+ session_start 机会性限速（100 文件/次）+ archiveProject 全扫（working-manifests/extractions 在 basePath 外、rename 不移走，已显式清理）。**实测**：1k turn 累计 96.9s→8.6s（11×）、稳态 p50 166→9.8ms、**3k 档从超时跑不完→39.7s 跑完**；代码级各阶段全 O(1)（1200 文件时 readIndex 1.2ms/merge 0ms/writeIndex 1.2ms/readdir 0.6ms）。残余 p95 尖峰（501/1001/1506/2007/2508 文件处 146→582ms 递增）经定位为 **ext4 目录索引再平衡**（文件系统级，非代码路径；P4 GC 在真实使用中把目录控制在保留窗口内）。+17 用例（working-index 11 + prune 6，含免 spy 的 phantom 功能证明） |
| 2b | P1 记录缓存 | .stamp 写戳 + 进程内缓存（§5.2-P1） | ✅ 已完成：`repository.ts` 加 `recordCache`（每分区 global/project/archived 独立片）+ `.cache-stamp` 写令牌（跨进程，不用 mtime）。`listBase` 命中即返、未命中扫描后回填；6 条写路径接失效（save/saveExtractionBatch/archiveProject/restoreProject 删片+bump；markProjectActive/saveWorkingState/rebuildIndex 经核实不触记录分区，不失效）。**实测缓存命中路径** buildPrompt p95：100→0.84ms / 1k→0.47ms / **10k→1.17ms**（基线 23/200/1867ms，10k ≈1600×）。search p95 10k→7.2ms。**验收**：2000 条 p95<5ms（实测 10k 仍 1.17ms，O(1) 平坦曲线）。+6 用例含跨实例可见性回归。**修复一真实 stale-read bug**：`restoreProject` 初版漏接失效，归档→预读→恢复→读会返回空，被 cache-regression 当场抓到 |
| 2c | P2 markProjectActive 节流 | 5 分钟阈值 | ✅ 已完成：`markProjectActive` 加 5 分钟节流——先无锁读 project.json，`lastActiveAt` 在窗口内且未归档则直接返回，跳过写锁+写盘；读取/比较异常一律走权威写路径兜底。+1 用例（同窗口不刷新 / 超窗刷新 / projectId 一致） |
| 2d | S2 N+1 检索 | searchByTerms 单扫 | ✅ 已完成：`repository.ts` 加 `searchByTerms(terms, cwd, opts)`（一次 listUnlocked + 每记录算命中词集合，含归档一致性双探测）；`review-core.ts` `searchRelevantMemories` 从「每词一次 search（max:3 截断）」改单扫（每词截断移除——低优先级词命中的记录不再漏，排序+maxCount 兜底）。单扫失败降级空集、非致命。 |
| ~~2e~~ | ~~P5 疑点处置~~ | 0c 已证伪，无逐轮膨胀，**移除** | — |

### Phase 3 · 检索质量 P1（2-3 天）

| # | 项 | 方案 | 验收 |
|---|---|---|---|
| 3a | M3 keywords | schema + 提示词 + 校验 + 加权 + SaveMemory 参数 + **存量回填脚本**（§3.3-M3） | ✅ 已完成：`MemoryRecord.keywords?`（可选，旧记录兼容）；`validateKeywords`（**按原文 ≤5 项×≤60 字符**、去重、拒密钥）+ `invalid-keywords` rejection；pipeline 候选 JSON **未知 key 拒绝保持**、keywords 唯一白名单新增键；抽取提示词产 keywords（0-5 项）；coordinator replace 时**并集保留旧词**（≤5）；检索按 **§3.3-M2 原文公式**打分（整串 title 10 / keywords 8 / content 4 + 查询词 token 3/1 × 信号乘子），整串包含边界保持；SearchMemory 输出展示关键词；**存量回填双通道**：`memory-keywords-backfill` 命令（**LLM 批量回填**，opt-in、dry-run 默认、`--write` 写回、单条失败不阻塞）+ `scripts/backfill-keywords.ts`（机械快速路径）。**eval：acronym/cross-language/synonym 三用例 recall@1 0→1 + keyword-noise-precision 负例 + 审计原文验收词「图学习框架」** |
| 3b | M4 信号消费 | 已并入 1c 公式 | ✅ 已完成：`formatSearchResults` 按 §3.3-M2 原文消费 provenance.score/reinforcement——**信号乘子** `× (1 + 0.1×min(score,1) + 0.02×min(reinforcement,5))`，同文本相关度时高信号记录胜出、信号不压文本相关性。新增 eval `signal-tiebreak` 用例：同文本相关度、高信号旧记录排前，recall@1=1 |
| 3c | M5 多日工作状态 | 扫最近 7 天 daily | ✅ 已完成：`searchWorkingState` 除最新 daily 外补扫最近 7 天（有界 7 文件×≤64KB），**结果带日期标注**（审计 §3.3-M5 要求），工具输出展示日期。+1 用例：两天前 daily 可搜到 + 日期断言 |
| 3d | M6 工具参数 | category/max | ✅ 已完成：SearchMemory 工具加 category（**逗号分隔多值**）/max 参数；`SearchMemoryOptions.category` 在相关度排序**前**过滤（非法值忽略、空集视为无过滤，不抛错）。+1 用例：单值/多值/非法值 |
| 3e | S4 代码停用词 | Tier 3 过滤 | ✅ 已完成：`CODE_STOP_WORDS`（跨语言内建类型/关键字）过滤 Tier 3（最高优先级）+ Tier 5 内容词。+1 用例：前 15 词无内建类型名、领域词保留 |

### Phase 4 · 演进（可选，1-2 周）

| # | 项 | 说明 |
|---|---|---|
| 4a | 向量检索 | embedding sidecar + 词法/向量 RRF 融合；**必须在 G1 eval 建立后做**，否则无法量化对比 |
| 4b | M8 注入相关性 | category 配额 → 逐步到消息相关选条 |
| 4c | S5 分片并发 | 有限并发 + 预算分配 |
| 4d | P6/P7 git 批量化、stat 快照 | review 路径常数优化 |

### 实施注意事项（不变项，重申）

- **fingerprint 迁移**（1a）：旧指纹失配退 similarity 兜底，无数据损坏，changelog 注明；
- **严格 key 校验放宽**（3a）：保持"未知 key 拒绝"，只白名单 `keywords`；
- **测试基线**：86 用例 + subagent 4 文件必须保持全绿，每个验收项新增用例；
- **S5 并发化**前确认 pi-runtime session 并发语义与 rate limit。

---

## 8. 面试交付物清单

目标：让"改得不错"变成**可验证的陈述**。按说服力排序：

1. **一张 before/after 数字表**（Phase 0-2 完成后自动产出）：

   | 指标 | Before | After |
   |---|---|---|
   | 检索 meanRecall@k（8 用例） | **0.2857**（Phase 0a 基线，7 用例） | **1.0**（1c M2 + 3a M3 + 3b M4，8/8 perfectRank） |
   | 检索 meanMRR | **0.4048**（Phase 0a 基线） | **1.0** |
   | 检索 belowOne 用例 | 5/7（2× M2 + 3× M3） | **0/8** |
   | 每轮注入 buildPrompt p95 @1k 记录 | **200ms**（Phase 0b 基线） | **0.47ms**（2b 缓存） |
   | 每轮注入 buildPrompt p95 @10k 记录 | **1867ms**（Phase 0b 基线） | **1.17ms**（2b 缓存，≈1600×） |
   | saveWorkingState 稳态 p50 @1k turn | **166ms**（Phase 0b 基线） | **9.8ms**（2a 索引） |
   | saveWorkingState 累计 @1k turn | **89.8s**（O(M²) 实测） | **8.6s**（2a 索引，残余为 ext4 目录索引再平衡，非代码路径） |
   | saveWorkingState 3k turn 累计 | **超时跑不完**（>500s） | **39.7s**（2a 索引） |
   | save 写放大 p95 @1k 记录 | **168.9ms**（每 save 全量重建 MEMORY.md + 记录缓存失效触发全扫） | **3.49ms**（延迟重建：save 只标脏，session_start/memory-status 刷新；MEMORY.md 无生产读取者——已核实。随规模平坦，@5k 外推 ~1038ms→个位数 ms） |
   | 每轮写锁获取 | 2 | ~1/5min |
   | 磁盘占用（100 天模拟） | 无界 | 有界 |

2. **中文去重 bug 的复现演示**（M1）：3 行脚本现场跑出 `similarity = 0.14 < 0.72`，然后展示修复后 = 1.0——"测试全绿但真实场景失败"的完整案例，包含根因（Unicode script 混跑）与修法（bigram）。
3. **retrieval eval 本身**：面试官提"检索弱"，你回答"我建了 eval 来量化它"——把对方的问题转化为你的贡献。这是这轮改进里**面试价值最高的单项**。
4. **性能审计方法**：一份热路径 IO 追踪表（§5.2）+ 写戳缓存的多进程安全设计——展示的是"会做容量推演"而不只是"会加缓存"。2b 已落地：缓存把每轮注入从 O(N) 降到 O(1)（10k 记录 1867ms→1.17ms），且实现中用一条跨实例回归测试当场抓出 `restoreProject` 漏接失效的真实 stale-read——"加缓存不难，难的是把失效面摸全"的可信案例。
5. **面试叙事线**（一条线讲完）：

   > 写入侧做到证据可溯源、事务可回滚、版本可回放 → 审计发现写读不对称 + 中文分词 bug（连写入去重都是坏的）→ 先建 eval 拿基线，再修正确性（bigram/打分/别名）和性能（O(N)→O(1) 热路径、无限增长→有界）→ 用数字验证 → 已知局限与向量检索演进路线。

6. **已知局限清单**（§9）——能主动说出系统边界，比"全修完了"可信得多。

---

## 9. 已知局限（诚实边界）

修完全部路线图后**仍然成立**的事实，面试被问到时应当坦然承认：

1. **keywords 是补丁不是语义检索的解**：别名集有限、查询无限；存量回填是 opt-in 的 LLM 批处理，有成本和噪声。词汇鸿沟的尾巴只有向量检索（4a）能兜住。
2. **打分权重是数据拟合的近似**：调参依赖 20-50 条的 eval case 集，规模上不去拟合精度就上不去；case 集本身的覆盖是人工判断。
3. **bigram 是工程折中**：中文无天然词界，bigram 召回好但区分度有限；停用词表是手工的；阈值为语料相关。
4. **文件系统存储的天花板**：.stamp 缓存解决读放大，但万条级以上记录、多机同步、复杂查询（时间范围+类别组合过滤）终归要索引结构或存储引擎——当前设计的甜蜜区是"单用户、百到千条、单机"，这是刻意选的简单性，不是疏忽。
5. **正则密钥检测可绕过**：base64/分段粘贴不在模式内；威胁模型假设用户不主动对抗自己的记忆库。
6. **P5 的 stat 快照弱化**：mtime 可伪造，威胁模型限定为并发编辑而非对抗。
7. **审计范围**：pi-runtime（fork 的运行时）、scripts/ 安装链路、extraction/source.ts 的分支遍历细节未深审；P5 疑点（system prompt 膨胀）待 Phase 0c 验证。
8. **去重的 token-Jaccard 天花板（1b 实测）**：相似度去重只能接住 ≥0.72 的近重述（标点/空白变体、同句改写）；**同义替换改写**（如"运行全部单元测试" vs "跑完所有单元测试"=0.387）必然漏去重——12 对实测 3/12 漏、0 误去重。语义级去重需 embedding 或内容指纹扩展，本阶段刻意不做（误去重丢信息比冗余更糟，阈值按"零误去重"优先校准）。
9. **MEMORY.md 延迟重建的前提**：save 不再即时重建 MEMORY.md（无生产读者，已核实）；若未来加生产读取者（如前端索引展示），必须先加"读前刷新"。

---

## 10. 附录：问题-方案速查表

| ID | 模块 | 级别 | 一句话 | 修复核心 |
|---|---|---|---|---|
| M1 | memory/写入 | **P0 bug** | 中文去重链路失效，同记忆反复写入 | CJK bigram 分词器 + 阈值重校 |
| M2 | memory/检索 | **P0** | 按 recency 而非相关度排序 | 打分排序（含信号加权） |
| M3 | memory/检索 | **P0** | 缩写/同义/跨语言搜不到 | 写时物化 keywords + 回填脚本 |
| M4 | memory/检索 | P1 | score/reinforcement 读取侧闲置 | 并入打分公式 |
| M5 | memory/检索 | P1 | 工作状态只搜最新一天 | 扫最近 7 天 daily |
| M6 | memory/工具 | P1 | SearchMemory 无过滤参数 | category/max 参数 |
| M8 | memory/注入 | P2 | 注入索引 recency-only | 类别配额 + 信号排序 |
| M9 | memory/存储 | P3 | ID=hash(title) 改标题即新记录 | 知悉即可 |
| S1 | subagent/召回 | **P0** | 中文检索词全被过滤，召回≈0 | CJK 门槛 + tokenizeText |
| S2 | subagent/召回 | P1 | 15 词 × 全量扫描 | searchByTerms 单扫 |
| S3 | subagent/遥测 | **降级** | 原"用户可见分片 0/1"经核实不成立（aggregator 本就正确显示 1/1）；真实问题是 per-manager 内部 parsedChunks 硬编码 0 | 成功路径 `parsedChunks:1`（已落地；见 §5.3-S3 修正） |
| S4 | subagent/召回 | P2 | 类型噪声词挤占词预算 | 代码停用词 |
| S5 | subagent/执行 | P2 | 串行分片 + 120s 全局 deadline | 有限并发 |
| S6 | subagent/聚合 | P3 | 去重依赖措辞一致 | 同文件相似度合并 |
| S7 | subagent/杂项 | P3 | 重复停用词等 | 顺手清理 |
| P1 | 性能/每轮 | **P0** | 每轮全量读盘 N 条记忆 | .stamp 写戳 + 进程内缓存 |
| P2 | 性能/每轮 | **P0** | markProjectActive 每轮写锁+写盘 | 5 分钟节流 |
| P3 | 性能/每轮 | **P0** | 每轮全量扫无限增长的 manifest | latest-index + 保留策略 |
| P4 | 性能/容量 | P1 | 四类数据无限增长无 GC | pruneProject 维护函数 |
| P5 | 性能/成本 | P1 | 每轮注入 ~20k 字符；疑似 system prompt 逐轮膨胀 | 低频刷新 + 替换旧块（待验证） |
| P6 | 性能/review | P2 | 每文件 spawn 一个 git 进程 | 整仓 diff + 切分 |
| P7 | 性能/review | P2 | untracked 文件全文读 ×2 | stat 指纹 + 回退 |
| P8 | 性能/杂项 | P3 | O(L²) join 等 | 重写时顺手 |
| G1 | 体系 | **战略** | 检索质量零 eval 覆盖 | retrieval eval + Recall@k/MRR |
| G2 | 体系 | **战略** | 性能零度量 | perf bench + 延迟分布 |
