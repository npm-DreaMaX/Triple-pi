# Triple-pi 技术面试深挖手册

> 目标不是背诵“做了一个 Memory 和 Reviewer”，而是能解释：边界在哪里、不变量是什么、为什么这样取舍、如何证明、哪里仍然不成立。
>
> 回答口径以当前源码为准。面试中宁可说清限制，也不要把设计意图、单元测试或本地原型夸大成生产保证。

## 1. 三档项目介绍

### 1.1 30 秒版本

Triple-pi 是建立在 Pi Extension API 上的本地 Coding Agent 增强层。它有两条主链路：一条把对话中的长期规则、偏好和决策经过脱敏、逐字 evidence 校验、二次 review、确定性 consolidation 后持久化；另一条收集 Git 变更和相关 Memory，启动隔离、只读的 Reviewer Session 做代码审查。工程重点不是“多调一次模型”，而是失败语义、可追溯 provenance、分支安全、补偿事务和不会把失败伪装成成功。

### 1.2 两分钟版本

系统通过统一入口 `extensions/index.ts` 注册 Memory 与 Reviewer，并共享一个 `FilesystemMemoryRepository`。

一个正常 turn 开始前，Memory 扩展在 `before_agent_start` 注入长期记忆索引；Working State 作为带 `derived/temporary/untrusted` 标记的 custom message 注入。turn 结束后，`agent_settled` 先从 branch delta 确定性生成 Working State，再把不可变 snapshot 交给后台 `ExtractionScheduler`。提取管线依次执行 source 构建、secret redaction、模型提取、严格 schema/evidence 校验、只允许 keep/remove 的 reviewer、信号计算、去重或纠正计划，最后在文件锁内批量提交 entry、revision、reinforcement、metadata 和最后发布的 manifest。

代码审查链路分别采集 staged、unstaged、untracked 变更，搜索相关长期记忆，按字符预算分片，再通过 `createAgentSession()` 启动 in-memory reviewer。resource loader 禁用扩展、技能、模板、主题和 context files；工具白名单只有 read/grep/find/ls。输出通过严格 JSON parser，timeout、provider、parse、schema、abort、worktree changed 都是不同失败类型。

验证分三层：确定性测试保护纯逻辑和本地文件系统行为；recorded provider 走完整提取链路，证明 wiring；live eval 必须显式提供模型，只测真实模型质量，并把 infra failure 与 semantic failure 分开。

### 1.3 十分钟展开顺序

1. 先画两个边界：turn lifecycle 与 reviewer lifecycle。
2. 解释为什么 Working State 和 Long-term Memory 物理、语义分层。
3. 展开自动提取的每个 fail-closed gate。
4. 讲 repository 的权威 entry、派生 index、manifest publish point。
5. 讲一个最有代表性的事故：fake success 或 scheduler stale pending。
6. 最后主动给出限制：不是 ACID、不是向量检索、不是强 sandbox、不是企业级多租户。

---

## 2. 架构总览题

### Q1：为什么用 Extension，而不是 fork Agent Runtime？

**标准回答**

Extension 提供生命周期 hook、tool/command 注册和当前 session context，足以实现注入、提取与 reviewer。这样不修改 runtime 核心，升级与部署边界更清晰。统一入口 `extensions/index.ts` 创建共享 repository，再分别注册两个模块，避免各模块自行初始化导致状态不一致。

**追问：Extension 的代价是什么？**

- 能力受 hook 时机和 context 暴露范围限制。
- 不能把 reviewer 调用“强制”为 runtime commit gate；当前主要靠工具描述提示 agent 在 commit 前调用。
- session/system prompt 的精确接线依赖 Pi SDK 支持；必须做真实 wiring 测试，不能只测字符串 builder。

**不能夸大**

不要说“零侵入所以绝对兼容未来版本”。Extension API、session message shape 和 provider contract 仍可能变化。

### Q2：系统最核心的不变量是什么？

**标准回答**

可以归纳为六条：

1. 自动记忆只能来自 user 原话的逐字 evidence，assistant 只能提供上下文。
2. 不确定、失败、超时或 schema 不合法时不提交 durable memory，也不推进 checkpoint。
3. project memory 只在对应 project 可见；global 自动提升必须有跨项目 evidence。
4. Working State 是 derived/temporary/untrusted，不能自动当作 durable truth。
5. Reviewer 失败、部分覆盖与“完整通过”必须区分。
6. manifest 是 batch 的 publish point，只有前序权威写入完成后才能发布。

