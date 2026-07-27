#!/usr/bin/env node
/**
 * Live Eval Runner — 使用真实 LLM 运行所有 eval case。
 *
 * 只在显式设置 TRIPLE_PI_EVAL_MODEL=provider/model 时运行。
 * 不猜模型，不静默触网。
 *
 * 用法：
 *   TRIPLE_PI_EVAL_MODEL=deepseek/deepseek-v4-flash TRIPLE_PI_EVAL_RUNS=5 npm run eval:live
 *
 * Exit codes:
 *   0 — 全部通过
 *   1 — 有 semantic failure
 *   2 — 有 infra/pipeline failure
 *
 * Priority: infra > semantic > pass.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
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
import { createHash } from "node:crypto";

// ═══════════════════════════════════════════════════════════════
// Guard: only run when explicitly opted in
// ═══════════════════════════════════════════════════════════════

const MODEL_SPEC = process.env.TRIPLE_PI_EVAL_MODEL;

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
  console.error("  TRIPLE_PI_EVAL_MODEL=deepseek/deepseek-v4-flash npm run eval:live");
  console.error("");
  console.error("Live eval 是 opt-in 的——不猜模型，不静默触网。");
  process.exit(2);
}

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const RUNS = Number(process.env.TRIPLE_PI_EVAL_RUNS || "5");
const RESULTS_DIR = process.env.TRIPLE_PI_EVAL_RESULTS_DIR ||
  path.join(import.meta.dirname, "..", "eval", "results");
const REVIEWER_ENABLED = process.env.TRIPLE_PI_EVAL_REVIEWER !== "false";
const DIRTY = execSync("git status --porcelain", { encoding: "utf8", timeout: 2000 }).trim().length > 0;
const COMMIT_SHA = execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 2000 }).trim();
let SUBMODULE_SHA = "unknown";
try {
  SUBMODULE_SHA = execSync("git submodule status", { encoding: "utf8", timeout: 2000 })
    .trim().split(/\s+/)[0] || "unknown";
} catch { /* ignore */ }

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

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
let infraFailure = false;

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
        extractionStatus: "ok",
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
          reviewerEnabled: REVIEWER_ENABLED,
        }, new AbortController().signal);

        trace.totalLatencyMs = Date.now() - t0;
        trace.savedCount = result.savedCount;

        if (result.status === "no-source") {
          trace.status = "no-source";
        }

        // Check for pipeline/infra failure
        if (result.status === "aborted") {
          trace.status = "infra-failure";
          trace.extractionStatus = "failed";
          infraFailure = true;
        }
      } catch (error) {
        trace.totalLatencyMs = Date.now() - t0;
        trace.status = "commit-failed";
        trace.commitFailure = error instanceof Error ? error.message : String(error);
        infraFailure = true;
      }

      const records = await repository.list(testCase.cwd);
      const metrics = evaluateRecords(testCase, records);
      allTraces.push(trace);

      allResults.push({ run, caseId: testCase.id, metrics, trace });

      const status = metrics.failures.length === 0 ? "✓" : "✗";
      const pStr = metrics.precision === null ? "?" : metrics.precision.toFixed(2);
      const rStr = metrics.recall === null ? "?" : metrics.recall.toFixed(2);
      const f1Str = metrics.f1 === null ? "?" : metrics.f1.toFixed(2);
      console.error(`  ${status} ${testCase.id}  F1=${f1Str}  P=${pStr}  R=${rStr}  TP=${metrics.truePositive} FP=${metrics.falsePositive} FN=${metrics.falseNegative}`);
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

const f1Values = allResults.map((r) => r.metrics.f1).filter((f): f is number => f !== null);
const meanF1 = f1Values.length > 0 ? f1Values.reduce((a, b) => a + b, 0) / f1Values.length : null;
const varianceF1 = f1Values.length > 1
  ? f1Values.reduce((s, v) => s + (v - (meanF1 ?? 0)) ** 2, 0) / f1Values.length
  : 0;
const worstF1 = f1Values.length > 0 ? Math.min(...f1Values) : null;
const bestF1 = f1Values.length > 0 ? Math.max(...f1Values) : null;

const precisionValues = allResults.map((r) => r.metrics.precision).filter((p): p is number => p !== null);
const meanPrecision = precisionValues.length > 0
  ? precisionValues.reduce((a, b) => a + b, 0) / precisionValues.length
  : null;

