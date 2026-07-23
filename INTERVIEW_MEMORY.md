# Triple-pi 面试答辩 — Memory 模块

> 本文档覆盖 Memory 模块的每一个设计决策、思考过程、踩坑记录。
> **目标：让面试官看到你会发现问题、分析问题、做 trade-off、用数据验证。**
>
> 读法：面试前通读，用自己的话讲出来。不要背。

---

## 前置知识（如果面试官问基础概念）

### 什么是 Agent 的"记忆"？

Agent 本身没有状态。每次调 LLM 就是把一堆消息发过去，LLM 回复。关了终端，所有对话历史没了。

"记忆系统"要解决的问题：**下次新开会话时，Agent 能知道上次聊了什么、用户偏好什么、项目有什么规则。** 同时不能把所有历史消息全塞进去——LLM 有 token 上限，塞满了就得丢东西。

### 记忆 vs 上下文，有什么区别？

- **上下文** = 这一次 LLM 调用传的 messages（有 token 上限，调用结束就消失）
- **记忆** = 跨会话保留的信息（存在磁盘上，下次会话还能读到）

Context Engine（Pi 的 assemble()）的工作就是把记忆加载进上下文。

### 为什么需要项目隔离？

一个开发者同时做多个项目。做 React 项目时加载 Pi 内部细节（agentLoop 导出路径、AgentTool 接口类型）全是噪音——浪费 token，干扰判断。

---

## 一、项目概述（30 秒电梯演讲）

**面试官：介绍一下这个项目。**

Triple-pi 是基于 Pi Agent Runtime 的个人 Coding Agent。Pi 提供了 Agent Loop 和多模型抽象。我在上面构建了跨会话持久化记忆层——让 Agent 在不同会话之间记住用户的知识水平、偏好、项目规则和技术决策。

**核心思路：不改 Pi 一行源码。** 通过 Pi 的 Extension 机制注册工具，通过文件系统做存储。借鉴 OpenClaw 的 Dreaming 异步提取模式，但针对个人开发者做了简化——省掉了多租户隔离、Postgres、三阶段全 LLM 管道。

---

## 二、架构：我做了什么，Pi 做了什么

### Q1：为什么选 Pi，不从零写 Agent？

Agent Loop 是基础设施——LLM 流式响应解析、工具串行/并行调度、token 截断保护、多 Provider API 适配、上下文压缩。Pi 在这些问题上打磨了两年，代码质量高。我的判断：**Agent Loop 不应该重写，应该在已有基础设施上做差异化。** 记忆系统、渠道接入、SubAgent 调度才是我的增量价值。

**追问："这不就是调包吗？"**

调试是调用别人的 API 拿到结果。我做的是在 Agent 的工作流里插入新能力——改变了 Agent "看到什么"（system prompt 注入记忆索引）、"能做什么"（SaveMemory/SearchMemory 工具）、"记住什么"（5 阶段异步提取管道）。类比：用 React 写应用不是调包。

### Q2：你和 Pi 的边界在哪？

| 层 | 提供方 | 我改了吗 |
|----|--------|---------|
| Agent Loop（双层 while 循环） | Pi | ❌ |
| LLM 多 Provider 抽象 | Pi | ❌ |
| 工具注册和执行系统 | Pi | ❌ |
| Session 管理 + Compaction | Pi | ❌ |
| 持久化记忆层 | **我** | ✅ Pi Extension |
| 5 阶段异步提取管道 | **我** | ✅ 独立脚本 |
| 项目隔离存储 | **我** | ✅ 独立脚本 |

**边界原则：Pi 负责"这一轮对话内怎么做"，我负责"跨会话记住什么"。**

### Q3：怎么集成的？

**现在的方案（Pi Extension）：** Pi 启动时自动扫描 `~/.pi/agent/extensions/`，发现我们的 Extension 文件，加载 SaveMemory 和 SearchMemory 工具。`npm run setup` 自动创建 symlink。

**最初尝试过 SDK 方案（后来废弃了）：** 用的是 `createAgentSession({ appendSystemPromptOverride })`。但发现 Pi 的 TUI 不是这样启动的——SDK 是给外部程序嵌入 Pi 用的，不是给 Pi 加能力的。正确方式是 Extension。

