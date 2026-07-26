# Triple-pi Memory Rebuild

> 这份文档持续记录 Memory 重做过程中的问题证据、工程决策、取舍和验收结果。它面向代码审查、复盘和面试说明；只记录可以由代码或测试验证的结论。

## 1. 为什么要重做

旧实现不是单点 bug，而是端到端协议断裂：

- Extension 将记忆写入 `global/` 或 project slug 目录，legacy extractor 写入根级 category 目录；两边互相看不到。
- `loadContextPrompt()` 虽存在，但没有接入 Pi 的 `before_agent_start`，新 session 不会自动获得记忆索引。
- Extension、extractor 和 session path 使用不同的 project identity 算法。
- cron 只猜一个“最新”JSONL，绕过 Pi session tree，会读取废弃 branch。
- extractor 自行读取 auth 和硬编码 provider endpoint，没有复用 Pi 的 ModelRegistry。
- 30 天清理会直接递归删除目录，且 activity marker 可能写到错误项目。
- 原“10/10”Eval 只解析 stdout，允许空结果和错误内容通过，也没有验证真实加载链路。

因此本次选择重建一个唯一 Memory Core，而不是继续在旧 extractor 上打补丁。

## 2. 产品边界

目标用户包括大厂程序员和个人开发者，因此优先级是：

1. **正确隔离**：项目 A 的长期记忆不能污染项目 B；global 必须显式选择。
2. **可审计**：本地文件可读，记录来源和更新时间；索引不是唯一真相。
3. **安全默认**：显式保存需要用户确认；无 UI 时 fail closed；不自动永久删除。
4. **可恢复**：单个文件损坏不拖垮全部记忆，索引可以从 entry 重建。
5. **原生接入 Pi**：使用 Extension lifecycle、当前 cwd、session branch 和 ModelRegistry，不复制 Agent Loop。
6. **测试分层**：确定性测试作为发布门，live LLM Eval 只作为独立统计，不用随机结果证明文件系统正确。

已确认的后续生命周期：

- 超过 30 天后重新打开项目，询问是否恢复热记忆；拒绝则本 session 不注入。
- 超过 90 天自动归档；不进入热 prompt/普通搜索，但可显式搜索或恢复。
- 自动提取放在 `agent_settled`，`session_shutdown` 负责有界 flush/cancel。

## 3. Block 1：Memory Core 与跨 session 闭环

### 3.1 交付目标

Block 1 只做显式保存，不做自动 LLM 提取：

```text
项目 A session 1
  → SaveMemory
  → 用户确认
  → canonical repository
  → 项目 A session 2 before_agent_start
  → 第一次模型请求前看到索引
```

同时必须满足：项目 B 看不到 A；global 在 A/B 都可见。

### 3.2 核心设计

#### ProjectIdentity

`extensions/memory/project-identity.ts` 以规范化绝对 `cwd` 为唯一身份输入：

```text
<可读 basename>-<SHA-256 前 20 hex>
```

原因：

- 不从 Pi session 目录名逆向猜 cwd；
- 不依赖 git remote，避免同 remote 的 monorepo/workspace 被合并；
- 不使用模块级单值 cache，session 切换不会沿用旧项目；
- display name 与稳定 ID 分离，兼顾可读性和碰撞控制。

当前定义是“不同启动 cwd 相互隔离”，因此 worktree 和 monorepo 子目录默认也是独立作用域。未来若要共享，应该增加显式 alias/config，而不是暗中改 identity。

#### Canonical repository

`extensions/memory/repository.ts` 使用新根目录：

```text
~/.triple-pi/memory-v1/
├── global/
│   ├── entries/<category>/<record-id>.md
│   └── MEMORY.md
└── projects/<project-id>/
    ├── entries/<category>/<record-id>.md
    └── MEMORY.md
```

旧 `~/.triple-pi/memory` 不读取、不迁移。本次明确选择从零开始，避免把已经污染、来源不明的旧记录带入新系统。

单条 entry 是权威数据；`MEMORY.md` 只是方便人和 prompt 阅读的派生索引：

- record id 由 scope/project/category/normalized title 生成，不把 title 当路径；
- 同分类同标题更新时保留 `createdAt`，只更新 `updatedAt`；
- repository 自身做 category/scope 运行时校验，不能只依赖 TypeScript 或工具层；
- root 与目录权限为 0700，文件为 0600；
- 使用 `proper-lockfile` 串行化多进程/并发 writer；
- 使用同目录临时文件 + rename，entry/index 不会半写；
- 索引失败不把已经成功写入的权威 entry 谎报成“保存失败”；索引可稍后重建；
- 单个损坏 entry 被隔离，不能让全部 prompt/search 失败。

