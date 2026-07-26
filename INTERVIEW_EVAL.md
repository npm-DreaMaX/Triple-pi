# Triple-pi Eval 系统面试指南

> 为什么旧系统宣称"10/10 全通过"是不可信的，以及我们如何建立一个真正能证明系统工作的验证体系。

---

## 背景：为什么要重做 Eval？

### 旧 Eval 的 10 个致命缺陷

旧 runner 宣称"10/10 case 通过"，但实际上：

**1. Category-only assertion**
```javascript
// 旧代码：只检查 category 字段
mustContain: [{ category: "rule" }]
// 如果 LLM 返回 { category: "rule", title: "随便编的", content: "胡言乱语" }
// → 通过！因为只检查了 category
```
现在：检查 category + scope + title atoms + content atoms + evidence atom + forbidden atoms。

**2. 默认 tolerance=1**
```javascript
// 旧代码的 "容错"
tolerance: 1
// minExpected: 1, tolerance: 1 → 允许 0 条结果，永远通过
// maxExpected: 0, tolerance: 1 → 允许 1 条结果（noise case 有结果也算通过）
```
现在：**没有 tolerance**。缺了就是 FN，多了就是 FP。

**3. Provider 错误 → 空结果 → 假通过**
```javascript
// 如果 LLM API 调用失败，返回空数组 []
// noise case（预期 0 条记忆）→ 空结果与预期匹配 → ✅ 通过
// 但实际上：根本没调用成功，不是"正确判断了没有记忆"
```
现在：基础设施错误 exit 2，和语义错误 exit 1 严格区分。

**4. 一个结果可以满足多个 expected**
旧代码的 matching 是 `for each prediction, for each expected, if match → count`。一条结果匹配到多个 expected 后可能产生"假 TP"。

现在：双向一对一匹配。一条 prediction 最多匹配一个 expected，一个 expected 最多被一条 prediction 满足。

**5. Correction case 的重复 key 覆盖**
```javascript
// JavaScript 对象的 key 重复取最后一个
{ title: "use-jwt", title: "use-oauth" }
// 只有 "use-oauth" 保留，"use-jwt" 被静默覆盖 → case 不完整
```

**6. Project isolation 只测了 project A**
只验证了 project A 的记忆在 project A 中可见，没验证 project B **不可见**。

**7. Cross-session 只是文本 marker**
不是真实的两个 Session 启动/新 prompt 注入，只是同一个 JSONL 里的 `--- NEW SESSION ---` 文本分割。

**8. knowledge case 的 minTotal=0**
"用户不熟悉某技术"的 case 设置 `minTotal=0`，永远绿——即使知识记忆完全没提取出来，也是 0 ≥ 0。

**9. stdout parser 解析文案而非数据结构**
旧 Eval 解析 `console.log` 的字符串输出做断言。输出文案改了 Eval 就挂，且没有任何类型安全。

**10. 没有测试整条链路**
只测了 extraction 候选输出，没测 review、consolidation、repository 写入、next-session recall 这些后续步骤。

### 面试话术

> "旧 Eval 的问题不是某几个 case 错了，而是整个验证框架不可信——category-only assertion 不检查实际内容、tolerance 容忍假阴性、provider 错误被当成正确结果、project isolation 没有反向验证。这说明：不能用看似通过的指标来证明质量，要检查指标本身是不是在测正确的东西。"

---

## 三层验证架构

```
Layer 1: Deterministic Tests (CI 门)
  npm test              → 99 tests, 0 network, 0 LLM
  npm run typecheck     → TypeScript 全项目类型检查

Layer 2: Recorded Full-Stack Eval (接线验证)
  npm run eval:recorded → 18 cases, mock LLM, 完整 pipeline

Layer 3: Live Eval (模型质量验证)
  npm run eval:live     → 真实 LLM, opt-in, 统计分布
```

### Layer 1: 确定性测试

**测什么**：代码逻辑的正确性，不依赖 LLM。

