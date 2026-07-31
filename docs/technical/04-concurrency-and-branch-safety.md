# 第四章：并发与分支安全

## 1. Triple-pi 面对的不是一种并发

至少存在四个并发平面：

```text
进程内异步：agent_settled 连续触发，旧 Promise 尚未完成
运行时切换：session tree/branch/reload/shutdown 改变上下文
跨进程并发：多个 Pi 进程共享 ~/.triple-pi/memory-v1
外部并发：用户、编辑器、备份软件直接读改本地文件
```

此外有三个“分支”概念，必须拆开：

| 概念 | 定义 | Triple-pi 中的作用 |
|---|---|---|
| Pi session branch | append-only session tree 的当前根到 leaf 路径 | extraction/working checkpoint 的局部进度 |
| Git branch | Git ref 指向的提交历史 | 可能改变仓库内容，但不是 Memory checkpoint key |
| Git worktree | 独立工作目录与 canonical cwd | 默认形成不同 project identity |

把它们混成一个 `branch` 字符串，是串线问题的根源之一。

## 2. 正确性目标

### 2.1 Safety

系统绝不能发生：

- branch A 的废弃对话被当作 branch B 新证据；
- 旧 generation 的任务向新 branch 追加 checkpoint；
- project/worktree A 的记忆出现在 B；
- 两个 writer 丢 entry 或 reinforcement 增量；
- archive 后旧 active 路径仍被写；
- checkpoint 前移但 repository 没有可靠提交。

### 2.2 Liveness

系统还应最终做到：

- settled 期间来的新 settled 不被永久吞掉；
- provider/storage 临时失败后可重试；
- branch 切换后新 branch 能继续提取；
- shutdown 不无限阻塞；
- stale lock 最终可恢复。

Safety 通常优先于 liveness：不确定时 fail closed，不 checkpoint；但若 scheduler 永远不处理 pending，也不是可用系统。

## 3. 为什么 cron/latest-file 不具 branch safety

反例：

```text
Session tree:
root ─ u1 ─ a1 ─ u2 ─ a2       branch A（后来废弃）
               └ u2' ─ a2'      branch B（当前）

filesystem mtime: A.jsonl 比 B 的 leaf 更新
cron 选择“最新文件” → 提取 u2/a2 → 写入废弃决策
```

mtime 不能表达 tree ancestry。正确输入必须来自 Pi：

```text
snapshot.branch = ctx.sessionManager.getBranch()
snapshot.branchLeafId = ctx.sessionManager.getLeafId()
```

## 4. Branch-local checkpoint

### 4.1 数据结构

长期提取 checkpoint：

```text
{
  version,
  sourceHash,
  lastEntryId,
  branchLeafId,
  savedCount
}
```

它作为 `customType = triple-pi-memory-checkpoint` 追加到 session tree，不进入长期 Memory entries。

### 4.2 为什么天然 branch-local

在当前 branch 末尾向前扫描最后一个 checkpoint：

```text
root
 ├─ ... cp(A1) ... cp(A2)       current A → 找 cp(A2)
 └─ ... cp(B1)                  current B → 找 cp(B1)
```

切换 branch 后，`getBranch()` 只包含目标 branch 的祖先，另一分支 checkpoint 不在路径中。这样进度随 tree 继承，而不是所有 branch 共用全局 offset。

### 4.3 Checkpoint 推进条件

```text
appendCheckpoint(cp)
only if:
  repository batch returned success/no-op
  ∧ scheduler generation unchanged
  ∧ job session identity still valid
  ∧ job branch identity still valid
  ∧ AbortSignal not aborted
```

Provider failure、malformed output、review rewrite、storage error均不推进。合法 `[]` 可以推进，因为“无候选”也是已成功处理的结果。

## 5. 不可变 ExtractionSnapshot

### 5.1 捕获内容

在 `agent_settled` 同步捕获：

