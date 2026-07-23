# Triple-pi 面试答辩 — Memory 模块

> 本文档覆盖 Memory 模块的每一个设计决策、思考过程、踩坑记录。
> **目标：让面试官看到你会发现问题、分析问题、做 trade-off、用数据验证。**
>
> 读法：面试前通读，用自己的话讲出来。不要背。

---

## 技术栈

| 层 | 用的是什么 | 为什么选它 |
|----|-----------|----------|
| Agent Runtime | Pi（TypeScript monorepo） | 已有成熟的 Agent Loop + 多 Provider 抽象，不需要重写 |
| 集成方式 | Pi Extension API（`defineTool` + `ExtensionAPI`） | Pi 的原生扩展机制，不改 Pi 源码 |
| 运行时 | Node.js 22+ | Pi 本身用 Node.js，保持一致 |
| 存储 | 文件系统（Markdown + JSON） | 人类可编辑、Git 跟踪、零依赖 |
| 提取 LLM | DeepSeek chat / Anthropic Claude（通过 HTTP fetch） | DeepSeek 便宜（~0.001元/1K tokens），个人开发者可接受 |
| 评分算法 | JavaScript（确定性计算，无外部依赖） | 6 维加权，不调 LLM |
| 去重算法 | Jaccard 3-gram 相似度 | O(n²) 在 < 500 条记忆下可忽略 |
| 调度 | Linux crontab | 零依赖，npm run setup 自动安装 |
| 脚本 | Node.js .mjs（ES Module） | 不需要编译，node 直接跑 |

---

## 前置知识（如果面试官问基础概念）

### 什么是 Agent 的"记忆"？

Agent 本身没有状态。每次调 LLM 就是把一堆消息发过去，LLM 回复。关了终端，所有对话历史没了。

"记忆系统"要解决的问题：**下次新开会话时，Agent 能知道上次聊了什么、用户偏好什么、项目有什么规则。** 同时不能把所有历史消息全塞进去——LLM 有 token 上限（比如 200K），塞满了就得丢东西。

### 记忆 vs 上下文，有什么区别？

- **上下文** = 这一次 LLM 调用传的 messages（有 token 上限，调用结束就消失）
- **记忆** = 跨会话保留的信息（存在磁盘上，下次会话还能读到）

Context Engine（Pi 的 `assemble()`）的工作就是把合适的记忆加载进当前上下文。

### 为什么需要项目隔离？

一个开发者同时做多个项目。在做 React 项目时如果加载了 Pi 内部细节（agentLoop 导出路径、AgentTool 接口类型），这些信息全是噪音——浪费 token，干扰判断。

---

## 一、项目概述（30 秒电梯演讲）

**面试官：介绍一下这个项目。**

Triple-pi 是基于 Pi Agent Runtime 的个人 Coding Agent。Pi 提供了 Agent Loop 和多模型抽象。我在上面构建了跨会话持久化记忆层——让 Agent 在不同会话之间记住用户的知识水平、偏好、项目规则和技术决策。

**核心思路：不改 Pi 一行源码。** 通过 Pi 的 Extension 机制注册工具，通过文件系统做存储。借鉴 OpenClaw 的 Dreaming 异步提取模式，但针对个人开发者做了简化——省掉了多租户隔离、Postgres、全 LLM 管道，只保留了核心的评分公式和 Deep Sleep 审核。

---

## 二、架构：我做了什么，Pi 做了什么

### Q1：为什么选 Pi，不从零写 Agent？

Agent Loop 是基础设施——LLM 流式响应解析、工具串行/并行调度、token 截断保护、多 Provider API 适配、上下文压缩。Pi 在这些问题上打磨了两年，代码质量高。我的判断：**Agent Loop 不应该重写，应该在已有基础设施上做差异化。** 记忆系统、渠道接入、SubAgent 调度才是我的增量价值。

**追问："这不就是调包吗？"**

调包是调用别人的 API 拿到结果。我做的是在 Agent 的工作流里插入新能力——改变了 Agent "看到什么"（system prompt 注入记忆索引）、"能做什么"（SaveMemory/SearchMemory 工具）、"记住什么"（5 阶段异步提取管道）。类比：用 React 写应用不是调包，"调包"是把 React 源码改了。

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
| 三层时间粒度（scratchpad/daily/long-term） | **我** | ✅ system prompt 指引 |

**边界原则：Pi 负责"这一轮对话内怎么做"，我负责"跨会话记住什么"。**

### Q3：怎么集成的？

**现在的方案（Pi Extension）：** Pi 启动时自动扫描 `~/.pi/agent/extensions/` 目录，发现我们的 Extension 文件，加载 SaveMemory 和 SearchMemory 工具。`npm run setup` 自动创建 symlink。

```bash
~/.pi/agent/extensions/memory → ~/Triple-pi/extensions/memory
```

Extension 文件里用 Pi 的 `defineTool` 定义工具，`ExtensionAPI` 注册。Pi 的 TUI 原生支持——工具出现在工具列表里，LLM 可以调用，执行结果正常渲染。

**最初尝试过 SDK 方案（v0.1-v0.3，后来废弃了）：** 用的是 `createAgentSession({ appendSystemPromptOverride })`，写了 `main.ts`、`package.json`、`tsconfig.json`，编译通过了。但发现 Pi 的 TUI 根本不会加载——SDK 是给外部程序嵌入 Pi 用的（比如你自己的 Node 服务里嵌入一个 Agent），不是给 Pi 本身加能力的。正确方式是 Extension——让 Pi 加载你的代码作为插件，而不是你用 SDK 启动一个新的 Agent 实例。

**这个错误让我学到了 Pi 的两种集成模式，以及理解框架设计意图比找到 API 更重要。**

---

## 三、Memory 设计 —— 每个决定都有为什么

### Q4：为什么用文件存，不用数据库？

三个原因，按重要性排：

1. **人类可读可编辑。** 用户可以 `vim ~/.triple-pi/memory/prefs/xxx.md` 直接看 Agent 记住了什么，错了可以直接改。这是信任问题——用户必须能审查和纠正 Agent 的记忆。数据库里的数据用户看不到也改不了。