**追问：这些不变量分别在哪里 enforcement？**

- evidence：`extraction/pipeline.ts::validateCandidates()`。
- reviewer 不可改写：`extraction/review.ts::reviewCandidates()`。
- scope guard：`validation.ts::resolveAutomaticScope()`。
- working contract：`working-state.ts` 的 strict parsers 与 `memory/index.ts::before_agent_start` 标签。
- reviewer failures：`subagent/types.ts::ReviewResultUnion` 与 parser。
- publish point：`repository.ts::saveExtractionBatch()` 最后写 manifest。

### Q3：为什么 Memory 和 Reviewer 要共享 repository？

**标准回答**

Reviewer 要检索 Memory 中的 rule/decision/preference。如果各自创建 repository，环境 root、生命周期视图或缓存策略可能漂移。统一入口把同一实例注入两者，使“被保存的规则”和“审查时搜索到的规则”处在同一个存储边界内。

**追问：同一实例是否等于跨进程一致？**

不等于。跨进程一致依赖 `proper-lockfile` 与原子文件替换，不依赖 JS 对象实例。共享实例只解决单扩展进程内的 wiring 一致性。

---

## 3. Working State 深挖

### Q4：Working State 与长期记忆为什么不能合并？

**标准回答**

两者的生命周期、可信度和召回方式不同：

| 维度 | Working State | Long-term Memory |
|---|---|---|
| 来源 | 最近 user/assistant 消息确定性投影 | 模型提取 + validation + review |
| 可信度 | 派生、临时、不可信 | 有 user evidence，但仍是系统记录 |
| 目的 | 接续当前任务 | 跨 session 保存规则、偏好、决策、知识 |
| 存储 | working/sessions、daily、latest、working-manifests | entries、revisions、extractions |
| 检索 | 显式 `scope=working` | 普通 SearchMemory/prompt index |
| 生命周期 | 跟随项目冷热与 branch checkpoint | hot/cold/archive 生命周期 |

合并会让 assistant 的临时自述通过普通 memory search 获得长期权重。

**追问：为什么 Working State 不用 LLM 总结？**

确定性取最后 user 和 assistant 文本，成本低、无额外模型失败面、sourceEntryIds 清晰。缺点是信息压缩能力弱，可能截断，也无法判断 assistant 自述是否真实。

### Q5：为什么把 `latestOutcome` 改成 `assistantReportedOutcome`？

**标准回答**

字段名应表达 provenance。assistant 说“测试通过”只是 report，不是已验证 outcome。改名防止读者或后续代码把模型自述当作外部事实。旧字段仍在 parser 中作为兼容 fallback，但标准输出只生成新字段。

**追问：那如何验证真实 outcome？**

当前没有结构化验证链。可扩展为保存 tool result、命令、exit code、artifact hash，并让 `verifiedOutcome` 只由可信执行事件生成。不能仅从 assistant text 推断。

### Q6：Working checkpoint 如何处理损坏？

**标准回答**

`findWorkingCheckpoint()` 从 branch 末尾向前扫描；遇到 matching custom entry 后调用 `parseWorkingCheckpoint()`。若损坏则跳过并继续找更旧的合法 checkpoint。这比“最新一条损坏就整个失忆”更可恢复。

**追问：严格校验有哪些？**

version、64 hex sourceHash、非空 entry/session、合法 ISO updatedAt、YYYY-MM-DD date 且与 timestamp 日期一致、请求/报告字段存在且不超长、sourceEntryIds 非空且最多 10、sessionKey 与 sessionId hash 匹配、内容不含 secret。

**不能夸大**

磁盘 `latest.json` 当前严格解析失败后还有 relaxed backward-compat fallback；因此不能说所有旧数据都绝对 fail-closed。

### 白板题 A：画出 branch switch 时 Working State 的恢复

建议画：

```text
branch A entries -> working checkpoint A(state A)
       |
       | session_tree
       v
branch B entries -> find latest valid working checkpoint B
       |
       +-- has valid state -> branchWorking[session] = B
       |                    setWorkingLatest(B)
       +-- none/corrupt ----> delete branchWorking
                            remove latest.json pointer
```

强调 checkpoint 在 session tree 内提供 branch-local truth，`latest.json` 只是项目级当前指针。

---