const recallValues = allResults.map((r) => r.metrics.recall).filter((r): r is number => r !== null);
const meanRecall = recallValues.length > 0
  ? recallValues.reduce((a, b) => a + b, 0) / recallValues.length
  : null;

const falsePositives = allResults.filter((r) => r.metrics.falsePositive > 0).length;
const fpRate = allResults.length > 0 ? falsePositives / allResults.length : 0;

// 按 case 聚合
const caseAgg: Record<string, { f1s: number[]; failures: number }> = {};
for (const r of allResults) {
  if (!caseAgg[r.caseId]) caseAgg[r.caseId] = { f1s: [], failures: 0 };
  if (r.metrics.f1 !== null) caseAgg[r.caseId].f1s.push(r.metrics.f1);
  if (r.metrics.failures.length > 0) caseAgg[r.caseId].failures += 1;
}

// Compute case prompt hashes
const caseHashes: Record<string, string> = {};
for (const c of EVAL_CASES) {
  caseHashes[c.id] = hashText(c.user + c.assistant);
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
    reviewerEnabled: REVIEWER_ENABLED,
    totalObservations: allResults.length,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    commitSHA: COMMIT_SHA,
    dirty: DIRTY,
    submoduleSHA: SUBMODULE_SHA,
    caseHashes,
    promptHash: hashText(EVAL_CASES.map((c) => c.user).join("\n")),
  },
  metrics: {
    meanF1: meanF1 !== null ? Math.round(meanF1 * 10000) / 10000 : null,
    varianceF1: Math.round(varianceF1 * 10000) / 10000,
    worstF1: worstF1 !== null ? Math.round(worstF1 * 10000) / 10000 : null,
    bestF1: bestF1 !== null ? Math.round(bestF1 * 10000) / 10000 : null,
    meanPrecision: meanPrecision !== null ? Math.round(meanPrecision * 10000) / 10000 : null,
    meanRecall: meanRecall !== null ? Math.round(meanRecall * 10000) / 10000 : null,
    falsePositiveRate: Math.round(fpRate * 10000) / 10000,
  },
  traces: traceSummary,
  perCase: Object.entries(caseAgg).map(([id, agg]) => ({
    caseId: id,
    caseDescription: EVAL_CASES.find((c) => c.id === id)?.description || "",
    meanF1: agg.f1s.length > 0
      ? Math.round((agg.f1s.reduce((a, b) => a + b, 0) / agg.f1s.length) * 10000) / 10000
      : null,
    worstF1: agg.f1s.length > 0 ? Math.round(Math.min(...agg.f1s) * 10000) / 10000 : null,
    failureRuns: agg.failures,
    totalRuns: agg.f1s.length || RUNS,
  })),
  rawResults: allResults.map((r) => ({
    run: r.run,
    caseId: r.caseId,
    f1: r.metrics.f1 !== null ? Math.round(r.metrics.f1 * 10000) / 10000 : null,
    precision: r.metrics.precision !== null ? Math.round(r.metrics.precision * 10000) / 10000 : null,
    recall: r.metrics.recall !== null ? Math.round(r.metrics.recall * 10000) / 10000 : null,
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
console.log(`  Reviewer:       ${REVIEWER_ENABLED ? "on" : "off"}`);
console.log(`  Commit:         ${COMMIT_SHA.slice(0, 12)}${DIRTY ? " (dirty)" : ""}`);
console.log("-".repeat(64));
console.log(`  Mean F1:        ${report.metrics.meanF1 ?? "N/A"}`);
console.log(`  Best F1:        ${report.metrics.bestF1 ?? "N/A"}`);
console.log(`  Worst F1:       ${report.metrics.worstF1 ?? "N/A"}`);
console.log(`  Variance:       ${report.metrics.varianceF1}`);
console.log(`  Mean Precision: ${report.metrics.meanPrecision ?? "N/A"}`);
console.log(`  Mean Recall:    ${report.metrics.meanRecall ?? "N/A"}`);
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
  console.log(`    ${status} ${c.caseId.padEnd(22)} F1=${c.meanF1 ?? "?"}  worst=${c.worstF1 ?? "?"}  (${c.totalRuns - c.failureRuns}/${c.totalRuns})`);
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

// ── Exit code: priority (infra > semantic > pass) ──
const hasSemanticFailures = allResults.some((r) => r.metrics.failures.length > 0 && !r.metrics.noiseRejected);
if (infraFailure) {
  process.exitCode = 2;
} else if (hasSemanticFailures) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