2. **Git 可追踪。** memory 目录加入版本控制后，每次记忆变更都有 diff："为什么 Agent 突然不用 any 了？→ git log 看到 7 月 15 号加了一条 preference"。调试 Agent 行为时能回溯。

3. **零依赖。** 不需要安装 PostgreSQL、Redis、pgvector。文件系统是操作系统自带的，性能对几百个文件完全够用。

**追问：什么时候升级到数据库？**

两个信号：1) 记忆量超过 ~500 条，grep 扫描所有文件的时间从 < 5ms 变成 > 50ms；2) 需要语义搜索（"找和认证相关的记忆"），关键词匹配找不到标题是 "JWT 选择" 的文件。升级路径：先上 SQLite FTS（全文搜索，仍然零运维），还不够就 pgvector 做向量检索。

### Q5：为什么索引+分文件，不是一个文件？

Token 预算。索引（MEMORY.md，< 200 tokens）始终在 system prompt → Agent 知道自己记住过什么。具体文件（每条记忆一个 .md）→ 需要时才用 Read 工具加载。

如果把所有记忆塞进一个大文件（50 条 × 每条 300 字 = 15000 tokens），每轮对话多烧 15000 token，其中 95% 和当前任务无关——这是噪声。而且 Agent 在大量文本里找到相关信息的能力会随文本长度下降。

**类比：索引是书的目录，记忆文件是章节。你不会每次翻书都把所有章节铺在桌上——你看目录，找到需要的章节，只翻那几页。**

### Q6：记忆是怎么写入的？

**两条路径，各有分工：**

```
路径 1（实时）：SaveMemory 工具
  用户明确说"记住这个" → Agent 调用 → 立即写入磁盘
  限制：tool description 里有严格的反例，防止 LLM 自作主张调用

路径 2（异步）：5 阶段提取管道
  每天凌晨 3 点（cron）→ 检查是否有今天的 session
    → 有 → Phase 1 (Light Sleep): LLM 扫描 transcript，提取候选 + 证据引用
          → Phase 2 (Scoring): 6 维加权评分，过滤低分候选
          → Phase 2.5 (Deep Sleep): LLM 二次审核，去噪音、合并相似、过滤可发现信息
          → Phase 3 (Merge): Jaccard 3-gram 确定性去重
          → Phase 4 (REM): 跨主题关联（当前跳过，> 500 条后启用）
          → 保存到磁盘，更新索引
    → 没有 → 静默跳过，不浪费 LLM 调用
```

**为什么是两条路径，不纯异步？** 异步提取是主力（不打扰用户，不需要用户主动说"记住"）。但偶尔用户想立即记住的东西（比如"别忘了把咱们的思考过程写进文档"）不应该等到凌晨 3 点——万一用户第二天早上开会，记忆还没提取。SaveMemory 是补充路径，且加了严格的反例限制防止 LLM 过度调用。

### Q7：5 种记忆类型怎么来的？

最初设计了 4 种（v0.1）：preference / decision / rule / fact。

**跑起来发现一个 bug：** 用户说"我已经读过 agent-loop.ts 源码"——这条信息不属于任何类型。但这是最重要的信息——Agent 不知道用户知识水平的话，要么把基础概念重新解释一遍浪费用户时间，要么跳过基础假设用户已经懂了但用户其实没懂。

**加了第 5 种 knowledge（v0.6）：**
- **knowledge** → "用户已读过 agent-loop.ts 源码"（用户知识水平。最重要——决定 Agent 对话起点）
- **preference** → "喜欢简洁回复"（工作偏好，改变 Agent 行为风格）
- **decision** → "选 JWT 因为多服务无状态"（技术决策 + 原因，帮助理解架构）
- **rule** → "禁止 git push"（行为约束，Agent 必须遵守）
- **fact** → "项目三个月后迁移 Go"（不在代码里的上下文。注意：能从代码读到的信息不算 fact——"项目用 TypeScript"这种 tsconfig.json 里有的就不存）

**frequency 跨会话累积：** 同一个项目里多次提到的东西自然高频。我们用 `.scores.json` 记录每个记忆标题在历次提取中的出现次数。frequency 得分 = 本次对话出现次数 + 历史累积 × 0.15。随着项目推进，真正重要的主题自然浮现——不需要特殊照顾任何类型。

### Q8：评分公式为什么是 6 维？

**和 OpenClaw 一样的权重，但计算方式针对短对话做了调整：**

```
Score = relevance(0.30) + frequency(0.24) + query_diversity(0.15)
      + recency(0.15) + consolidation(0.10) + conceptual_richness(0.06)
```

**每个维度到底在算什么（具体代码逻辑）：**

**relevance (0.30)：** 维护了一个 tech 关键词列表（TypeScript、API、auth、token、database 等），检查候选记忆内容里匹配了几个。匹配 3 个以上 = 满分 0.30。为什么 0.30 最高？因为偏离工作的闲聊不应该进入记忆。这是最重要的过滤器。

**frequency (0.24)：** 本次对话里标题关键词出现的次数 / 3（归一化）+ 从 `.scores.json` 读的历史累积次数 × 0.15。cap 在 1.0。为什么是 0.24？提了多次的事比随口一提的可靠，但不是决定性的——一个事提了很多次但和项目完全无关也不该记（relevance 已经挡掉了）。

**query_diversity (0.15)：** 检查候选的 evidence 关键词是否同时出现在 user 消息和 assistant 消息里。两边都出现 = 0.15（双向确认），只在一方出现 = 0.075。为什么？用户说了 Agent 也回应了的，比单方面提的更可靠。

**recency (0.15)：** 候选的 evidence 出现在 transcript 的什么位置。越靠后的消息，得分越高。为什么 0.15？最近提到的事比两小时前提到的事更可能和当前任务相关，但不是决定性的。

**consolidation (0.10)：** 候选的标题关键词和已有记忆的标题/内容有多少重叠。和已有记忆关联越多，得分越高。为什么 0.10？因为记忆少的时候这个维度接近 0，但随着记忆积累会自然增长——它是一个可生长的维度。

**conceptual_richness (0.06)：** 内容长度（200 字以上满分）+ 是否包含原因/上下文（"因为"、"所以"、"选择"）。为什么只有 0.06？有细节比没细节好，但权重不能太高——一条简短的纠正 ("不要用 any") 可能比长篇大论更重要。