这里的取舍是：entry 与 index 不是一个跨文件原子事务。因为索引是可重建派生物，所以把 entry durability 作为提交点，比“entry 已成功但因 index 失败返回失败”更符合用户可观察语义。

#### Pi Extension lifecycle

`extensions/memory/index.ts`：

- SaveMemory/SearchMemory 使用 `ctx.cwd`，不使用 `process.cwd()`；
- SaveMemory 展示 scope/category/title/content 后调用 `ctx.ui.confirm()`；
- `ctx.hasUI === false` 时拒绝保存，不静默降级；
- `before_agent_start` 追加有界索引到当前 chained system prompt；
- 不返回 custom message，避免每个 turn 把 memory snapshot 写进 session JSONL；
- 空库不注入 DAILY/SCRATCHPAD 等尚未实现的承诺。

Prompt 只注入索引，完整正文通过 SearchMemory 按需读取，避免 memory 数量增加后永久占满上下文。

### 3.3 为什么停用 legacy extractor 和 legacy Eval

- `npm run extract` 现在明确失败并说明等待 Block 3 的 branch-aware lifecycle；setup 不再自动安装 cron。
- `npm run eval` 现在明确失败，因为旧 Eval 不覆盖新 repository 或 Pi hook，且会产生虚假通过。
- `npm run eval:legacy` 仅为历史对照保留，不能作为发布门。

已有旧 cron 不会被 setup 静默删除，因为修改用户 crontab 是外部副作用；升级用户应显式运行 `npm run cron:remove`。后续安装/诊断块会提供状态检查和精确迁移提示。

## 4. Block 1 验收证据

### 确定性测试

命令：

```bash
npm test
npm run typecheck
```

覆盖：

- project identity 稳定性、同 basename 隔离、非法字符；
- A/B/global 可见性矩阵；
- createdAt 更新语义；
- title/category 路径穿越；
- 索引重建；
- 单条损坏记录隔离；
- 派生索引失败后的权威 entry 语义；
- 20 个并发 writer 不丢 entry/index；
- SaveMemory 确认、拒绝、无 UI fail closed；
- 新 session `before_agent_start` 注入；
- SearchMemory 当前项目 + global。

最终结果应以当前命令输出为准，不在文档里用 tolerance 放宽失败。

### 真实 Pi smoke

使用临时 `PI_CODING_AGENT_DIR`、临时 `TRIPLE_PI_MEMORY_ROOT`、本地 mock model server 和真实 `pi` CLI：

1. Pi 启动时显示 `[Extensions] memory`；
2. 模型调用真实 SaveMemory tool；
3. TUI 展示完整确认框；
4. 选择 Yes 后显示保存成功；
5. 结束并在同 cwd 启动新 Pi session；
6. mock provider 在真实请求中观察到 `Persistent Memory` 与 `Block 1 Smoke Rule`，返回 `MEMORY_INJECTED`；
7. 从不同 cwd 启动时返回 `MEMORY_MISSING`，证明 project scope 隔离。

Smoke 全程使用 `/tmp`，不读写用户真实 memory。

## 5. 面试高频问题

### Q1：为什么不用向量数据库？

Block 1 的问题是正确性和生命周期闭环，不是召回算法不够聪明。对个人/项目级规模，本地 Markdown + 派生索引更容易审计、备份、恢复和测试。等数据规模与语义召回需求有测量证据后，再引入 embedding/FTS；否则只会把 split-brain 搬进更复杂的基础设施。

### Q2：为什么 project ID 不只用 git remote？

大厂 monorepo、同 remote 多 workspace、git worktree 都会共享 remote。只用 remote 会产生跨服务污染。Block 1 选择 cwd identity，默认隔离；共享应该显式配置，而不是隐式猜测。

### Q3：为什么每个 turn 使用 before_agent_start？

它发生在本轮 Agent Loop 之前，可以修改当前 system prompt，又不会像 custom message 一样持久化重复 snapshot。SaveMemory 在当前 turn 中写入后，下一 turn 也会重新读取最新索引。

### Q4：为什么 SaveMemory 要代码级确认？

提示词不是授权边界。模型可能误调用工具，而长期写盘是持久副作用。`ctx.ui.confirm()` 把最终授权交还用户；无 UI 时默认拒绝，符合 fail-closed。

### Q5：为什么 entry 是真相、MEMORY.md 是派生索引？

跨多个文件做严格事务成本高，而且索引可以确定性重建。把不可丢失的 entry 作为 commit point，索引失败后可恢复，能避免“工具报告失败但数据其实已经写入”的歧义。

### Q6：为什么自动提取不继续用 cron？

cron 不知道当前 session leaf、branch、queued continuation、compaction 和 provider runtime，只能扫描 JSONL 并猜最新文件。Pi 已提供 `agent_settled`、session tree、ModelRegistry 和 shutdown hook，原生接入能实现 branch-aware、幂等和正确认证。

