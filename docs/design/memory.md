# Memory 设计摘要

## Project Identity

项目身份由 SHA-256(realpath(cwd)) 取前 20 hex 字符确定。Display name 使用 basename，与 stable ID 分离。不依赖 git remote（避免 monorepo 污染），不使用模块级单值 cache（session 切换不沿用旧项目）。

## 作用域

| 范围 | 存储位置 | 可见性 |
|---|---|---|
| project | `projects/<id>/entries/` | 仅当前 cwd 项目 |
| global | `global/entries/` | 所有项目 |

默认 project scope。Global 必须通过显式的 `scope: "global"` 指定。

## 生命周期

| 状态 | 触发条件 | 行为 |
|---|---|---|
| hot | 上次活跃 <30 天 | 正常注入 prompt，刷新 lastActiveAt |
| cold | 30-90 天 | session_start 询问用户是否恢复；拒绝则不注入 project 记忆 |
| archived | >90 天 | 同文件系统 rename 到 archive/，不注入不搜索；可显式恢复 |

Activity 由 session_start 记录（不是 memory write）。Global 记忆生命周期独立，不冻结。

## 存储

```
~/.triple-pi/memory-v1/
  global/entries/<category>/<record-id>.md
  projects/<id>/entries/<category>/<record-id>.md
  projects/<id>/MEMORY.md (派生索引, 可重建)
  archive/projects/<id>/ (无损归档)
  extractions/<project-id>/ (幂等 manifest)
  signals/<project-id>/ (reinforcement)
```

单条 entry（Markdown + JSON header）是权威数据。MEMORY.md 是派生索引，可遍历 entries 重建。

## 提取管线

```
agent_settled
  -> buildExtractionSource (incremental delta from checkpoint)
  -> secret redaction (10 种正则模式)
  -> LLM extraction (复用 Pi ModelRegistry)
  -> strict validation (schema, evidence 逐字校验, secret 二次检测)
  -> Grounded Review (LLM 二次调用, 只能 keep/remove)
  -> signal scoring (fingerprint, correction, reinforcement)
  -> consolidation (分层去重: exact title > fingerprint > Jaccard>=0.72)
  -> transactional commit (写锁内 atomic write entry + manifest + index)
```

每步失败 fail-closed：不写 checkpoint，下次 agent_settled 重试。

## Working State

Scratchpad 和 Daily 从对话确定性生成（不调 LLM）。与长期记忆物理隔离（不同目录），prompt 标注为 temporary context。

## Scheduler

`agent_settled` 创建不可变 snapshot（cwd, sessionId, branch, model），后台任务使用 snapshot 而非可变 ctx。支持 branch-local checkpoint，切换 branch 自动恢复进度。

## 失败恢复

- 单文件破坏：try-catch 跳过，不阻断全部
- 写入崩溃：temp+rename 保证单文件可见性原子性；批量写入用备份恢复（补偿事务）
- Manifest 最后写入：保证 entry 全部成功后标记幂等，防止重做
