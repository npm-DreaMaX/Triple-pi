# 第三章：存储、事务与恢复

## 1. 先区分四种“成功”

文件型记忆系统最危险的表述是“用了原子写，所以有事务”。一次自动提取至少有四个不同层次的成功：

```text
A. 单文件可见性成功：reader 看到完整旧版或完整新版
B. 批次逻辑提交成功：entry/reinforcement/metadata/manifest 达成协议状态
C. branch 进度成功：checkpoint 已追加到 Pi session tree
D. 物理持久成功：断电后数据仍保证存在
```

当前设计主要建立 A、B 的补偿语义，以及 B→C 的可重放协议。它**不能仅凭 `writeFile + rename` 宣称 D**；严格掉电持久性还涉及文件与目录 `fsync`、文件系统语义和硬件缓存。

## 2. Canonical repository

[现状] `FilesystemMemoryRepository` 是 Memory 的唯一持久化边界。默认根目录为：

```text
~/.triple-pi/memory-v1/
├─ global/
│  ├─ entries/<category>/<record-id>.md
│  └─ MEMORY.md
├─ projects/<project-id>/
│  ├─ project.json
│  ├─ entries/<category>/<record-id>.md
│  ├─ revisions/<record-id>/<revision-id>.md
│  ├─ MEMORY.md
│  ├─ working/sessions/<session-key>/SCRATCHPAD.md
│  ├─ working/latest.json
│  └─ daily/YYYY-MM-DD.md
├─ archive/projects/<project-id>/
├─ extractions/<project-id>/<sourceHash>.json
├─ working-manifests/<project-id>/<sourceHash>.json
└─ signals/<project-id>/reinforcement.json
```

[校正点] 后续实现可能重排 manifest、revision、transaction journal 的目录；必须保留以下语义角色：

- `entries`：长期记录权威数据；
- `MEMORY.md`：可重建派生索引；
- `manifest`：sourceHash 已提交的发布证明；
- `project.json`：生命周期 metadata；
- `reinforcement`：需在锁内做增量的辅助状态；
- `working/daily`：非长期记录；
- `archive`：无损冷存储。

## 3. 权威数据与派生视图

### 3.1 为什么 entry 是真相

单条 entry 包含 JSON header 和 Markdown 正文。它具有独立 record ID、scope、category、时间与 provenance。`MEMORY.md` 只列出链接和摘要。

不变量：

```text
删除 MEMORY.md
  ──rebuildIndex──>
由 entries 确定性生成等价索引
```

这是一种 CQRS-like 分离：entries 是写模型/事实，index 是读优化。它不需要跨 entry/index 严格事务，因为 index 可恢复。

### 3.2 派生索引失败的返回语义

手动保存的顺序：

```text
atomicWrite(entry)            ← 权威 commit point
write project metadata
try rebuildIndex
catch → 忽略，稍后可重建
return success
```

如果 entry 已写成功但 index 失败却返回“保存失败”，调用者可能重试并产生歧义。把 entry durability 作为成功点更符合用户可见语义。

代价是短时间内 index 可陈旧；因此所有正确性路径不能把 `MEMORY.md` 当唯一来源。

## 4. 单文件原子替换

### 4.1 协议

当前 `atomicWrite(filepath, content)`：

```text
mkdir/chmod parent
  → temporary = same-dir/.<basename>.<uuid>.tmp
  → writeFile(temporary, full content, 0600)
  → rename(temporary, filepath)
  → chmod(filepath, 0600)
  → finally rm(temporary, force)
```

同目录 temp 很关键。在通常本地文件系统上，rename 不跨 mount，替换目录项是原子的。reader 在 rename 前看到旧文件，rename 后看到新文件。

### 4.2 线性化点

对单文件逻辑可见性，线性化点是：

```text
fs.rename(temp, target) 成功返回
```

不是 `writeFile(temp)`，因为 target 尚未变化；也不是最后 `chmod`，因为内容已发布。