### Q7：如何处理一条损坏的 Markdown？

读取时按 entry 隔离，损坏记录不能阻断其他健康记忆。当前 Block 1 先 fail-soft；后续 lifecycle/diagnostics 会记录并 quarantine 损坏文件，而不是静默永久丢弃。

### Q8：如何证明跨 session 真的工作，而不是函数单测自证？

除 unit/integration tests 外，使用真实 Pi CLI、真实 Extension loader、真实 tool loop、真实 TUI confirm 和真实 `before_agent_start` 请求做临时环境 smoke。mock 的只有模型网络端，生命周期和文件系统路径都是真实生产代码。

## 6. Block 2：冷记忆与无损归档

### 6.1 生命周期状态机

项目目录新增 `project.json`，持久化：

```text
projectId / displayName / canonical cwd
status: active | archived
lastActiveAt / archivedAt
schemaVersion
```

状态由真实 session 使用时间计算：

| 闲置时间 | 状态 | 行为 |
|---|---|---|
| 0–30 天 | hot | 正常注入并刷新 `lastActiveAt` |
| 31–90 天 | cold | session 启动时询问是否恢复热记忆 |
| >90 天 | archive-due | 原子移动到 `archive/projects/<id>` |
| 已归档 | archived | 不注入、不参与普通搜索，可显式搜索/恢复 |

边界明确使用 `>30` 和 `>90`，所以第 30/90 天仍属于前一区间，第 31/91 天才发生状态变化。

### 6.2 为什么 activity 来自 session_start

旧实现只在 memory save/extract 时 touch marker，会把“持续开发但没有产生新记忆”的项目误判为闲置。Block 2 在 Pi `session_start` 处理真实项目使用：

- hot：直接刷新；
- cold + Yes：刷新并恢复热注入；
- cold + No：本 session 保持冷态，不刷新；
- cold + 无 UI：fail closed，保持冷态；
- archive-due：先归档，不刷新。

### 6.3 无损归档语义

归档不是删除：

```text
memory-v1/projects/<id>
  --rename-->
memory-v1/archive/projects/<id>
```

rename 在同一个 memory root 下完成。移动前先把 metadata 写为 archived；恢复时反向 rename，再写 active metadata。自动路径没有永久删除接口。

普通 prompt/search 不扫描 archive。`SearchMemory.includeArchived=true` 是显式冷查询；`/memory-restore` 经确认后恢复热态。归档期间 project SaveMemory 被拒绝，global SaveMemory 不受影响。

### 6.4 Pi 接入

- `session_start`：执行状态判断、30 天确认和 90 天自动归档；
- `before_agent_start`：根据本 session cold/hot 决策，只组合 global 或 global + project；
- `/memory-status`：显示状态、闲置天数和 project id，不输出正文；
- `/memory-archive`：确认后手动无损归档；
- `/memory-restore`：确认后恢复；
- SearchMemory 默认不搜归档，只有 `includeArchived` 才搜索。

### 6.5 验收证据

确定性测试使用 fake clock 覆盖阈值后一毫秒、第 30/31、90/91 天边界、每次真实 user turn 的 activity 刷新、无损归档、默认隐藏、显式 archived search、cold/archive 恢复、归档写保护，以及 Extension 的 Yes/No/无 UI 行为。读取与归档共享 repository lock，避免归档完成后仍从旧 active 目录返回部分 prompt/search 结果。

真实 Pi smoke 使用临时 Memory Root 和真实 TUI：

1. 写入一个 `lastActiveAt` 为 31 天前的项目规则；
2. 启动真实 Pi CLI，`session_start` 弹出“恢复项目热记忆？”；
3. 选择 Yes；
4. 发送第一条消息；
5. 本地 mock provider 在真实模型请求中观察到 `Block 2 Cold Rule`，返回 `COLD_MEMORY_INJECTED`。

该 smoke 只使用 `/tmp`，未读写用户真实 memory。

### 6.6 Block 2 面试问题

#### Q9：为什么 30 天只变冷，不直接归档或删除？

30 天在真实开发中很常见，例如季度项目轮换、等待上游或长假。冷态给用户一次显式恢复决策，避免旧上下文自动污染当前工作，也不造成数据损失。

#### Q10：为什么 90 天归档而不是删除？

磁盘成本远低于错误删除的恢复成本，尤其记忆可能包含历史架构决策。归档让热 prompt、普通搜索和缓存不承担成本，同时保留审计与恢复能力。

#### Q11：为什么归档用 rename？

active 和 archive 位于同一 filesystem root，同文件系统 rename 能让目录在观察者眼中从一个完整位置切换到另一个完整位置，避免逐文件 copy 中途出现半归档状态。跨设备 root 不在本设计范围内。