**阈值为什么是 0.35？** 我跑过三轮对照实验——同一个 15 条消息的 transcript，分别用 0.5、0.35、0.2。0.5 时 22 候选只过 1 个，最重要的 "用户读过 agent-loop.ts" 被误杀。0.35 时过 6-7 个，knowledge + preference + 核心 fact 都保留，噪音被 relevance 和 evidence 过滤。0.2 时过 15 个，extension 安装记录等大量噪音通过。**0.35 是甜点。**

OpenClaw 可以用更高阈值因为它面对的是几百条消息的 transcript（同一个主题自然出现十几次），我的 transcript 只有 15 条（重要的事只说 1-2 次）。阈值必须适配输入规模。

### Q9：评分公式已经过滤了，为什么还要 Deep Sleep？

**评分公式是机械的——数关键词、算频率、看位置。但它判断不了"这条信息对用户有用吗"。**

具体例子："Pi 工具接口是 AgentTool" 和 "用户读过 agent-loop.ts"，在评分上：
- relevance: 都是 0.20（都包含 tech 关键词）
- frequency: 都是 0.16（都出现 2 次）
- recency: 差不多
- 总分可能都接近 0.50

但前者 Agent 读 `packages/agent/src/types.ts` 就能知道，后者只有用户说了才知道。**这个区别评分公式算不出来——只有 LLM 能判断。**

所以我加了 Phase 2.5（Deep Sleep）——把评分通过的候选再发给 LLM 审一次。prompt 是："这些是从对话中提取的候选记忆。哪些真的有用？哪些 Agent 读源码就能知道？哪些是噪音？哪些应该合并？"

**对照实验验证：** 同一批 7 个候选，跑 vs 不跑 Deep Sleep。不跑的话，"Pi 工具接口是 AgentTool"、"Pi 测试框架用 harness.ts"、"agentLoop 导入路径" 全被保存。跑了 Deep Sleep 后，这 3 条被正确识别为"读源码就能知道"并删除。7 条 → 4 条，保留的是真正的知识（"用户读过 agent-loop.ts"）和偏好（"用户重视 token 成本"）。

**代价有多大？** DeepSeek 的 Deep Sleep 每次调用约 2000 tokens 输入 + 200 tokens 输出 ≈ 0.002 元。加上 Light Sleep（~4000 tokens + 500 output ≈ 0.005 元），一天总共 2 次 LLM 调用约 0.007 元。我写 0.02 元是向上取整留了余量。一个月 30 天天天有对话 = 约 0.6 元。对个人开发者可以忽略。

### 三个适配是怎么验证出来的（实验过程）

**问题：权重和 OpenClaw 一样，但我们的场景不同（短对话、单用户、记忆少）。哪些参数要调？怎么调？**

#### 适配 1：阈值 0.35（3 轮对照实验）

拿同一个 15 条消息的 transcript，只改阈值，其他参数不变。

| 阈值 | 候选 | 通过 | 结果分析 |
|------|------|------|---------|
| 0.5 | 22 | 1 | 唯一通过的是"Pi 测试框架用 harness.ts"。漏了"用户读过 agent-loop.ts"（最重要）和"用户偏好 token 最小化" |
| 0.35 | 22 | 7 | knowledge 2条 + preference 1条 + fact 4条。重要信息全保留，extension 安装记录因 relevance 低被过滤 |
| 0.2 | 22 | 15 | 大量噪音通过——"装了 pi-fff"、"不装 pi-session-manager" 等 extension 安装记录涌入 |

OpenClaw 用更高阈值是因为它的候选池来自 17000+ 条记忆的筛选，信号强度天然高。我的候选池来自 15 条消息的短对话，信号弱但真实——需要低阈值让它们过线。

#### 适配 2：frequency 跨会话累积

最初给了 knowledge 类型特殊待遇——"只说一次也给满分 0.24"。后来有人问"凭什么 knowledge 就能满分？preference 也可能只说一次但很重要啊。"

**根因不是类型问题，是 frequency 的数据源问题。** 评分公式的 frequency 维度设计意图就是跨时间累积——但我的单次 transcript 只有 15 条消息，同一主题最多出现 1-2 次。OpenClaw 的 transcript 几百条，同一主题出现十几次。

**修复：** 用 `.scores.json` 跟踪每个记忆标题在历次提取中被提取的次数。frequency 不再只看单次对话，而是 `sessionMentions + historicalHits × 0.15`。随项目推进，"用户读过 agent-loop.ts" 在第 1、3、5 次被提取时 frequency 得分 0.08 → 0.15 → 0.20，自然增长。

#### 适配 3：Deep Sleep LLM 兜底

同一批 7 个评分通过的候选，A/B 对照。

| 候选 | 不跑 Deep Sleep | 跑 Deep Sleep | Deep Sleep 的判断理由 |
|------|----------------|--------------|---------------------|
| "用户读过 agent-loop.ts" | ✅ | ✅ | 知识状态，LLM 判断"有用" |
| "用户重视 token 成本" | ✅ | ✅ | 偏好，LLM 判断"改变 Agent 行为" |
| "Pi 测试框架用 harness.ts" | ✅ | ❌ | LLM："代码里能读到，不需要记忆" |
| "Pi 工具接口是 AgentTool" | ✅ | ❌ | LLM："源码里有，不需要记忆" |
| "agentLoop 导入路径" | ✅ | ❌ | LLM："读源码就知道" |

不跑 Deep Sleep = 7 条全保存（3 条噪音）。跑 Deep Sleep = 4 条保存（0 噪音）。质量差异明显。

---

### Q10：项目隔离怎么做？

**问题来源：** 有人问"agent-loop.ts 的细节在做 React 项目时有什么用？"——答案是没用，还浪费 token。

**设计：**
```
~/.triple-pi/memory/
├── global/                              ← 跨项目（沟通风格、通用偏好）
└── github-com-npm-DreaMaX-Triple-pi/    ← 只在 cd 到这个项目时加载
```

**项目识别：** 优先用 `git remote get-url origin`（最稳定，跨机器不变），没有 git 就用工作目录的绝对路径（至少保证同一台机器上唯一）。不用随机哈希——OpenClaw 的原则是 workspace 路径 = 身份标识。