覆盖矩阵：
| 模块 | 测试文件 | 核心验证点 |
|---|---|---|
| project-identity | `project-identity.test.ts` | cwd hash 稳定性、同 basename 隔离、特殊字符 |
| repository | `repository.test.ts` | 项目隔离、createdAt 保留、路径穿越、索引重建、损坏隔离、20 并发、索引失败不报假错 |
| lifecycle | `lifecycle.test.ts` | 30/90 天阈值、fake clock 边界、冷态确认、归档写保护 |
| extraction source | `extraction-source.test.ts` | branch delta、checkpoint、source hash 幂等 |
| extraction pipeline | `extraction-pipeline.test.ts` | secret redaction、strict validation、evidence 校验、schema rejection |
| review | `review.test.ts` | keep/remove、改写拒绝、格式错误拒绝 |
| signals+consolidation | `signals-consolidation.test.ts` | fingerprint 稳定、correction 检测、分层匹配、category 隔离 |
| working-state | `working-state.test.ts` | scratchpad 生成、daily 滚动、source 幂等、secret redaction |
| extension | `extension.integration.test.ts` | SaveMemory 确认/拒绝/无UI、before_agent_start 注入、SearchMemory |
| install/status/reset | `install-extension.test.ts` + `status-reset.test.ts` | 首次安装、重复安装、broken symlink、777 权限拒绝、dry-run |
| eval metrics | `metrics.test.ts` | TP/FP/FN 计算、F1、一对一匹配 |

**为什么不用 mock 文件系统**：repository 测试使用 `fs.mkdtemp` 创建真实临时目录，因为 `fs.rename`、`fs.chmod`、文件锁等行为在 mock 中不可靠。

### Layer 2: Recorded Full-Stack Eval

**原理**：用预定义的 FIFO recorded provider 替代真实 LLM。每个 test case 的"LLM 输出"是手写的，但走真实 pipeline 全链路。

```typescript
// recorded-cases.ts
function recordedOutput(testCase: EvalCase): RecordedEvalCase {
  // 把 expected memory 转换成"LLM 会返回的候选格式"
  const extraction = testCase.expected.map(e => ({
    category: e.category,
    scope: e.scope,
    title: e.titleIncludes.join(" "),
    content: e.contentIncludes.join("; "),
    evidence: extractEvidenceFromUser(testCase.user, e.evidenceIncludes),
    sourceEntryId: e.sourceEntryId,
  }));
  // Review 输出：全部 keep（因为这是正确答案的录制）
  const review = extraction.map(c => ({
    action: "keep", reason: "recorded grounded fixture",
    title: c.title, content: c.content,
    evidence: c.evidence, sourceEntryId: c.sourceEntryId,
  }));
  return { extraction, review };
}
```

**验证链路**：
```
recorded provider 输出（手写正确数据）
  → pipeline.ts validateCandidates()    ← 验证 schema/evidence
  → review.ts reviewCandidates()        ← 验证 review 流程
  → signals.ts scoreCandidate()         ← 验证 signal 计算
  → consolidation.ts planConsolidation() ← 验证去重策略
  → repository.saveExtractionBatch()    ← 验证事务写入
  → repository.list()                   ← 验证记录正确落盘
  → metrics.ts evaluateRecords()        ← 验证 F1=1.0
```

**Recorded Eval 证明什么**：整条 pipeline 的接线是正确的——数据从 extraction 流到 repository 的全过程没有逻辑错误。

**Recorded Eval 不证明什么**：LLM 真的能从任意对话中提取出正确记忆。那需要 Live Eval。

**Eval Cases**：
```
project-rule:      "Always run unit tests..." → 提取出 rule
global-preference: "Across all my projects..." → 提取出 global preference
correction:        "Actually, use JWT instead..." → correction 信号 + replace
noise-only:        "Try rerunning that once..." → 无记忆提取（空结果算满分）
knowledge:         "I have never used Rust..." → 提取出 knowledge
```

### Layer 3: Live Eval

**为什么是 opt-in**：
- 需要真实的 API key 和网络
- 产生 API 费用
- 结果有随机性（依赖 LLM 输出）
- 不适合做 CI 发布门

**使用方式**：
```bash
# 必须显式指定 model 和 runs
TRIPLE_PI_EVAL_MODEL=provider/model-name
TRIPLE_PI_EVAL_RUNS=3
npm run eval:live
```

**报告内容**：
```
Model: provider/model-name
Runs: 3
Extractor version: 1

Case results:
  project-rule:      3/3 ✓
  global-preference: 3/3 ✓
  correction:        2/3 ✓ (run 2: evidence mismatch)
  noise-only:        3/3 ✓
  knowledge:         3/3 ✓

Aggregate:
  mean F1:    0.933
  variance:   0.008
  worst F1:   0.800
```

**Exit codes**：
| Exit | 含义 | 示例 |
|---|---|---|
| 0 | 全部通过 | 所有 case semantic gate 满足 |
| 1 | 语义错误 | 模型输出不符合 ground truth |
| 2 | 基础设施错误 | API key 没配、网络不通、模型不存在 |

Exit 2 和 Exit 1 的分离至关重要——前者不是"模型不行"而是"没跑成"，不能混为一谈。