```text
ExtractionSnapshot
├─ cwd
├─ sessionId
├─ branch[]
├─ branchLeafId
├─ lastProcessedEntryId
├─ model
└─ modelRegistry
```

`branch[]` 应视为防御性快照；若宿主返回可变引用，需复制必要字段。后台任务只能消费 snapshot。

### 5.2 为什么不能闭包持有 ctx

时序反例：

```text
t0 branch A settled，启动 async extraction，闭包引用 ctx
t1 用户切 branch B / new session / extension reload
t2 async 在 await 后继续，读取 ctx.sessionManager.getBranch()
t3 得到 B，却把 A 的 provider 结果与 B 的 leaf 组合
```

snapshot 将身份绑定在 t0。即使任务晚返回，也只代表 A 的结果，随后由 generation fence 决定是否还能发布 checkpoint。

## 6. Scheduler 状态机

### 6.1 当前抽象

`ExtractionScheduler` 维护：

```text
task?: Promise<void>
abort?: AbortController
generation: number
pending?: ExtractionSnapshot
currentJob?: { generation, sessionId, branchLeafId, snapshot }
```

单个 scheduler 同时最多一个 in-flight task，并保留一个 latest pending snapshot。

### 6.2 状态机

```text
                 start(S1)
[IDLE] ─────────────────────────> [RUNNING S1, gen=g]
  ▲                                      │
  │ finally, no pending                  │ start(S2)
  └──────────────────────────────────────┤
                                         ▼
                              [RUNNING S1 + PENDING S2]
                                         │
                                         │ S1 finally
                                         ▼
                              [RUNNING S2, gen=current]

session_tree:
  generation++ ; abort current ; restore target-branch working state

shutdown:
  generation++ ; clear pending ; abort ; bounded wait
```

### 6.3 Latest-pending coalescing

若 settled 频率高于模型提取速度，不能无限排队每个 snapshot。只保留最新 snapshot，让下一次 source builder 包含更大的 delta：

```text
S1 handles entries [1..10]
while running: S2 [1..12], S3 [1..15]
pending = S3
S1 commits cp=10
next S3 should process [11..15]
```

优点：有界内存、减少模型调用。难点：必须正确携带已处理 offset，且 pending 必须与同一 session/branch ancestry 兼容。

### 6.4 当前实现的校正点

[校正点] 当前 scheduler 的注释声称“同 session 且同 branch ancestor”才 merge，但条件主要显式比较 sessionId，对 branch ancestry 与 leaf 演进的验证不充分；`lastProcessedEntryId` 的来源和写入对象也应复核。

批准修复应把兼容谓词写成显式函数，例如：

```text
canCoalesce(current, pending, next) =
  sameSession
  ∧ next.branch contains currentCommittedLastEntryId
  ∧ next branch is descendant/compatible with pending branch
  ∧ same canonical project identity
```

若无法证明 ancestry，宁可丢弃 pending 并从目标 branch 自己的 checkpoint 重建，不要猜。

## 7. Generation fencing

### 7.1 代际令牌

任务启动时捕获 `gen = scheduler.generation`。tree switch、cancel、shutdown 都令 `generation++`。

```text
Task A starts with g=7
session_tree → generation=8, abort A
Task A ignores/late-observes abort and returns
commit guard checks 7 === 8 → false
因此不 append checkpoint
```

这是一种 fencing token。AbortSignal 提供尽快停止，generation 提供晚到结果隔离；二者缺一不可。

### 7.2 为什么 AbortSignal 不够

取消是协作式的：

- provider 可能在 abort 同时返回；
- Promise 的某段 CPU 工作不检查 signal；
- 已发起的文件 I/O 不能撤销；
- `.then` 回调仍可能调度。

因此：

```text
abort = liveness optimization
fence = safety condition
```

### 7.3 为什么仅比较 leaf 也不够

若 guard 写成 `job.branchLeafId === snapshot.branchLeafId`，两者都来自同一个 snapshot，本质是恒真，不能证明**当前宿主 leaf**仍一致。正确方案有两种：

