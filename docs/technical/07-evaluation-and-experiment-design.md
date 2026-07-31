# 07. 评估与实验设计：从指标公式到可复现实验

> **校正声明**：本章按“缺陷修复后的目标语义”撰写。case 数量、字段匹配规则、reviewer pilot 参数、trace schema、退出码和统计实现必须由最终源码校正。公式描述的是目标测量语义；若当前实现不同，不应靠修改文字掩盖，而应明确差异并决定修代码、修测试或修实验定义。

## 1. 先区分三个问题

LLM 系统最常见的评估错误，是拿一个“全通过”数字同时回答三个不同问题：

```text
代码逻辑正确吗？        -> Deterministic tests
全链路接线正确吗？      -> Recorded/Faux full-stack eval
真实模型效果好吗？      -> Live statistical eval
```

推荐验证金字塔：

```text
                   Live Eval
              真实模型，统计质量
             /                  \
       Recorded Full-Stack Eval
      固定输出，真实 pipeline 接线
     /                            \
 Deterministic Unit/Integration Tests
       无网络、快速、CI 发布门
```

上层不能替代下层：真实模型偶然答对，不能证明 parser 的所有失败分支正确；recorded provider 全通过，也不能证明模型能从自然语言中提取正确记忆。

---

## 2. Layer 1：确定性测试

### 2.1 测量目标

- 数据结构与状态机；
- secret redaction；
- evidence grounding；
- reviewer keep/remove；
- repository 隔离、锁、原子写入；
- Git 三棵树采集；
- chunk/coverage；
- failure taxonomy；
- metrics 实现自身。

### 2.2 为什么文件系统应尽量真实

对 `rename`、权限位、symlink、文件锁和并发，mock fs 往往模拟了错误语义。更好的方式：

```ts
const root = await fs.mkdtemp(join(tmpdir(), "triple-pi-test-"));
try {
  // 在真实临时目录执行 repository / git / lock 测试
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
```

确定性不等于“所有依赖都 mock”；它意味着输入和结果可控、无外部随机性。

---

## 3. Layer 2：Recorded Full-Stack Eval

Recorded provider 使用手写输出，但走真实 pipeline：

```text
recorded output
   v
candidate parse/validation
   v
review keep/remove
   v
signal scoring
   v
consolidation planning
   v
repository commit
   v
repository list
   v
evaluateRecords
```

它证明：

- 测试 case 真的抵达 provider；
- provider 返回真的经过验证与 review；
- repository 真实写入结果与 evaluator 对接；
- trace 与 failure status 没丢。

它不证明模型质量，因为 recorded output 本来就是人工写对的。

### 3.1 Recorded eval 的危险假象

如果 recorded case 只断言 category：

```text
expected category = rule
predicted category = rule, title/content 全错
```

仍可能通过。因此 expected slot 应至少约束：

```ts
interface ExpectedMemory {
  category: Category;
  scope: Scope;
  titleIncludes: string[];
  contentIncludes: string[];
  sourceEntryId: string;
}
```

还应验证 provenance source、session、source hash 与 evidence grounding。

---

## 4. Layer 3：Live Eval

### 4.1 Opt-in 与失败分层

```text
exit 0: 所有运行基础设施成功，语义门也通过
exit 1: 基础设施成功，但存在 semantic failure
exit 2: provider/认证/pipeline/存储等 infra failure
```

优先级：

```text
infra > semantic > pass
```

为什么 infra 必须优先？考虑 noise case：

```text
expected = []
provider 崩溃 -> repository 仍为空
naive evaluator: predicted=[] -> “完美拒绝噪声”
```

这是虚假通过。只有 pipeline status 成功，空预测才有语义资格参与评分。

### 4.2 多次运行

单次 live 输出是样本，不是结论。对每个 case 运行 `R` 次：

```text
case_i -> run_1 ... run_R
```

记录每次原始输出和失败，不只记录均值。小样本时不要过度解释 p95 或正态假设。

---

## 5. 一对一匹配

设 expected slots 为 `E={e1,...,em}`，预测记录为 `P={p1,...,pn}`。匹配关系 `M ⊆ E×P` 必须满足：

```text
每个 expected 至多匹配一个 prediction
每个 prediction 至多匹配一个 expected
```

否则一个宽泛记录可能同时“填满”三条 expected，虚增 recall。

### 5.1 贪心与最大匹配

当前简单实现通常按 expected 顺序贪心：

```pseudo
for e in expected:
  choose first unused p that matches(e, p)
```

复杂度 `O(mn)`，但结果可能依赖数组顺序。若匹配规则重叠，应构建二分图并求最大匹配：

```text
Expected side       Prediction side
 e1  ───────────── p1
 e2  ───── p1, p2
 e3  ───────────── p2
```