## 4. Extraction 深挖

### Q7：为什么 evidence 必须是 user message 的逐字子串？

**标准回答**

自动记忆会跨 session 反复影响决策，错误写入的长期成本高。逐字子串是一个可确定性验证的 grounding contract：candidate 的 `sourceEntryId` 必须指向 user message，`evidence` 必须被该 message `includes()`。这样至少能证明 evidence 没有由 assistant 或 extractor 凭空生成。

**追问：逐字 evidence 能保证 content 正确吗？**

不能。它只保证引用存在，不保证 candidate content 对引用的归纳完全忠实。二次 reviewer 过滤临时、可发现、unsupported 内容，但仍是模型判断。因此这是 precision guard，不是形式化语义证明。

### Q8：为什么 secret 要先 redaction，后 detection？

**标准回答**

防线分层：

1. provider 前先把已知 secret pattern 替换为 `[REDACTED_SECRET]`，减少敏感信息出进程边界。
2. candidate validation 拒绝引用 placeholder。
3. 对 provider 返回的 title/content/evidence 再做 secret detection，防止模型复原或生成敏感格式。
4. repository/manual path 还调用共享 validator，避免绕过工具层。

**追问：能说 100% 防泄漏吗？**

不能。正则只能覆盖已知格式，自定义 token、短 secret、自然语言密码都可能漏检。更强方案包括 entropy 检测、组织规则、DLP、最小化 provider 输入与用户可配置 denylist。

### Q9：为什么 reviewer 只能 keep/remove，不能改写？

**标准回答**

一旦 reviewer 可以改写 title/content/evidence，它就能引入没有出现在用户原话中的新事实。当前 review prompt 要求同数量、同顺序，所有 grounded 字段保持不变；代码逐项比较，不一致就整批失败。语言模型只承担筛选，不承担事实生成。

**追问：为什么不是让 reviewer 返回候选 ID？**

返回完整字段并逐项比较可以检测 reorder、rewrite 和 identity 漂移；但 token 成本更高。更简洁的协议可以使用 candidateId + action + reason，同时 candidateId 由确定性 hash 生成。无论采用哪种，reviewer 不应拥有内容写权限。

### Q10：为什么整个 candidate array 严格校验，而不是丢掉坏项保留好项？

**标准回答**

当前选择 batch fail-closed。坏项可能说明模型没有遵守 schema、出现注入或输出被截断；部分接受会让 checkpoint 推进后丢失同一 delta 中的其他候选。失败不写 checkpoint，下个 settled 可重试。

**追问：代价是什么？**

一个坏项会阻塞整批，降低 recall 和吞吐。未来可设计逐项 quarantine，但必须保证 checkpoint 与重试语义不会让好项重复、坏项永久丢失。

### Q11：`sourceHash` 和 checkpoint 分别解决什么？

**标准回答**

- checkpoint 的 `lastEntryId` 定义下一次 branch delta 起点。
- sourceHash 对当前 delta 的 entry IDs 与 message content 做内容寻址，用 extraction manifest 防止相同 source 重复提交。

checkpoint 是顺序进度，manifest 是幂等 publish 记录。只用 checkpoint 无法防重放；只用 hash 无法高效找增量。

### Q12：为什么空提取也推进 checkpoint？

**标准回答**

若模型成功返回合法 `[]`，这是业务结论“这段没有 durable memory”。不推进会在每次 settled 重复调用模型。与此相反，provider/parse/validation/storage failure 不能推进，因为没有形成合法结论。

### Q13：consolidation 的顺序是什么？

**标准回答**

同 scope/category 边界内按：

1. title 大小写归一后的 exact identity；
2. provenance fingerprint；
3. title+content token Jaccard，相似度至少 0.72；
4. 否则 create。

如果 signals 标记 correction，则命中项 replace；否则 skip 近重复。

**追问：为什么不用 embedding？**

当前数据量和本地可解释性优先，确定性规则便于测试和回放。代价是中英文 tokenization、同义表达和阈值泛化较弱。不能声称语义去重等价于向量检索。

### 白板题 B：完整画一条提取管线

```text
branch snapshot
  -> delta source(last checkpoint)
  -> sourceHash / idempotency check
  -> redact secrets
  -> extractor model
  -> strict JSON/schema/length/evidence/secret validation
  -> reviewer model: keep/remove only
  -> scoring + reinforcement
  -> consolidation: create/replace/skip
  -> locked batch commit
       revision snapshots
       head entries
       reinforcement
       project metadata
       manifest LAST
  -> append session checkpoint
```