1. generation 由所有 tree/session identity 变化严格递增，作为主要 fence；
2. append callback 在宿主边界重新验证 current session/leaf，但不能让后台任意读取 mutable ctx。

可通过注册层维护一个小型 runtime epoch/identity token，由同步 lifecycle 更新，scheduler 只比较 token。

## 8. Repository 与 Scheduler 的双重取消

取消检查至少位于：

```text
runExtraction before provider
runExtraction after provider
runExtraction after review
repository before staging/commit
repository staged loop
repository each write / before manifest
scheduler before append checkpoint
```

这形成多层防线。但应理解不可逆边界：

```text
manifest 已成功 rename
  + signal 随后 aborted
```

此时 repository 已逻辑提交，不应回滚成“未发生”却又让另一进程已观察 manifest。Scheduler 可以拒绝旧 branch checkpoint；下次重放由 manifest no-op。换言之，branch 取消不会撤销已经安全提交的长期事实，但会阻止错误 branch 前移进度。

这带来产品问题：branch 切换前的 A 证据若已经提交为 project Memory，B 仍可能看到它。branch checkpoint safety 不等于 branch-scoped memory isolation。当前产品语义是 project-level长期记忆；若要求废弃 branch 的尚未确认事实绝不进入项目 Memory，必须把 branch validity 检查推到 manifest commit 前，或增加 tentative/branch provenance 与撤销策略。

## 9. 跨进程 writer 串行化

### 9.1 线性化

所有 repository writer 使用同一 root lock：

```text
Pi process P1                    Pi process P2
acquire lock
check manifest absent
read reinforcement n
write entries/R/manifest
release                         acquire lock
                                check same manifest present → no-op
                                release
```

这同时让 check-then-act 原子化。

### 9.2 Reinforcement lost update

错误：

```text
P1 read n=3          P2 read n=3
P1 write 4           P2 write 4
期望 5，实际 4
```

正确：锁内读取当前值并应用 increment。Coordinator 在锁外计算候选 plan 只能作为建议；repository 必须对安全边界和增量再次验证。

### 9.3 Optimistic plan 失效

Coordinator 先无锁读取 existing records，随后模型/计算，最后才进写锁。期间另一个进程可能新增相同 record，导致计划陈旧。

Repository 的防线：

- create collision 时拒绝，不能覆盖；
- replace target 必须仍存在且同边界；
- 同批 target 唯一；
- sourceHash manifest 锁内复查。

这类似 optimistic concurrency control：锁外规划，锁内验证；验证失败则整批 fail-closed，后续重新读取再规划。

## 10. Archive 与无锁 reader 的竞争

### 10.1 Race

```text
Reader                              Archiver
check archive absent
                                    acquire write lock
                                    rename active → archive
read active entries (可能 ENOENT/部分空)
```

当前读路径常用“archive 位置前后检查，变化则重试一次”：

```text
positionBefore = exists(archive)
read chosen base
positionAfter = exists(archive)
if changed → read again from new base
```

它避免常见 rename 窗口，但不是一般线性一致性证明：第二次读取期间还可能 restore/archive 再变化（ABA）。

### 10.2 可选强化

1. **共享读锁**：reader 持 shared，archive 持 exclusive；语义强，吞吐与库支持复杂。
2. **epoch 文件**：archive/restore 增加单调 epoch，reader 前后比较；ABA 不再隐藏。
3. **immutable generation**：reader 固定 generation，目录切换只改 pointer。
4. **重试上限 + 明确不确定错误**：不静默返回可能错误视图。

对 prompt/search，短暂重试可能够用；对 status/reset/export，需要更强一致性。

## 11. Working State 的 branch safety

Working State 有独立 checkpoint，因为它与长期 extraction 的提交频率和失败语义不同。

`session_tree` 时：