**这个错误让我学到了 Pi 的两种集成模式，以及理解框架设计意图比找到 API 更重要。**

---

## 三、Memory 设计 —— 每个决定都有为什么

### Q4：为什么用文件存，不用数据库？

三个原因，按重要性排：

1. **人类可读可编辑。** `vim ~/.triple-pi/memory/prefs/xxx.md` 直接看。知道 Agent 记住了什么，能纠正错误记忆。数据库不行。
2. **Git 可追踪。** 记忆变更可以版本控制。调试 Agent 行为时能回溯。
3. **零依赖。** 不需要 PostgreSQL、Redis、pgvector。文件系统就够了。

**追问：什么时候升级到数据库？**

两个信号：1) 记忆 > 500 条，grep 搜索变慢；2) 需要语义搜索（不是关键词匹配）。升级路径：SQLite + FTS，再不够就 pgvector。

### Q5：为什么索引+分文件，不是一个文件？

Token 预算。索引（< 200 tokens）始终在 system prompt → Agent 知道自己记住过什么。具体文件（每条记忆一个 .md）→ 需要时才用 Read 工具加载。全部塞进一个大文件（500KB+）每轮多烧 token，且 95% 无关。

**类比：索引是目录，记忆文件是章节。你不会每次把整本书摊桌上。**

### Q6：记忆是怎么写入的？

**两条路径，各有分工：**

```
路径 1（实时）：SaveMemory 工具
  用户明确说"记住这个" → Agent 调用 → 立即写入

路径 2（异步）：5 阶段提取管道
  每天凌晨 3 点 → 扫描昨日 transcript
    → Phase 1 (Light Sleep): LLM 提取候选 + 证据引用
    → Phase 2 (Scoring): 6 维加权评分
    → Phase 2.5 (Deep Sleep): LLM 审核质量
    → Phase 3 (Merge): Jaccard 去重
    → 保存到磁盘
  用户不需要主动说"记住"，系统自己发现
```

**为什么是两条？** 异步提取是主力（不打扰用户），但用户想立即记住的东西（"别忘了把思考写进文档"）不应该等到凌晨 3 点。SaveMemory 是补充，且加了严格限制防止误调用。

### Q7：5 种记忆类型怎么来的？

最初设计了 4 种（v0.1）：preference / decision / rule / fact。

**跑起来发现一个 bug：** 用户说"我已经读过 agent-loop.ts 源码"——这条信息不属于任何类型。但这是最重要的信息——Agent 不知道用户知识水平的话，要么重复解释，要么跳过基础。

**加了第 5 种 knowledge（v0.6）：**
- knowledge → "用户已读过 agent-loop.ts 源码"（用户知识水平）
- preference → "喜欢简洁回复"（工作偏好）
- decision → "选 JWT 因为多服务无状态"（决策 + 原因）
- rule → "禁止 git push"（约束）
- fact → "项目三个月后迁移 Go"（不在代码里的上下文）

**knowledge 的评分特殊处理：** 只说一次就够了，给满分 frequency score（0.24），不因低频被过滤。

### Q8：评分公式为什么是 6 维？

**和 OpenClaw 一样的权重：**

```
Score = relevance(0.30) + frequency(0.24) + query_diversity(0.15)
      + recency(0.15) + consolidation(0.10) + conceptual_richness(0.06)
```

| 维度 | 权重 | 测什么 | 为什么这个权重 |
|------|------|--------|-------------|
| relevance | 0.30 | 和工作相关吗？ | 最重要——闲聊不该记 |
| frequency | 0.24 | 提了多少次？ | 提到一次可能是随口 |
| diversity | 0.15 | 用户和 Agent 都提了？ | 双向确认比单向可靠 |
| recency | 0.15 | 最近说的？ | 越近越相关 |
| consolidation | 0.10 | 和已有记忆关联？ | 有联系的加强 |
| richness | 0.06 | 有细节还是空泛？ | 质量加分项 |

**阈值为什么是 0.35？** 我测试过三个值：
- 0.5 → 22 候选只过 1 个（太严，重要信息被误杀）
- 0.35 → 22 候选过 6-7 个（合理）
- 0.2 → 太多噪音

OpenClaw 可以用更高阈值因为它面对 17000+ 记忆的候选池。我面对的是 15 条消息的短对话——重要的事只提一次，低阈值是适配规模的选择。