在每条箭头旁标：失败是否写盘、是否推进 checkpoint。正确答案几乎都应是“不推进”。

---

## 5. Repository、并发与事务

### Q14：权威数据是什么？`MEMORY.md` 是数据库吗？

**标准回答**

权威数据是 `entries/<category>/<record-id>.md` 单条记录。`MEMORY.md` 是派生索引，写失败不影响 save 成功，可通过遍历 entries 重建。manifest 是 extraction batch 的发布/幂等标记，不是内容本体。

**追问：为什么 Markdown + JSON header？**

便于人读、备份和手工恢复，同时 metadata 可结构化解析。代价是搜索为目录遍历和 substring，规模大时性能有限，手工编辑也可能损坏 schema。

### Q15：并发安全是怎么做的？

**标准回答**

写操作通过 `proper-lockfile` 对 repository root 加跨进程排他锁；单文件写使用同目录 temp file + rename，读者不会看到半文件。读操作不拿写锁，因为 per-file replacement 具有可见性原子性；archive/list 等跨目录读取用 before/after 检查，位置变化则 retry once。

**追问：是不是线性一致？**

不是。多文件 batch 对无锁读者可能暴露中间组合；rename 的持久性也没有 fsync 保证。当前目标是单文件不撕裂、写者串行和可补偿恢复，不是数据库级 linearizability。

### Q16：为什么 manifest 最后写？

**标准回答**

`hasExtractionSource()` 以 manifest 判断 batch 是否已提交。如果 manifest 先写，后续 entry 失败会导致重试被永久跳过。最后写使它成为 publish point：只有前面的 revision/head/reinforcement/metadata 成功后才标记 source committed。

### Q17：补偿事务是不是 ACID？

**标准回答**

不是。实现先保存旧内容，按顺序写，失败时逆序恢复。它提供 best-effort rollback；rollback 自身可能失败，并且没有 WAL、fsync 或跨文件系统原子提交。准确名称是“文件级原子写 + 写锁内补偿事务”。

**追问：当前 metadata rollback 有什么风险？**

当前 batch 代码在完整备份前调用过一次 metadata 写，可能使 backup 捕获到新值；原先不存在的 project.json 也未在 rollback 中删除。这是应主动承认的遗留缺口。

### Q18：record ID 为什么是确定性的？

**标准回答**

ID 由 `scope/projectId/category/normalized title` hash 得到。manual same-title 更新可定位同一 record；path 不含用户 title，避免路径穿越。自动 create 若碰撞 existing record 会拒绝，必须显式 replace，避免模型候选覆盖手工权威记录。

### Q19：revision 机制如何工作？

**标准回答**

更新前把 previous head 保存为 immutable `MemoryRevision`，再写新 head。API 可 list/get revision。设计目标是可审计、可恢复。

**必须主动补充的限制**

当前 revision pointer ID 的 ownership 在 coordinator 与 repository 间重复，head pointer 与实际 snapshot ID 未被完整链式测试证明。可以说“保存了 revision snapshots”，不应说“已经有严格可遍历、引用完整的版本链”。

### 白板题 C：故障注入下的 batch commit

让面试官指定在第 N 步失败，然后逐项说明恢复：

```text
backup(write set)
  R1 revision -> R2 head -> S signal -> M metadata -> P manifest
                                      X failure
rollback: M <- old, S <- old, R2 <- old/delete, R1 delete
```

随后指出当前实现的 metadata 预写缺口，说明如何用纯 `buildMetadata` 消除 staging side effect。

---

## 6. Scheduler 与异步语义

### Q20：为什么不能在 `agent_settled` 里直接 await extraction？

**标准回答**

提取有两次模型调用和文件 I/O，直接 await 会增加交互尾延迟。scheduler 让 turn settle 后后台执行，只保留一个 in-flight 与最新 pending snapshot，并允许 shutdown/tree switch abort。

**追问：后台执行会引入什么新问题？**

snapshot 必须不可变；ctx 可能切 session/branch；迟到结果不能提交；pending 需要明确定义 offset；取消是协作式而非强制；shutdown 只有 1 秒等待窗口。

### Q21：generation、sessionId、branchLeafId 为什么都要检查？

**标准回答**

