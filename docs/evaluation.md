# Evaluation 验证体系

## 三层验证

```
Layer 1: Deterministic Tests (CI 门)
  npm test              -> vitest, 0 network, 0 LLM
  npm run typecheck     -> TypeScript 全项目类型检查

Layer 2: Recorded Full-Stack Eval (接线验证)
  npm run eval:recorded -> 10 cases, mock LLM (FIFO recorded provider), 完整 pipeline

Layer 3: Live Eval (模型质量验证)
  npm run eval:live     -> 真实 LLM, opt-in, 统计分布
  npm run eval:reviewer-pilot -> Reviewer 效果对比
```

### Layer 1: 确定性测试

验证模块逻辑正确性，不依赖 LLM。覆盖：project identity、repository CRUD/隔离/并发、生命周期状态机、提取管线（secret redaction / validation）、review（keep/remove schema）、signals + consolidation、working state、extension integration、installer/status/reset、eval metrics。

测试使用真实临时文件系统（`fs.mkdtemp`），不 mock fs 操作——因为 `rename`、`chmod`、文件锁等行为在 mock 中不可靠。

### Layer 2: Recorded Eval

用预定义的 FIFO recorded provider 替代真实 LLM。每个 case 的 LLM 输出是手写正确数据，但走真实 pipeline 全链路：

```
recorded provider 输出 -> validateCandidates() -> reviewCandidates() ->
signal scoring -> consolidation planning -> saveExtractionBatch() ->
repository.list() -> evaluateRecords()
```

Recorded Eval 证明 pipeline 接线正确，不证明模型在真实对话上的表现。

### Layer 3: Live Eval

Opt-in，必须显式设置 `TRIPLE_PI_EVAL_MODEL`。报告 mean F1 / variance / worst F1 / best F1 / FP rate / noise rejection。退出码：0（全通过）、1（有 semantic failure）、2（有 infra/pipeline failure）。

## Failure Taxonomy

| 类别 | 退出码 | 示例 |
|---|---|---|
| Infrastructure | 2 | 模型未配置、认证失败、Provider 不可用 |
| Pipeline/Infra | 2 | runExtraction() 返回 ok=false |
| Semantic | 1 | 模型输出不符合 ground truth、FP/FN 不为零 |
| 全部通过 | 0 | 所有 case 无 failure |

优先级：infra > semantic > pass。

## 指标定义

**Per-Case**：
- TP = 记录匹配 expected（双向一对一），扣除含 forbidden 的降级 TP
- FP = 未匹配记录数 + 最多一次 forbidden 惩罚（所有 forbidden 内容合并算一次预测级 FP）
- FN = expected - TP
- Precision = TP / (TP + FP)；TP+FP=0 时为 null
- Recall = TP / expected.length；expected=0 时为 null
- F1 = 2 * P * R / (P + R)；任一为 null 时为 null
- noiseRejected = expected=0 且 predicted=0
- falseDiscoveryRate = FP / (TP + FP)
- caseFPIncidence = 导致 FP 的记录标题列表

**Macro**（computeSummary）：
- noiseObs 和 positiveObs 分别汇总
- positivePrecision/positiveRecall/positiveF1 排除 noise case
- noiseRejectionRate = noise 中被正确拒绝的比例

## 证据复现

每次 Live Eval 记录：
- 模型名、RUNS、case 数、extractor 版本、reviewer-on/off
- commit SHA、dirty flag、submodule SHA
- Node 版本、generatedAt
- 每个 case 的 prompt hash（SHA-256 前 16 位）
- 全量 trace JSONL（包含延迟、token、pipeline 状态）
- Per-case + per-run 原始结果

## 评审效果评估

Reviewer Pilot 使用固定 10 个 git diff case，每个 case 做 paired with-memory / without-memory（3 runs），共享同一个 repo snapshot。两组都用真实 SubAgentManager（生产路径）。记录 coverage、failure kind、findings、worktree snapshot（git diff --stat）、latency、tool calls。Summary 从 raw observations 计算，非 success pair 不被静默删除。