#### Q12：用户拒绝恢复后，global memory 为什么还可见？

用户拒绝的是当前项目的陈旧上下文，不是全局沟通偏好。global 与 project 生命周期独立，既保持产品语义，也避免一个冷项目冻结所有跨项目偏好。

## 7. Block 3：Pi 原生 Branch-aware 异步提取

### 7.1 为什么从 cron 改为 Agent 生命周期

旧 cron 扫描整个 session 目录并猜“最新 JSONL”，不知道当前 leaf、废弃 branch、compaction、queued continuation，也复制了 provider/auth 逻辑。Block 3 使用：

- `agent_settled`：自动 retry、compact-and-retry 和 queued continuation 全部结束后再提取；
- `ctx.sessionManager.getBranch()`：只快照当前活动 branch；
- `session_tree`：取消旧 branch 的在途提取；
- `session_shutdown`：取消并有界等待，不让任务无限悬挂；
- `pi.appendEntry()`：checkpoint 作为 custom entry 写入 session tree，不进入 LLM context。

后台任务不持有可变 `ctx`：在 `agent_settled` 同步捕获 cwd、session ID、model、ModelRegistry 和 branch 的防御性快照，然后只使用 snapshot。这样 session replacement 后不会读取新的 runtime 状态或向错误 branch 前移 checkpoint。

### 7.2 Branch-local checkpoint

checkpoint 包含：

```text
extractor version
source hash
last processed entry ID
branch leaf ID
saved count
```

恢复时只扫描 `getBranch()` 中 `customType=triple-pi-memory-checkpoint` 的最后一条，因此切换 branch 会自然恢复该 branch 自己的处理边界。只有 provider 成功、输出通过严格解析并完成全部 persistence 后才 append checkpoint；provider/storage 失败不会跳过输入，可以在后续 settled 重试。

### 7.3 Provider 与认证边界

提取默认复用当前 `ctx.model`：

```text
ctx.modelRegistry.getApiKeyAndHeaders(model)
→ @earendil-works/pi-ai/compat complete()
```

不读取 `auth.json`，不通过 key 前缀猜 provider，不硬编码 endpoint，并传递 AbortSignal。这样 OAuth、custom provider、headers、base URL 和用户当前模型行为都由 Pi 的 canonical runtime 处理。

### 7.4 严格、fail-closed 的第一版提取

第一版不恢复旧 Deep Sleep/六维评分，只建立可信输入门：

1. 发送前对常见 API key、AWS key、private key、password/token assignment 做 redaction；
2. Provider 必须返回纯 JSON array；
3. 每项必须且只能包含 category/title/content/evidence/sourceEntryId/scope；
4. category/scope 使用 allowlist，字段有长度和候选数上限；
5. evidence 必须是指定 **user entry** 的逐字 substring；assistant 文本不能作为证据；
6. redacted placeholder 不能成为记忆；
7. malformed JSON、额外字段、幻觉 evidence 任一出现时整批 fail closed；
8. 最终写入复用 canonical repository，并记录 session/sourceEntry provenance。

此处故意先追求 precision、grounding 和可重试性。评分、纠正、合并属于 Block 4，不能在基础协议未稳定时一起调试。

独立复核后进一步收紧：

- malformed/截断/错误 evidence 与合法 `[]` 分离；前者抛错且不 checkpoint，只有合法空数组才推进；
- provider 的 `length/toolUse/error/aborted` 都视为失败，只有 `stop` 可解析；
- 在途提取期间的新 `agent_settled` 保存 latest pending snapshot，当前任务结束后自动补跑，不吞最后一轮；
- tree/shutdown 会清空 pending、abort 当前批次，repository 在 commit 前再次检查 signal；
- 候选以 project-scoped `sourceHash` manifest 做批次幂等，重放不会刷新 `updatedAt` 或重复调模型；entry 写入失败会按原内容回滚，manifest 只在整批 entry commit 后生成；
- cold/archive 项目不启动自动提取，不能绕过用户的恢复决定；
- secret detector 增加 GitHub PAT、Bearer、Google key、Slack token、JWT，并对 provider 返回内容再次检测；
- 调用 native provider `streamSimple()`，支持 ambient auth、动态 auth base URL 与 extension custom provider，不绕过 Pi provider runtime。

### 7.5 验收证据

确定性测试覆盖 current branch、branch-local checkpoint、稳定 source hash、严格 schema/evidence、secret 双向检测、provider/validation 失败不保存、合法空结果 checkpoint、sourceHash 幂等重放、provenance 和 abort-before-call。

真实 Pi CLI smoke：

