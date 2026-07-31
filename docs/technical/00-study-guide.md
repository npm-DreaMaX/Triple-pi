# Triple-pi 纯技术教材（上卷）学习指南

> 本卷讨论当前仓库可验证的架构，以及已经进入 Memory Rebuild 设计并由现有实现、测试或设计摘要支撑的修复协议。它不是产品介绍，也不把历史文档中的旧路径当成当前事实。

## 0. 如何阅读本卷

这五章不是按文件名罗列代码，而是按正确性依赖排序：

```text
系统边界
   │ 先回答：谁拥有 Agent Loop、session tree、模型与 UI？
   ▼
持久记忆引擎
   │ 再回答：什么数据值得跨 session 保存？如何建立证据链？
   ▼
存储、事务与恢复
   │ 再回答：一次写入何时算成功？崩溃后如何判定真相？
   ▼
并发与分支安全
      最后回答：多 writer、异步任务、branch/worktree 切换如何不串线？
```

推荐顺序：

1. `01-system-boundaries-and-runtime.md`：先建立 Pi 上游与 Triple-pi 的责任边界。
2. `02-persistent-memory-engine.md`：沿一次 `agent_settled` 追踪长期记忆形成过程。
3. `03-storage-transactions-and-recovery.md`：把“原子文件”“补偿事务”“发布点”分开理解。
4. `04-concurrency-and-branch-safety.md`：用 happens-before、代际 fencing 与 branch-local checkpoint 证明安全性。

## 1. 文档中的事实等级

本卷使用四种标记。后续代码修复完成后，主会话应优先校正标为“校正点”的路径和符号。

| 标记 | 含义 | 判定依据 |
|---|---|---|
| **[现状]** | 当前 `main` 源码直接体现 | TypeScript、脚本、测试 |
| **[目标协议]** | 已批准的重建设计或设计摘要 | `docs/design/memory.md`、Memory Rebuild 的 Block 设计 |
| **[历史]** | 解释为什么改变，不表示当前行为 | `docs/history/MEMORY_REBUILD.md`、提交历史 |
| **[校正点]** | 后续修复可能改路径、类型或细节 | 目标语义应保留，但源码定位要复核 |

必须避免两种混淆：

```text
“设计写了”  ≠ “当前代码已完全实现”
“测试覆盖了” ≠ “所有崩溃模型下均已证明”
```

## 2. 上游与原创边界速查

### 2.1 Pi 上游提供的机制

Pi 是运行时与宿主。Triple-pi 依赖而不重新实现以下能力：

- Agent Loop、工具调用循环、消息与模型交互；
- Extension API：工具、命令和 lifecycle hook 注册；
- `ExtensionContext` 中的 `cwd`、`model`、`modelRegistry`、`sessionManager`、`ui`；
- append-only session tree、当前 branch 与 leaf；
- `session_start`、`before_agent_start`、`agent_settled`、`session_tree`、`session_shutdown` 等时机；
- provider 认证、请求头、base URL、自定义 provider 与模型兼容层。

在代码中看到 `pi.on(...)`、`pi.registerTool(...)`、`ctx.sessionManager`、`ctx.modelRegistry` 时，应把它们看作**调用上游能力**，不能宣称为 Triple-pi 自研 runtime。

### 2.2 Triple-pi 原创的机制

Triple-pi 在宿主之上定义领域协议：

- project/global 记忆作用域与项目身份算法；
- 长期 Memory 的 record schema、evidence、provenance、revision；
- `SaveMemory`、`SearchMemory` 的用户语义和安全门；
- branch-aware 提取源、secret redaction、严格候选校验；
- Grounded Review 的 keep/remove 限制；
- reinforcement、fingerprint、确定性 consolidation；
- 本地文件 repository、派生索引、manifest、补偿回滚；
- hot/cold/archived 生命周期；
- Scratchpad/Daily 与长期记忆的物理隔离；
- `ExtractionScheduler` 的 snapshot、pending、AbortSignal 与 generation fencing；
- Reviewer 子代理的产品协议（本卷只在系统边界章说明，不深入其算法）。

### 2.3 边界图