最大基数匹配能减少顺序偏差；若匹配有质量分数，可求最大权匹配。是否需要升级，应由 case 歧义率决定。

### 5.2 匹配谓词

目标谓词示例：

```text
match(p,e) =
  category equal
  AND scope equal
  AND all titleIncludes present
  AND all contentIncludes present
  AND provenance.source = extraction
  AND sourceEntryId present
  AND sessionId non-empty
  AND sourceHash valid SHA-256
  AND evidence grounded
```

`includes` 是可解释的确定性近似，不是语义相似度。它适合回归门，但对同义表达 recall 较低。不要把 substring evaluator 的结果宣传成“语义准确率”。

---

## 6. TP、FP、FN 与污染惩罚

### 6.1 基本计数

```text
TP = 成功的一对一可信匹配数
FN = expected 总数 - TP
FP = 未匹配预测数 + policy penalty
```

### 6.2 Forbidden 内容

如果匹配记录同时含 forbidden 内容，它不能既算 TP 又被当作污染。目标语义：

```text
matched + contaminated -> 从 TP 降级，并产生失败证据
```

若 forbidden 惩罚是“预测级最多一次”：

```text
FP = unmatchedPredictionCount + I(anyForbiddenHit)
```

其中 `I(condition)` 是指示函数，真为 1，假为 0。

必须在报告中把这条规则写清楚，因为另一个合理定义是“每条污染记录一个 FP”。不同定义会产生不同数值，不能混用。

---

## 7. 指标公式

### 7.1 Precision

```text
Precision = TP / (TP + FP)
```

解释：被系统持久化的内容中，有多少是对的。

若 `TP+FP=0`，precision 数学上未定义，目标表示为 `null`，而不是 1。

### 7.2 Recall

```text
Recall = TP / (TP + FN) = TP / |E|
```

解释：应该提取的内容中，有多少被提取。

若 `|E|=0`，recall 同样设为 `null`，不把 noise case 混入 positive recall。

### 7.3 F1

```text
F1 = 2PR / (P + R)
```

若 P 或 R 为 `null`，F1 为 `null`；若 P=R=0，则 F1=0。

### 7.4 False Discovery Rate

```text
FDR = FP / (TP + FP) = 1 - Precision
```

在 precision 定义域内成立。Memory 系统通常 precision-first，因为错误记忆会跨 session 持续污染。

### 7.5 Noise Rejection Rate

对 noise case 集合 `N`：

```text
noiseRejected_i = I(|E_i|=0 AND pipelineSuccess_i AND FP_i=0)
NRR = Σ noiseRejected_i / |N|
```

若 pipeline 失败，该 observation 不得记作 reject success；应归入 infra failure。

### 7.6 Reviewer Filter Ratio

```text
FilterRatio = removed / reviewerInput
```

它不是质量指标。过滤 100% 可能是 reviewer 很好，也可能是把正确候选全删了。必须与 precision/recall 联合分析。

### 7.7 Success Rate

```text
PipelineSuccessRate = successfulPipelineRuns / attemptedRuns
```

不要把 semantic pass rate 与 pipeline success rate 混成一个数：

```text
semanticPassRate = semanticPasses / infrastructureSuccessfulRuns
```

---

## 8. Macro、Micro 与分层汇总

### 8.1 Macro

对有定义的 positive case 指标取平均：

```text
MacroF1 = (1/K) Σ F1_i
```

每个 case 权重相等，适合看场景覆盖。

### 8.2 Micro

先合并计数：

```text
MicroPrecision = ΣTP / (ΣTP + ΣFP)
MicroRecall    = ΣTP / (ΣTP + ΣFN)
```

预测/expected 多的 case 权重大，适合看总体记录级表现。

### 8.3 为什么两个都要报告

假设：

```text
Case A: 20 expected, F1=0.95
Case B: 1 expected, F1=0
```

Micro 可能仍很好，但 Macro 会暴露系统完全失败的少数场景。反之，一个大 case 的灾难会被 Macro 稀释。

### 8.4 Noise 与 Positive 分开

推荐 summary：

```text
Positive: Macro P/R/F1, Micro P/R/F1, worst-case F1
Noise: NRR, noise FP count
Infra: failure count/rate by kind
Cost: tokens and latency
```

不要给 noise case 人工赋 F1=1 再放进 MacroF1。

---

## 9. 方差、置信区间与最坏表现

### 9.1 样本均值与方差

对 R 次运行指标 `x1...xR`：

```text
mean = (1/R) Σ x_r
sample variance = (1/(R-1)) Σ (x_r - mean)^2
standard deviation = sqrt(variance)
```

`R=1` 时方差没有估计意义。

