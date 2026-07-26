#!/usr/bin/env node
/**
 * Live Eval Runner — 使用真实 LLM 运行所有 eval case。
 *
 * 用法：
 *   TRIPLE_PI_EVAL_MODEL=provider/model TRIPLE_PI_EVAL_RUNS=5 npm run eval:live
 *
 * 输出：
 *   - 每个 case × 每轮运行的逐条指标
 *   - 汇总统计（mean F1, variance, worst F1, false positive rate）
 *   - ExtractionTrace JSONL（写入 eval/results/ 目录）
 *   - TraceSummary（延迟分布、token 消耗、reviewer 过滤率）
 *
 * Exit codes:
 *   0 — 全部 semantic gate 通过
 *   1 — 模型输出不符合 ground truth
 *   2 — 基础设施错误（未配置模型、认证失败等）
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "./cases.ts";
import { evaluateRecords } from "./metrics.ts";
import { FilesystemMemoryRepository } from "../extensions/memory/repository.ts";
import { runExtraction } from "../extensions/memory/extraction/coordinator.ts";
import {
  generateTraceId,
  summarizeTraces,
  type ExtractionTrace,
  type TraceSummary,
} from "./trace.ts";

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const RUNS = Number(process.env.TRIPLE_PI_EVAL_RUNS || "5");
const MODEL_SPEC = process.env.TRIPLE_PI_EVAL_MODEL;
const RESULTS_DIR = process.env.TRIPLE_PI_EVAL_RESULTS_DIR ||
  path.join(import.meta.dirname, "..", "eval", "results");

if (!MODEL_SPEC || !MODEL_SPEC.includes("/")) {
  console.error("=".repeat(60));
  console.error("Live Eval — 需要显式指定模型");
  console.error("=".repeat(60));
  console.error("");
  console.error("用法:");
  console.error("  TRIPLE_PI_EVAL_MODEL=provider/model \\");
  console.error("  TRIPLE_PI_EVAL_RUNS=5 \\");
  console.error("  npm run eval:live");
  console.error("");
  console.error("示例:");
  console.error("  TRIPLE_PI_EVAL_MODEL=openai/gpt-4o npm run eval:live");
  console.error("");
  console.error("Live eval 是 opt-in 的——不猜模型，不静默触网。");
  process.exit(2);
}

if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 10) {
  console.error("TRIPLE_PI_EVAL_RUNS must be an integer from 1 to 10.");
  process.exit(2);
}

// ═══════════════════════════════════════════════════════════════
// 初始化 Pi Runtime
// ═══════════════════════════════════════════════════════════════

const [providerId, ...modelParts] = MODEL_SPEC.split("/");
const modelId = modelParts.join("/");

console.error(`\nLive Eval — ${MODEL_SPEC} × ${RUNS} runs × ${EVAL_CASES.length} cases\n`);

let runtime: ModelRuntime;
let modelRegistry: ModelRegistry;
let model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

try {
  runtime = await ModelRuntime.create();
  modelRegistry = new ModelRegistry(runtime);
  const selectedModel = runtime.getModel(providerId, modelId);
  if (!selectedModel) throw new Error(`Model not found: ${MODEL_SPEC}`);
  model = selectedModel;
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!modelRegistry.getProvider(model.provider)) {
    throw new Error(`Provider unavailable: ${model.provider}`);
  }
} catch (error) {
  console.error("Infrastructure initialization failed:", error);
  process.exit(2);
}

// ═══════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════

const root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-live-eval-"));

function branch(user: string, assistant: string): SessionEntry[] {
  return [
    {
      type: "message", id: "u1", parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: user, timestamp: Date.now() },
    },
    {
      type: "message", id: "a1", parentId: "u1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistant }],
        timestamp: Date.now(),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      },
    },
  ] as SessionEntry[];
}

interface CaseResult {
  run: number;
  caseId: string;
  metrics: ReturnType<typeof evaluateRecords>;
  trace: ExtractionTrace;
}

// ═══════════════════════════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════════════════════════

const allResults: CaseResult[] = [];
const allTraces: ExtractionTrace[] = [];

try {
  for (let run = 0; run < RUNS; run += 1) {
    console.error(`Run ${run + 1}/${RUNS}...`);

    for (const testCase of EVAL_CASES) {
      const repository = new FilesystemMemoryRepository({
        root: path.join(root, `run-${run}`, testCase.id),
      });
      const trace: ExtractionTrace = {
        traceId: generateTraceId(),
        sessionId: `live-${run}-${testCase.id}`,
        projectId: testCase.id,
        sourceMessageCount: 0,
        sourceCharCount: testCase.user.length + testCase.assistant.length,
        redactedSecretCount: 0,
        extractionRawLength: 0,
        candidateCount: 0,
        validationRejectedCount: 0,
        reviewerInputCount: 0,
        reviewerKeptCount: 0,
        reviewerRemovedCount: 0,
        savedCount: 0,
        createdCount: 0,
        replacedCount: 0,
        skippedCount: 0,
        extractionLatencyMs: 0,
        reviewLatencyMs: 0,
        commitLatencyMs: 0,
        totalLatencyMs: 0,
        status: "success",
        timestamp: new Date().toISOString(),
        extractorVersion: 1,
      };

      const t0 = Date.now();

      try {
        const result = await runExtraction(repository, {
          cwd: testCase.cwd,
          sessionId: trace.sessionId,
          branch: branch(testCase.user, testCase.assistant),
          branchLeafId: "a1",
          model,
          modelRegistry,
        }, new AbortController().signal);

        trace.totalLatencyMs = Date.now() - t0;
        trace.savedCount = result.savedCount;

        if (result.status === "no-source") {
          trace.status = "no-source";
        }
      } catch (error) {
        trace.totalLatencyMs = Date.now() - t0;
        trace.status = "commit-failed";
        trace.errorMessage = error instanceof Error ? error.message : String(error);
      }

      const records = await repository.list(testCase.cwd);
      const metrics = evaluateRecords(testCase, records);
      allTraces.push(trace);

      allResults.push({ run, caseId: testCase.id, metrics, trace });

      const status = metrics.failures.length === 0 ? "✓" : "✗";
      console.error(`  ${status} ${testCase.id}  F1=${metrics.f1.toFixed(2)}  P=${metrics.precision.toFixed(2)}  R=${metrics.recall.toFixed(2)}  TP=${metrics.truePositive} FP=${metrics.falsePositive} FN=${metrics.falseNegative}`);
      if (metrics.failures.length > 0) {
        for (const f of metrics.failures) console.error(`    └ ${f}`);
      }
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════════════

const f1Values = allResults.map((r) => r.metrics.f1);
const meanF1 = f1Values.reduce((a, b) => a + b, 0) / f1Values.length;
const varianceF1 = f1Values.reduce((s, v) => s + (v - meanF1) ** 2, 0) / f1Values.length;
const worstF1 = Math.min(...f1Values);
const bestF1 = Math.max(...f1Values);

const precisionValues = allResults.map((r) => r.metrics.precision);
const meanPrecision = precisionValues.reduce((a, b) => a + b, 0) / precisionValues.length;

const recallValues = allResults.map((r) => r.metrics.recall);
const meanRecall = recallValues.reduce((a, b) => a + b, 0) / recallValues.length;

const falsePositives = allResults.filter((r) => r.metrics.falsePositive > 0).length;
const fpRate = allResults.length > 0 ? falsePositives / allResults.length : 0;

// 按 case 聚合
const caseAgg: Record<string, { f1s: number[]; failures: number }> = {};
for (const r of allResults) {
  if (!caseAgg[r.caseId]) caseAgg[r.caseId] = { f1s: [], failures: 0 };
  caseAgg[r.caseId].f1s.push(r.metrics.f1);
  if (r.metrics.failures.length > 0) caseAgg[r.caseId].failures += 1;
}

// Trace summary
const traceSummary = summarizeTraces(allTraces);

// ═══════════════════════════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════════════════════════

const report = {
  metadata: {
    model: MODEL_SPEC,
    runs: RUNS,
    casesPerRun: EVAL_CASES.length,
    extractorVersion: 1,
    reviewerEnabled: process.env.TRIPLE_PI_EVAL_REVIEWER !== "false",
    totalObservations: allResults.length,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    commitSHA: (() => {
      try {
        const { execSync } = require("node:child_process");
        return execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 2000 }).trim();
      } catch { return "unknown"; }
    })(),
  },
  metrics: {
    meanF1: Math.round(meanF1 * 10000) / 10000,
    varianceF1: Math.round(varianceF1 * 10000) / 10000,
    worstF1: Math.round(worstF1 * 10000) / 10000,
    bestF1: Math.round(bestF1 * 10000) / 10000,
    meanPrecision: Math.round(meanPrecision * 10000) / 10000,
    meanRecall: Math.round(meanRecall * 10000) / 10000,
    falsePositiveRate: Math.round(fpRate * 10000) / 10000,
  },
  traces: traceSummary,
  perCase: Object.entries(caseAgg).map(([id, agg]) => ({
    caseId: id,
    caseDescription: EVAL_CASES.find((c) => c.id === id)?.description || "",
    meanF1: Math.round((agg.f1s.reduce((a, b) => a + b, 0) / agg.f1s.length) * 10000) / 10000,
    worstF1: Math.round(Math.min(...agg.f1s) * 10000) / 10000,
    failureRuns: agg.failures,
    totalRuns: agg.f1s.length,
  })),
  rawResults: allResults.map((r) => ({
    run: r.run,
    caseId: r.caseId,
    f1: Math.round(r.metrics.f1 * 10000) / 10000,
    precision: Math.round(r.metrics.precision * 10000) / 10000,
    recall: Math.round(r.metrics.recall * 10000) / 10000,
    truePositive: r.metrics.truePositive,
    falsePositive: r.metrics.falsePositive,
    falseNegative: r.metrics.falseNegative,
    failures: r.metrics.failures,
  })),
};

// ── 人类可读报告 ──
console.log("");
console.log("=".repeat(64));
console.log("  Live Eval Report");
console.log("=".repeat(64));
console.log(`  Model:          ${MODEL_SPEC}`);
console.log(`  Runs × Cases:   ${RUNS} × ${EVAL_CASES.length} = ${allResults.length} observations`);
console.log(`  Extractor:      v${report.metadata.extractorVersion}`);
console.log("-".repeat(64));
console.log(`  Mean F1:        ${report.metrics.meanF1}`);
console.log(`  Best F1:        ${report.metrics.bestF1}`);
console.log(`  Worst F1:       ${report.metrics.worstF1}`);
console.log(`  Variance:       ${report.metrics.varianceF1}`);
console.log(`  Mean Precision: ${report.metrics.meanPrecision}`);
console.log(`  Mean Recall:    ${report.metrics.meanRecall}`);
console.log(`  FP Rate:        ${report.metrics.falsePositiveRate}`);
console.log("-".repeat(64));
console.log(`  Success Rate:        ${report.traces.successRate}`);
console.log(`  Avg Candidates:      ${report.traces.avgCandidates}`);
console.log(`  Reviewer Filter:     ${Math.round(report.traces.avgReviewerFilterRatio * 100)}%`);
console.log(`  Avg Latency:         ${report.traces.avgLatencyMs}ms`);
console.log(`  P95 Latency:         ${report.traces.p95LatencyMs}ms`);
console.log(`  Avg Total Tokens:    ${report.traces.avgTotalTokens}`);
console.log("-".repeat(64));
console.log("  Per-case breakdown:");
for (const c of report.perCase) {
  const status = c.failureRuns === 0 ? "✓" : "✗";
  console.log(`    ${status} ${c.caseId.padEnd(22)} F1=${c.meanF1}  worst=${c.worstF1}  (${c.totalRuns - c.failureRuns}/${c.totalRuns})`);
}
console.log("=".repeat(64));

// ── JSON 报告 → stdout（供脚本解析） ──
console.log("");
console.log(JSON.stringify(report, null, 2));

// ── 写入 trace JSONL（供后续分析） ──
try {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const traceFile = path.join(RESULTS_DIR, `live-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await fs.writeFile(traceFile, allTraces.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
  console.error(`\nTrace data written to: ${traceFile}`);
} catch {
  // Trace 写入失败不阻碍 Eval 结果。
}

// ── Exit code ──
const hasFailures = allResults.some((r) => r.metrics.failures.length > 0);
process.exitCode = hasFailures ? 1 : 0;