**休眠：** 30 天不活跃 → 删除项目记忆。为什么 30 天不是 90 天？个人开发者的项目周期短——大作业集中做 2-3 天，一个月不碰就是放弃了。为什么直接删不先问？简单规则换零维护成本。如果让 Agent "先问你还要不要这些记忆"，用户每次打开一个老项目都要先回答这个问题——比记忆丢了还烦。

### Q11：记忆的时间粒度 —— 为什么需要 Daily Log + Scratchpad

**调研 pi-mem 时发现：** 他们除了长期记忆（MEMORY.md），还有 daily log（每天摘要）和 scratchpad（当前在做的事）。这和 OpenClaw 的 daily memory + MEMORY.md 双层结构一样。

**我们缺了什么：**

```
OpenClaw / pi-mem:              我们加之前:
  MEMORY.md (长期记忆)      →   ✅
  daily/YYYY-MM-DD.md       →   ❌ 没有 —— 加了 DAILY.md
  SCRATCHPAD.md             →   ❌ 没有 —— 加了 SCRATCHPAD.md
```

**为什么需要三层时间粒度：**

| 层 | 时间跨度 | 内容 | 谁维护 | 例子 |
|----|---------|------|--------|------|
| Scratchpad | 几小时 | 当前在做的事、进行到哪了 | Agent 自己用 Write 工具 | "正在改 auth 模块，改到 token.ts 第 42 行" |
| Daily Log | 1 天 | 今天的会话摘要 | Agent 自己用 Write 工具 | "7/23：讨论了评分阈值，加了 Deep Sleep" |
| Long-term | 永久 | 跨会话保留的知识 | extractor + 评分 | "用户偏好 TypeScript strict 模式" |

**为什么 Agent 能自己维护前两层：** 不需要 extractor，不需要 cron。Agent 本来就有 Write 工具——在 system prompt 告诉它这两个文件的路径和用途，它就能自己读写。加这几行提示的成本为零。

**面试时怎么说：** "调研 pi-mem 时发现他们有三层时间粒度。我只做了长期记忆，漏了前两层。加这两层不需要写代码——Agent 有 Write 工具，在 system prompt 里告诉它文件路径和用途就行。这让我意识到记忆管理的核心不是技术复杂度，是给 Agent 正确的上下文指引。"

### Q12：纠正信号权重 —— 不是所有对话同等重要

**调研 pi-hermes-memory 时发现：** 他们做了 Failure Memory 和 Correction Detection——用户纠正 Agent 时触发保存，优先级比普通对话高。

**我们的问题：** extraction prompt 对所有对话一视同仁。用户随口说的 "今天写了 login 模块" 和纠正 Agent 的 "不对，应该用 JWT 不是 session"——在 LLM 的提取视角下权重一样。但纠正信号显然更重要——它意味着 Agent 之前的做法是错的，需要纠正行为。

**解决：在 extraction prompt 里加信号权重，不改代码：**

```
特别关注的信号（按重要性排序）：
1. 纠正信号："不对"、"应该是"、"改成"、"不要用 X，用 Y"
   → 这意味着 Agent 之前的行为是错的，必须记住正确的做法
2. 失败信号："这个方案不行"、"试过了有问题"
   → 记录什么失败了 + 为什么，防止重复踩坑
3. 强偏好信号："我讨厌 X"、"以后都 Y"、"再也别 Z"
   → 高置信度偏好，比普通陈述更具权重
4. 明确记忆请求："记住这个"、"别忘了"、"下次记得"
   → 用户主动标记，最高权重
```

**为什么是改 prompt 不是实时触发：** pi-hermes-memory 是每 10 轮触发一次实时保存。我们是凌晨 3 点异步提取。但纠正信号的权重提升和触发时间无关——LLM 扫描 transcript 时看到 "不对，应该用 JWT"，给它标记更高的 confidence 就行。信号权重的价值在于"这条比别的更重要"，不在于"什么时候保存"。

### Q13：和已有的 Pi Memory 扩展相比，你的差异在哪

调研了 6 个已有的 Pi Memory 扩展：pi-hermes-memory、pi-mem、pi-memory-md、pi-memory、pi-memory-blocks、pi-memd。它们大部分做了存储和检索，但没做自动提取和质量审核。

| 能力 | 已有的 6 个扩展 | Triple-pi（我们） |
|------|---------------|-----------------|
| 存储 | ✅ 全部都有 | ✅ markdown + JSON |
| 检索 | ✅ 大部分有（FTS/向量/grep） | ✅ grep 全文搜索 |
| 项目隔离 | ⚠️ 只有部分有 | ✅ global + per-project |
| 自动提取 | ❌ 只有 1 个做了规则触发 | ✅ 评分驱动 + 证据验证 |
| 质量审核 | ❌ 没有一个做 | ✅ Deep Sleep LLM 二次审核 |
| 纠正信号 | ⚠️ pi-hermes-memory 有 | ✅ extraction prompt 信号加权 |
| 时间粒度 | ⚠️ pi-mem 有 daily log | ✅ 三层（scratchpad / daily log / long-term） |
| cron 自动 | ❌ 没有一个做 | ✅ npm run setup 自动安装 |
| 失败记忆 | ⚠️ pi-hermes-memory 有 | ✅ extraction prompt 信号加权 |

**我们的差异化：** 大部分扩展关注"怎么存、怎么搜"——这是文件管理问题。我们关注"存什么、怎么判断该不该存、存的质量如何"——这是知识管理问题。区别在于有没有提取管道和质量审核。

---

## 四、Trade-off：每个选择都有代价，我知道代价是什么

### Trade-off 1：异步提取 + 实时保存双路径

**我选了什么：** 两条路径并存。异步提取是主力（不打扰用户），SaveMemory 工具是补充（立即写入）。

**替代方案：** 纯异步（OpenClaw 做法）。用户想记住的东西也要等 cron 到点才提取。

**为什么不选纯异步：** 用户说了"别忘了把咱的思考写进文档"——如果晚上才提取，用户第二天早上开会时记忆还没进 system prompt。延迟最多 17 小时（下午 5 点到凌晨 3 点），对紧急的偏好来说不可接受。