- generation 防 tree switch/shutdown 前启动的任务提交；
- sessionId 防不同 session 的 snapshot 混淆；
- branchLeafId 防同 session 不同树叶的迟到结果污染。

单个 generation 不足以表达业务身份；若 stale pending 能在重派时领取新 generation，还会复活，因此 job 应在入队时冻结 identity。

### Q22：AbortController 能强制取消 provider HTTP 吗？

**标准回答**

不能保证。它是协作式取消。调用方可以在 deadline 后返回并丢弃迟到结果，但底层 provider 请求是否立即停止取决于 SDK/transport 是否响应 signal。Reviewer manager 文档也明确承认底层 HTTP 可能继续。

### Q23：如何测试 scheduler race？

**标准回答**

不能只用普通 resolved promise。要用 deferred promise 控制 interleaving：启动 A、排 A2、切 B、让 A 迟到完成，断言无旧 checkpoint；再测试失败不推进、成功传播 offset、shutdown 后 late resolve。测试的是 happens-before，而不是单次函数输出。

---

## 7. Reviewer 深挖

### Q24：Reviewer 的隔离具体是什么？

**标准回答**

- `SessionManager.inMemory()`：独立、不持久化的会话。
- `DefaultResourceLoader` 禁用 extensions、skills、prompt templates、themes、context files。
- tools 白名单只有 read/grep/find/ls。
- 不传主 agent 对话历史，只传 task/diff/相关 memory。
- review 前后做 worktree snapshot comparison，发现变化则结果作废。

**追问：这是不是安全 sandbox？**

不是。它是应用层最小能力与上下文隔离。read/grep/find/ls 仍能读取 cwd 范围内数据；底层工具路径约束取决于 Pi；模型/provider 是外部信任边界；资源耗尽和网络侧信道也没有完全封闭。

### Q25：为什么同时要工具白名单和 worktree snapshot？

**标准回答**

白名单是预防控制，snapshot 是事后检测，属于 defense in depth。若未来 SDK、工具注册或扩展加载发生漂移，snapshot 可以发现 tracked/untracked 工作区变化并拒绝结果。

**追问：snapshot 能证明“没写任何文件”吗？**

不能。它主要观察 `git status --porcelain` 中路径及 `git hash-object`；被 ignore 的文件、仓库外文件、写后恢复原 hash、权限/mtime 变化可能不被检测。准确说法是“检测 Git 工作树内容变化”，不是完整文件系统审计。

### Q26：staged、unstaged、untracked 如何采集？

**标准回答**

分别使用 `git diff --cached --no-ext-diff`、`git diff --no-ext-diff`、`git ls-files --others --exclude-standard -z`。review chunks 按 staged > unstaged > untracked 排序。

**必须主动补充的缺口**

当前同一路径同时 staged 和 unstaged 时，unstaged entry 会被 path 去重掉。面试中不能声称完整覆盖这种状态；正确修复应保留 `(path,status)` 两个视图。

### Q27：为什么分片？coverage 如何定义？

**标准回答**

分片控制上下文大小，每个 chunk 独立 review，最后按 file/line/description hash 去重 finding，保留最高 severity。若所有 chunk 成功，coverage complete；有 chunk 失败则 partial。

**必须补充的缺口**

- 单文件超预算不会被内部拆分，chunk 可能超过上限。
- skipped binary/unreadable 尚未计入 final coverage。
- manager 对多 chunk 单次结果设置 partial，而真正 complete/partial 由 aggregator 决定；语义略混乱。
- 全 chunk 失败仍可能显示“未发现问题”，属于待修 fake success。

### Q28：如何防 prompt injection？

**标准回答**

设计上把 task/diff/memory 放在 user message 的 XML block，做 XML entity encode，并明确标为 untrusted/background；policy 要求忽略嵌入指令。更重要的是工具层没有 write/bash，即使模型服从恶意 diff，也缺少直接写工具。

**关键追问：policy 真正送到 reviewer 了吗？**

当前 `ReviewOptions.systemPrompt` 被构造并传给 manager，但 manager 实际只 `session.prompt(userMessage)`，没有使用该字段。这是已识别的 wiring gap。因此应说“输入 builder 已构造 policy，但当前运行时接线需修复和端到端测试”，不能说 prompt policy 已被运行时保证。

### Q29：strict parser 为什么拒绝额外字段？

**标准回答**