### 4.3 它保证什么

- 不向 target 原地逐字节写，因此不会暴露半个 header；
- 新旧版本切换有单一目录项操作；
- temp 使用 UUID，多个 writer 不共享 temp 名。

### 4.4 它不保证什么

- 不保证多个文件同时切换；
- 不保证掉电后 rename 与数据块都落盘；
- 不保证跨文件系统 rename；
- 不阻止 reader 依次读两个文件时看到混合 epoch；
- 不阻止不遵守 repository lock 的外部程序直接改文件；
- `chmod` 在 rename 后失败时，内容已经发布但函数可能抛错。

如果目标是严格 crash durability，典型强化序列是：

```text
open temp
write all
fsync(temp fd)
close
rename(temp, target)
fsync(parent directory fd)
```

不同平台对目录 fsync、rename replacement 和 antivirus/file sharing 的行为不同，需要平台契约与故障测试。

## 5. 跨进程写锁

### 5.1 锁的作用

`proper-lockfile` 锁住 repository root。所有 writer 在 `withWriteLock` 内执行：

```text
W1: acquire ───── mutate ───── release
W2:          wait                   acquire ─ mutate ─ release
```

它把并发 write/read-modify-write 排成总序，解决：

- 两个 writer 重建 index 时互相覆盖；
- reinforcement 同时 `n→n+1` 丢更新；
- archive 与 save 同时移动/重建目录；
- 两批相同 sourceHash 同时通过“manifest 不存在”检查。

### 5.2 锁参数与失效模型

当前配置具有 retry 和 stale timeout。要理解 stale lock 的危险：如果持锁操作超过 stale 阈值，而锁库不能持续正确刷新 mtime，另一个进程可能误判并闯入。正确性不能只看常数，应核实 `proper-lockfile` 的 heartbeat/update 语义和最大事务时间。

### 5.3 为什么读路径不持写锁

设计选择是：单文件原子替换让 reader 不见半文件，因此普通 read 不占 exclusive lock，以提升并发。

换来的不是“读完全一致”，而是较弱保证：

```text
每个读取到的文件是完整版本；
多个文件组成的结果未必来自同一个事务 epoch。
```

例如批次先写 entry E1、E2，最后 manifest。无锁 reader 在中途可能看到 E1 新、E2 旧且 manifest 旧。普通搜索允许这种短暂 read skew；要求严格批次快照的诊断/导出操作则应使用共享锁、版本目录或 manifest-filtered snapshot。

## 6. 手动保存事务语义

### 6.1 更新路径

```text
acquire write lock
  → 验证 archived write protection
  → 读取 previous head
  → 若存在 previous，写 immutable revision snapshot
  → atomicWrite(new head)
  → 更新 project metadata
  → best-effort rebuild index
release
```

手动保存不是完整 all-or-nothing batch：revision 成功而 head 失败时，会留下 orphan revision；head 成功而 metadata/index 失败时，可能形成可恢复的不一致。这些 orphan 通常不破坏当前 head 正确性，但诊断工具应能识别和清理。

### 6.2 Revision 不等于事务日志

Revision 用于业务审计和历史版本，不应承担崩溃恢复 WAL 的职责：

- revision 只覆盖 record 更新；
- 不一定覆盖 reinforcement/manifest/metadata；
- 其生成时机与 transaction ID 未必一致；
- orphan revision 可以合法存在。

恢复日志需要记录事务意图、write set、before/after image、状态和校验和。

## 7. 自动提取批次：补偿事务

### 7.1 Staging

在写锁内：

1. 检查 AbortSignal；
2. 验证 `sourceHash`，计算 manifest path；
3. manifest 已存在则 no-op；
4. 读取现有记录；
5. 拒绝向 archived project 写 project entry；
6. 验证每个 create/replace；
7. 为 replace 准备 revision 与新 head；
8. 构建 reinforcement 的锁内增量结果；
9. 构建完整 write set 与 before images。

