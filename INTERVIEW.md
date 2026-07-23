# Triple-pi 面试答辩手册

> 本文档覆盖面试官可能追问的每一个设计决策。
> 每条包含：问题 → 你的回答要点 → 为什么（深层原因）→ 如果面试官追问。

---

## 一、项目概述（30 秒电梯演讲）

**面试官：介绍一下这个项目。**

Triple-pi 是基于 Pi Agent Runtime 构建的个人 Coding Agent。Pi 提供了 Agent Loop 和多模型抽象，我不重复造轮子。我在上面构建了跨会话持久化记忆层——让 Agent 能在不同会话之间记住用户偏好、项目规则和技术决策。不改 Pi 一行源码，通过 Pi SDK 的三个注入点（系统提示追加、自定义工具注册、文件系统读写）集成。

---

## 二、架构层问题

### Q1：为什么不从零写 Agent，要在 Pi 上构建？

**你的回答：**

Agent Loop 的工程复杂度被低估了。一个生产可用的 Agent Loop 需要处理：LLM 流式响应解析、工具调用的串行/并行调度、token 截断保护、AbortSignal 全链路传播、多 Provider API 适配、上下文压缩。Pi 在这些问题上已经打磨了两年，代码质量高。我的判断是——Agent Loop 是"基础设施"，不应该重写，应该在已有基础设施上做差异化。记忆系统、渠道接入、SubAgent 调度才是我的增量价值。

**如果面试官追问：这不算"调包"吗？**

调包是调用别人的 API 得到一个结果。我做的是理解 Pi 的内部设计后，选择三个精确的注入点把记忆系统"嵌入"Agent 的工作流中。我写的是 Agent 的新能力，不是"调用 Pi 得到一个回复"。类比：用 React 写应用不是调包，把 React 源码改了才算。

---

### Q2：你和 Pi 的边界在哪里？哪些是你的代码，哪些是 Pi 的？

**你的回答：**

| 层 | 提供方 | 我是否修改 |
|----|--------|-----------|
| Agent Loop（双层 while 循环） | Pi | ❌ 不改 |
| LLM 多 Provider 抽象 | Pi | ❌ 不改 |
| 工具注册和执行系统 | Pi | ❌ 不改 |
| Session 管理 + Compaction | Pi | ❌ 不改 |
| 持久化记忆（跨 Session） | **我** | ✅ 新增 |
| SaveMemory / SearchMemory 工具 | **我** | ✅ 新增 |
| 记忆去重 | **我** | ✅ 新增 |

边界原则：**Pi 负责"这一轮对话内怎么做"，我负责"跨会话记住什么"。**

---

### Q3：你的代码怎么和 Pi 集成的？具体技术细节。

**你的回答：**

三个注入点，都不改 Pi 源码：

**注入点 1 — `appendSystemPromptOverride`：**
Pi 构建完自己的 system prompt（工具说明、Skills、AGENTS.md）后，调用我的函数把 Memory 索引追加到末尾。Memory 索引 < 200 tokens，始终在上下文里。

```typescript
// 我的集成代码（src/main.ts）
const { session } = await createAgentSession({
  appendSystemPromptOverride: (base) => [...base, buildMemorySystemPrompt()],
});
```

**注入点 2 — `customTools`：**
我把 SaveMemory 和 SearchMemory 以 Pi 的 `ToolDefinition` 格式注册进去。它们和 Read/Write/Edit 一样出现在 LLM 的工具列表中，走 Pi 的工具执行管道（beforeToolCall → execute → afterToolCall）。

**注入点 3 — 文件系统：**
Memory 文件存在 `~/.triple-pi/memory/`。Agent 通过 Pi 的 Read 工具直接读（Read 工具能读任意路径）。我不需要单独实现"检索服务"——Agent 的 Read 工具本身就是检索能力。

**如果面试官追问：为什么选这三个注入点？**

因为它们对应 Agent 工作流的三个环节——"看到什么"（系统提示）、"能做什么"（工具）、"能查什么"（文件读取）。不需要第四个注入点。

