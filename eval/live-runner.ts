#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "./cases.ts";
import { evaluateRecords } from "./metrics.ts";
import { FilesystemMemoryRepository } from "../extensions/memory/repository.ts";
import { runExtraction } from "../extensions/memory/extraction/coordinator.ts";

const RUNS = Number(process.env.TRIPLE_PI_EVAL_RUNS || "3");
const MODEL_SPEC = process.env.TRIPLE_PI_EVAL_MODEL;
if (!MODEL_SPEC || !MODEL_SPEC.includes("/")) {
  console.error("Set TRIPLE_PI_EVAL_MODEL=provider/model. Live eval is opt-in and never guesses a model.");
  process.exit(2);
}
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 10) {
  console.error("TRIPLE_PI_EVAL_RUNS must be an integer from 1 to 10.");
  process.exit(2);
}

const [providerId, ...modelParts] = MODEL_SPEC.split("/");
const modelId = modelParts.join("/");
let runtime: ModelRuntime;
let modelRegistry: ModelRegistry;
let model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
try {
  runtime = await ModelRuntime.create();
  modelRegistry = new ModelRegistry(runtime);
  const selectedModel = runtime.getModel(providerId, modelId);
  if (!selectedModel) throw new Error(`Configured model not found: ${MODEL_SPEC}`);
  model = selectedModel;
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!modelRegistry.getProvider(model.provider)) throw new Error(`Provider unavailable: ${model.provider}`);
} catch (error) {
  console.error("Live eval infrastructure initialization failed:", error);
  process.exit(2);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-live-eval-"));

function branch(user: string, assistant: string): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: user, timestamp: Date.now() } },
    { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: assistant }], timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
  ] as SessionEntry[];
}

try {
  const scores: number[] = [];
  const caseReports: unknown[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    for (const testCase of EVAL_CASES) {
      const repository = new FilesystemMemoryRepository({ root: path.join(root, `run-${run}`, testCase.id) });
      try {
        await runExtraction(repository, {
          cwd: testCase.cwd, sessionId: `live-${run}-${testCase.id}`,
          branch: branch(testCase.user, testCase.assistant), branchLeafId: "a1",
          model, modelRegistry,
        }, new AbortController().signal);
      } catch (error) {
        console.error(`Infrastructure failure [run=${run} case=${testCase.id}]:`, error);
        process.exitCode = 2;
        break;
      }
      const records = await repository.list(testCase.cwd);
      const metrics = evaluateRecords(testCase, records);
      scores.push(metrics.f1);
      caseReports.push({ run, case: testCase.id, metrics });
    }
    if (process.exitCode === 2) break;
  }
  if (process.exitCode !== 2) {
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
    const report = {
      model: MODEL_SPEC,
      runs: RUNS,
      casesPerRun: EVAL_CASES.length,
      extractorVersion: 1,
      meanF1: mean,
      varianceF1: variance,
      worstF1: Math.min(...scores),
      cases: caseReports,
    };
    console.log(JSON.stringify(report, null, 2));
    if (caseReports.some((item: any) => item.metrics.failures.length > 0)) process.exitCode = 1;
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
