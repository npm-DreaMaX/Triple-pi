# Triple-pi

面向企业研发场景的 Coding Agent 跨会话记忆与代码审查系统。基于 [Pi Agent Runtime](https://github.com/earendil-works/pi) Extension API 构建，**不修改 Runtime 源码**。

[![CI](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## 为什么需要 Triple-pi

Coding Agent 每个 Session 都从零开始——你每次都要重新告诉它项目的技术栈、代码规范、之前做过什么决策。Agent 自己也累：上周刚讨论完”用 GraphQL 替代 REST”，这周又建议你用 fetch。

但直接把聊天记录塞进新 Session 会污染上下文。需要一套机制：**该记住的记住，该忘掉的忘掉，不确定的宁可不要**。

### Memory 到底帮你做了什么

不是”把聊天存成 Markdown”。是：

- **Agent 改好代码、对话结束后**，自动从对话中提取值得长期保留的内容——项目规则、技术决策、你的偏好。每条提取必须引用你原话作为依据，不会凭空捏造
- **下次打开同一个项目**，Agent 自动知道”这个项目用 pino 记日志、禁止 any 类型、事务必须有 timeout”
- **你说”其实用 GraphQL，不是 REST”**，它会更新旧记忆，而不是同时保留两条矛盾的规则
- **超过 30 天没碰的项目**，下次打开时会问一句”要恢复这个项目的记忆吗？”，而不是把过时的上下文悄悄塞进来
- **不同项目的记忆完全隔离**——前端项目和后端项目不会互相污染

### Reviewer 到底帮你做了什么

不是”让 AI 看一遍代码”。是：

- **在你提交之前**，把 git diff 和你这个项目的规则一起交给一个**独立只读的审查 Agent**
- 审查 Agent 不能改任何文件——真的不能，不是 prompt 里说”请只读”，而是代码级禁掉了写工具
- **它对照你的项目规则检查**：参数有没有用 any？事务有没有设 timeout？不是做通用 lint
- 审查完告诉你：哪些文件有问题、什么等级、为什么违规

### 跟 Pi Runtime 已有的 Memory/SubAgent 插件区别在哪

Pi 生态里确实有 Memory 工具和 SubAgent 模板，但它们解决的是”能不能跑通”。Triple-pi 解决的是”能不能在生产环境里用”。

| 关注点 | 典型插件做法 | Triple-pi |
|---|---|---|
| 记忆提取 | LLM 输出直接写盘 | 6 步管线，每一步失败都终止写入 |
| 证据 | 信任模型不编 | Evidence 必须是你的原话逐字子串，不存在就整条拒绝 |
| 错误 | try-catch 吞掉 | 分类到具体阶段（provider/解析/schema/写盘），该重试的重试，不该重试的不反复付费 |
| 项目隔离 | 靠 git remote，或不隔离 | cwd 自动识别；monorepo 子目录天然分开；也支持 `.triple-pi/project.json` 手动绑定 |
| 作用域 | 模型说 global 就 global | 自动提取只有你真的说了”所有项目都……”才允许 global，否则自动降级 project，不弹窗 |
| 过期处理 | 一直在，或过期直接删 | 30 天冷态提醒、90 天无损归档（改名不删除）、拒绝恢复后 global 偏好依然生效 |
| Reviewer 只读 | prompt 里写”请不要修改文件” | 代码级禁掉扩展/技能/上下文文件加载，只开放 4 个读工具，审查前后做 worktree 快照比对 |
| Reviewer 输出 | 祈祷是 JSON | 严格区分”JSON 格式错了”和”JSON 合法但内容不对”，passed 必须零 findings，line 必须是正整数 |
| 评测 | 跑一遍截个图 | 178 测试 + 46 条 recorded eval + opt-in live eval；基础设施崩了 exit 2、结果不对 exit 1，noise case 不混进统计 |

---

## 模块

### Persistent Memory

```
对话结束 (agent_settled)
  → secret redaction（正则脱敏）
  → LLM 提取候选记忆
  → strict validation（evidence 逐字校验，不能编证据）
  → Grounded Review（keep/remove，不能改写）
  → deterministic consolidation（去重、替换、跳过）
  → 事务性写入（文件锁 + temp → rename 原子写入）

新 Session 启动 (before_agent_start)
  → 注入项目 Memory 索引到 system prompt
  → 模型按需 SearchMemory 获取完整正文
```

- **手动保存**：用户确认后立即写盘
- **自动提取**：`agent_settled` 触发，异步执行不阻塞对话
- **Evidence Grounding**：每条自动记忆必须有 user message 的逐字子串作为证据
- **Precision over Recall**：宁可漏存（下次重试），不能存错（跨 Session 污染）
- **30/90 天生命周期**：hot (≤30d) → cold (31-90d，下次启动询问) → archive (>90d，无损归档)

### Reviewer SubAgent

```
review_current_changes
  → git diff + staged + untracked 全量采集
  → 从 diff 和文件内容提取关键词
  → 检索项目 Memory（OR 搜索 + 排序）
  → 创建隔离只读 SubAgent Session
  → 分块审查（不静默截断）
  → 结构化 JSON 输出（严格 schema 校验）
  → worktree snapshot 验证文件未修改
```

- **代码级只读隔离**：工具白名单 `[read, grep, find, ls]`，禁用所有扩展/技能/上下文文件
- **硬超时**：`Promise.race` 保证调用方在 deadline 后必返回
- **Fail-closed**：解析失败明确报错，绝不显示"未发现问题"

---

## 架构

```
Pi Agent Runtime
  │
  ├── Memory Extension
  │   ├── SaveMemory / SearchMemory tools
  │   ├── agent_settled → 自动提取管线
  │   │   secret redaction → LLM extraction →
  │   │   strict validation (evidence 逐字校验) →
  │   │   Grounded Review (keep/remove only) →
  │   │   deterministic consolidation
  │   ├── before_agent_start → 记忆注入
  │   └── 生命周期: hot(30d) / cold(90d) / archive
  │
  └── Reviewer Extension
      ├── delegate_review — 手动传入审查参数
      └── review_current_changes — 自动 git diff + Memory 检索
          ├── createAgentSession (独立 in-memory session)
          ├── tools: [read, grep, find, ls] (代码级白名单)
          ├── 分块审查 + 超时保护
          └── 严格结构化输出 + worktree 未修改验证
```

---

## 快速开始

```bash
# 克隆（含子模块）
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi

# 安装（构建 Pi Runtime + 安装依赖 + 安装扩展）
npm run setup

# 验证
npm run typecheck    # TypeScript 类型检查
npm test             # 178 自动化测试
npm run demo         # 离线端到端 Demo（修改代码 → 自动审查）
```

要求 Node.js `>=22.19.0`。

---

## 怎么知道它真的有用——不是能跑就行

写 Agent 最大的坑不是跑不通，是”跑通了但行为不对”。比如 provider 崩了返回空结果，看起来”噪声被正确拒绝了”，实际上什么都没做。

Triple-pi 的评测分三层，各自回答不同问题：

| 层级 | 规模 | 依赖 LLM | 验证什么 |
|---|---|---|---|
| 确定性测试 | 178 条 | ❌ | 代码逻辑正确——category 校验、evidence 比对、并发写入、scheduler 调度、parser 边界…… |
| Recorded Eval | 46 条 | ❌ (mock) | 全链路接线正确——extraction → review → consolidation → commit 整条管线没断 |
| Live Eval | opt-in | ✅ | 真实模型表现——噪声误提取率、分类稳定性、跨项目泄漏、格式可靠性 |

```
确定性测试   → 每次 push 自动跑，0 网络 0 成本
Recorded     → 改完代码确认”没断线”
Live Eval    → 换模型时评估”这个模型能用吗”，人工触发
```

**Live Eval 不会骗你**：provider 崩了 exit 2，模型输出不如预期 exit 1，全部通过 exit 0。期望零记忆的 noise case 不会因为 empty + empty = “F1=1”而假装通过。

```bash
npm run typecheck       # TypeScript 严格模式
npm test                # 确定性测试 (178)
npm run eval:recorded   # Recorded 全链路 (46)
npm run demo            # 离线端到端 Demo
```



---

## 存储

```
~/.triple-pi/memory-v1/
├── global/entries/              ← 跨项目共享
├── projects/<id>/entries/       ← 项目隔离（按 cwd 或 .triple-pi/project.json）
├── projects/<id>/working/       ← 临时工作状态
├── projects/<id>/revisions/     ← 不可变 audit log
├── archive/                     ← 无损归档
├── extractions/                 ← 幂等 manifest
└── signals/                     ← reinforcement
```

## 关键设计决策

- **Evidence grounding**：自动提取的 evidence 必须是 user message 逐字子串，LLM 不能编证据
- **Precision over Recall**：宁可漏存（下次可重试），不能存错（跨 session 污染）
- **CWD isolation**：项目身份由工作目录决定，不依赖 git remote（避免 monorepo 污染）
- **Project alias**：通过 `.triple-pi/project.json` 声明稳定 ID，同一仓库不同 clone 路径共享 Memory
- **Fail-closed**：无 UI 拒绝写入、malformed 输出整批拒绝、归档项目拒绝写入
- **Reviewer 工具白名单**：代码级 `tools: ["read","grep","find","ls"]`，不是 prompt 约束

## 已知限制

- 搜索基于关键词子串匹配，无向量语义检索（当前规模下够用，跨语言命中依赖 diff 符号提取）
- 知识类记忆（knowledge category）在不同模型上分类不稳定
- Secret redaction 基于正则，不覆盖组织自定义密钥格式
- Temp + rename 提供可见性原子性，不保证断电持久化

## Roadmap

- [x] 跨 Session Memory 自动提取与召回
- [x] Evidence Grounding + 严格 schema validation
- [x] 30/90 天生命周期管理
- [x] 分支感知的增量提取 (branch-safe scheduler)
- [x] 不可变 revision 历史 audit
- [x] 隔离只读 Reviewer SubAgent
- [x] 统一扩展安装链 (Memory + Reviewer 共享 repository)
- [x] 项目 alias（不同 clone 路径共享 Memory）
- [ ] FTS / embedding 语义搜索
- [ ] 多模型 Live Eval 对比报告
- [ ] 多开发者共享记忆

## 贡献

欢迎提交 Issue 和 Pull Request。

- 代码风格：参考 `pi-runtime/AGENTS.md` 和项目现有代码
- 测试：新功能需要包含确定性测试
- 提交：使用 conventional commits 格式

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design/memory.md](./docs/design/memory.md) | Memory 设计摘要 |
| [docs/design/reviewer.md](./docs/design/reviewer.md) | Reviewer 设计摘要 |
| [docs/evaluation.md](./docs/evaluation.md) | 三层验证体系、指标定义、证据复现 |
| [docs/demo.md](./docs/demo.md) | 端到端验证 runbook |
| [docs/interview.md](./docs/interview.md) | 面试准备 |
| [docs/history/MEMORY_REBUILD.md](./docs/history/MEMORY_REBUILD.md) | 历史设计日志 |

## Contributors

Fang Wang

## License

MIT
