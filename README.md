# Triple-pi

Coding Agent 扩展系统，基于 [Pi Agent Runtime](https://github.com/earendil-works/pi)。

**不修改 Pi Runtime 源码。** 通过 Pi Extension lifecycle、SDK Agent Session、tool system 和 ModelRegistry 接入。

两个模块：

- **Persistent Memory** — 跨 Session 项目记忆，可信保存项目规则、偏好、决策
- **Reviewer SubAgent** — 独立只读代码审查，自动 git diff + Memory 检索

## 运行状态

| 指标 | 值 |
|---|---|
| 确定性测试 | 21 文件 / 152 测试 |
| Recorded Eval | 10 cases / 全通过 |
| Live Eval | deepseek-v4-flash × 3 runs × 10 cases |
| typecheck | 通过 |

### Live Eval 结果

| 条件 | 值 |
|---|---|
| 模型 | deepseek/deepseek-v4-flash |
| Cases | 10 |
| Runs per case | 3 |
| 总观测数 | 30 |
| Commit | 3498dbd |

| 指标 | 值 |
|---|---|
| Mean F1 | 0.73 |
| Worst F1 | 0.0（knowledge/mixed-noise） |
| Best F1 | 1.0（6/10 cases） |
| Mean Precision | 0.73 |
| Mean Recall | 0.74 |
| Pipeline Success Rate | 100%（30/30 提取完成） |
| False Positive Rate | 27% |
| Avg Latency | 2,533ms |
| P95 Latency | 3,962ms |

**稳定通过**（3/3 全对）：project-rule、correction、noise-only、implicit-convention、code-constraint

**不稳定**：knowledge（category 归类为 fact 而非 knowledge）、mixed-noise（噪声误提取为规则）、chinese-convention（category 归类不一致）、multi-rule（部分规则遗漏）

> 这是 Pilot Eval，10 cases × 3 runs 是小规模统计，不能宣称生产级准确率。knowledge 和 mixed-noise 的失败反映了 DeepSeek V4 Flash 在细粒度分类和噪声过滤上的边界。

## 架构

```
Pi Agent Runtime
    │
    ├── Memory Extension
    │   ├── SaveMemory / SearchMemory tools
    │   ├── agent_settled → 自动提取管线
    │   │   ├── secret redaction
    │   │   ├── LLM extraction
    │   │   ├── strict validation (evidence 逐字校验)
    │   │   ├── Grounded Review (keep/remove only)
    │   │   └── deterministic consolidation
    │   ├── before_agent_start → 记忆注入
    │   └── 生命周期: hot(30d) / cold(90d) / archive
    │
    └── SubAgent Extension
        ├── delegate_review — 手动审查
        └── review_current_changes — 自动 git diff + Memory 检索 → Reviewer
            ├── createAgentSession (独立 in-memory session)
            ├── tools: [read, grep, find, ls] (只读白名单)
            ├── Promise.race 硬超时
            └── 结构化 ReviewResult
```

## 安装

```bash
git clone --recurse-submodules https://github.com/npm-DreaMaX/Triple-pi.git
cd Triple-pi
npm run setup
```

要求 Node.js `>=22.19.0`。

## 测试

```bash
npm run typecheck    # 类型检查
npm test             # 152 确定性测试
npm run eval:recorded # 10 recorded case
```

Live Eval（opt-in，需 API key）：

```bash
TRIPLE_PI_EVAL_MODEL=deepseek/deepseek-v4-flash TRIPLE_PI_EVAL_RUNS=5 npm run eval:live
```

## 存储

```
~/.triple-pi/memory-v1/
├── global/entries/          ← 跨项目共享
├── projects/<id>/entries/   ← 项目隔离
├── projects/<id>/working/   ← Scratchpad
├── projects/<id>/daily/     ← 按日时间线
├── archive/                 ← 无损归档
├── extractions/             ← 幂等 manifest
└── signals/                 ← reinforcement
```

## 关键设计决策

- **Evidence grounding**: 自动提取的 evidence 必须是 user message 逐字子串，LLM 不能编证据
- **Fail-closed**: 无 UI 拒绝写入，malformed 输出整批拒绝，归档项目拒绝写入
- **Precision over Recall**: 宁可漏存（下次可重试），不能存错（跨 session 污染）
- **CWD isolation**: 不同项目目录独立隔离，不用 git remote（避免 monorepo 污染）
- **原子写入**: temp + rename 保证文件级原子可见性
- **Reviewer 工具白名单**: 代码级 `tools: ["read","grep","find","ls"]`，不是 prompt 约束

## 当前限制

- 知识类记忆（knowledge category）在不同模型上分类不一致
- 噪声过滤依赖 reviewer 质量，长对话中可能误提取
- 没有向量检索（当前规模下子字符串搜索够用）
- Secret redaction 基于正则，不覆盖组织自定义格式
- 缺少多开发者共享和企业级 soak test

## 文档

- [INTERVIEW_MEMORY.md](./INTERVIEW_MEMORY.md) — 面试完整指南（基础概念、架构、QA、回答模板）
- [INTERVIEW_EVAL.md](./INTERVIEW_EVAL.md) — Eval 面试指南
- [MEMORY_REBUILD.md](./MEMORY_REBUILD.md) — 设计决策和验收记录

## License

MIT