边界检查：

```text
replaceRecordId matches /^[a-f0-9]{32}$/
target exists
target.scope/category/projectId 均与候选一致
同批不得两次命中同 filepath
create 不得隐式覆盖已有 ID
```

### 7.2 写入顺序

目标协议：

```text
1. revisions
2. head entries
3. reinforcement
4. project metadata
5. manifest LAST                 ← batch publish marker
6. best-effort derived indexes
```

Manifest 最后发布的含义：只有此前事实均成功，才宣布此 `sourceHash` 已处理。

### 7.3 Commit point

对 repository 幂等语义：

```text
atomicWrite(manifest) 成功 = batch logical commit
```

Entry 在 manifest 前已经对无锁 reader 可见，因此这不是数据库式“commit 前完全不可见”。更准确叫**有序发布 + 补偿回滚**。

### 7.4 回滚

任一写失败时，按逆序恢复：

```text
for target in reverse(writeOrder):
  before image 不存在 → rm(target)
  before image 存在   → atomicWrite(target, before)
restore metadata
restore/remove manifest
collect rollbackErrors
rethrow original error (+ rollbackErrors)
```

逆序回滚与栈语义一致，降低依赖项先被删除的风险。

### 7.5 当前实现需要复核的时序

[校正点] 当前源码在构建完整 metadata backup set 之前可能调用一次 metadata 写函数，随后又在正式 write phase 写一次。这会导致所谓 before image 可能已经是新值，削弱 metadata 回滚语义。后续批准修复应满足：

```text
读取全部 before images
  happens-before
任何 write-set 目标第一次被修改
```

另外，若 before image 为“不存在”，metadata/manifest 回滚也必须显式删除新建文件，而不能只在旧内容存在时恢复。

## 8. 为什么 manifest 必须最后写

考虑 source S：

### 正确顺序

```text
entries/reinforcement 成功
  → manifest(S) 成功
  → crash before branch checkpoint
  → retry sees manifest(S)
  → no-op + 补 checkpoint
```

不会重复更新。

### 错误顺序：manifest 先写

```text
manifest(S) 成功
  → entry 写失败/crash
  → retry sees manifest(S)
  → 错误跳过
  → 永久数据缺失
```

因此不变量是：

```text
manifest(S) exists ⇒ S 的 canonical write set 已逻辑提交
```

若 manifest 文件可能损坏，简单的 `exists()` 不足以证明提交；修复设计应解析并校验 schema/sourceHash/projectId/recordIds，必要时 quarantine 无效 manifest。

## 9. 崩溃矩阵

设批次写 E1、E2、R、M（manifest），checkpoint 为 C。

| 崩溃点 | 磁盘可能状态 | 下次行为 | 风险 |
|---|---|---|---|
| 写前 | 全旧，无 M/C | 完整重试 | 安全 |
| E1 后、E2 前 | E1 新，其余旧，无 M | 进程内异常可回滚；进程崩溃则需恢复协议 | 当前补偿事务的主要上限 |
| R 后、M 前 | entries/R 新，无 M | 重试可能再次增量 | 若无 crash recovery/WAL，可能重复 reinforcement |
| M 后、C 前 | 全新，有 M，无 C | repository no-op，补 C | 设计预期安全 |
| C 后 | 全新，有 M/C | branch delta 从 C 后开始 | 正常 |

关键结论：**catch 中 rollback 只处理可被当前进程捕获的错误，不能处理 SIGKILL、机器断电或进程直接退出。**

## 10. 恢复机制分层

### 10.1 单条损坏隔离

`listBase` 对每个 record 独立 parse：坏文件跳过，健康记录继续服务。诊断版本累计 `corruptRecordCount`。

这保证 availability，但存在 silent omission 风险。生产强化应：

- 记录损坏路径、错误码与 hash；
- 移到 quarantine 而非直接删除；
- 防止每次读取重复告警风暴；
- 提供显式修复/导出命令。