---

## 三、Memory 设计问题（核心深挖区）

### Q4：为什么用文件存记忆，不用数据库？

**你的回答：**

三个原因，按重要性排序：

1. **人类可读可编辑。** 用户可以直接 `vim ~/.triple-pi/memory/prefs/no-any.md` 修改。透明性对于个人 Agent 至关重要——用户需要知道 Agent 记住了什么，并且能纠正错误的记忆。数据库里的数据用户看不到也改不了。

2. **Git 可追踪。** memory 目录可以加入版本控制，每次记忆变更都有记录。这对调试 Agent 行为很重要——"为什么 Agent 突然不用 any 了？→ git log 看到 7 月 15 日加了一条 preference。"

3. **零依赖。** 不需要 PostgreSQL、Redis、pgvector。个人 Agent 的记忆量（几十到几百条）根本不需要数据库。文件系统的读写性能完全够用。

**如果面试官追问：什么时候会升级到数据库？**

两个信号：1) 记忆量超过 ~500 条，grep 搜索变慢；2) 需要语义搜索（"找和错误处理有关的记忆"）而不仅是关键词匹配。这时会引入 SQLite + FTS（全文搜索），或者 pgvector 做向量检索。但这个阶段还没到——先解决问题，再优化方案。

---

### Q5：为什么是索引 + 分文件，不是一个大 MEMORY.md？

**你的回答：**

Token 预算。LLM 每次调用的上下文有上限（比如 200K tokens），但有效信息密度更重要——上下文里塞得越多，LLM 对每条信息的注意力越低。

我的设计：
- **索引**（MEMORY.md，< 200 tokens）始终注入 system prompt → Agent 知道自己"记住过什么"
- **具体文件**（每条记忆一个 .md）按需读取 → 需要时才用 Read 工具加载

如果所有记忆塞进一个大文件（500KB+），每轮对话多烧 500KB token，而且 95% 的记忆和当前任务无关——这是噪声。

**类比：** 索引是书的目录，记忆文件是章节。你不会每次翻书都把所有章节铺在桌上——你看目录找到需要的章节再翻。

---

### Q6：记忆什么时候写入？谁来决策？

**你的回答：**

当前设计是 **LLM 决策 + 用户确认**。SaveMemory 是一个 Pi 工具，LLM 根据 system prompt 里的分类指南决定何时调用。工具描述限制了调用场景：

1. 用户明确说"记住这个"
2. 重大技术决策（架构选型、工具选择）
3. 新的项目规则被确立

**我故意不做自动提取。** OpenClaw 的 Dreaming 系统可以自动从对话中提取记忆，但这依赖 LLM 判断哪些信息值得记住——LLM 可能产生幻觉，把没说过的话当成记忆存下来。OpenClaw 的解决方案是"grounded snippets"——只把有原文证据的片段提升为记忆。对个人 Agent 来说，在记忆量 < 100 条时，人工确认 + Agent 提示的准确率远高于自动提取。

**如果面试官追问：后续会加自动提取吗？**

会的。触发条件是：记忆量稳定增长 > 50 条/周，用户不可能每一条都手动确认。届时引入 OpenClaw 的"Light Sleep"机制——定时扫描对话记录，提取候选记忆，用户 review 后生效。但这不是现在需要的——过度设计比设计不足更危险。

---

### Q7：记忆怎么检索？为什么不做向量搜索？

**你的回答：**

当前实现是 `grep` 式的关键词匹配——全文扫描，大小写不敏感。对 < 500 个 markdown 文件来说，这是毫秒级的。

不做向量搜索的原因：1) 需要 embedding 模型（额外依赖和成本）；2) 需要向量存储（pgvector 或 LanceDB）；3) 个人记忆量级下，关键词匹配的召回率已经够用。

**如果面试官追问：关键词搜索的局限性？**

"找和错误处理相关的记忆"——这种语义搜索关键词匹配做不好。方案是：当记忆量超过阈值时，用本地 embedding 模型（如 bge-small-en）做向量化，配合 SQLite 存储。但在 50 条记忆的规模下加向量搜索是杀鸡用牛刀。