**代价：** 多维护一条代码路径（SaveMemory 的 tool description、参数校验、防误调用限制）。如果 SaveMemory 被 LLM 误调用（v0.1 遇到过），还要回头修 prompt。但这比丢掉用户明确要求记住的信息好。

### Trade-off 2：文件存储 vs 数据库

**我选了什么：** 文件系统。每条记忆一个 .md 文件，MEMORY.md 做索引，.scores.json 做频率跟踪。

**替代方案：** SQLite（pi-hermes-memory 用了）。有 FTS5 全文搜索，性能更好。

**为什么不选 SQLite：** 文件系统有三个 SQLite 没有的优势：1) 人类可编辑——`vim ~/.triple-pi/memory/xxx.md` 直接看和改；2) Git 可追踪——每次记忆变更都有 diff；3) 零依赖——npm install 不需要 native module（better-sqlite3 要编译）。对于 < 500 条记忆的规模，grep 扫描所有 .md 文件耗时 < 10ms——性能差异不可感知。

**什么时候切换：** grep 搜索开始超过 50ms（大约 500+ 文件），或者需要语义搜索（搜"认证"找不到"JWT"）时。升级路径：先 SQLite FTS（全文搜索，语义问题没解决但是速度问题解决了），还不够就 pgvector。

### Trade-off 3：评分 + Deep Sleep 分工

**我选了什么：** 确定性评分做初筛（快速、免费），Deep Sleep LLM 做终审（准确、花钱）。

**替代方案 A：** 纯确定性评分。零 LLM 成本，但判断不了"有用性"和"可发现性"。v0.13 之前就是这样——AgentTool、harness.ts 这些代码可发现的 fact 也会被保存。

**替代方案 B：** 全 LLM 审核（OpenClaw 做法）。Light Sleep、Deep Sleep、REM 都是 LLM 调用。质量最高，但每天 3 次 LLM 调用。

**为什么选中间方案：** 评分做它能做的（算频率、算相关性、过滤明显噪音），Deep Sleep 做评分做不了的（判断有用性、合并相似、过滤可发现信息）。各做各擅长的。每天 2 次 LLM 调用（vs OpenClaw 的 3 次），少花约 0.01 元/天。

### Trade-off 4：项目隔离

**我选了什么：** global + per-project 两层。启动时只加载当前项目的记忆。

**替代方案：** 全局记忆池。所有项目的记忆放一起，每次启动全量加载。

**为什么不选全局：** 做 React 项目时加载 Pi 内部细节（agentLoop 导出路径、AgentTool 接口类型）是纯噪音。而且全局索引随项目增多会越来越大——做 10 个项目后，每个项目的 system prompt 都有 9 个无关项目的记忆。

**代价：** 跨项目通用偏好（"用户喜欢简洁回复"）需要显式标记为 `scope: global`。如果用户忘了标记，这条偏好只在当前项目生效。

### Trade-off 5：30 天删除

**我选了什么：** 项目 30 天不活跃 → 删除。直接删，不先问用户。

**替代方案 A：** 30 天时 Agent 问"这些记忆还要吗？"。

**为什么不选：** 用户每次打开一个 31 天前的项目，Agent 第一句话不是回答问题，而是问要不要保留记忆——烦。而且问了用户也不一定记得 30 天前做了什么。

**替代方案 B：** 90 天删除（我之前是 90 天，后来改成 30 天）。

**为什么从 90 改到 30：** 个人开发者的项目周期短。大作业集中做 2-3 天，一个月不碰就是放弃了。90 天保留 3 个月的废弃项目记忆是浪费。

**代价：** 间歇性维护项目（集中改 2 天 → 放 2 个月 → 发现 bug 回来改）在回来时记忆已经被删。但这种情况相对少见，而且 Pi 的 `--resume` 还能恢复上次 transcript。综合来看 30 天是合理的平衡点。

### Trade-off 6：Pi Extension 不改源码

**我选了什么：** 全部代码通过 Pi Extension 机制集成，不在 Pi 源码里加一行。

**替代方案：** Fork Pi 然后在源码里改 agent-loop.ts、system-prompt.ts 等。

**为什么不选：** Pi 每两周发版。如果改了 Pi 源码，每次合并 upstream 都是地狱。而且面试官看到 fork 的 commit history 分不清哪些是我的代码。独立仓库 + Extension 集成 → 100% 的代码边界清晰。

**代价：** 只能用 Pi Extension API 暴露的钩子（`registerTool`、`defineTool`）。如果 Pi 的钩子不够用，需要等 Pi 更新或者换方案。目前为止钩子够用。

### 如果面试官说"你这和 OpenClaw 比差了很多"

> "OpenClaw 是多用户 SaaS，我是个人工具。它需要 Postgres 存 17000+ 记忆页面、需要多租户隔离、需要三阶段全 LLM Dreaming、需要 Compiled Truth + Timeline 证据链。这些对我全是过度设计——个人开发者不会有 17000 条记忆，不会有多个用户同时访问，不需要审计追溯。
>
> 我选择性地借鉴了核心设计——索引+分文件、评分公式权重、Deep Sleep 审核——在我的规模下这些就够了。知道什么该借鉴、什么该舍弃，比全盘照搬更能体现工程判断力。
>
> 如果你问我个人工具什么时候需要升级到 OpenClaw 的架构——当用户数从 1 变成 100，记忆量从 50 变成 5000，会话频率从每天 1 次变成每秒 10 次。那时候 Postgres、多级隔离、全 LLM 管道的价值才会超过它们的成本。"

---

## 五、开发迭代 —— 17 个版本的真实记录

**整个系统不是一次设计出来的。17 个版本中 12 个改进来自实际使用发现和用户反馈。**