```text
find target branch working checkpoint
  ├─ deep parse valid state
  │    → branchWorking[sessionId] = state
  │    → repository latest = state
  └─ missing/corrupt
       → clear in-memory branch state
       → clear project latest
```

为什么要“缺失则清空”？若继续沿用旧 branch latest，会把 A 的临时任务当成 B 的当前任务。

### 11.1 Key 粒度

当前内存 map 以 sessionId 为 key，branch 切换靠事件覆盖状态。更显式的模型可使用：

```text
WorkingKey = (sessionId, branchLeaf/branchEpoch)
```

但 leaf 每条消息都会变，不能简单当稳定 branch ID。可使用 Pi tree 的 branch root/fork identity，或以 branch checkpoint ancestry 恢复，而不是凭 leaf 字符串永久命名。

### 11.2 latest.json 不是 branch 真相

磁盘 `working/latest.json` 是跨请求便利视图，可能在 branch 切换前指向旧状态。branch-local checkpoint 才是恢复目标 branch 的权威进度；latest 必须可清除、可重建。

## 12. Project identity、worktree 与显式 alias

### 12.1 默认隔离

```text
canonical realpath(cwd) → hash → projectId
```

所以两个 worktree 默认不同 ID、不同 entries/manifests/reinforcement。即便 Git branch 名相同，也不共享。

这防止：

- 并行修复分支相互注入尚未合并的决策；
- worktree A 的 sourceHash 让 B 错误 no-op；
- 同名项目 basename 冲突。

### 12.2 Symlink 归一化

同物理目录的 symlink 通过 realpath 合并，避免同一 workspace 因入口不同产生两套 Memory。

### 12.3 显式 alias 的风险

`.triple-pi/project.json` 可让多个 cwd 共用 ID。共享意味着：

- entries 与 lifecycle 合并；
- manifest/reinforcement 合并；
- archive 一个 alias 可能影响另一个；
- writer lock 仍是同 root，物理并发安全，但业务隔离由用户主动放弃。

Alias 文件必须校验 ID allowlist，且诊断应显示来源。若 alias 被恶意仓库提交，它可能把 workspace 指向已知 project ID；安全修复可要求 alias 位于用户配置或首次确认，而不是无条件信任仓库文件。

## 13. Happens-before 证明模板

### 13.1 同 source 幂等

要证明两个进程不会重复提交：

```text
P1 acquire lock
  happens-before P1 manifest publish
  happens-before P1 release
  happens-before P2 acquire
  happens-before P2 manifest existence check
```

因此 P2 看到 manifest 并 no-op。若 existence check 在锁外，此证明不成立。

### 13.2 Checkpoint 安全

```text
repository manifest publish
  happens-before runExtraction resolve
  happens-before scheduler guarded then
  happens-before pi.appendEntry(checkpoint)
```

异常路径不得绕开 chain。

### 13.3 Tree switch fencing

```text
session_tree handler increments generation
  happens-before late task commit guard reads generation
```

JavaScript 同 event loop 内同步 increment 与后续 microtask 有明确顺序；跨 worker/thread 则需要原子或消息协议。

## 14. 典型竞态时序

### 14.1 Settled during extraction

```text
Pi              Scheduler             Task S1
│ start S1          │                    │
├──────────────────>│───────────────────>│ provider await
│ settled S2        │                    │
├──────────────────>│ pending = S2       │
│                   │                    │ commit S1
│                   │<───────────────────┤
│                   │ finally → start S2 │
```

要求：S2 的 source 从 S1 已提交 checkpoint 后开始，否则会重复；即使重复，manifest 仍应兜底。

### 14.2 Tree switch during provider call

```text
branch A task(g=4) ── provider await
session_tree(B): generation=5, abort
provider late returns
run checks aborted → stop
即使漏检：scheduler sees gen mismatch → no checkpoint
```

### 14.3 Shutdown during write