### 10.2 索引重建

`rebuildIndex` 遍历健康 entries，排序后 atomicWrite `MEMORY.md`。它恢复派生视图，不修改 entry。

### 10.3 Archive/restore

同一 memory root 内目录 rename：

```text
archive:
 active/project.json.status = archived
 active project dir ──rename──> archive/projects/<id>

restore:
 archived/project.json.status = active
 archive dir ──rename──> projects/<id>
```

Restore rename 失败时，代码尝试把源目录 metadata 改回 archived。这里采用“目录位置 + metadata”双重状态，需要定义冲突处理优先级。

建议恢复判定表：

| active dir | archive dir | metadata | 判定 |
|---|---|---|---|
| 有 | 无 | active | 正常 hot/cold |
| 无 | 有 | archived | 正常 archived |
| 有 | 无 | archived | archive 中断，标 archive-due 或修复 |
| 无 | 有 | active | restore 中断，恢复 metadata 为 archived 或继续 restore |
| 有 | 有 | 任意 | split-brain，拒绝自动写，需诊断 |
| 无 | 无 | 无 | new |

### 10.4 Reset 应 quarantine

长期记忆删除不可逆。安全 reset 应先在同一根目录 rename 到 quarantine，而不是直接 `rm -rf`；真正 purge 应是另一个显式动作。Status 必须只读，不能“顺便修复”而改变证据。

## 11. 更强的 crash recovery 设计

若要求进程崩溃后的 batch all-or-nothing，可选两类方案。

### 11.1 WAL / intent journal

```text
txn/<txid>.json = {
  state: PREPARED,
  sourceHash,
  writes: [{target, beforeHash, tempPath, afterHash}],
  manifest
}
fsync journal
write/rename targets
write manifest
mark COMMITTED + fsync
cleanup journal/backups
```

启动恢复：

```text
PREPARED without manifest → rollback/complete according to policy
manifest valid + writes match → mark committed/cleanup
hash mismatch → quarantine + stop writes
```

优点：故障状态显式；缺点：实现和测试复杂，WAL 自身也需 fsync 与版本迁移。

### 11.2 Immutable generation directory

```text
generations/
  g41/<complete snapshot or changed files>
  g42/...
CURRENT -> g42             // 单一原子指针
```

先构建完整新 generation，再原子切换 `CURRENT`。reader 先固定 generation，因此获得一致快照。

优点：读快照简单、回滚只切指针；缺点：空间放大、GC、global/project 多作用域组合复杂。

### 11.3 SQLite

SQLite 自带 WAL、事务、并发与 crash recovery，能显著减少自研存储协议。代价：

- Markdown 人工审计性下降；
- 文件级备份/版本控制不再直观；
- working/daily 展示仍需导出；
- migration 与查询层复杂度转移到 schema。

正确取舍取决于是否真的需要强跨文件事务和规模，而不是“数据库一定高级”。

## 12. 存储不变量

### S-1 Path safety

```text
untrusted title/content 不参与路径
category 必须 allowlist
record/replacement/source hash 必须固定格式
```

### S-2 Before-image ordering

```text
captureBeforeImage(target) happens-before firstMutation(target)
```

### S-3 Publish ordering

```text
all canonical writes succeed happens-before manifest publish
manifest publish happens-before branch checkpoint append
```

### S-4 Index dispensability

```text
entry 可读取 ⇒ index 缺失/陈旧不得使 record 不可用
```

### S-5 Archive exclusivity

同一 project ID 不应同时存在可写 active 与 archive 目录。

### S-6 Permission boundary

root/dir 为 0700、文件为 0600 是本地隐私基线；权限设置失败不能被当作无关错误悄悄忽略。

### S-7 Rollback observability

回滚失败必须单独暴露，不能只抛原始写错误。否则操作者会误以为状态已恢复。

## 13. 源码导读