Agent 输出是协议，不是方便的自然语言。额外字段可能代表模型漂移、注入或版本不兼容；宽松接受会把未知语义吞掉。parser 只允许 status/summary/findings，并校验每个 finding 与 status 一致性。

### Q30：Reviewer 怎么使用 Memory？

**标准回答**

从 task、路径、diff 的类型/符号/词项提取至多 15 个 search terms；逐词调用 repository substring search，按 title hit、命中词数量、category、scope、updatedAt 稳定排序，最多取 5 条，格式化为 background memory。

**追问：为什么不是把全部 Memory 注入？**

减少 token、噪声和不相关规则冲突。代价是 substring recall 有限，关键词提取可能漏规则，因此不能承诺相关规则必然召回。

### 白板题 D：Reviewer fan-out/fan-in

```text
Git states -> ChangeFile views -> skipped accounting -> chunks
                                          |          |
Memory search ----------------------------+          v
                                                reviewer sessions
                                             / success / failure
                                                    |
                                             typed aggregation
                                      findings + coverage + failure kinds
                                                    |
                                      compare worktree snapshot
                                                    |
                                     complete pass / issues / partial / failed
```

重点是 aggregate 不能只看 findings；必须同时携带 coverage 和 failure set。

---

## 8. Metrics 与实验设计

### Q31：为什么三层 Eval 不能合成一个 E2E？

**标准回答**

验证目标不同：

- deterministic tests：代码逻辑、文件系统和边界，无网络、稳定、适合 CI。
- recorded eval：recorded provider 给固定输出，但走真实 validation/review/consolidation/repository，验证 wiring。
- live eval：真实模型输出，测语义质量、方差和失败率。

混合会让模型随机性污染 CI，也会让 recorded 的满分被误解为模型能力。

### Q32：TP/FP/FN 如何定义？

**标准回答**

每条 expected 最多匹配一条 record，每条 record 最多占一个 expected。匹配要求 category、scope、title/content 子串、extraction provenance、sourceEntryId、sessionId 和 64 hex sourceHash。未匹配 record 是 FP，未填 expected 是 FN。forbidden 命中可把匹配记录从 TP 降级，并施加至多一次 prediction-level penalty。

### Q33：为什么 noise case 的 F1 是 null？

**标准回答**

expected=0、predicted=0 时 precision 是 0/0，F1 没有定义。把它写成 1 会抬高 positive macro。正确做法是单独标记 `noiseRejected`，positive metrics 排除 noise，另报 noise rejection rate。

### Q34：infra failure 为什么要 exit 2？

**标准回答**

provider 失败后空 repository 恰好匹配 noise expected=0，曾产生 fake success。exit code 分层：infra/pipeline=2，semantic=1，全部通过=0，优先级 infra > semantic > pass。这样 CI/脚本不能把“没跑起来”当成“质量好”。

### Q35：怎样保证报告可复现？

**标准回答**

记录 model、runs、reviewer toggle、Node 版本、commit SHA、dirty flag、submodule SHA、case hash、prompt hash、per-run raw results 与 trace。报告数字应能从 raw observation 重算。

**不能夸大**

模型服务本身可能更新；temperature/provider server version 未必完全固定；dirty flag 只说明有改动，不包含完整 patch。它提升可追溯性，不等于 bit-for-bit 可复现。

### Q36：当前汇总指标还有什么风险？

**标准回答**

`computeSummary()` 分别过滤 precision 和 recall 后按 index 配对，可能在 undefined precision 位于中间时错配；noise with FP 也可能被归入 positive observations。正确做法是基于 observation 构造 tuple 后整体过滤，并把 case type 显式写入 observation。

### 白板题 E：设计一个不会 fake pass 的 observation schema

建议字段：

```text
observationId, caseId, runId
executionStatus: success | infra-failed | aborted | invalid-output
semanticCaseType: positive | noise
TP, FP, FN (仅 executionStatus=success 有效)
precision?, recall?, f1?
noiseRejected?
failureKinds[]
model/prompt/source/commit hashes
```

先按 executionStatus 分桶，再算 semantic metrics。

---

## 9. 安装、运行与环境

### Q37：为什么安装器曾经“成功”但 Reviewer 不存在？

**标准回答**

旧脚本只链接 `extensions/memory`。Reviewer 源码存在，但没有进入 runtime loader。修复是统一 `extensions/index.ts`，安装整个 `extensions/` 到 `extensions/triple-pi`，并共享 repository。这个事故说明部署图比源码图更重要。