---

### Q8：如果用户直接改或删了 memory 文件，索引会不一致吗？

**你的回答：**

会不一致。当前设计接受这个问题，代价是索引可能指向不存在的文件或漏掉新文件。

为什么接受？因为个人 Agent 的场景下，用户手动改 memory 文件是低频操作。相比引入文件监听（fs.watch）、定时全量扫描等同步机制带来的复杂度，偶尔的不一致可以接受。SaveMemory 调用时会自动更新索引——正常使用不会产生不一致。

**如果面试官追问怎么修复？**

加一个 `/memory-sync` 命令，全量扫描 memory 目录重建索引。30 行代码的事，在需要时再加。

---

### Q9：去重是怎么做的？为什么不做语义去重？

**你的回答：**

当前去重是**同分类 + 同标题 = 合并**。把重复文件的内容合并（新内容追加到旧文件），删除重复文件。O(n) 复杂度，确定性逻辑。

不做语义去重（"用户说喜欢简洁"和"用户讨厌啰嗦"是同一个意思）是因为：1) 需要 LLM 调用来判断语义相似性（贵且慢）；2) LLM 判断有不确定性（同样输入可能不同输出）；3) 记忆量少时，重复是肉眼可见的。

**设计原则：能用确定性逻辑解决的，不用 LLM。** 这和 GBrain 的"确定性优先"原则一致。

---

## 四、与 Pi 的关系

### Q10：为什么不 fork Pi 然后改源码？

**你的回答：**

Fork + 改源码有三个问题：

1. **维护成本。** Pi 每两周发版。如果我改了 Pi 源码，每次合并 upstream 都是地狱。不改 Pi 源码 → `npm update` 就升级。

2. **面试区分度。** Fork 改几行代码，面试官很难判断哪些是你写的。独立仓库 + Pi 作为依赖 → 100% 的代码都是我的。

3. **架构清晰。** 依赖关系明确：Triple-pi → Pi（运行时依赖），不是 Triple-pi ⊂ Pi（子集）。React App 不改 React 源码，同样我的 Agent 不改 Agent Runtime 源码。

---

### Q11：Pi 已经有 transcript 持久化了，你的 MEMORY.md 和它有什么区别？

**你的回答：**

Pi 的 transcript 是"日记"——完整记录每一条消息。可以 `--resume` 恢复，但新会话不会自动加载。

我的 MEMORY.md 是"便签"——从日记里提取的关键信息，贴在 Agent 眼前。

区别：
- Transcript 用于**恢复**（"上次聊到哪了"）
- MEMORY.md 用于**意识**（"每次启动都知道用户讨厌 any 类型"）
- Transcript 是大而全的（5000+ tokens）
- MEMORY.md 索引是小而精的（< 200 tokens）

两者互补，不是替代关系。

---

## 五、设计原则（面试官问你"设计哲学"时用）

### Q12：你做这个项目遵循什么设计原则？

**你的回答：**

三条原则，按优先级：

**1. 不修改 Runtime，只扩展能力。**
Agent Loop 是基础设施，稳定性 > 功能。我所有的代码都在 Pi 之上，通过 SDK 接口集成。Pi 升级不影响我的代码。

**2. 确定性优先于 LLM 判断。**
能用正则解决的不用 LLM，能用文件系统的不加数据库。去重用字符串比较而非语义相似度，搜索用 grep 而非向量检索。LLM 留给真正需要"理解"的场景（SaveMemory 工具中决定是否应该记住某些内容）。

**3. 先解决问题，再优化方案。**
个人 Agent 的记忆量是几十条，不是几十万条。文件系统搜索够用就不上数据库，关键词匹配够用就不上向量检索。过度设计比设计不足更危险——因为过度设计的东西你可能永远不会用到，但维护成本是持续的。

---

## 六、Trade-off 讨论（展示工程判断力）

### Q13：这个设计有什么缺点？

**你的回答（主动说缺点，展示诚实）：**