**为什么 Live 不进 CI？**
- CI 要求：可重复、无外部依赖、零额外成本
- Live Eval：有随机性（LLM 输出）、依赖 API key、产生费用

Live Eval 的正确用途：Provider/模型升级时、Prompt 调整后、RC 发布前的统计门。

---

## Exact Ground Truth 匹配机制

### Expected 定义

```typescript
interface ExpectedMemory {
  category: MemoryCategory;        // 精确匹配
  scope: MemoryScope;              // 精确匹配
  titleIncludes: string[];         // title 包含所有 atom → 满足
  contentIncludes: string[];       // content 包含所有 atom → 满足
  evidenceIncludes: string;        // evidence 包含 atom → 满足
  sourceEntryId: string;           // 精确匹配
  // 额外要求：sessionId 存在、64-char sourceHash 存在
}
```

### 匹配规则

```
对每条实际输出的 record：
  对每条 expected：
    如果 record.category === expected.category
      && record.scope === expected.scope
      && expected.titleIncludes 的所有 atom 都在 record.title 中
      && expected.contentIncludes 的所有 atom 都在 record.content 中
      && expected.evidenceIncludes 在 record.evidence 中
      && record.provenance.sourceEntryId === expected.sourceEntryId
      && record.provenance.sessionId 存在
      && record.provenance.sourceHash 是 64 位 hex
      → 匹配成功
```

### 双向一对一匹配

```typescript
// 不是简单的 for-for-if-match-count
// 而是：
// 1. 对每条 prediction，找最佳匹配的 expected
// 2. 对每条 expected，标记是否已被匹配
// 3. 不能一对多，不能多对一
function evaluateRecords(testCase, records) {
  const matchedRecords = new Set();
  const matchedExpected = new Set();

  for (const expected of testCase.expected) {
    const match = records.find(r =>
      !matchedRecords.has(r.id) && matches(r, expected)
    );
    if (match) {
      matchedRecords.add(match.id);
      matchedExpected.add(expected);
    }
  }

  const TP = matchedExpected.size;
  const FP = records.length - TP;           // 多出来的记录
  const FN = testCase.expected.length - TP; // 没匹配上的 expected
  // 还有 forbidden 检查：任何 record 包含 forbidden atom → 额外 FP
}
```

---

## Product Eval

Product Eval 不测内部日志或候选列表，只测用户可观察到的行为。

| 模式 | 验证内容 |
|---|---|
| memory off | 系统 prompt 不含 Memory 索引 |
| manual | SaveMemory 确认后，下一个 Session 的 before_agent_start 注入索引 |
| async | runExtraction → review → consolidation → repository 后，最终 prompt 可见记忆 |

关键：`visible` 字段来自真实的 prompt 命中，不是复制 expected 值。

---

## 面试 Q&A

**Q: 为什么 Eval 分三层而不是一个 test suite 全搞定？**

> 因为验证的目标不同。确定性测试验证代码逻辑不依赖 LLM——改了 consolidation 逻辑后不用花钱调 API 就能知道对不对。Recorded Eval 验证整条 pipeline 接线——确保 extraction → review → repository 的数据流是通的。Live Eval 验证模型质量——测的是 LLM 在真实对话上的表现。混在一起的话，LLM 的随机性会污染确定性测试的结果。

**Q: Recorded Eval 100% F1 能说明什么？**

> 只说明 pipeline 接线和确定性逻辑是正确的。不能说明 LLM 在实际使用中会表现好。类似于——你测试了水管没有漏水（Recorded），但没测试水源是不是干净的（Live）。

**Q: 为什么 Live Eval 要跑多轮（runs=3）？**

> LLM 输出有随机性（temperature > 0 时）。单次的 F1 可能是运气好或运气差。3 次可以报告 mean + variance + worst，能看到最差情况——在大厂场景中，最差情况的 F1 往往比平均 F1 更重要。

**Q: 为什么没有 coverage 目标（比如 80%）？**

> 行覆盖率是一个质量信号但不是目标。repository 的 archive/restore 路径、abort 路径、并发测试——这些都是关键路径但难以用覆盖率衡量。我们选择了关键路径全覆盖的策略（每个模块的核心行为都有 case），而不是追求覆盖率数字。

**Q: 旧 Eval 最大的教训是什么？**

> 1. 不能只测"理想路径"——provider 失败、无 UI 环境这些异常路径必须覆盖。2. 指标要测对东西——category-only assertion 测的不是记忆质量。3. 负向测试同样重要——不仅要证明"该有的有了"，还要证明"不该有的没有"。4. 随机系统的测试结果不能用 tolerance 修饰——应该报告分布。