### Q38：安装器如何处理已有路径？

**标准回答**

相同正确 symlink 幂等返回；broken 或指向其他位置的 symlink 会替换；普通目录拒绝覆盖；legacy memory symlink 会迁移。之后还尝试把 `bin/trip` 链接到 `~/.local/bin` 或 `~/bin`。

**追问：迁移逻辑是否过宽？**

当前脚本会删除任何 symlink 形式的 legacy `extensions/memory`，没有先证明它属于本项目。这可能误删用户其他 memory extension 链接，应改为 realpath allowlist 后再迁移。

### Q39：为什么 Live Eval 要求显式 env？

**标准回答**

`TRIPLE_PI_EVAL_MODEL=provider/model` 是 opt-in gate。无 env 立即 exit 2，不猜默认模型、不静默触网。RUNS 也限制 1..10。认证交给 Pi ModelRegistry，不在 Triple-pi 重复硬编码 provider secret。

**追问：如何测试 no-env？**

用子进程和最小 env，断言在 runtime 初始化前退出、无网络、无结果文件。installer 则用临时 HOME 验证默认路径，不能继承真实开发机环境。

---

## 10. 行为面试故事模板

### 故事 1：从 fake success 到 typed failures

**Situation**：明显有问题的 diff 被显示“未发现问题”。

**Task**：证明是模型真的通过，还是审查根本失败。

**Action**：沿 parser → manager → formatter 追踪，发现 parse 的 failed 被 manager 固定包装成 success，空 findings 又被 formatter解释为 pass。引入判别联合，严格 schema，并为 parse/provider/timeout/worktree-change 分别显示。

**Result**：direct reviewer path 不再把 parse failure 显示为通过；同时进一步发现 multi-chunk 聚合仍有同类缺口，说明修复要沿全链路验证。

**面试加分点**：主动讲“为什么旧测试复制 parser 所以漏掉 wiring”。

### 故事 2：noise eval 的满分其实是 provider 崩了

**Situation**：noise-only case 异常稳定地满分。

**Action**：区分业务空结果与 infra failure；precision 0/0 改为 null；增加 noiseRejected；exit code 分层；记录环境 metadata。

**Result**：基础设施失败不能再借空 repository 冒充正确拒绝。

### 故事 3：安装后的产品少了一半

**Situation**：源码里有 Reviewer，标准 setup 后工具不存在。

**Action**：从 installer symlink 追到 runtime entry，建立统一入口、共享 repository、迁移旧链接和安装测试。

**Result**：部署路径覆盖两模块。随后提出 install → load → enumerate tools 的更强 smoke test。

### 故事 4：异步调度中的 stale pending

**Situation**：branch switch 后旧 pending 可能在新 generation 中复活。

**Action**：把问题建模为 job identity 与 enqueue-time generation；设计 deferred promise 的交错测试；提出 immutable job、清 stale queue 和 checkpoint offset 单点推进。

**面试加分点**：不要假装当前已完全修复；准确说明发现与应改设计。

---

## 11. 高频反问与标准答案

### Q40：为什么不用数据库？

小规模、本地、人可读和零服务依赖优先。文件系统模型便于检查与备份。随着数据量、多进程查询、版本链和事务需求增长，SQLite/WAL 会更合适；当前设计不是为了替代数据库。

### Q41：为什么 project ID 用 realpath(cwd) hash，不用 Git remote？

monorepo 中多个子项目共享 remote，remote 粒度太粗；cwd 天然隔离。realpath 统一 symlink。代价是同一 repo 的不同 clone/path 被视为不同项目，需要显式 alias 才能合并，目前 alias 能力有限。

### Q42：为什么是 30/90 天？

这是产品启发式，不是从大规模数据学习出的最优阈值。30 天冷态要求用户恢复，90 天归档通过 rename 无损移出热路径。应通过真实使用数据校准，不能包装成科学最优。

### Q43：为什么 score 不直接作为准入阈值？

未经校准的词表与权重容易系统性漏掉短但重要的规则。当前 score 主要作为 provenance 信号，真正准入由 strict validation、review 和 consolidation 决定。若未来阈值化，需要 labeled dataset、precision/recall 曲线和漂移监控。

### Q44：如果 reviewer 搜不到相关 memory 呢？

