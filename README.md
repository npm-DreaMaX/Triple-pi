<div align="center">

# `Triple-pi`

*A Pi-based coding agent with persistent memory and project-aware code review.*

<p>
  <a href="https://github.com/npm-DreaMaX/Triple-pi/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/npm-DreaMaX/Triple-pi/ci.yml?branch=main&style=flat-square" alt="CI"></a>
  <a href="https://www.bilibili.com/video/BV1wA3w6uEuH/"><img src="https://img.shields.io/badge/📺_Bilibili-讲解视频-00A1D6?style=flat-square&logo=bilibili&logoColor=white" alt="Bilibili"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-≥22.19-brightgreen?style=flat-square" alt="Node"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

<p>
  <sub>
  🏗️ Built on <b><a href="https://github.com/earendil-works/pi">Pi</a></b>（GitHub 近 <b>8 万 star</b>）
  &nbsp;·&nbsp;
  📺 <b><a href="https://www.bilibili.com/video/BV1wA3w6uEuH/">B 站讲解</a></b>
  &nbsp;·&nbsp;
  📋 <b><a href="./docs/interview.md">面试指南</a></b>
  </sub>
</p>

---

<p>
  <kbd>🧠 Memory</kbd>&nbsp; Agent 聊完天自动提取记忆，下次打开自动加载，不用每次重讲项目规范
  <br>
  <kbd>🔍 Reviewer</kbd>&nbsp; 提交前对照项目规则检查代码，隔离审查，只读不写
  <br>
  <kbd>🧪 Evaluation</kbd>&nbsp; 178 确定性测试 + 46 全链路测试 + Live Eval，基础设施崩了绝不假装通过
</p>

</div>

---

## ⚡ Install

<table><tr><td>

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

</td><td>

Node.js `≥22.19`

Uses **Pi** as agent runtime

`trip` linked to `~/.local/bin/`

</td></tr></table>

| | Linux | macOS | Windows |
|---|---|---|---|
| **启动** | `trip` | `trip` | `trip.ps1` |
| **找不到** | `source ~/.zshrc` | `source ~/.zshrc` | 加 `bin\` 到 PATH |

---

## 🧠 Memory

> **两条路径，一个仓库。** 自动提取在对话结束后跑，手动保存让你精确控制。

| | 🔄 Automatic | ✋ Manual |
|---|---|---|
| **触发** | 对话结束 (`agent_settled`) | 调 `SaveMemory` |
| **流程** | 后台 6 步管线，全部过才写盘 | 弹确认框 → 确认后立写 |
| **场景** | 项目规范、技术决策、偏好 | 「记住这条」|

```
对话结束
  ┃ ❶ secret redaction    正则脱敏 · 10 种模式
  ┃ ❷ LLM extraction       调模型提取候选
  ┃ ❸ strict validation    evidence 必须是用户原话逐字子串
  ┃ ❹ grounded review      二次审核 · 只能 keep/remove · 禁止改写
  ┃ ❺ consolidation        按指纹去重 · 纠错信号触发 replace
  ┗ ❻ atomic write         进程锁 · temp → rename
```

> **🔒 Evidence grounding**：不是用户原话？整条拒掉。<br>
> **🌐 Scope guard**：模型标 `global` 但没说「所有项目」？降级 `project`。<br>
> **⏳ Lifecycle**：`≤30d` 热 → `31-90d` 冷（询问恢复）→ `>90d` 无损归档。<br>
> **📝 Revisions**：每次覆盖自动保存不可变快照。

---

## 🔍 Reviewer

> **提交之前，按你的规则检查代码。** 审查 Agent 只读——不是请求，是机制。

```
review_current_changes
  ┃ 📋 采集 staged + unstaged + untracked（git）
  ┃ 🔎 diff 提取搜索词 → 多路 OR 搜 Memory
  ┃ ✂️ 按文件/hunk 分块（不静默截断）
  ┃ 🛡️ 起独立只读 Session
  ┗ ✅ 严格 schema 校验 → 📸 快照比对
```

| | 🚫 常见做法 | ✅ Triple-pi |
|---|---|---|
| **隔离** | prompt 说「请只读」 | `ResourceLoader` 禁扩展/技能/上下文<br>工具白名单 `[read,grep,find,ls]` 由注册表强制 |
| **验证** | 不做 | 审查前后 git status + 文件 hash 快照 |
| **输出** | 赌它是 JSON | 解析失败 ≠ schema 失败 ≠ passed<br>`passed` ↔ 0 findings · line 正整数 · description 非空 |
| **Diff** | 整段扔 prompt | 按文件/hunk 分块 · 覆盖不到标 `partial` |

> **🛡️ 写工具压根没加载。** 审查后快照不一致 → `worktree-changed`，绝不假装没改文件。

---

## 🧪 Evaluation

> **不是跑几遍截个图。** 每层回答不同问题，崩溃绝不假装通过。

| | 规模 | 跑法 | 验证什么 |
|---|---|---|---|
| 🧩 **确定性** | 178 条 | 每次 push · 0 LLM | 解析、锁、校验、调度逻辑 |
| 🔗 **Recorded** | 46 条 | 每次 push · mock LLM | 全链路接线：提取→审核→合并→写入 |
| 🎯 **Live** | opt-in | 显式配模型 | 模型质量：精度、召回、噪声拒绝 |

```
🚨 exit 2 = 基础设施崩了  ❌ exit 1 = 语义不匹配  ✅ exit 0 = 全通过
```

<details>
<summary>📊 指标怎么算（点击展开）</summary>

- **TP** = 双向一对一匹配 expected
- **FP** = 多余记录 + forbidden 惩罚（最多计一次）
- **FN** = expected 未匹配
- Matched 但含 forbidden → 从 TP 降级
- Noise case（期望 0）→ `precision = null`，不计入宏平均

</details>

---

## 📁 Project

```
extensions/
├── memory/
│   ├── extraction/        6 步管线
│   ├── repository.ts      原子写入 · 进程锁 · 搜索 · revision
│   └── validation.ts      手动/自动共用校验
└── subagent/
    ├── review-core.ts      diff 采集 · 分块 · 解析
    └── manager.ts          session 隔离 · 超时 · 清理

eval/    三层评测   test/    178 条测试   docs/    设计+面试
```

---

> **⚠️ 局限** — 关键词匹配，无语义检索 &nbsp;·&nbsp; Secret 正则 10 种，不覆盖自定义 &nbsp;·&nbsp; 单用户 &nbsp;·&nbsp; `temp→rename` 原子可见，非 `fsync`

**📖** [Memory](./docs/design/memory.md) · [Reviewer](./docs/design/reviewer.md) · [评测](./docs/evaluation.md) · [面试](./docs/interview.md) · [Demo](./docs/demo.md)

<p align="center"><sub>MIT</sub></p>
</div>