| 版本 | 问题 | 怎么发现的 | 解决 |
|------|------|-----------|------|
| v0.1 | SaveMemory 被 LLM 过度调用——用户测试工具它也当真 | 实际对话测试 | 加异步提取模式，SaveMemory 降价为辅助 |
| v0.4 | 阈值 0.5 太严——22 候选只过 1 个 | 跑 extractor 看数据 | 降到 0.35 |
| v0.5 | LLM 把 prompt 里的示例当成真实内容抄 | 看到记忆里有"迁移到 Go"——根本没聊过 | 删掉所有具体示例，只留抽象描述 |
| v0.5 | 存了大量 extension 安装记录 | **用户质疑**："配置本身就是记忆，干嘛还存" | 加 Permanence Test + 文件可发现测试 |
| v0.6 | "用户读过 agent-loop.ts"没被提取 | **用户发现**遗漏 | 新增 knowledge 类型（第 5 种） |
| v0.7 | fact 类型提取了代码可发现的信息 | **用户质疑**："Agent 读文件就知道" | fact 加可发现性过滤 |
| v0.8 | 项目记忆混一起——做 React 时看到 Pi 内存 | **用户问**："agent-loop.ts 细节做其他项目有用吗" | 项目级隔离：global + per-project |
| v0.9 | fallback 到随机 ID 不安全 | 调研 OpenClaw 做法 | workspace 路径识别 |
| v0.10-12 | 退休机制迭代——固定时间窗口区分不了项目类型 | **用户追问**："大作业、日常项目、间歇项目怎么区分" | activity-based .last-active |
| v0.13 | 评分公式算不出记忆质量 | **用户指出**质量不够 | 加 Deep Sleep 二次 LLM 审核 |
| v0.13 | 30 天够判断个人项目是否放弃 | **用户说**："直接删不用问" | 简化：30 天不碰 = 删除 |
| v0.14 | 没 session 的日子也跑 extractor 浪费 LLM 调用 | 逻辑审视 | 检查今天是否有 session，没有就跳过 |
| v0.15 | cron 要手动装 | **用户指出**："别人下载了不知道怎么加 cron" | npm run setup 自动安装 |
| v0.16 | knowledge 类型 frequency hack | **用户指出**："凭什么 knowledge 一次就满分" | frequency 跨会话累积 |
| v0.17 | 缺 daily log + scratchpad | 调研 pi-mem 发现 | 三层时间粒度 |
| v0.17 | 纠正信号权重被忽视 | 调研 pi-hermes-memory 发现 | extraction prompt 信号加权 |

**面试官能从这张表看到什么：**
1. 你会通过实际使用发现问题（不是纸上谈兵）
2. 你会听反馈并改设计（不是固执己见）
3. 你会主动做减法（退休机制加了又删）
4. 你会调研同类项目（pi-mem、pi-hermes-memory、OpenClaw）

---

## 六、具体困难 —— 怎么发现、怎么分析、怎么解决

### 困难 1：SDK vs Extension —— 选错了集成方式，然后推倒重来

**发生了什么：** 最初我读了 Pi 的 SDK 文档，看到 `createAgentSession({ customTools, appendSystemPromptOverride })`，觉得很合适。写了 `main.ts`、`package.json`、`tsconfig.json`，`npm run build` 编译通过了。但执行 `node dist/main.js` 后发现——Pi 的 TUI 根本没有出现。我拿到的只是一个 `session` 对象，需要自己写交互循环。

**排查过程：** 我在 Pi 源码里搜 "extension" 和 "extensions"，发现了 `examples/extensions/hello.ts`——一个 15 行的文件，用 `defineTool` + `export default function(pi: ExtensionAPI)` 格式。搜索 `~/.pi/agent/extensions/`，发现 Pi 启动时自动扫描这个目录并加载所有 Extension。这和我的需求完全匹配——我想让 Pi 的 TUI 里多一个 Memory 工具，不是自己写一个新的 Agent 程序。

**解决：** 扔掉所有 SDK 模式的代码（`main.ts`、`package.json` 的 `build`/`start` 脚本、`tsconfig.json`）。重写为 Pi Extension 格式——一个 `index.ts` 文件 `export default function`，用 `defineTool` 注册 SaveMemory 和 SearchMemory。

**教训：** 不是所有"看起来能用的 API"都适合你的场景。SDK 是给外部程序嵌入 Pi 的（你的 Node 服务里需要一个 Agent），Extension 是给 Pi 内部加能力的（你想让 Pi 的 TUI 里多一个工具）。花半天理解框架的设计意图比花半天调试代码更高效。

### 困难 2：LLM 返回的 evidence 和 transcript 原文对不上

**发生了什么：** extractor 的 Phase 1（LLM 提取）返回了 22 个候选，Phase 2（评分）大部分 > 0.35。但 Phase 2 的证据验证步骤把几乎全部拒绝了——candidate.evidence 里的字符串在 transcript 里找不到。

**排查过程：** 我打印了 LLM 返回的 evidence 和 transcript 原文对比。发现 LLM 的 evidence 是意译——比如 transcript 里用户说的是中文"我不太喜欢那种特别啰嗦的回复方式"，LLM 的 evidence 写的是"user prefers concise replies"。然后我把 evidence 的 "prefers concise replies" 拿去在中文 transcript 里做 `includes()`——当然找不到。

**解决：** 放弃了精确字符串匹配。改为关键词语义匹配——从 evidence + candidate.content 里提取有意义的 token（中文 2+ 字，英文 4+ 字母），然后检查这些 token 在 transcript 中出现的比例。阈值从 80% 降到 60%，加了 CJK 字符的特殊处理。

**教训：** LLM 是意译工具，不是复制粘贴工具。要求它在 evidence 字段里返回"精确引用"是理想，实际上是做不到的。证据验证必须容忍 LLM 的措辞变化。

### 困难 3：LLM 把 prompt 里的示例当成输出模板抄

**发生了什么：** 跑 extractor 后，`~/.triple-pi/memory/fact/` 里有一条记忆"项目三个月后要迁移到 Go"。但这段对话从来没发生过。更离谱的是，还有"选择 JWT 而非 session 认证"——也没聊过。

**排查过程：** 打开 extraction prompt，发现我在 "What TO extract" 部分写了具体示例：`"项目三个月后要迁移到 Go → fact"`、`"选择 JWT 而非 session → decision"`。LLM 把 prompt 里的示例当成"应该输出的内容"直接复制了。

**解决：** 删掉 extraction prompt 里所有具体示例，只保留分类的抽象描述（"不在代码中的上下文"、"决策 + 原因"）。在 prompt 末尾加了 CRITICAL 警告："以上示例仅说明格式。不要提取示例内容。只提取 THIS transcript 里实际出现的信息。"