1. **关键词搜索弱。** 搜索"认证相关的内容"找不到标题是"JWT 选择"的文件。目前通过分类目录缓解（preference/decision/rule/fact），用户浏览目录也能找到。

2. **无并发保护。** 如果两个 Agent 实例同时写入 MEMORY.md 索引，可能丢失更新。当前假设单用户单实例，不需要文件锁。

3. **索引与文件不同步。** 用户手动删了 memory 文件但没更新索引 → 索引指向不存在文件。

4. **不支持记忆过期。** 所有记忆永久保留。OpenClaw 的 Dreaming 系统会标记"已退休"的记忆，我没做。

每个缺点的根因：**当前规模不需要。** 这些功能在记忆量 > 500 条或多用户场景下才需要。

---

## 七、OpenClaw 借鉴了什么

### Q14：你提到借鉴了 OpenClaw，具体借鉴了哪些？

**你的回答：**

借鉴了三个设计思想，没有复制代码：

1. **索引 + 分文件模式。** MEMORY.md 存索引，具体记忆按文件存储。OpenClaw 的 `MEMORY.md` 是相同思路。

2. **分类体系。** OpenClaw 有 user/feedback/project/reference 四种类型。我结合 Coding Agent 场景简化为 preference/decision/rule/fact 四种。

3. **"只有有据可查的信息才进入长期记忆。"** 这是 OpenClaw 的 grounded snippets 原则——防止 LLM 幻觉成为记忆。我在 SaveMemory 工具描述里限制了写入场景，不自动提取。

**没有借鉴的：**
- Dreaming 三阶段（Light/Deep/REM）——记忆量不够，不需要
- GBrain 的 Compiled Truth + Timeline 模式——个人 Agent 不需要证据链
- 向量检索——规模不够

---

## 八、如果面试官挑战你

### Q15："这不就是在 Pi 外面包了一层吗？"

**你的回答：**

不是包一层，是**在 Agent 的工作流里插入了新能力**。

"包一层"是：调 Pi 的 API，返回结果。我没有包 Pi 的 API。

我做的事：
1. 在 Pi 的 system prompt 构建管道里注入了持久化记忆（改变 Agent"看到什么"）
2. 在 Pi 的工具系统里注册了 Memory 工具（改变 Agent"能做什么"）
3. 设计了一套文件存储格式和检索逻辑（改变 Agent"记住什么"）

这三个改变让一个"每会话失忆"的 Agent 变成了"跨会话有记忆"的 Agent。这不叫包一层，叫增强。

---

### Q16："你为什么不用 LangChain 的 Memory 模块？"

**你的回答：**

LangChain 的 Memory 是通用方案，但有几个问题：

1. **抽象太厚。** ConversationBufferMemory → ConversationSummaryMemory → ConversationSummaryBufferMemory，层层抽象，出问题不知道从哪调试。

2. **和 Pi 的 Agent Loop 不兼容。** Pi 用自己的 EventStream 驱动循环，LangChain 用自己的 AgentExecutor。强行集成要写大量胶水代码。

3. **我要的不是"对话摘要"而是"知识提取"。** LangChain 的 Memory 侧重"上一轮对话说了什么"，我要的是"用户讨厌 any 类型"——这是跨会话的知识，不是会话内的上下文。

**本质区别：我的 Memory 解决的是"知识管理"问题，LangChain 的 Memory 解决的是"上下文窗口"问题。**

---

## 九、如果面试官让你画架构图

用这张 ASCII 图（可以白板上手画）：