### Q9：评分公式已经过滤了，为什么还要 Deep Sleep？

**评分公式是机械的——数关键词、算频率、看位置。但判断不了"这条信息对用户有用吗"。**

比如 "Pi 工具接口是 AgentTool" 和 "用户读过 agent-loop.ts" 在评分上可能差不多，但前者 Agent 读源码就知道，后者只有用户说了才知道。**这个区别只有 LLM 能判断。**

所以我加了 Phase 2.5（Deep Sleep）——二次 LLM 调用，专门审核质量：去噪音、合并相似、过滤可发现信息。

代价：每天多一次 LLM 调用（约 0.01 元）。对个人开发者可忽略。

### Q10：项目隔离怎么做？

**问题来源：** 有人问"agent-loop.ts 的细节在做 React 项目时有什么用？"——答案是没用，还浪费 token。

**设计：**
```
~/.triple-pi/memory/
├── global/                              ← 跨项目（沟通风格）
└── github-com-npm-DreaMaX-Triple-pi/    ← 只在 cd 到这个项目时加载
```

**项目识别：** 优先 `git remote get-url origin`，fallback 工作目录绝对路径。

**休眠：** 30 天不活跃 → 删除项目记忆。为什么 30 天？个人项目周期短。为什么直接删不先问？简单规则换零维护成本。

---

## 四、Trade-off：每个选择都有代价，我知道代价

| 选择 | 为什么 | 代价 |
|------|------|------|
| 异步提取 + 实时保存双路径 | 异步主力，实时补充 | 多维护一条路径 |
| 文件不用数据库 | 人类可编辑、Git 跟踪、零运维 | grep 搜索，非语义 |
| 评分 + Deep Sleep 分工 | 确定性快免费，LLM 准花钱 | 多 1 次 LLM 调用 |
| 项目隔离 | 做 React 不加载 Pi 记忆 | 跨项目偏好要显式 global |
| 30 天删除 | 个人项目周期短 | 间歇项目可能误删 |
| Extension 不改 Pi | Pi 升级不受影响 | 只能用预留钩子 |

### 省了哪些成本（vs 照搬 OpenClaw）

| 没做的 | 为什么 | 省了什么 |
|--------|------|---------|
| Postgres + pgvector | 个人 < 500 条记忆 | 零基础设施 |
| 三阶段全 LLM Dreaming | 确定性算法在 50 条下够用 | 每天少 1-2 次 LLM 调用 |
| 多租户隔离 | 单用户工具 | Session Router 等全不用 |
| Compiled Truth + Timeline | 不需审计 | 存储复杂度大降 |

### 如果面试官说"你这和 OpenClaw 比差了很多"

> "OpenClaw 是多用户 SaaS，我是个人工具。它需要 Postgres、多级隔离、三阶段 LLM——这些对我的场景全是过度设计。我选择性地借鉴了核心设计（索引+分文件、评分公式、Deep Sleep），舍弃了不适合的部分。知道什么该借鉴、什么该舍弃，比全盘照搬更能体现工程判断力。"

---

## 五、开发迭代 —— 15 个版本的真实记录

**整个系统不是一次设计出来的。7 个核心问题中 5 个来自实际使用发现。**

| 版本 | 问题 | 怎么发现的 | 解决 |
|------|------|-----------|------|
| v0.1 | SaveMemory 被 LLM 过度调用 | 实际对话测试 | 加异步提取 |
| v0.4 | 阈值 0.5 太严（22→1） | 跑 extractor | 降到 0.35 |
| v0.5 | LLM 抄 prompt 示例 | 看到凭空出现的"迁移 Go" | 删掉所有示例 |
| v0.5 | 存 extension 安装记录 | **用户质疑** | 加 Permanence Test |
| v0.6 | knowledge 类型缺失 | **用户发现** | 新增 knowledge |
| v0.7 | fact 存了代码可发现信息 | **用户质疑** | 加可发现性过滤 |
| v0.8 | 项目记忆污染 | **用户问** | 项目隔离 |
| v0.9 | fallback ID 不安全 | 调研 OpenClaw | workspace 路径 |
| v0.10-12 | 退休机制迭代 | **用户追问** | activity-based |
| v0.13 | 评分算不出质量 | **用户指出** | 加 Deep Sleep |
| v0.14 | 无 session 也跑 | 逻辑审视 | 有 session 才跑 |
| v0.15 | cron 需手动 | **用户指出** | npm run setup 自动化 |