```text
┌──────────────────────────── Pi upstream ────────────────────────────┐
│ CLI/TUI  Agent Loop  ModelRegistry  Provider/Auth  Session Tree     │
│    │         │            │                │             │           │
│    └──────── Extension API / ExtensionContext / lifecycle ─────────┘
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 稳定扩展面
┌───────────────────────────────▼──────────────────────────────────────┐
│ Triple-pi unified extension                                         │
│  ├─ Memory: scope, extraction, repository, lifecycle, working state │
│  └─ Reviewer: isolated review orchestration and policy checks       │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                  ~/.triple-pi/memory-v1/ + session custom entries
```

## 3. 全卷核心对象

### 3.1 身份对象

```text
ProjectIdentity = {
  id,             // 稳定存储 key
  cwd,            // canonical real path
  displayName,    // 仅供人读
  aliased,        // 是否来自显式 alias
  aliasPath?
}
```

不要把 `displayName` 当 key，也不要把 Git branch 当项目身份。branch 是一个项目内的对话历史分叉；worktree 是不同 canonical cwd，默认形成不同项目作用域。

### 3.2 长期记录

```text
MemoryRecord
├─ schemaVersion, id
├─ category, scope, projectId
├─ title, content
├─ createdAt, updatedAt
└─ provenance
   ├─ source: manual | extraction
   ├─ sessionId, sourceEntryIds, sourceHash
   ├─ fingerprint, score, reinforcement, correction
   ├─ evidence[]
   ├─ scopeDecision
   └─ revision
```

长期记录的正确性不只在 `content`，还在“为什么可以相信”和“来自哪里”。

### 3.3 三种进度标记

| 标记 | 所属空间 | 用途 |
|---|---|---|
| extraction checkpoint | Pi session branch | 该 branch 已处理到哪个 entry |
| extraction manifest | repository / project | 某个 `sourceHash` 是否已经持久提交 |
| working checkpoint/manifest | branch + repository | Scratchpad/Daily 的增量和重放幂等 |

它们不能合并成一个全局 offset：branch 进度与磁盘提交事实是不同维度。

## 4. 全卷不变量清单

学习时应不断回到这些不变量，而不是记函数名。

### I-1 项目隔离

```text
project record 可见(project A) ⇒ currentProject.id = A
```

Global 例外必须是显式作用域决策，自动提取还要求跨项目 evidence。

### I-2 权威数据唯一

```text
entries/**/*.md 是长期记忆真相
MEMORY.md 是可删除、可重建的派生视图
```

索引损坏不应造成权威 entry 丢失，也不应把已成功 entry 谎报为失败。

### I-3 Grounding

```text
被自动写入的结论
⇒ evidence 属于指定 user entry 的逐字子串
⇒ evidence/title/content 均通过 secret 检测
⇒ reviewer 不得改写候选
```

### I-4 Fail-closed checkpoint

```text
append extraction checkpoint
⇒ provider 成功
∧ strict validation 成功
∧ review 成功
∧ repository batch 已发布 manifest
```

失败时宁可重试，不得跳过尚未可靠提交的输入。

### I-5 单文件可见性原子

任一读者只应看到旧完整文件或新完整文件，不能看到半个 JSON header 或截断 Markdown。

### I-6 Writer 串行化

所有可能改变 repository 事实的操作必须在同一个跨进程写锁下排序：save、batch、reinforcement 增量、archive/restore、metadata 和 index rebuild。

### I-7 Branch fencing

旧 branch 或旧 runtime generation 的异步任务可以停止，也可能晚返回，但不得向新 branch 追加 checkpoint。

### I-8 生命周期写保护

Cold/archived project 不允许通过手动保存、自动提取或 working-state 写入绕过用户恢复决策；global 生命周期独立。

### I-9 临时状态不晋升

Working State 是 derived、temporary、untrusted。它不能自动进入长期 entries，也不能混入长期搜索范围。

## 5. 源码导读方法

### 5.1 从入口向内

```text
bin/trip
  → pi-runtime/pi-test.sh                         [Pi 启动]
  → Pi extension loader                          [Pi 上游]
  → extensions/index.ts                          [统一注册]
      ├─ registerMemoryExtension
      └─ registerSubagentExtension
```

随后选择两条主链：

```text
读路径：before_agent_start → buildPrompt/loadWorkingState → 模型请求
写路径：agent_settled → snapshot → scheduler → runExtraction → repository
```

### 5.2 从不变量反查测试

- 项目隔离、并发 writer、损坏 entry：`test/memory/repository.test.ts`
- branch delta/checkpoint：`test/memory/extraction-source.test.ts`
- provider/validation 失败不 checkpoint：`test/memory/extraction-coordinator.test.ts`
- hot/cold/archive：`test/memory/lifecycle.test.ts`、`extension-lifecycle.integration.test.ts`
- Working State 幂等：`test/memory/working-state.test.ts`