**教训：** LLM 的 instruction following 不是人类想象的那样。你给的示例越具体，它越倾向于复制。抽象描述比具体示例更安全。这不是 DeepSeek 特有的问题——Anthropic 的文档也提到过类似的"示例污染"现象。

### 困难 4：CJK 文件名编码

**发生了什么：** 用户的中文记忆标题（如 "不使用 any 类型"）直接用作文件名时，终端显示乱码，`git diff` 也不友好。纯英文文件名用户看不懂，拼音转换需要额外依赖（pinyin 库）。

**解决：** 混合编码——ASCII 字符保留原样，CJK 字符转十六进制。`"不使用 any 类型"` → `any-e4b88de4bdbfe794a8-e7b1bbe59e8b.md`。用户不需要直接看文件名——通过索引和搜索找到记忆。

**代码：**
```javascript
title.toLowerCase()
  .replace(/[一-鿿]+/g, m => '-' + Buffer.from(m).toString('hex') + '-')
  .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
```

---

## 七、设计的缺点（主动承认，展示诚实）

### 缺点 1：没有语义搜索

**现象：** SearchMemory 是全文 grep——把用户输入的关键词在所有 .md 文件里做 `toLowerCase().includes(keyword)`。搜"认证"能找到包含"认证"这个词的记忆，但找不到标题是"JWT 选择"的记忆——"JWT"和"认证"在字符串层面没有重叠，虽然语义上相关。

**为什么现在不做：** 语义搜索需要 embedding 模型（把文本转成向量）和向量存储（存向量 + 做相似度搜索）。最轻量的方案是 LanceDB（嵌入式向量库）+ bge-small-en（本地 embedding 模型），但这引入了两个新依赖。对 < 100 条记忆的规模，浏览分类目录就能找到想要的——用户记得自己说过什么。

**什么时候做：** 记忆量 > 200 条，用户开始抱怨"搜不到"的时候。升级方案：先用分类目录 + grep 撑到 200 条，然后评估需要 LanceDB 还是 SQLite FTS 就够了（FTS 能搜"JWT"找到包含"JWT"的文件，但不能搜"认证"找到"JWT"）。

### 缺点 2：Deep Sleep 每天多一次 LLM 调用

**现象：** 5 阶段管道比纯确定性评分多一次 LLM 调用（Phase 2.5 Deep Sleep）。每天约 0.005 元（DeepSeek），一个月 ~0.15 元。对个人开发者可忽略，但如果放到零成本场景（比如给学生用的免费工具），这个成本需要被优化。

**为什么还要做：** Deep Sleep 是质量兜底——评分公式判断不了"有用性"和"可发现性"。去掉它，质量下降但有评分公式撑着，不会完全失效。保留它，质量更高但多花一分钱。考虑到个人开发者场景，我选择保留。如果面试官问"能不能删"，答案是能——把 Phase 2.5 注释掉，系统退回 v0.12 的纯评分模式，一样能跑。

### 缺点 3：30 天休眠可能误删间歇维护项目

**现象：** 一个项目集中改 2 天 → 放 2 个月不管 → 发现生产 bug 回来改。此时项目记忆已经被删（30 天过期），Agent 完全不记得之前的修改。

**为什么还选 30 天：** 个人开发者大部分项目的寿命就是 30 天以内。大作业做完就交了，side project 做几天就可能放弃。保留 2 个月前的项目记忆对大多数项目是浪费。对于少数真正的间歇维护项目，Pi 的 `--resume` 还能恢复上次 transcript——记忆丢了但对话历史还在。

**什么时候改：** 如果用户发现自己经常因为记忆被删而要重复解释，把 DORMANT_DELETE_DAYS 从 30 改成 60 或 90 就行——一行配置。

### 缺点 4：依赖 transcript 质量

**现象：** 如果用户连续几天都在做调试（"试试这个能不能编译"、"换个参数再跑"），extractor 提取不出有用记忆。系统不会编造记忆（证据验证保证了 grounded 原则），但也不会从低质量 transcript 里创造价值。

**为什么可以接受：** 调试会话本来就不应该产生持久记忆——它是临时性的。用户不会在同一个 bug 上调试 3 天然后需要跨会话记住调试过程。真正值得记住的（偏好、决策、规则）通常出现在讨论和设计对话里，而不是调试对话里。

### 缺点 5：单机绑定

**现象：** 所有记忆存在 `~/.triple-pi/memory/` 本地文件系统。换电脑、重装系统 → 记忆全部丢失。

**为什么现在不做同步：** 当前假设单机使用（大多数个人开发者只有一台主力机）。如果需要同步：把 memory 目录加入 git repo（pi-memory-md 已经这么做了），或者未来支持 S3/Cloudflare R2 云同步。方案是现成的，只是还没做。

---

## 八、数字（面试时随口说出来，显著加分）

| 指标 | 数字 | 怎么算出来的 |
|------|------|------------|
| Extension 代码 | ~200 行 TS | `extensions/memory/` 下两个文件的行数 |
| Extractor 代码 | ~580 行 JS | `scripts/extract.mjs` 的行数 |
| Pi 修改 | 0 行 | git diff pi-runtime/ → 空 |
| 管道阶段 | 5 | Light Sleep → Scoring → Deep Sleep → Merge → REM（当前跳过了 REM） |
| 评分维度 | 6 维 + 4 种信号权重 | 同 OpenClaw 权重，信号加权是 prompt 层面 |
| 记忆类型 | 5 种 | knowledge / preference / decision / rule / fact |
| 时间粒度 | 3 层 | scratchpad（小时）/ daily log（天）/ long-term memory（永久） |
| 项目隔离 | global + per-project | git remote URL 或 workspace 绝对路径识别 |
| 休眠 | 30 天删除 | `.last-active` 文件记录最后活跃时间 |
| LLM 调用/天 | 最多 2 次 | Light Sleep（~4000 tokens）+ Deep Sleep（~2000 tokens） |
| 每日 LLM 成本 | ~0.007 元 | DeepSeek 定价 ~0.001 元/1K tokens × 6K tokens ≈ 0.006 元，向上取整留余量 |
| 内存占用 | 0 MB | 没有常驻进程，extractor 是 cron 触发的 Node 脚本，跑完就退出 |
| 磁盘占用 | ~50KB（50 条记忆） | 每条记忆 ~1KB，加上索引和 scores.json |