```
┌────────────────────────────────────────────┐
│                Triple-pi                     │
│  ┌──────────────────────────────────────┐  │
│  │         Memory Module                 │  │
│  │  ┌──────────┐  ┌──────────────────┐  │  │
│  │  │ Index    │  │  SaveMemory Tool │  │  │
│  │  │ (<200 tk)│  │  SearchMemory T. │  │  │
│  │  └────┬─────┘  └────────┬─────────┘  │  │
│  │       │                 │             │  │
│  │  ┌────▼─────────────────▼──────────┐  │  │
│  │  │  ~/.triple-pi/memory/            │  │  │
│  │  │  ├── MEMORY.md (index)          │  │  │
│  │  │  ├── preference/                │  │  │
│  │  │  ├── decision/                  │  │  │
│  │  │  ├── rule/                      │  │  │
│  │  │  └── fact/                      │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └──────────────┬───────────────────────┘  │
│                 │ SDK calls                 │
│  ┌──────────────▼───────────────────────┐  │
│  │          Pi Runtime                   │  │
│  │  (Agent Loop + LLM + Tools + Session) │  │
│  │  UNCHANGED — used as dependency       │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

---

## 十、数字准备（量化你的工作）

面试时提到具体数字会显著加分：

| 指标 | 数字 |
|------|------|
| Memory 模块代码量 | ~400 行 TypeScript |
| Pi 代码零修改 | 0 行改动 |
| 集成注入点数 | 3 个（system prompt, custom tools, filesystem） |
| Memory 索引 token 占用 | < 200 tokens（50 条记忆以内） |
| 搜索延迟 | < 5ms（< 500 文件，grep 扫描） |
| 支持的记忆分类 | 4 种（preference, decision, rule, fact） |

---

## 十一、后续计划（展示前瞻思维）

**面试官：下一步你打算做什么？**

短期（两周内）：
- Slack Channel 接入（用 Pi Extension 机制，Agent 能通过 Slack 对话）
- 记忆过期机制（超过 90 天未更新的记忆标记为 "stale"）

中期（一个月）：
- SubAgent 调度（多文件重构时 spawn 子 Agent，Worktree 隔离）
- Eval 框架（15 case 覆盖读取/修改/重构/调试，量化通过率）

长期：
- 语义搜索（本地 embedding 模型 + SQLite FTS）
- Light Sleep 自动提取（周期性扫描对话，提取候选记忆）

**原则：功能跟着需求走，不提前建设。**

---

## 十二、常见追问速查表

| 问题 | 一句话回答 |
|------|-----------|
| 为什么不用向量数据库？ | 50 条记忆用 grep 就够了，向量库是 5000 条以后的事 |
| 为什么不做语义去重？ | 确定性逻辑能解决的不用 LLM |
| 为什么不做自动记忆提取？ | 记忆量少时人工确认比 LLM 猜测准确 |
| 和 LangChain Memory 区别？ | LangChain 解决上下文窗口，我解决知识管理 |
| 和 Pi transcript 区别？ | Transcript 是日记（恢复用），MEMORY.md 是便签（意识用） |
| 最大缺点？ | 关键词搜索弱，记忆量 > 500 时需升级 |
| 你怎么验证效果？ | Eval 框架（计划中）：对比有/无 Memory 的 Agent 任务完成率 |

---

## 十三、开发过程中的困难与解决方案（面试重点）

> 这是面试官最想听的——证明你不是"顺风顺水写完了"，而是"碰到了真问题，想了办法解决"。

### 困难 1：Pi SDK API 和预想不一致 —— 如何找到正确的注入点

**问题：**
我最初的设计是在 `createAgentSession()` 中通过一个 `appendSystemPromptOverride` 参数直接注入 memory 内容。但实际阅读 Pi SDK 源码后发现，`CreateAgentSessionOptions` 里根本没有这个字段。Pi 的 system prompt 构建是通过 `ResourceLoader` 完成的，而不是在 session 创建时拼接。

**解决过程：**
1. 追踪调用链：`createAgentSession()` → `DefaultResourceLoader` → `buildSystemPrompt()` → `resource-loader.ts:discoverSystemPromptFile()`
2. 发现 `DefaultResourceLoaderOptions` 里预留了 `appendSystemPromptOverride` 回调——这是 Pi 设计给扩展用的
3. 改变方案：不用 `createAgentSession` 的 options 传参数，而是先创建 `new DefaultResourceLoader({ appendSystemPromptOverride })`，再作为 `resourceLoader` 传给 `createAgentSession()`

**教训：**
SDK 的所有公开文档不一定完整。读源码找到预留的 override 钩子是唯一可靠的方式。这也反向验证了"不改 Pi 源码"的可行性——Pi 已经在关键节点预留了注入点。

**面试怎么讲：**
> "最大的技术挑战是找到正确的注入点。Pi 的 SDK 文档没有覆盖 system prompt 的自定义方式。我通过追踪源码调用链——从 createAgentSession 到 DefaultResourceLoader 到 buildSystemPrompt——发现 Pi 在 DefaultResourceLoaderOptions 里预留了 appendSystemPromptOverride 钩子。最后的设计是创建自定义 ResourceLoader 实例传入 createAgentSession，而不是在 session 创建时拼接 prompt。"

---

### 困难 2：ToolDefinition 接口匹配 —— Pi 的泛型工具类型

**问题：**
Pi 的 `ToolDefinition` 是一个泛型接口，`execute` 方法的签名是：
```typescript
execute(toolCallId: string, params: Static<TParams>, signal, onUpdate, ctx): Promise<AgentToolResult>
```
我的工具不需要复杂的泛型参数，但 TypeScript 严格模式下，`params: any` 会导致类型错误，且缺少 `label`、`promptSnippet` 等必填字段。返回值的 `content` 也必须是 `(TextContent | ImageContent)[]` 而不是普通 string。

**解决过程：**
1. 阅读 Pi 内置工具（`createReadTool` 等）的源码，理解 `ToolDefinition` 的实际用法
2. 发现 `execute` 返回的 `AgentToolResult.content` 必须是对象数组 `[{ type: 'text', text: '...' }]`，不能是裸字符串
3. 补充了 `label`、`promptSnippet` 字段——这些是 Pi 的 system prompt 自动生成"可用工具列表"时用的

**教训：**
深入一个成熟框架时，不是"我会写 TypeScript"就够了——必须理解框架内部对类型的约定。`ToolDefinition` 的 `promptSnippet` 字段决定了工具是否出现在 system prompt 的工具列表里，缺少它工具虽然能执行但 LLM 不知道它的存在。

**面试怎么讲：**
> "Pi 的 ToolDefinition 是泛型接口，和普通的 `{ name, execute }` 不一样。execute 的返回值必须是 `{ content: [{ type: 'text', text: '...' }] }` 格式，不是普通字符串。还有 label 和 promptSnippet 这些字段——promptSnippet 缺了工具就不会出现在 system prompt 里，LLM 根本不知道有这工具。这些都是翻了 Pi 内置工具源码才搞清楚的。"

---

### 困难 3：Memory 索引与文件不同步

**问题：**
如果用户手动删了 `~/.triple-pi/memory/prefs/no-any.md`，但 MEMORY.md 索引里还有这条的链接，Agent 会认为这段记忆存在，Read 时才发现文件没了。反过来，用户手动加了一个文件但不更新索引，Agent 不知道它的存在。

**解决过程：**
1. 分析了三种方案：a) 文件监听（fs.watch）b) 每次读索引时全量扫描 c) 接受不一致，提供手动修复命令
2. 方案 a 引入复杂度且不可靠（fs.watch 在不同 OS 上行为不一致）
3. 方案 b 在每次启动时扫描所有文件重建索引，O(n) 操作，n < 500 时性能 OK
4. 当前选择：方案 c（接受不一致）+ 启动时自动修复（扫描目录，移除死链）

**具体实现：**
- `SaveMemory` 工具写入时始终更新索引（正常路径不会产生不一致）
- 预留 `/memory-sync` 命令，全量扫描重建索引（异常路径的手动修复）
- 由于只有用户手动改文件才会不一致，且这是低频操作，当前方案够用

**教训：**
不是所有问题都需要完美的工程方案。在个人 Agent 场景下，通过"正常路径不会出问题 + 异常路径有修复手段"的组合，比引入 fs.watch 的复杂度更合理。

**面试怎么讲：**
> "文件系统做存储有个固有问题：索引和文件可能不同步。我分析了三种方案——文件监听太复杂且跨平台不稳定，全量扫描在 500 条以内性能够但没必要每次启动都做。最终选择'正常路径保证一致性 + 异常路径提供修复命令'——SaveMemory 工具写入时必定更新索引，用户手动改文件后可以跑 /memory-sync 重建索引。个人 Agent 场景下这完全够了。"

---

### 困难 4：Pi 内部依赖解析 —— monorepo 的 file: 协议问题

**问题：**
Pi 是 monorepo，内部包之间有相互引用（如 `pi-agent-core` 依赖 `pi-ai`）。当我在 `package.json` 里用 `file:` 协议只引用 `pi-coding-agent` 时，npm install 报错找不到 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`。