1. `extensions/memory/repository.ts`
   - `serializeRecord` / `parseRecord`：磁盘格式与 schema compatibility；
   - `save`：手动单 record 写；
   - `saveExtractionBatch`：staging、before image、write order、manifest、rollback；
   - `listBase` / `listBaseWithDiagnostics`：损坏隔离；
   - `rebuildIndexUnlocked`：派生视图；
   - `withWriteLock` / `atomicWrite`：最底层并发与可见性协议；
   - `archiveProject` / `restoreProject`：目录级状态迁移。
2. `extensions/memory/domain.ts`：磁盘 schema 与 revision/provenance。
3. `test/memory/repository.test.ts`：项目隔离、路径安全、索引重建、损坏 entry、20 writer。
4. `test/memory/lifecycle.test.ts`：归档隐藏、显式搜索、恢复和写保护。
5. `scripts/memory-status.mjs`、`memory-reset.mjs`：诊断与维护边界。

[校正点] 后续修复后优先检查 fault-injection tests，而不是只更新函数路径。

## 14. 错误方案与 trade-off

### 14.1 原地覆盖 target

崩溃可能留下截断文件。temp+rename 更好，成本是额外 I/O 和孤儿 temp 清理。

### 14.2 用 index 作为唯一真相

写 index 失败会拖垮所有记录，且多人编辑易冲突。权威 entry + derived index 更可恢复，成本是短暂不一致。

### 14.3 在锁外计算 reinforcement 绝对值

两个 writer 都读 n，再各写 n+1，最终只增加一次。锁内增量确保串行，但锁粒度为全 root，吞吐较低。

### 14.4 把 manifest 当锁

`if !exists(manifest) then write` 在并发下是 TOCTOU；两个进程都可能通过。manifest 是幂等发布证明，不替代互斥锁。

### 14.5 catch 后“尽力回滚”却不记录失败

补偿也可能失败。吞掉 rollback error 会把不确定状态伪装成已恢复。应进入 diagnostics，严重时熔断写入。

### 14.6 所有 read 都持 exclusive lock

一致性强但 prompt/search 被慢模型后的写事务拖住。当前选择无锁 read + 单文件原子；若需要快照读，优先 shared/read lock 或 generation，而非一刀切 exclusive。

## 15. 面试追问

1. **temp+rename 是 ACID 吗？**
   - 不是；它主要给单文件原子可见性。跨文件原子、隔离、掉电持久分别要额外协议。
2. **批次的 commit point 在哪里？**
   - repository 语义是 manifest 最后发布；session branch 另有 checkpoint。
3. **为什么 checkpoint 不能充当 manifest？**
   - checkpoint 属于 branch 进度域，repository 可能跨 session 重放；两个持久域无法原子提交。
4. **如果 manifest 损坏但存在怎么办？**
   - 仅 `exists` 会误判；应深度校验或 quarantine，并基于 entries/provenance 恢复。
5. **补偿回滚和数据库 rollback 的差别？**
   - 当前进程必须活着执行补偿；进程崩溃需要 WAL/恢复扫描。数据库通常把恢复协议持久化。
6. **为什么 reader 可以不加锁？**
   - 因单文件替换不半写，并接受跨文件 read skew；若调用者要求事务快照则不够。
7. **如何测试 crash recovery？**
   - 在每个写入/rename/fsync 点注入失败与子进程 kill，重启后执行 recovery，再验证不变量。
8. **Archive rename 为什么要求同 filesystem？**
   - 跨设备 rename 可能返回 `EXDEV`，复制+删除不具同样原子性。
9. **权限 0600/0700 是否足以保护 secrets？**
   - 不是。还依赖 secret rejection、备份权限、磁盘/主机安全；权限只是本地最小暴露。
10. **何时应从 Markdown repository 迁到 SQLite？**
    - 当强事务、并发、查询规模或恢复复杂度有测量证据超过人工可审计性的收益时。