```text
shutdown aborts
repository before next write detects signal
  → catch rollback
  → no manifest
scheduler bounded wait expires
```

若进程随后强退且 rollback 未完成，必须依赖第三章讨论的 crash recovery；scheduler 本身不能解决。

### 14.4 Concurrent create collision

```text
P1/P2 都在锁外计划 create same ID
P1 lock → create + manifest → release
P2 lock → re-read existing / collision → reject or manifest no-op
```

Repository 不能盲信 coordinator 的旧计划。

## 15. 并发不变量

### C-1 Single active extraction per extension instance

```text
scheduler.task != undefined ⇒ 新 snapshot 只能进入有界 pending
```

### C-2 Epoch fence

```text
job.generation != currentGeneration ⇒ 禁止 append checkpoint
```

### C-3 Snapshot identity

一个 job 的 cwd/session/branch/model 在生命周期内不可变。

### C-4 Branch-local progress

delta offset 只能来自当前 branch 可达 checkpoint，不可来自全局“最新”。

### C-5 Repository serializability for writers

所有 write-set validation 与 mutation 位于同一跨进程 exclusive lock。

### C-6 Optimistic revalidation

锁外 plan 在锁内必须验证 create collision、replace boundary、manifest、archive 状态。

### C-7 Worktree isolation by default

不同 canonical cwd 不共享 project records，除非显式 alias。

### C-8 No stale working fallback

目标 branch 无合法 working checkpoint 时，清空旧 branch working state。

## 16. 错误方案与 trade-off

### 16.1 只有 boolean `isExtracting`

能阻止重入，但新 settled 会被丢弃。需要 latest pending 或队列。无限队列又会重复处理和放大模型成本，所以采用 coalescing。

### 16.2 只有 AbortController

晚到 Promise 仍可能执行 commit callback。必须加 generation/runtime epoch fence。

### 16.3 只用 sessionId 判 branch

同 session 内可以 fork/switch branch。必须结合 branch ancestry/checkpoint/generation。

### 16.4 用 git branch 名做 checkpoint key

同 git branch 可有多个 Pi session tree；detached HEAD、rename、worktree 都会破坏映射。对话 branch 应由 Pi session tree 表达。

### 16.5 所有 worktree 自动共享记忆

方便主分支规则复用，但会泄漏尚未合并的实验决策。默认隔离 + 显式 alias 更安全，代价是共享配置。

### 16.6 一个全局 writer lock

证明简单且个人规模足够；不同 project 也互相阻塞。未来可按 project/global 分片锁，但跨 global/project batch 会引入锁排序与死锁问题。

### 16.7 无锁 reader 前后检查一次

吞吐好、实现轻，但不提供强快照和 ABA 防护。适合 prompt/search 的弱一致读，不适合破坏性维护命令。

### 16.8 branch switch 后撤销所有已提交 Memory

能严格避免废弃 branch 污染，却难判断哪些事实仍被共享祖先或其他 branch 需要，并造成复杂补偿。当前选择以 project-level durable Memory 为主，branch 只隔离输入进度；更强语义需 tentative records。

## 17. 测试策略

### 17.1 确定性单测

- current branch 不含 abandoned branch message；
- checkpoint 后只取 delta；
- 相同 source 稳定 hash；
- provider/validation 失败无 checkpoint；
- 同 source manifest 幂等；
- 20 concurrent writers 不丢记录；
- reinforcement 两次 increment 得到 2；
- archive 时 project write 拒绝、global 允许。

### 17.2 Scheduler 模型测试

使用 deferred Promise 精确控制：

```text
start A
start B while A blocked
switch tree / bump generation
resolve A
assert: no A checkpoint
assert: B 是否按目标策略保留/丢弃
```

应覆盖：same branch coalesce、different branch、new session、cancel、shutdown timeout、late rejection、onSettled callback 抛错。

### 17.3 多进程测试