### 9.2 Worst/Best

```text
worstF1 = min(valid F1 observations)
bestF1  = max(valid F1 observations)
```

Agent 产品中 worst case 往往比均值更有工程价值，因为单次错误记忆会长期存留。

### 9.3 Bootstrap 置信区间

当指标分布非正态、样本有限，可对 observation 重采样：

```pseudo
for b in 1..B:
  sample R observations with replacement
  theta[b] = metric(sample)
CI95 = percentile(theta, 2.5%, 97.5%)
```

必须明确重采样单位：按 run、按 case，还是按 paired case-run。不能把同一 case 的重复运行当完全独立而忽略聚类。

### 9.4 百分位延迟

排序延迟 `l_(1) <= ... <= l_(n)`，nearest-rank 定义：

```text
p95 = l_(ceil(0.95n))
```

不同库的插值方法不同。小样本下 p95 几乎等于最大值，报告时必须注明样本数和算法。

---

## 10. Reviewer 实验：Paired Design

问题：注入 relevant Memory 是否改善 Reviewer？

### 10.1 配对实验

同一 case、同一 repo snapshot、尽可能同一模型配置，分别运行：

```text
Treatment: with relevant memory
Control:   without memory
```

配对差值：

```text
Δ_i = metric_i(with) - metric_i(without)
Average Treatment Effect estimate = mean(Δ_i)
```

配对能控制 case 难度差异，比两组独立 case 更有效。

### 10.2 顺序偏差

总是先 without 再 with，可能受缓存、provider 热身或限流影响。应随机化或 AB/BA 平衡：

```text
一半 case: A then B
一半 case: B then A
```

如果系统使用 prompt cache，必须记录 cache read/write token；否则 latency 差异可能只是缓存差异。

### 10.3 控制变量

```text
- 同一 commit/worktree snapshot
- 同一 diff chunking
- 同一 task
- 同一 model/provider/effort
- 同一 timeout
- 同一 parser 版本
- 同一 memory 候选集（treatment 只改变注入）
```

### 10.4 Reviewer 指标

仅统计 finding 数会鼓励多报。建议：

```text
finding precision
finding recall
F1
false positive per case
critical/high recall
coverage-complete rate
failure rate by kind
latency/token delta
worktree-changed count
```

finding 匹配同样应一对一，并允许行号容忍窗口，例如 `|predictedLine-expectedLine| <= k`，但 k 必须预注册，不能看结果后调大。

### 10.5 不静默删除失败 pair

若 treatment success、control provider-failed，不能只保留“完整 pair”并让失败消失。报告至少分为：

```text
paired semantic observations
unpaired treatment failures
unpaired control failures
all raw observations
```

---

## 11. 实验预注册与防止调参污染

在跑 live eval 前冻结：

```text
- case set 与 hash
- expected/forbidden
- matching rule
- runs
- timeout
- model/provider 参数
- primary metric
- pass threshold
- exclusion rule
- failure taxonomy
```

如果看完结果再改 tolerance、forbidden 或阈值，原结果只能算开发集调参，不能再当无偏测试集结果。

推荐数据划分：

```text
Development set -> prompt 与 pipeline 调试
Validation set  -> 选择阈值/版本
Holdout set     -> 最终一次报告
```

对于 case 很少的项目，至少保留一组从未用于 prompt 调试的挑战样本。

---

## 12. 可复现证据包

每次 live run 应保存：

```json
{
  "model": "explicit-model-id",
  "provider": "provider-name",
  "runs": 3,
  "commit": "...",
  "dirty": false,
  "runtimeCommit": "...",
  "node": "v...",
  "generatedAt": "ISO-8601",
  "caseHash": "...",
  "promptHash": "...",
  "extractorVersion": 2,
  "reviewerEnabled": true
}
```

以及：

- 全量 JSONL trace；
- 每个 case/run 原始模型文本；
- parse/validation/review/commit status；
- latency 与 token usage；
- 最终记录；
- evaluator 版本。

### 12.1 Hash 的边界

只 hash prompt 模板但不 hash Memory 注入内容，仍不可复现。理想 hash 覆盖最终 provider 输入的规范化表示；敏感内容不能直接上传，但可以存 SHA-256 与本地受控原文。

### 12.2 Dirty 工作区

Dirty 不一定禁止运行，但结果必须标记。若源码、cases 或 prompt 未提交，commit SHA 单独不足以复现。

---

## 13. 阈值与发布决策

不要只写“F1 越高越好”。根据风险设门：

```text
Hard gates:
  infraFailureRate = 0 in recorded/CI
  noise false positive = 0 on security-sensitive cases
  worktreeChanged = 0
  schema false-pass = 0

Quality gates:
  MacroF1 >= target
  WorstCaseF1 >= floor
  NRR >= target

Budget gates:
  p95 latency <= SLO
  avg tokens <= budget
```

