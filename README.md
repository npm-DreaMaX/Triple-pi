<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="88">
  </a>
</p>

<h1 align="center">Triple-pi</h1>

<p align="center">
  <b>A Pi-based coding agent that remembers.</b><br/>
  <sub>跨会话持久记忆 + 提交前规则审查 · Built on <a href="https://github.com/earendil-works/pi">Pi</a>（GitHub 近 <b>8 万 star</b>）</sub>
</p>

<p align="center">
  <a href="https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/npm-DreaMaX/Triple-pi/ci.yml?branch=main&style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-≥22.19-brightgreen?style=flat-square" /></a>
  <a href="https://www.bilibili.com/video/BV1wA3w6uEuH/"><img alt="Bilibili" src="https://img.shields.io/badge/📺_Bilibili-讲解视频-00A1D6?style=flat-square&logo=bilibili&logoColor=white" /></a>
</p>

<p align="center">
  <img alt="Recall@k" src="https://img.shields.io/badge/Recall%40k-1.00-brightgreen?style=for-the-badge" />
  <img alt="MRR" src="https://img.shields.io/badge/MRR-1.00-brightgreen?style=for-the-badge" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-254%20green-brightgreen?style=for-the-badge" />
  <img alt="Injection latency" src="https://img.shields.io/badge/buildPrompt%4010k-1.2ms-9cf?style=for-the-badge" />
</p>

---

<table align="center">
<tr>
<td width="50%" align="center">
  <h3>🧠 Memory</h3>
  <sub>从对话中抽取规则 / 偏好 / 决策，自动注入未来的会话</sub>
  <br/><br/>
  <b>6 阶段抽取管线</b> · 证据强制引用原文<br/>
  <b>相关度排序检索</b> · keywords 别名闭环（缩写 / 同义 / 跨语言）<br/>
  <b>生命周期管理</b> · 31-90 天降温 → 归档可恢复<br/>
  <b>30 / 180 / 10 / 90 天 GC</b> · 磁盘占用有界
</td>
<td width="50%" align="center">
  <h3>🔍 Reviewer</h3>
  <sub>提交前对照项目记忆审查改动，只读、按需运行</sub>
  <br/><br/>
  <b>隔离会话</b> · 仅 4 个只读工具，无写工具存在<br/>
  <b>前后快照</b> · git status + 哈希证明零改动<br/>
  <b>严格 schema</b> · 解析失败绝不谎报"通过"<br/>
  <b>分片审查</b> · 跳过的文件显式列出，无静默遗漏
</td>
</tr>
</table>

---

## 📊 At a glance

| | Before | Now |
|---|---|---|
| 🎯 Retrieval quality（确定性 eval） | meanRecall@k **0.29** · MRR **0.40** | **1.00 / 1.00**（10/10 满分排序） |
| ⚡ Prompt injection @10k records | **1 867 ms**（O(N) 全量读盘） | **1.2 ms**（O(1) 写令牌缓存） |
| ⚡ `saveWorkingState` @3k turns | **超时跑不完**（O(M²) manifest 全扫） | **28.4 s**（索引化，线性） |
| ⚡ `save()` @1k records | **169 ms**（O(N) 索引重建） | **3.5 ms**（延迟重建） |
| 🗂 Working manifests / daily / revisions | 无限增长 | **有界**（30 / 180 / 10 天 + GC） |