测试是可执行规格，但要注意测试只证明它建模的故障。没有故障注入的 `fsync`/断电测试，就不能从 temp+rename 推出物理掉电持久性。

## 6. 常见错误学习法

### 错误一：逐文件背诵

问题：知道 `repository.ts` 很长，却说不清 commit point。正确方法是画一笔事务的写序列和失败点。

### 错误二：把 lock 当万能原子性

锁只建立 writer 间互斥；它不能自动提供断电持久性、跨文件 all-or-nothing，也不能阻止不遵守锁协议的外部进程。

### 错误三：把 hash 当语义理解

`sourceHash` 提供内容寻址幂等，fingerprint 提供规范化近似身份；它们都不能证明内容是真的。真实性来自 user evidence 与 review 限制。

### 错误四：把 `AbortSignal` 当回滚

abort 是协作式取消。检查 signal 之前已经完成的 I/O 不会自动撤销；事务层仍要负责备份、回滚和发布顺序。

### 错误五：混淆 branch 与 worktree

- branch：Pi session tree 内的对话路径；
- git branch：版本控制引用；
- worktree：具有独立 canonical cwd 的工作目录。

Triple-pi 的 branch-local checkpoint 指 Pi session branch；project identity 默认按 cwd，因此不同 git worktree 通常是不同 project ID。

## 7. 练习路线

### 基础练习

1. 从 `before_agent_start` 画出长期记忆和 Working State 的注入差异。
2. 给定两个 cwd（真实目录和指向它的 symlink），计算它们是否应同 ID。
3. 说明为什么合法 `[]` 可以推进 checkpoint，而 malformed JSON 不可以。

### 进阶练习

1. 构造两个并发 writer 对 reinforcement 做 `+1`，解释锁外 read-modify-write 如何丢更新。
2. 构造 branch A 提取在途、用户切到 branch B 的时序，找出 generation 检查的位置。
3. 枚举 batch 在每个 atomicWrite 后崩溃时，manifest、entry、reinforcement 的可观察组合。

### 高阶练习

1. 设计基于 WAL 的替代 repository，并比较复杂度、恢复时间、审计性。
2. 证明“manifest 最后写”提供的是发布协议，而不是完整数据库事务。
3. 为 read/archive 竞争定义线性化点；判断“前后检查并重试一次”是否足以保证线性一致。

## 8. 面试总追问

1. **为什么不直接把全部对话 JSONL 每次注入？**
   - 追问：上下文预算、隐私、branch 污染、陈旧状态分别如何处理？
2. **为什么不只使用向量数据库？**
   - 追问：向量召回解决了哪一层问题，又没解决 grounding、事务和生命周期中的哪些问题？
3. **如何定义一次自动提取成功？**
   - 追问：模型返回、entry 写完、manifest 发布、checkpoint append，哪个是哪个系统的 commit point？
4. **如何证明不会串 branch？**
   - 追问：仅有 AbortSignal 是否足够？晚到结果如何 fencing？
5. **为什么 archive 是 rename 而不是 delete？**
   - 追问：跨文件系统 rename 会怎样？metadata 与目录位置不一致怎样恢复？
6. **为什么读不持有写锁？**
   - 追问：它换来了什么吞吐，又放弃了何种跨文件快照保证？
7. **当前补偿事务的上限是什么？**
   - 追问：进程崩溃发生在 rollback 之前怎么办？是否需要 WAL/fsync？

## 9. 后续路径校正清单

代码修好后，主会话应逐项复核：

- `extensions/memory/repository.ts` 是否拆分为 storage/transaction/recovery 子模块；
- `ExtractionScheduler` 是否仍位于 `extensions/memory/extraction/scheduler.ts`；
- checkpoint custom type 与字段版本是否变化；
- project alias 文件是否仍为 `.triple-pi/project.json`；
- record schema version、revision 指针和 manifest 路径是否变化；
- 当前 read/archive 一致性是否已从“前后检查重试”升级为共享锁或快照；
- batch metadata 备份时序与 rollback 是否已修正；
- Pi submodule 的启动脚本和 Extension API 导入路径是否变化。

本卷后续章节会尽量引用稳定的概念名；具体行号不作为长期接口。