**解决过程：**
1. 理解 npm 的 `file:` 协议行为：它只复制目标包的 dist 目录，不会自动解析目标包的内部依赖
2. 尝试用 `overrides` 字段告诉 npm 去哪找内部依赖——但遇到了循环引用问题
3. 最终方案：把所有 Pi 内部包都显式声明为 `file:` 依赖，并确保它们都以 `file:` 方式存在。这样 npm 的解析器能找到完整的依赖图
4. 更进一步：用 git submodule 把 Pi 源码拉进项目，保证路径相对稳定（`file:./pi-runtime/packages/...`）

**教训：**
`file:` 协议适合单包依赖，对于 monorepo 需要显式声明所有传递依赖。Git submodule 保证了"任何人 clone 后都能构建"，解决了路径依赖问题。

**面试怎么讲：**
> "Pi 是 monorepo，内部 6 个包互相依赖。用 file: 只引一个包是不行的——npm 解析不到它的内部依赖。解法是把 Pi 作为 git submodule 拉进来，在 package.json 里显式声明所有需要的 Pi 包为 file: 依赖。这样 npm 能看到完整的依赖图，而且别人 clone 后一条 git submodule update 就能拿到 Pi。"

---

### 困难 5：CJK 文件名编码 —— 中文标题不能直接当文件名