### grep 为什么真的够用（数据支撑）

面试官可能质疑"grep 扫描在 500 条记忆时真的快吗？"——这里给出具体计算：

```
500 个 .md 文件 × 平均 2KB/文件 = 1MB 总数据
文件系统读取速度 > 100MB/s → 读完全部文件 < 10ms
grep 字符串匹配在 1MB 文本上 < 5ms
总耗时 < 15ms

对比 SQLite FTS5 在有索引的情况下 < 1ms
差异：15ms vs 1ms → 用户不可感知

500 条记忆是什么概念？
  10 个项目 × 50 条记忆/项目 = 500 条
  每天 2 个项目有 session，每条 session 提取 3-5 条新记忆
  达到 500 条需要 ~100 天
  对于个人开发者，这是 1-2 年的使用量
```

**结论：grep 在个人开发者整个使用周期内都够用。** 超过 500 条后升级到 SQLite FTS 是合理的规划，但不是现在需要的。

### 语义去重是怎么做的（确定性流程详解）

面试官问"为什么不做语义去重？"——需要解释当前的确定性流程：

```
当前去重（Jaccard 3-gram 相似度，完全确定性，不调 LLM）：

1. 把两条记忆的 "标题 + 内容" 分别拆成 3-gram 集合
   "禁止使用 any 类型" → {'禁止使', '止使用', '使用 a', '用 an', ' any', 'any ', 'ny 类', 'y 类型'}
   "不要用 any"         → {'不要用', '要用 a', '用 an', ' any', ...}

2. 计算 Jaccard 相似度 = |交集| / |并集|
   交集：{' any'} 等 → 1 个
   并集：两个集合合并 → ~10 个
   相似度 = 1/10 = 0.1 → < 0.6 → 判断为 "不重复"

3. 阈值 0.6：相似度 > 0.6 且同 category → 合并

为什么 0.6 不是 0.8？
  实测："Pi 没有 MEMORY.md" vs "Pi 没有跨 session 记忆" 
  3-gram 相似度约 0.4 → 不会合并（Jaccard 看不到语义）
  但用户知道这两条是同一件事 → 这是语义重复，确定性算法检测不到

什么时候需要语义去重：
  记忆量 > 200 条，同 category 下有大量 "说同一件事但措辞不同" 的记忆
  此时引入 LLM：把同 category 的所有标题发给 LLM，问 "哪些在说同一件事？"
```

---

## 九、追问速查表（每条都能展开讲 2-3 分钟）

| 问题 | 详细回答 |
|------|---------|
| **为什么不用向量数据库？** | 个人 Agent < 500 条记忆，grep 扫描 1MB 数据 < 15ms，用户体验无差别。向量库增加 embedding 模型和向量存储两个依赖。升级信号：记忆 > 500 或者需要语义搜索（搜"认证"找到"JWT"）。 |
| **为什么不做语义去重？** | Jaccard 3-gram 相似度是确定性算法——拆词 → 算交集/并集 → 阈值判断。能检测"不用 any"和"禁用 any 类型"是重复（相似度 > 0.6）。但检测不了"偏好函数式"和"讨厌 class"是同一件事——这需要语义理解。在 50 条记忆下用户自己肉眼能分辨，200 条以上再引入 LLM 语义去重。遵循"确定性优先于 LLM"原则。 |
| **和 LangChain Memory 区别？** | LangChain Memory 解决上下文窗口问题（对话长了怎么办 → 摘要/压缩）。我解决知识管理问题（跨会话哪些信息值得保留 → 提取/评分/审核）。LangChain 侧重"这一轮对话的上下文管理"，我侧重"跨轮次的知识提取"。 |
| **和 Pi transcript 区别？** | Pi 的 transcript 是完整对话记录（日记，5000+ tokens），用于恢复会话。MEMORY.md 是提取后的知识索引（便签，< 200 tokens），用于意识——让 Agent 每次启动就知道关键信息。互补关系：transcript 记录一切，memory 提取重点。 |
| **最大缺点？** | 没有语义搜索——搜索"认证"找不到"JWT"。这是有意延迟的优化，在 < 200 条记忆时浏览目录就够了。不是不知道怎么做，是知道什么时候该做。 |
| **怎么验证效果？** | 目前有对照实验数据（阈值 0.5 vs 0.35 的通过率对比、Deep Sleep 跑不跑的保存质量对比）。下一步建 Eval 框架——15 个 case 覆盖读取/修改/重构/调试，量化有 Memory vs 无 Memory 的任务完成率。 |
| **"这不就是包了一层？"** | 不是包一层，是在 Agent 工作流里插入了三个新能力：system prompt 记忆注入（改变 Agent "看到什么"）、5 阶段异步提取管道（改变 Agent "记住什么"）、SaveMemory/SearchMemory 工具（改变 Agent "能做什么"）。这些 Pi 本身都不提供。 |
| **"和 OpenClaw 比差了什么？"** | OpenClaw 是多用户 SaaS——需要 Postgres、多租户隔离、三阶段全 LLM Dreaming、Compiled Truth + Timeline 证据链。我是个人工具——不需要这些。但核心设计同源：索引+分文件、评分公式权重、Deep Sleep 审核、grounded snippet 原则。知道什么该借鉴、什么该舍弃，比全盘照搬更体现工程判断力。 |
| **"你这技术含量在哪？"** | 技术含量不在"用了什么技术"（文件系统、grep、http fetch 都很基础），而在"在 17 个版本的迭代中，发现了一系列真实问题，做了 6 个有意识的 trade-off，用实验数据验证了 3 个参数"。大部分项目不会经历这种迭代——demo 阶段就停了。我的系统是实际跑过的，数据是跑出来的。 |

---

## 十、后续

1. **Eval 框架**（最高优先级）—— 15 个 case 覆盖读/改/重构/调试，量化有 Memory vs 无 Memory 的通过率。面试核武器。
2. **Slack Channel**——Agent 走出终端，通过 Slack 接收和回复消息。
3. **SubAgent + Worktree**——多文件任务时 spawn 子 Agent，隔离上下文和文件系统。