> [!NOTE]
> 性能数字来自零 LLM 的 perf bench（真实落盘 + p50/p95 + 累积曲线）；检索与去重数字来自确定性 eval（10 查询 + 12 去重对 + 阈值扫描）。跑法见 [Verify](#-verify)。

---

## ⚙️ How it works

### 🧠 Memory

记忆有两条路径——自动与显式，落到同一个存储。

| Path | Trigger | What happens |
|---|---|---|
| **Automatic extraction** | 对话结束（`agent_settled`） | 后台 6 阶段管线：密钥脱敏 → LLM 抽取 → 逐字段校验 → 二次审查 → 合并去重 → 原子写入 |
| **Manual save** | 你或 agent 调 `SaveMemory` | 展示全文并确认后立即写入 |

```
对话结束
  → 密钥脱敏
  → LLM 抽取（含检索关键词 keywords）
  → 严格校验（evidence 必须是你的原话子串）
  → 落地审查（只准 keep/remove，不准改写）
  → 合并（merge / replace / skip——近重述去重）
  → 原子写入
```

> [!IMPORTANT]
> **检索按相关度排序，不按时间排序。** 每条记录按打分公式加权：整串标题命中 > 关键词命中 > 内容命中，写入时的信号（score / reinforcement）作乘子，查询词按 CJK bigram + ASCII 分词。每条记录可带 **keywords** 别名——`search("PyG")` 命中「PyTorch Geometric」，`search("鉴权")` 命中「JWT 认证」，中文近重述正确去重。

每条抽取记录携带 `provenance.evidence`——你的原话引用。LLM 编造对话中不存在的 evidence，候选直接被拒。

作用域确定性解析：LLM 标 `global` 而无跨项目证据（"所有项目"、"跨项目"）时自动降级为 `project`。

记忆并非永久：31-90 天不活跃的项目注入前会询问；90 天后重命名进 `archive/`（不删除，`/memory-restore` 恢复）。四类衍生数据按保留策略自动 GC。

### 🔍 Reviewer

独立的隔离 agent 会话：读 diff → 检索项目记忆中的相关规则 → 逐条对照。

```
review_current_changes
  → 收集 staged + unstaged + untracked（git）
  → 从 diff 抽取检索词（中英文分词，滤内建类型名）
  → 单扫相关度检索项目记忆
  → 按文件 / hunk 分片
  → 拉起隔离 reviewer 会话
  → 严格 schema 校验
  → 校验工作区未被改动
```

> [!CAUTION]
> Reviewer **无法改文件**：会话以 `noExtensions` + `noSkills` + `noContextFiles` 创建，只挂 `read / grep / find / ls` 四个工具——写工具在会话里根本不存在。审查前后的 git status + 文件哈希快照证明零改动。

`passed` 要求零 findings；`issues_found` 要求至少一条；JSON 解析失败绝不谎报"无问题"。大 diff 分片处理，跳过的文件显式列出——没有任何静默省略。

---

## ⚡ Performance design

每轮 turn、LLM 调用前的热路径全部 O(1)：

| Hot path | Was | Now | How |
|---|---|---|---|
| 每轮注入 `buildPrompt` | 全量读盘 N 条记录 | **O(1)** | 进程内记录缓存 + `.cache-stamp` 写令牌（跨进程失效，不依赖 mtime） |
| `SearchMemory` | O(N) 扫描 | **O(1)** | 同上 |
| `saveWorkingState` | O(M) 全扫（累积 O(M²)） | **O(1) 增量** | `latest-index.json` + 计数自愈兜底 |
| `save()` | O(N) 重建 MEMORY.md | **O(1)** | 脏标记 + 延迟重建（session 边界刷新） |
| `markProjectActive` | 每轮写锁 + 写盘 | **每 5 分钟 1 次** | 节流 |

写路径全部持全局写锁、temp→rename 原子写、批量事务带回滚。跨进程正确性由写令牌保证——WSL2/NFS 的 mtime 不可靠，不用时间判过期。

---

## 📊 Compared to common approaches

<details open>
<summary><b>🧠 Memory</b></summary>

| Common approach | Triple-pi |
|---|---|
| LLM output saved directly | 6-stage pipeline; any stage can reject |
| No evidence required | Verbatim user message substring mandatory |
| LLM picks project/global | Automatic global → project downgrade without cross-project evidence |
| Overwrite on save | Immutable revision snapshots |
| No lifecycle | 30d hot → 31-90d cold (asks) → >90d archive (renamed) |
| Substring search, recency-ranked | Relevance scoring（标题 / 关键词 / 内容加权 + 信号），keywords 别名闭环 |
| No CJK handling | bigram 分词——中文近重述去重、中文检索、中文 review 召回 |
| Silent on failure | Fail-closed; stage-classified errors |

</details>

<details open>
<summary><b>🔍 Reviewer</b></summary>

| Common approach | Triple-pi |
|---|---|
| Prompt requests read-only | Session configured with noExtensions, noSkills, noContextFiles |
| Trust the model | Tool allowlist enforced by registry |
| No proof files unchanged | Git status + hash snapshot before/after |
| Raw output, hope it's JSON | Strict schema; parse failure ≠ passed |
| Full diff in one prompt | Chunked; skipped files recorded |
| No memory integration | Single-scan relevance-ranked recall against project memory |

</details>

---

## ⚡ Install

> [!TIP]
> 需要 Node.js `>=22.19.0`。

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

`npm run setup` 构建 runtime、装依赖、全局链接 `trip` 命令。

**Linux / macOS**

```bash
trip
```

找不到 `trip` 时：

```bash
source ~/.zshrc     # 或: source ~/.bashrc
```

**Windows**

```powershell
.\bin\trip.ps1
```

或把仓库的 `bin\` 目录加入 PATH。

---

## ✅ Verify

```bash
npm run typecheck
npm test               # 254 tests, 0 LLM
npm run eval:recorded
npm run demo
```

---

## 🧪 Evaluation

| Layer | Scale | Runs on | Validates |
|---|---|---|---|
| 🧩 Deterministic | 254 tests (31 files) | 每次 push，零 LLM | 代码逻辑 |
| 🎯 Retrieval | 10 cases | 每次 push，零 LLM | Recall@k / MRR / Precision（当前 **1.00**） |
| 🔁 Dedup | 12 pairs + 阈值扫描 | 每次 push，零 LLM | 相似度去重阈值校准 |
| 📼 Recorded | 46 tests | 每次 push，mock LLM | 管线接线 |
| 🔴 Live | Opt-in | 显式模型配置 | 模型质量 |

Exit codes：`2` = 基础设施失败，`1` = 语义不匹配，`0` = 通过。

---

## 📁 Structure

```
extensions/
├── index.ts                    # 单一入口
├── memory/
│   ├── index.ts                # 扩展生命周期、工具、命令
│   ├── repository.ts           # 锁、原子 IO、检索、缓存、GC
│   ├── working-state.ts        # 工作状态 + manifest 索引
│   ├── extraction/             # 6 阶段管线（含 tokenize / signals）
│   └── validation.ts           # 共享写校验
└── subagent/
    ├── index.ts                # Reviewer 工具注册
    ├── manager.ts              # 会话生命周期、超时、清理
    └── review-core.ts          # diff 收集、检索、分片、解析

eval/                           # 检索 + 去重用例集
scripts/                        # perf-bench、keywords 回填、状态/重置
test/                           # 254 tests
```

---

## ⚠️ Limitations

> [!WARNING]
> - **keywords 是补丁不是语义检索的解**：别名集有限、查询无限；词汇鸿沟的尾巴需要向量检索（未来演进项）。
> - **去重天花板**：相似度去重只接 ≥0.72 的近重述；同义替换改写（「运行全部单元测试」vs「跑完所有单元测试」）会漏去重——刻意选择「宁可冗余、不可误删」。
> - Secret redaction covers 10 common patterns, not custom formats.
> - Single-user. No shared memory.
> - `temp → rename` = atomic visibility, not `fsync` durability.
> - 单机文件存储的甜蜜区是「百到千条记录」；万条以上、多机同步、复杂查询需要索引结构或存储引擎。

---

## Docs

[Memory design](./docs/design/memory.md)
· [Reviewer design](./docs/design/reviewer.md)
· [Audit & fix report（检索/性能修复全记录）](./docs/technical/14-audit-memory-retrieval-and-reviewer.md)
· [Evaluation](./docs/evaluation.md)
· [Demo](./docs/demo.md)
· [Interview prep](./docs/interview.md)
· [History](./docs/history/MEMORY_REBUILD.md)

---

<p align="center">
  <sub>MIT © <a href="https://github.com/npm-DreaMaX">npm-DreaMaX</a> · Built on <a href="https://github.com/earendil-works/pi">Pi</a></sub>
</p>