**面试官能从这张表看到：** 你会通过使用发现问题、会听反馈、会做减法、会调研。

---

## 六、具体困难（面试重点）

### 困难 1：SDK vs Extension —— 选错集成方式

最初用 Pi SDK 方式集成，写了完整的 `main.ts` + `package.json` + `tsconfig.json`。编译通过了但 Pi TUI 不加载。发现 SDK 是给外部程序嵌入 Pi 的，不是给 Pi 加能力的。研究 Pi Extension 示例后重写。

**教训：不是所有"看起来能用的 API"都适合你的场景。理解框架设计意图比找到 API 更重要。**

### 困难 2：LLM evidence 和 transcript 对不上

Phase 2 评分合格但 evidence 验证全挂——LLM 返回的 evidence 是意译不是原文（中文 transcript → 英文 evidence）。改为关键词语义匹配（token 提取 + 阈值匹配），放下了精确匹配的要求。

**教训：LLM 是意译工具不是复制粘贴。证据验证要容忍措辞变化。**

### 困难 3：LLM 把 prompt 示例当成内容抄

看到记忆里有"项目三个月后要迁移到 Go"——这段对话根本没发生。排查发现 extraction prompt 里的示例被 LLM 当模板复制。删掉所有具体示例，只留抽象描述，加 CRITICAL 警告。

**教训：LLM 的 instruction following 不是你想象的那样——示例越具体，越倾向于复制。**

### 困难 4：CJK 文件名编码

中文标题不能直接当文件名。方案：ASCII 保留，CJK 转 hex。`"不使用 any 类型"` → `any-e4b88de4bdbfe794a8-e7b1bbe59e8b.md`。用户不直接看文件名，通过索引和搜索找。

---

## 七、设计的缺点（主动承认）

1. **没有语义搜索。** grep 搜"认证"找不到"JWT"。规模 < 500 条时浏览目录就够了。**有意延迟的优化。**

2. **Deep Sleep 多一次 LLM 调用。** 每天约 0.01 元。零成本场景可去掉退回纯评分。

3. **30 天休眠误删风险。** 间歇维护项目可能被清。**简单规则换零维护的 trade-off。**

4. **依赖 transcript 质量。** 全是调试/闲聊就提取不出有用记忆。系统不会编造，但也不会创造不存在的价值。

5. **单机绑定。** 换电脑记忆丢失。同步方案：git 同步 memory 目录。

---

## 八、数字

| 指标 | 数字 |
|------|------|
| Extension 代码 | ~200 行 TS |
| Extractor 代码 | ~550 行 JS |
| Pi 修改 | 0 行 |
| 管道阶段 | 5（Light Sleep → Scoring → Deep Sleep → Merge → REM） |
| 评分维度 | 6 维（同 OpenClaw 权重） |
| 记忆类型 | 5 种（knowledge/preference/decision/rule/fact） |
| 项目隔离 | global + per-project |
| 休眠 | 30 天删除 |
| LLM 调用/天 | 最多 2 次，约 0.02 元 |

---

## 九、追问速查表

| 问题 | 回答 |
|------|------|
| 为什么不用向量数据库？ | < 500 条记忆，grep 够用 |
| 为什么不做语义去重？ | 确定性逻辑能解决的不用 LLM |
| 和 LangChain Memory 区别？ | LangChain 解决上下文窗口，我解决知识管理 |
| 和 Pi transcript 区别？ | Transcript 是日记（恢复），MEMORY.md 是便签（意识） |
| 最大缺点？ | 没有语义搜索。有意延迟的优化，不是不知道怎么做 |
| 怎么验证效果？ | 下一步 Eval 框架量化通过率 |
| "这不是包了一层？" | 是在 Agent 工作流里插入了新能力：记忆注入 + 异步提取 |
| "和 OpenClaw 比" | 多用户 SaaS vs 个人工具。借鉴核心设计，舍弃不适合的部分 |

---

## 十、后续

1. **Eval 框架** — 15 case 量化 Memory 效果
2. **Slack Channel** — Agent 走出终端
3. **SubAgent + Worktree** — 多文件并行重构