单进程 `Promise.all` 能测试异步争用，但不能完全证明跨进程 lock。应 fork 20 个 Node 进程共享 temp root，使用 barrier 同时开始，验证 entries/index/reinforcement/manifest。

### 17.4 线性化历史

记录每次操作：invoke time、response time、sourceHash、lock acquire/release、manifest commit。对小规模随机历史用模型检查器寻找是否存在满足顺序约束的串行历史。

### 17.5 故障注入

在 provider return、每次 atomicWrite、metadata、manifest、append checkpoint、archive rename 处注入：

- throw；
- abort；
- 子进程 SIGKILL；
- 损坏/截断文件；
- stale lock；
- `EXDEV`/`EACCES`/disk full。

## 18. 源码导读

1. `extensions/memory/extraction/source.ts`
   - `findCheckpoint`、`buildExtractionSourceFromBranch`；
   - 验证 current branch 和 hash 输入。
2. `extensions/memory/extraction/scheduler.ts`
   - `start`、`pending`、`generation`、`cancel/bumpGeneration/shutdown`；
   - 重点审查 commit guard，不只看 abort。
3. `extensions/memory/extraction/coordinator.ts`
   - snapshot 消费、各阶段 abort check、锁外 plan。
4. `extensions/memory/index.ts`
   - `agent_settled` 快照时机；
   - `session_tree` generation 与 working 恢复；
   - `session_shutdown` 有界等待。
5. `extensions/memory/repository.ts`
   - 锁内 manifest check、collision/replacement revalidation、archive。
6. `project-identity.ts`
   - realpath、Windows normalization、alias 与 worktree 默认隔离。
7. 测试：`extraction-source.test.ts`、`extraction-coordinator.test.ts`、`repository.test.ts`、`extension-lifecycle.integration.test.ts`。

[校正点] 代码修复后尤其复核 scheduler ancestry、pending offset、runtime epoch 与多进程测试路径。

## 19. 面试追问

1. **AbortSignal 和 generation 的职责分别是什么？**
   - abort 促使任务尽快停；generation 阻止旧任务发布结果。
2. **为什么 sessionId 不足以识别 branch？**
   - 一个 session 是 tree，可有多个 branch；sessionId 只识别树，不识别路径。
3. **branch leaf ID 能作为 branch ID 吗？**
   - leaf 随追加变化；它是快照位置，不一定是稳定分支身份。需要 ancestry 或 epoch。
4. **为什么 pending 只保留最新 snapshot？**
   - delta 具有包含关系时可合并，减少调用并保持有界；必须先证明同 branch ancestry。
5. **若旧 branch task 已写 entry，但 generation 检查失败，是否算串 branch？**
   - checkpoint 不串；但 project-level Memory 已提交。需说明产品语义及 tentative record 替代设计。
6. **如何证明 sourceHash 幂等在多进程下成立？**
   - manifest check 与 publish 位于同一跨进程锁，形成 happens-before。
7. **为何 coordinator 可锁外读 existing？**
   - 减少长锁；repository 锁内重新验证冲突。它是 optimistic plan，不是最终授权。
8. **不同 worktree 应共享规则吗？**
   - 默认不共享以隔离实验状态；稳定共享规则可显式 global 或 alias，每种选择有权限含义。
9. **读前后检查 archive 位置是否线性一致？**
   - 不完全，存在重复切换/ABA；只是一种弱一致性重试。
10. **全局锁如何扩展？**
    - 可按 project 分片，但 global 与 project 混合事务需固定锁序，例如 global→project，且 lock identity 必须 canonical。
11. **怎样测试“不会吞最后一次 settled”？**
    - 用 deferred task 阻塞第一轮，连续触发 settled，完成第一轮后断言 latest pending 启动并覆盖新增 delta。
12. **shutdown 等待一秒后任务仍运行怎么办？**
    - generation 已 fencing，不能 checkpoint；repository 仍依靠 AbortSignal 与事务恢复。若必须硬停止，应放入 worker/child process。