1. 使用临时 Pi config、session dir 和 memory root 启动真实 TUI；
2. 用户输入 `Always use strict TypeScript for this project.`；
3. 主 Agent 返回后触发真实 `agent_settled`；
4. Extension 使用当前 mock provider 做第二次异步提取调用；
5. canonical repository 写入 `Block 3 Extracted Rule`；
6. session JSONL 追加 `triple-pi-memory-checkpoint`，包含 sourceHash、lastEntryId、leafId 和 savedCount；
7. entry provenance 包含真实 session ID、user sourceEntryId 和 sourceHash。

Smoke 全程位于 `/tmp`，未读写用户真实 memory。

### 7.6 Block 3 面试问题

#### Q13：为什么用 `agent_settled`，不用 `agent_end`？

`agent_end` 后 Pi 仍可能自动重试、压缩后重试或处理 queued follow-up。`agent_settled` 才表示本轮不会自动继续，能避免提取半成品或同一逻辑被多次处理。

#### Q14：为什么 checkpoint 放 session tree，不只放全局文件？

Pi session 是 append-only tree。checkpoint 作为 custom entry 会随 branch 继承和切换，既不进入模型上下文，也能避免废弃 branch 与当前 branch 共用一个全局 offset。

#### Q15：为什么 evidence 必须来自 user message？

Assistant 可能幻觉或只是提出建议。长期记忆应保存用户明确表达的偏好、规则和事实；assistant 内容只可作为解释上下文，不能自我证明。

#### Q16：为什么 malformed 候选整批拒绝？

自动后台任务没有人在场逐条审核。第一版宁可牺牲 recall，也不能把部分可信、部分越界的数据混合写入。后续可以加入逐项 manifest 和隔离审核，但默认必须 fail closed。

#### Q17：为什么后台任务不能直接保留 `ctx`？

Extension runtime 在 reload、resume、fork 或 new session 时会失效。异步持有 `ctx` 可能读取另一个 session 或调用 stale runtime API。同步创建不可变 snapshot，使后台任务的身份、branch 和模型边界固定。

## 8. Block 4：纠正、Grounded Review 与 Consolidation

### 8.1 设计原则

旧实现把未经校准的六维浮点分数作为 admission gate，reviewer 可以自由改写，Jaccard 相似后直接 append。Block 4 不复用这些危险写法，采用：

```text
strict extraction
→ stable signals
→ grounded review
→ deterministic consolidation plan
→ transactional repository batch
```

浮点 score 只作为可审计信号写入 provenance，不单独决定 admission；候选仍必须通过严格 evidence 和 reviewer。

### 8.2 Stable fingerprint 与 project-scoped reinforcement

fingerprint 基于 scope/category 与 title+content 的规范化 Unicode token 集合，不使用 LLM 每次可能变化的原始 title 作为历史 key。

reinforcement state 按 canonical project ID 存入：

```text
signals/<project-id>/reinforcement.json
```

key 同时包含 scope 与 fingerprint：

- project memory、source manifest 和 reinforcement 在项目间完全隔离；共享 global record 不会让另一个项目误判相同 source 已完成；
- global 信号仍记录在哪个 project context 中观察到，避免项目 A 的重复自动抬高项目 B；
- 只有通过 strict validation + review 并进入最终 consolidation plan 的 source 才更新；
- sourceHash manifest 让同 source replay 不重复计数。

### 8.3 Correction signal

Correction 只从 user evidence 中具有方向性的明确语言检测；普通否定规则（如 `do not use unsafe any`）不视为 correction，避免把补充约束误当替换。例如：

```text
actually / correction / instead / do not / no longer
更正 / 不是…而是 / 不要再 / 改成 / 以后用
```

它提高可审计 score，并允许在同 scope + category 内对 fingerprint 或高相似旧记录生成 `replace` plan。Correction 不能绕过 secret、grounding 或 review，也绝不跨 category 替换。

### 8.4 Grounded Review

所有非空候选都执行同一 review，不再有“候选少于 3 条就跳过”。Reviewer 只能返回 keep/remove 和原样字段：

- 不能改 title/content/evidence/sourceEntryId；
- 返回数量和顺序必须与输入一致；
- strict JSON schema；
- malformed、未知字段、改写或 count mismatch 整批 fail closed；
- review 输入包含 candidate 以及对应完整 user message，能识别“README 引用了规则但用户明确否定”这类断章取义；
- review 后再次检查 user evidence 和 secret；
- 同标题候选不会在 review 前丢弃，避免 correction 因 provider 输出顺序被静默吞掉。

该限制牺牲 reviewer 的自由合并能力，换来可证明的 grounding。内容重写必须等将来有逐句 evidence mapping 后再开放。

### 8.5 Deterministic consolidation

分层规则：

