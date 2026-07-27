# Triple-pi

让 Coding Agent 记住你的项目习惯，并在提交前按项目规则检查代码变更。

基于 [Pi Agent Runtime](https://github.com/earendil-works/pi)，不修改 Runtime 源码。

[![CI](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## 干什么的

两个模块：

**Persistent Memory** — Agent 对话结束后自动提取项目规则、偏好、技术决策，下次打开同一项目自动加载。

**Reviewer SubAgent** — 在你提交代码之前，对照项目 Memory 里的规则检查 git diff。只读，不能改文件。

---

## 安装

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

Node.js `>=22.19.0`。

---

## 验证

```bash
npm run typecheck      # TypeScript 严格模式
npm test               # 178 条自动化测试
npm run eval:recorded   # 46 条全链路测试
npm run demo            # 离线 Demo
```

---

## 做了什么 Pi 现有插件没做的事

Pi 生态有 Memory 工具和 SubAgent 模板，但它们侧重"能不能跑通"。这个项目在意的是"跑出来的结果能不能信"。

**Memory：不只是 LLM 输出直接写盘**

```
对话结束
  → secret 脱敏
  → LLM 提取候选
  → strict validation（evidence 必须是用户原话逐字子串，不存在就拒绝）
  → Grounded Review（只允许 keep/remove，不允许改写）
  → consolidation（去重、替换、跳过）
  → 文件锁 + temp→rename 原子写入
```

| | 常见做法 | 这里做的 |
|---|---|---|
| 证据 | 信模型 | 必须是用户原话逐字子串，assistant 说的不算 |
| 项目隔离 | 不管，或靠 git remote | cwd 自动识别，monorepo 子目录天然分开 |
| 跨项目共享 | LLM 自己判断 | 自动提取仅当用户明确说"所有项目都"才 global，否则自动降级 project |
| 过期处理 | 一直在或直接删 | 30 天冷态提醒 → 90 天无损归档（改名，不删） |
| 写入失败 | 吞掉异常 | 分类到具体阶段，该重试的有限重试，不改重试的不反复付费 |

**Reviewer：不是 prompt 说"请只读"，是代码级保证**

| | 常见做法 | 这里做的 |
|---|---|---|
| 隔离方式 | prompt 请求只读 | 禁掉扩展/技能/上下文文件加载，只开放 read grep find ls |
| 验证没改文件 | 不验证 | 审查前后 worktree SHA-256 快照比对 |
| 输出处理 | 信它是 JSON | 区分格式错 vs 内容错；passed 必须零 findings；line 必须是正整数 |
| 超时保护 | 可能没有 | Promise.race 硬超时，迟到结果被丢弃 |
| diff 覆盖 | 有就行 | 分块审查，不静默截断；partial 时明确标注哪些文件没覆盖到 |

**评测：不是跑几遍截个图**

```
确定性测试 178 条  →  每次 push 自动跑，不依赖 LLM，零成本
Recorded 46 条     →  验证全链路管线接线正确
Live Eval (opt-in)  →  验证真实模型质量，显式配模型才运行
```

Live Eval 的退出码：provider 崩了 exit 2，语义不匹配 exit 1，全通过 exit 0。noise case（期望零记忆）不会因为 provider 崩了就"恰好零匹配 F1=1"。

---

## Memory 能力一览

- 自动提取：`agent_settled` 触发，后台异步，不阻塞对话
- 手动保存：用户确认后写盘，支持 project / global 两种作用域
- 跨 Session 召回：下次打开同一项目，自动注入记忆索引；需要正文时 SearchMemory
- 纠错更新：说"其实用 GraphQL，不是 REST"，会更新旧记忆，不会同时保留两条矛盾规则
- 生命周期：hot (≤30d) → cold (31-90d，下次打开询问) → archive (>90d，无损改名)
- 不可变审计：每次更新自动保存上一版本到 revisions 目录
- 工作状态：最近对话的 user request + assistant 报告，以不可信上下文注入（不进 system prompt）

## Reviewer 能力一览

- 自动采集：git staged + unstaged + untracked 全量获取
- 关键词检索：从 diff 和文件内容提取搜索词，按优先级排序后多路搜索 Memory
- 分块审查：按文件和 hunk 分块，不静默截断
- Partial coverage：diff 超过预算时明确标注哪些文件没审查
- 硬超时 + 安全清理：调用方在 deadline 后必返回，child session 被 abort + dispose
- 严格输出：passed 零 findings、issues_found 非空、description 非空、line 正整数

---

## 项目结构

```
extensions/
├── index.ts                  # 统一入口
├── memory/
│   ├── index.ts              # Extension 注册、工具、生命周期
│   ├── repository.ts         # 存储、原子写入、锁、搜索、revision
│   ├── domain.ts             # 数据模型
│   ├── project-identity.ts   # cwd → 稳定 project ID
│   ├── validation.ts         # 手动/自动共用校验规则
│   ├── working-state.ts      # 工作状态
│   └── extraction/           # 自动提取管线
│       ├── coordinator.ts    # 流程编排
│       ├── scheduler.ts      # branch-safe 异步调度
│       ├── provider.ts       # LLM 调用
│       ├── pipeline.ts       # secret 脱敏 + 严格校验
│       ├── review.ts         # grounded reviewer
│       ├── signals.ts        # fingerprint + reinforcement
│       ├── consolidation.ts  # 去重合并
│       └── source.ts         # 对话增量 + checkpoint
└── subagent/
    ├── index.ts              # Reviewer 工具注册
    ├── manager.ts            # Session 管理
    ├── review-core.ts        # git diff、检索、分块、解析
    └── types.ts              # 类型

eval/     # 评测（三层）
docs/     # 文档
test/     # 测试（21 文件 / 178 条）
scripts/  # 安装、诊断、Demo
```

---

## 局限

- 基于关键词子串匹配，没有语义/向量检索（当前规模够用；跨语言用 diff 符号补足）
- secret 检测用正则，不覆盖组织自定义密钥格式
- 单用户，没有多开发者共享

---

## 文档

| | |
|---|---|
| [Memory 设计](./docs/design/memory.md) | project identity、作用域、生命周期、提取管线 |
| [Reviewer 设计](./docs/design/reviewer.md) | 接线、diff 采集、检索、分块、隔离模型 |
| [评测体系](./docs/evaluation.md) | 三层验证、指标定义、如何复现 |
| [Demo runbook](./docs/demo.md) | 离线端到端验证 |
| [面试准备](./docs/interview.md) | 常见追问、STAR 故事、真实踩坑记录 |
| [历史日志](./docs/history/MEMORY_REBUILD.md) | 设计迭代记录 |

## License

MIT