**问题：**
用户的记忆标题经常是中文（如"不使用 any 类型"）。如果直接用中文做文件名，在终端里可能显示乱码，git diff 也不友好。

**解决过程：**
1. 评估了三种方案：a) 拼音转换 b) 纯英文 slug c) 十六进制编码
2. 拼音转换依赖外部库（pinyin），增加依赖
3. 英文 slug 要求用户用英文写标题，不现实
4. 选择：混合方案——ASCII 字符保留原样，CJK 字符编码为十六进制

**具体实现：**
```typescript
function titleToFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[一-鿿]+/g, (m) => '-' + Buffer.from(m).toString('hex') + '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    + '.md';
}
// "不使用 any 类型" → "any-e4b88de4bdbfe794a8-e7b1bbe59e8b.md"
```

**教训：**
即使是"小功能"——文件名生成——也需要考虑国际化。方案不完美（用户不能直接通过文件名看懂内容），但在终端兼容性和 git 友好性上是合理的折中。

**面试怎么讲：**
> "中文标题做文件名是个小但实际的问题。直接拿中文当文件名，终端可能乱码，git diff 也不好看。我用了折中方案——ASCII 字符保留，CJK 字符转十六进制编码。虽然文件名变成了一串 hex，但用户不需要直接看文件名的——他们通过索引和搜索找到需要的记忆。"

---

## 十四、如果面试官说"你这不是很简单吗"

**你的回答（态度 > 技术）：**

"简单是刻意为之。Agent 记忆系统可以做得极其复杂——向量数据库、语义去重、自动合成、知识图谱。但我选择从最简单的方案开始：文件系统 + grep 搜索 + 人工确认写入。

原因是个人 Agent 的记忆量不超过几百条，文件系统完全够用。当前的设计是可演进的：索引太慢 → 上 SQLite FTS，搜索太弱 → 上 embedding + 向量检索，手动太累 → 上自动提取。

**简单不是因为不会做复杂的，而是因为知道什么时候该做复杂的。** 这是我在这个项目里最重要的工程判断。"