1. 同 project + sourceHash：manifest no-op；
2. 同 scope + category + semantic fingerprint：普通候选 skip，纠正候选 replace；
3. 同 scope + category 且 token Jaccard ≥ 0.72：普通候选作为 near-duplicate skip，明确纠正才 replace；
4. 不同 category 永不自动合并；
5. 无匹配则 create。

Replace 使用明确的 existing record ID，保留原 `createdAt`，更新 content/title/provenance，并记录 `revisionOf`。不再追加无限 `### Updated` 文本。

### 8.6 Transaction 与审计

同一个 repository lock 内提交：

- create/replace entry；
- project-scoped reinforcement state；
- source manifest；
- 派生 index。

entry 写入失败会恢复旧内容或删除本批新文件。Manifest、reinforcement 和 metadata 都纳入备份/回滚边界；manifest 最后发布，因此同 source 重放不会重复调用 review、刷新 updatedAt 或增加 reinforcement。Reinforcement 在 repository lock 内做增量更新，不使用锁外算出的绝对值，避免多 Pi 进程丢计数。`replaceRecordId` 必须是 32 位 hex，且目标必须属于同 project/scope/category；同一批不能多次写同一目标。

Record provenance 记录：

```text
sessionId / sourceEntryIds / sourceHash
fingerprint / score / reinforcement / correction / revisionOf
```

### 8.7 验收证据

确定性测试覆盖：stable fingerprint、project reinforcement 累积、普通否定不误判 correction、同标题候选全部进入 review、review keep/remove、review 改写/格式/count mismatch fail closed、同 fingerprint skip、category isolation、grounded correction replace、unsafe replacement ID、repository-lock 内增量计数，以及全部 Block 1–3 回归。

真实 Pi 双阶段 smoke：

1. 用户在真实 TUI 输入 `Actually, use GraphQL instead of REST for this project.`；
2. 主 Agent 返回后，`agent_settled` 发起 extraction；
3. extraction candidate 进入第二次 Grounded Review 调用；
4. reviewer 原样 keep；
5. repository 写入 `Project API protocol`；
6. provenance 记录 `score=0.95`、`reinforcement=3`、`correction=true`、fingerprint、真实 session/source IDs；
7. session JSONL 追加 savedCount=1 的 checkpoint。

Smoke 使用临时 config、session 和 memory root，没有读写用户真实 memory。

### 8.8 Block 4 面试问题

#### Q18：为什么 score 不作为写入阈值？

旧 relevance 词表、recency 和 diversity 都未经校准，单一阈值会系统性漏掉简洁但重要的规则。Block 4 把 score 作为可观察特征，真正 admission 仍由 strict grounding、统一 review 和 deterministic plan 共同决定。

#### Q19：为什么 reviewer 不允许改写？

自由改写后必须证明每个新结论仍被 transcript 支持。没有逐句 evidence mapping 时，最安全的做法是 reviewer 只做 keep/remove；否则第二次 LLM 会破坏第一层 grounding 保证。

#### Q20：为什么 correction 才允许自动 replace？

普通语义相似可能只是两个细微不同的规则。用户明确纠正包含方向性，才足以授权替换；即便如此，也限制在同 scope/category 和确定性高相似目标内。

#### Q21：为什么 frequency 不统计 assistant 复述？

Assistant 复述不是独立观察，会制造虚假“高频”。Reinforcement 只来自通过 review 的 user evidence，并以 distinct source manifest 保证重放不重复计数。

## 9. Block 5：Daily/Scratchpad 工作状态分层

### 9.1 三层时间模型

Block 5 将数据明确分成：

| 层 | 目录 | 用途 | 默认检索 |
|---|---|---|---|
| 长期记忆 | `entries/` | 稳定规则、决策、偏好、知识 | SearchMemory long-term |
| Scratchpad | `working/SCRATCHPAD.md` | 当前请求与最近 outcome | 仅 prompt + 显式 working search |
| Daily | `daily/YYYY-MM-DD.md` | 每次 settled 的按日时间线 | 最近一天 prompt + 显式 working search |

Working 文件不位于 `entries/`，因此 repository long-term list/search/consolidation 不会把它们当长期 Memory。

### 9.2 Grounded Working State

Working state 不再调用额外 LLM。它从当前 branch、working checkpoint 之后的真实 user/assistant message 确定性生成：

```text
Current Request = 最新 user text
Latest Outcome = 最新 assistant text
Source entries = 两个真实 entry IDs
```

写盘前复用 Block 3 secret redaction。内容有硬上限：Scratchpad 8,000 字符，单日 Daily 64,000 字符；prompt 只读取 8,000 Scratchpad + 最近 Daily 尾部 12,000 字符。

### 9.3 Branch-local Working Checkpoint

使用独立 custom entry：

```text
triple-pi-working-checkpoint
```