Precision-first Memory 的损失函数可以写成：

```text
Loss = λ_FP * FP + λ_FN * FN + λ_infra * InfraFailure
```

通常 `λ_FP > λ_FN`，且 `λ_infra` 不能通过 semantic 指标抵消。

---

## 14. 常见统计陷阱

### 14.1 把 `null` 变成 0 或 1

Undefined precision 不是 0，也不是 1。用 `null` 并分层汇总。

### 14.2 只报告均值

均值隐藏方差和灾难 case。至少报告 mean、variance/std、worst、样本数。

### 14.3 Case 泄漏

Prompt 中包含 case-specific 关键词或 expected 表述，会把 benchmark 变成背答案。

### 14.4 多重比较

同时试 20 个 prompt，只报告最好的一个，会高估真实效果。应保留 holdout 或校正比较。

### 14.5 Provider 失败被排除

“只统计成功请求”可能掩盖 30% failure rate。语义质量和可用性要分开，但都必须报告。

### 14.6 把自动 grader 当真值

LLM grader 也有偏差。关键 finding 应有人类标注，至少做双人抽样一致性或 adjudication。

---

## 15. 实验运行伪代码

```ts
for (const testCase of frozenCases) {
  for (let run = 0; run < RUNS; run++) {
    const trace = beginTrace(testCase, run, metadata);
    try {
      const pipeline = await runExtraction(testCase.input);
      if (!pipeline.ok) {
        trace.markInfra(pipeline.failureKind);
        continue;
      }

      const records = await repository.list();
      const metrics = evaluateRecords(testCase, records);
      trace.markSemantic(metrics);
    } catch (error) {
      trace.markInfra(classify(error));
    } finally {
      await trace.flushJsonl();
      await resetCaseIsolation();
    }
  }
}

const report = summarize(rawObservations);
process.exitCode = report.infraFailures > 0 ? 2
  : report.semanticFailures > 0 ? 1
  : 0;
```

`resetCaseIsolation()` 必须验证，而不是假定 repository 清空成功。

---

## 16. 面试问答

### Q1：为什么 noise case 的 F1 不设成 1？

**答**：expected 和 predicted 都为空时 precision、recall 没有定义。把 F1 设 1 会污染 positive macro，而且 provider 崩溃导致空结果时可能虚假满分。Noise 用独立的 rejection rate。

### Q2：Macro 和 Micro 哪个更重要？

**答**：没有单一答案。Macro 给每个 case 等权，暴露小场景完全失败；Micro 按记录量加权，反映总体吞吐质量。两者连同 worst case 一起报告。

### Q3：为什么一条预测不能匹配多个 expected？

**答**：否则宽泛记录会虚增 recall。一对一匹配把 TP 变成可解释的槽位填充问题；有重叠时应考虑二分图最大匹配。

### Q4：Recorded eval 全通过说明什么？

**答**：说明预定义输出能经过真实 pipeline 被正确验证、review、合并、持久化和评分；不说明真实模型能产生这些输出。

### Q5：为什么 infra failure 用 exit 2？

**答**：把“实验没有有效运行”和“实验运行了但质量不达标”分开。CI/自动化可以据此决定重试基础设施还是阻止语义发布。

### Q6：如何评估 Reviewer Memory 注入的收益？

**答**：对同一 case 和同一 repo snapshot 做 paired with/without-memory，随机化顺序，比较 finding P/R/F1、coverage、failure、latency 和 token 的配对差值。

### Q7：三次运行能报告 p95 吗？

**答**：可以机械计算，但几乎没有稳定统计意义，通常接近最大值。必须报告样本量和算法，不应以小样本 p95 做强结论。

### Q8：这个系统为什么 precision-first？

**答**：漏掉一条记忆通常可在后续 session 重试；错误记忆一旦持久化会跨 session 反复影响模型，因此 FP 的长期代价通常高于 FN。

---

## 17. 最终源码校正清单

- `evaluateRecords()` 的真实匹配顺序与 forbidden 降级算法；
- noise case 的 `null` 指标和 summary 排除逻辑；
- Macro/Micro 当前是否都实现；
- 方差、p95、p99 的准确公式与索引；
- live runner 的环境变量、模型配置和退出码；
- trace 是否记录 provider、runtime commit、prompt/case hash；
- reviewer pilot 的 case 数、runs、paired 顺序与成功 pair 处理；
- infra/pipeline failure 是否可能继续读取空 repository 并评分；
- evaluator 是否采用贪心匹配，以及是否需要最大匹配演进；
- 所有报告中的历史测试数量是否已移除或由机器生成。