审查仍运行，但缺少项目规则背景。memory search failure 当前是 non-fatal。结果不能证明所有项目规则都被检查，只能说明在实际召回上下文下完成了审查。

### Q45：如何支持多用户/团队？

当前不支持。需要 identity/ACL、共享存储、并发冲突解决、租户隔离、审计日志、删除/合规策略和 server-side secret controls。不能直接把本地目录放到共享盘就称为团队版。

### Q46：如何删除错误记忆？

当前主要有 reset/archive/restore 与 revision read 能力，没有完整的用户级编辑、定点 rollback、tombstone 和因果传播 UI。手工改文件可能损坏 schema，不应作为正式答案。

### Q47：如果模型一直返回 malformed JSON？

管线 fail-closed、不写 checkpoint，后续 settled 会重试；这可能形成重复成本。应增加 bounded retry/backoff、diagnostics 和人工可见 failure state，避免 silent retry storm。当前 diagnostics 接线并不完整。

### Q48：系统如何观测故障？

提取返回 telemetry，repository diagnostics 类型定义了 running/pending/failure/rollback/corrupt counts，live eval 有 traces。但当前若干字段固定为 false/0，scheduler diagnostics 未完整接到持久状态，因此只能说“有 telemetry/diagnostics 结构与部分报告”，不能说已实现完整生产监控。

---

## 12. 不能夸大清单

面试中以下说法应替换为更准确版本：

| 不要说 | 应该说 |
|---|---|
| Production-ready | RC/本地原型，确定性测试较充分，未做企业级 soak 与多租户验证 |
| ACID 事务 | 写锁内的单文件 atomic rename + 多文件 best-effort rollback |
| 完全防崩溃/断电 | 避免半文件可见；无 fsync/WAL，断电持久性不保证 |
| Reviewer 绝对只读 | 工具注册表只给只读工具，并检测 Git worktree 变化；不是 OS sandbox |
| 完整审查所有变更 | 设计采集三类 Git 变更，但同文件 staged+unstaged、binary/skipped、oversize 仍有 coverage 缺口 |
| Prompt injection 已解决 | 有输入编码和最小工具；policy system prompt 当前存在 runtime 接线缺口 |
| Evidence 保证记忆正确 | evidence 证明引用存在，不证明归纳语义完全正确 |
| 100% secret 防护 | 多种已知正则 + 多层检测，仍可能漏自定义/短 secret |
| 语义搜索 | 关键词 substring search + deterministic ranking |
| 严格版本链 | 有 revision snapshots；pointer 引用完整性仍需修复与链式回归 |
| Metrics 完全正确 | per-case noise/failure语义已收紧；summary tuple 配对仍有缺口 |
| Branch-safe scheduler 已完全闭合 | 有 generation/session/leaf gate；stale pending/offset 仍需专门交错测试与修复 |
| 可完全复现实验 | 记录关键 metadata；外部模型服务版本与随机性仍不可完全冻结 |
| 自动强制 commit 前审查 | tool description 要求调用，但不是 Git hook/runtime 硬门 |

---

## 13. 面试前自测题

如果以下问题不能在白板上回答，就不应只背介绍：

1. provider 返回 `[]` 与 provider 抛异常，checkpoint 有何不同？
2. 为什么 manifest 必须最后写？如果最后写失败，哪些文件要恢复？
3. 同文件 staged+unstaged 时当前代码会发生什么？
4. 15KB 单文件放入 10KB chunk budget 时当前算法会发生什么？
5. 为什么 `assistantReportedOutcome` 不是事实？
6. global scope downgrade 后当前 provenance 为什么会丢 requested scope？
7. reviewer system prompt 在真实 session 中是否已接线？如何证明？
8. 所有 chunk parse failure 且 findings 为空时，当前 UI 是否可能 fake pass？
9. tree switch 前 pending snapshot 为什么可能在新 generation 复活？
10. 为什么 temp+rename 不是断电安全？
11. head revision pointer 是否一定能找到真实 snapshot？
12. noise case 为什么不能用 F1=1 表示？
13. recorded eval 能证明模型质量吗？
14. reviewer worktree snapshot 能检测 ignored file 写入吗？
15. installer symlink 存在能否证明所有 tools 已注册？

一个成熟回答的结构应始终是：

> **先给 contract，再给实现位置，再讲失败路径和测试，最后主动限定保证范围。**