它与长期 extraction checkpoint 分离，记录 working sourceHash、lastEntryId 和 leafId。相同 source 通过 project-scoped working manifest 幂等，重放不会重复追加 Daily。

### 9.4 生命周期与检索

- `agent_settled` 先写 derived working state，再启动长期 extraction；working 失败不阻塞长期记忆；
- cold/archive 项目不会更新 working state；
- cold/archive prompt 不注入 Scratchpad/Daily；
- project 归档时 working/daily 随整个项目目录一起 rename；恢复后一起回来；
- SearchMemory 默认仍只查 long-term；显式 `scope=working` 才查询 Scratchpad/最近 Daily；
- prompt 明确标记 Working State 是 temporary context，不得当作 durable truth 或自动晋升。

### 9.5 验收与复核修正

确定性测试覆盖：branch delta、working checkpoint、secret redaction（包括带空格引号值）、Scratchpad 上限、按日滚动、source 幂等、多 session 新旧顺序、working/long-term 搜索隔离、cold 项目搜索隔离和 prompt 注入。

真实 Pi 跨 session smoke：

1. session 1 输入 `Fix the checkout race condition.`；
2. settled 后写 per-session Scratchpad、Daily、working manifest 与 branch checkpoint；
3. Scratchpad 记录真实 user/assistant source entry；
4. session 2 在同 cwd 启动；
5. `before_agent_start` 注入有界 Working State，mock provider 返回 `WORKING_STATE_INJECTED`。

独立复核后修正：

- assignment redaction 支持完整单双引号值，不残留后半段 secret；
- `scope=working` 服从 hot/cold/archive lifecycle；
- Scratchpad 改为 per-session 路径，project latest 按 `updatedAt` 选择，不因慢旧 session 回退；
- Daily 从 immutable working manifests 按事件时间重建，同 source crash/retry 不重复 append；
- working checkpoint 携带有界 state，tree 切换优先恢复目标 branch state，没有 checkpoint 时清除 project latest；
- tree 切换后的 pending extraction 不再被旧 generation finally 静默丢弃；
- prompt 根据当前 model contextWindow 动态分配 long-term/working 字符预算，再保持硬上限。

### 9.6 Block 5 面试问题

#### Q22：为什么 Working State 不直接交给提取 LLM 总结？

Scratchpad 需要低延迟、可重复和强 grounding。直接取最近 user/assistant 的确定性投影不会新增事实，也不增加第三次模型调用；更复杂的任务总结等有真实质量数据后再引入。

#### Q23：为什么 Daily 按日期分文件？

单一 DAILY.md 会无限增长，滚动和恢复困难。按日文件天然有界，归档简单，prompt 只需加载最近一天，同时保留本地可审计时间线。

#### Q24：为什么 Working Search 必须显式 scope？

临时进度与长期规则语义不同。默认混搜会让模型把“刚才尝试了 X”误当“以后必须用 X”。显式 scope 保持召回意图清晰。

## 10. Block 6：可复现 Eval 与 CI

### 10.1 为什么废弃旧“10/10”

旧 runner 的 category-only mustContain、默认 tolerance、stdout parser、重复对象 key、provider error→空结果和只运行 project A 会制造假阳性。Block 6 不再修改它；`eval:legacy` 只保留历史对照，默认 `npm run eval` 指向新 recorded gate。

### 10.2 Exact Ground Truth

新 case 使用结构字段：

```text
category / scope
exact title atoms / content atoms
user evidence atom
forbidden atoms
```

没有 free-text reason、默认 tolerance 或 category-only 成功。每条输出只能匹配一个 expected；匹配还要求真实 extraction provenance（sessionId、sourceEntryId、64 位 sourceHash）。额外记录与 forbidden 命中都计 false positive，缺失计 false negative。Noise case 只有真正空结果才是满分。

### 10.3 三层 Eval

#### Deterministic / Recorded

`eval:recorded` 使用 FIFO recorded provider 响应驱动真实 `provider.ts → strict pipeline → review.ts → signals/consolidation → repository`，检查最终磁盘 record、provenance 和项目隔离。它证明接线和确定性策略，不声称证明模型质量。

#### Live LLM

`eval:live` 是显式 opt-in：

```bash
TRIPLE_PI_EVAL_MODEL=provider/model TRIPLE_PI_EVAL_RUNS=3 npm run eval:live
```

它不猜模型、不复制 auth，使用 Pi ModelRuntime/ModelRegistry；每 case/run 使用独立临时 root。基础设施错误 exit 2，不伪装成正确空结果。报告 model、run 数、extractor version、逐 case failures、mean/variance/worst F1；任何 semantic failure exit 1。

#### Product Comparison

Offline product contract 比较：

- memory off：不注入；
- manual：真实 SaveMemory 确认工具调用后，由 next-session `before_agent_start` 召回；
- async：真实 `runExtraction → review → consolidation → repository` 验证 project isolation 和 correction 最终视图。

它评价用户可观察的 prompt/search 结果，而不只看候选日志；报告中的 visible 来自实际 prompt 命中，不复制 expected 值。

### 10.4 CI 发布门

GitHub Actions 在 Node 22.19.0：

```text
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` 已包含 `test/eval`，CI 不重复执行 recorded suite；push 只监听 main，PR 分支由 pull_request 触发，避免同一更新双跑。`tsconfig` 显式包含 `eval/**/*.ts`，所以 opt-in live runner 也受类型门保护。Live eval 不执行网络调用，避免凭证、成本和随机性污染确定性发布门。

### 10.5 验收证据

```text
15 deterministic test files / 90 tests passed
4 recorded eval files / 18 cases passed
typecheck passed（包含 eval/live-runner.ts）
git diff --check passed
live 未配置模型时 exit 2
```

Recorded full-stack cases逐个验证 extraction system prompt、第二次 review 调用、review 获得完整 user message、最终 repository exact metrics。Live 未配置 `TRIPLE_PI_EVAL_MODEL` 时明确 exit 2，确认默认路径不会猜模型或静默触网。

### 10.6 Block 6 面试问题

#### Q25：Recorded Eval 通过能证明模型效果吗？

不能。它证明 pipeline 接线、schema、repository 和 scoring 没回归；模型质量必须由版本固定、重复运行并报告方差的 live eval 衡量。

#### Q26：为什么基础设施失败要 exit 2？

认证或网络错误与“模型正确判断无记忆”语义完全不同。混为 `saved=[]` 会让 noise case 假通过，因此必须独立失败分类。

#### Q27：为什么不在 CI 跑 Live Eval？

CI 应可重复、无外部凭证、无随机成本。Live Eval 是发布前/模型升级时的统计门，不是每个 commit 的单元门。

## 11. Block 7：安装、诊断、Reset 与发布收口

### 11.1 安装器

`install-extension.mjs` 从脚本自身定位仓库，不依赖调用 cwd；支持 `PI_CODING_AGENT_DIR`，首次安装和重复安装幂等，能替换 broken/旧 symlink，但拒绝覆盖普通文件或目录。Setup 不安装 cron、不清理数据，最后运行只读 status。

### 11.2 只读诊断

`memory:status` 默认只输出版本、Node 兼容、extension installed、schema、project ID、lifecycle、counts、root mode 和安全布尔值，不输出正文、title、evidence、session ID、auth/header/env 或绝对路径；`--verbose` 才显示本机路径。Root 不存在时不创建、不 chmod、不拿会创建目录的 lock；mode 非 700 返回异常状态。

### 11.3 安全 Reset

默认 scope 是 current project。`--scope=all` 与 `--scope=legacy` 必须显式选择；先 `--dry-run`，交互输入精确 token 或自动化显式 `--yes`。目标必须位于 canonical/custom memory root，拒绝 `/`、HOME、`.triple-pi` 根和 symlink。Reset 不永久删除，而是同文件系统 rename 到 timestamp quarantine；不碰 Pi sessions、auth 和 extension。

### 11.4 发布元数据

- source/GitHub release：`1.0.0-rc.1`，package 保持 private；
- package.json 与 lockfile 版本一致；
- Node `>=22.19.0`；
- Pi submodule 固定且干净；
- 根 MIT LICENSE；
- legacy cron 不再安装，移除脚本只匹配历史 canonical entry/marker；
- `.claude`、coverage、logs 和临时 lock artifacts 不进入发布。

### 11.5 Block 7 面试问题

#### Q28：为什么 Status 必须只读？

诊断常在安装失败、权限异常时运行。若 status 自己 mkdir/chmod，就会改变被诊断状态、掩盖问题并违反用户预期，因此只允许 stat/read。

#### Q29：为什么 Reset 默认只处理当前项目且先 quarantine？

长期记忆删除不可逆，默认 all 会扩大误操作半径。项目级 scope + rename quarantine 把恢复成本降到最低，真正 purge 应是另一个显式维护动作。

#### Q30：为什么保留 package private 还设置版本？

当前 RC 是 source/GitHub release，不承诺 npm registry 安装；版本仍用于 schema、诊断、文档和 reproducible release 标识，private 防止误发包。

### 11.6 最终验收

```text
17 test files / 99 tests passed
recorded eval 4 files / 18 cases passed
typecheck passed
git diff --check passed
package/lock version 1.0.0-rc.1
Pi submodule pinned clean
```

新增脚本测试覆盖 custom Pi dir、首次/重复安装、broken symlink、非 symlink 拒绝、status missing root 无副作用、777 权限拒绝、reset dry-run 和 current-project quarantine。
