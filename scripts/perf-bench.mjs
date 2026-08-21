#!/usr/bin/env node
/**
 * perf-bench.mjs — Triple-pi memory 性能基线（G2，Phase 0b）。
 *
 * 度量三类热路径在不同规模下的延迟，为后续性能优化（P1 记录缓存 / P2 节流 /
 * P3+P4 manifest 扫描+GC）提供可量化的 before/after 基线：
 *
 *   1. search        — O(N) 每条记录一次 readFile（listBase 1183-1203），无索引
 *   2. buildPrompt   — 每轮注入（before_agent_start）同样 listUnlocked 全量读 N 条
 *   3. saveWorkingState — O(M) 每次读 working-manifests 全目录（turn 数线性增长，
 *                      累计 seeding 是 O(M²)，实证 P3/P4 无界增长）
 *   4. save 稳态     — 单次 save() 的耗时（含 rebuildIndexUnlocked 全量重建 MEMORY.md，
 *                      实证 save 自身是 O(N)——写入侧放大）
 *
 * 全部走真实 FilesystemMemoryRepository，零 LLM。隔离到 mkdtemp 临时目录。
 *
 * seeding 用"直接写记录文件"（O(N)）绕过 save 的 O(N²) 全量索引重建——后者单独
 * 用"save 稳态"档度量。磁盘格式参照 repository.ts:145 serializeRecord / 138 recordId，
 * 是稳定且 parseRecord 能正确读回的格式（非依赖私有实现，而是复刻稳定磁盘契约）。
 *
 * 运行：node --experimental-strip-types scripts/perf-bench.mjs [--max-scale=10000]
 *
 * 输出：每个规模/路径的 p50/p95/max（ms）+ manifest 累计 seeding 曲线。
 *      数字写进 docs/technical/14-... 的 Phase 0b 基线表，作为性能优化验收门槛。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryRepository } from "../extensions/memory/repository.ts";
import { resolveProjectIdentity } from "../extensions/memory/project-identity.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 配置 ────────────────────────────────────────────────────────
const argScale = (() => {
  const a = process.argv.find((x) => x.startsWith("--max-scale="));
  return a ? Number.parseInt(a.slice("--max-scale=".length), 10) : 10_000;
})();

const RECORD_SCALES = [100, 1_000, 10_000].filter((n) => n <= argScale);
const TURN_SCALES = [100, 1_000, 3_000].filter((n) => n <= argScale);
const FIXED_NOW = new Date("2026-08-19T12:00:00.000Z");
const FIXED_ISO = FIXED_NOW.toISOString();

// ── 磁盘格式复刻（与 repository.ts:138/145 一致，parseRecord 可读回）────────
const RECORD_START = "<!-- triple-pi-memory";
const RECORD_END = "-->";

function recordId(scope, projectId, category, title) {
  return crypto
    .createHash("sha256")
    .update(`${scope}\0${projectId}\0${category}\0${title.toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

function serializeRecord(record) {
  const metadata = JSON.stringify({ ...record, content: undefined });
  return `${RECORD_START}\n${metadata}\n${RECORD_END}\n\n# ${record.title}\n\n${record.content.trim()}\n`;
}

// ── 工具 ────────────────────────────────────────────────────────
const hr = () => Number(process.hrtime.bigint()); // ns
const ms = (ns) => ns / 1e6;

function percentile(sortedNs, p) {
  if (sortedNs.length === 0) return 0;
  return sortedNs[Math.min(sortedNs.length - 1, Math.floor(p * sortedNs.length))];
}

function stats(samplesNs) {
  const s = [...samplesNs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: ms(percentile(s, 0.5)),
    p95: ms(percentile(s, 0.95)),
    max: ms(s[s.length - 1] ?? 0),
  };
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function makeUpdate(turnIndex) {
  return {
    version: 1,
    sourceHash: sha256(`turn-${turnIndex}`),
    lastEntryId: `entry-${turnIndex}`,
    branchLeafId: null,
    sessionId: `bench-session-${turnIndex % 5}`,
    updatedAt: FIXED_ISO,
    date: FIXED_ISO.slice(0, 10),
    userRequest: `请帮我重构检索模块第 ${turnIndex} 轮，关注中文检索与排序`,
    assistantReportedOutcome: `已完成第 ${turnIndex} 轮检索重构分析，记录到工作状态。`,
    sourceEntryIds: [`u-${turnIndex}`, `a-${turnIndex}`],
  };
}

/**
 * O(N) 直接写记录文件，绕过 save 的 O(N²) 全量索引重建。
 * 写到 <root>/projects/<projectId>/entries/fact/<id>.md，与 recordPath 一致。
 * 全部含"测试"以使 search 命中并触发全量过滤+排序。
 */
async function seedRecordsDirect(repoRoot, projectId, n) {
  const categoryDir = path.join(repoRoot, "projects", projectId, "entries", "fact");
  await fs.mkdir(categoryDir, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    const title = `记忆 ${i} 测试`;
    const id = recordId("project", projectId, "fact", title);
    const record = {
      schemaVersion: 2,
      id,
      category: "fact",
      scope: "project",
      projectId,
      title,
      content: `第 ${i} 条记忆的测试内容，用于性能基准，关键词：测试 检索 重构 ${i % 7}。`,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      provenance: { source: "manual" },
    };
    await fs.writeFile(path.join(categoryDir, `${id}.md`), serializeRecord(record));
  }
}

async function timeAsync(fn) {
  const t0 = hr();
  await fn();
  return hr() - t0;
}

// 确保记录数与期望一致（也验证直接写入的文件 parseRecord 能读回）
async function countRecords(repo, cwd) {
  return (await repo.buildPrompt(cwd, { includeProject: true })).count;
}

// ── 基准一：记录规模 → search / buildPrompt（每轮注入）延迟 ───────
async function benchRecordScale() {
  const rows = [];
  for (const n of RECORD_SCALES) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-perf-rec-"));
    const repo = createMemoryRepository({ root: repoRoot, now: () => FIXED_NOW });
    // 真实项目目录：用 repoRoot 下的子目录，resolveProjectIdentity 按路径解析
    const cwd = path.join(repoRoot, "project");
    await fs.mkdir(cwd, { recursive: true });
    const projectId = resolveProjectIdentity(cwd).id;

    const seedNs = await timeAsync(() => seedRecordsDirect(repoRoot, projectId, n));

    // 预热（OS 文件缓存）
    await repo.search("测试", cwd, { max: 10, includeProject: true });
    const countCheck = await countRecords(repo, cwd);

    const searchIters = n >= 10_000 ? 25 : 100;
    const searchSamples = [];
    for (let s = 0; s < searchIters; s += 1) {
      searchSamples.push(
        await timeAsync(() => repo.search("测试", cwd, { max: 10, includeProject: true })),
      );
    }

    const promptIters = n >= 10_000 ? 15 : 50;
    const promptSamples = [];
    for (let s = 0; s < promptIters; s += 1) {
      promptSamples.push(await timeAsync(() => repo.buildPrompt(cwd, { includeProject: true })));
    }

    const searchSt = stats(searchSamples);
    const promptSt = stats(promptSamples);
    rows.push({ n, count: countCheck, seedMs: ms(seedNs), search: searchSt, buildPrompt: promptSt });
    await fs.rm(repoRoot, { recursive: true, force: true });
    process.stdout.write(
      `  records=${String(n).padStart(5)} count=${countCheck} seed=${ms(seedNs).toFixed(0)}ms ` +
        `search p50=${searchSt.p50.toFixed(2)} p95=${searchSt.p95.toFixed(2)} ` +
        `buildPrompt p50=${promptSt.p50.toFixed(2)} p95=${promptSt.p95.toFixed(2)}\n`,
    );
  }
  return rows;
}

// ── 基准一b：save 稳态延迟（单次 save 含 rebuildIndexUnlocked 全量重建）──
async function benchSaveSteadyState() {
  const rows = [];
  for (const n of [100, 1_000, 5_000].filter((x) => x <= argScale)) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-perf-save-"));
    const repo = createMemoryRepository({ root: repoRoot, now: () => FIXED_NOW });
    const cwd = path.join(repoRoot, "project");
    await fs.mkdir(cwd, { recursive: true });
    const projectId = resolveProjectIdentity(cwd).id;
    await seedRecordsDirect(repoRoot, projectId, n);

    // 新标题确保每次都是新记录（走完整 save 含 rebuildIndex）
    const saveIters = n >= 5_000 ? 10 : 25;
    const samples = [];
    for (let s = 0; s < saveIters; s += 1) {
      samples.push(
        await timeAsync(() =>
          repo.save({
            category: "fact",
            scope: "project",
            cwd,
            title: `保存基准 ${s} 测试`,
            content: `save 稳态基准第 ${s} 次，规模 ${n}。`,
            provenance: { source: "manual" },
          }),
        ),
      );
    }
    const st = stats(samples);
    rows.push({ n, save: st });
    await fs.rm(repoRoot, { recursive: true, force: true });
    process.stdout.write(
      `  现存=${String(n).padStart(5)}条时 save() p50=${st.p50.toFixed(2)} p95=${st.p95.toFixed(2)}max=${st.max.toFixed(2)}ms\n`,
    );
  }
  return rows;
}

// ── 基准二：turn 规模 → saveWorkingState 延迟 + 累计 O(M²) seeding 曲线 ──
async function benchTurnScale() {
  const rows = [];
  for (const m of TURN_SCALES) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-perf-turn-"));
    const repo = createMemoryRepository({ root: repoRoot, now: () => FIXED_NOW });
    const cwd = path.join(repoRoot, "project");
    await fs.mkdir(cwd, { recursive: true });
    await seedRecordsDirect(repoRoot, resolveProjectIdentity(cwd).id, 20);

    let cumulativeNs = 0;
    const curve = [];
    const checkpointEvery = Math.max(1, Math.floor(m / 5));
    for (let i = 0; i < m; i += 1) {
      cumulativeNs += await timeAsync(() => repo.saveWorkingState(cwd, makeUpdate(i)));
      if ((i + 1) % checkpointEvery === 0 || i + 1 === m) {
        curve.push({ turns: i + 1, cumulativeMs: ms(cumulativeNs) });
      }
    }

    // 稳态：第 M+1 轮 saveWorkingState（此时需读全部 M 个 manifest）
    const wsIters = m >= 3_000 ? 12 : 25;
    const wsSamples = [];
    for (let s = 0; s < wsIters; s += 1) {
      wsSamples.push(
        await timeAsync(() =>
          repo.saveWorkingState(cwd, { ...makeUpdate(m + s), sourceHash: sha256(`turn-${m + s}-b`) }),
        ),
      );
    }
    const st = stats(wsSamples);
    rows.push({ m, steadyState: st, cumulativeMs: ms(cumulativeNs), curve });
    await fs.rm(repoRoot, { recursive: true, force: true });
    process.stdout.write(
      `  turns=${String(m).padStart(4)} saveWorkingState(稳态) p50=${st.p50.toFixed(2)} p95=${st.p95.toFixed(2)} 累计=${ms(cumulativeNs).toFixed(0)}ms\n`,
    );
  }
  return rows;
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  process.stdout.write(
    `\n=== Triple-pi memory 性能基线 (Phase 0b) ===\n` +
      `node ${process.version} | platform=${process.platform} | 处理器=${os.cpus().length}核\n` +
      `record scales=${RECORD_SCALES.join("/")} | save scales=${[100, 1_000, 5_000].filter((x) => x <= argScale).join("/")} | turn scales=${TURN_SCALES.join("/")}\n\n`,
  );

  process.stdout.write("─ 基准一：记录规模 → search / buildPrompt（每轮注入）延迟 ─\n");
  const recRows = await benchRecordScale();

  process.stdout.write("\n─ 基准一b：save 稳态延迟（单次 save 含全量索引重建，写入侧放大） ─\n");
  const saveRows = await benchSaveSteadyState();

  process.stdout.write("\n─ 基准二：turn 规模 → saveWorkingState 延迟 + 累计 O(M²) seeding 曲线 ─\n");
  const turnRows = await benchTurnScale();

  const report = {
    generatedAt: FIXED_ISO,
    node: process.version,
    platform: process.platform,
    cpus: os.cpus().length,
    recordScales: recRows,
    saveSteadyState: saveRows,
    turnScales: turnRows,
  };
  const outPath = path.join(projectRoot, "scripts", "perf-bench-result.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  process.stdout.write(`\n结果已写入 ${path.relative(projectRoot, outPath)}\n`);

  process.stdout.write("\n─ 结论速读 ─\n");
  for (const r of recRows) {
    process.stdout.write(
      `  ${String(r.n).padStart(5)}条记录: search p95=${r.search.p95.toFixed(1)}ms | buildPrompt p95=${r.buildPrompt.p95.toFixed(1)}ms` +
        `${r.buildPrompt.p95 >= 5 ? "  ⚠ >5ms 阈值" : "  ✓"}\n`,
    );
  }
  for (const r of saveRows) {
    process.stdout.write(`  ${String(r.n).padStart(5)}条时 save() p95=${r.save.p95.toFixed(1)}ms (写入侧 O(N) 证据)\n`);
  }
  for (const r of turnRows) {
    process.stdout.write(
      `  ${String(r.m).padStart(4)}轮: saveWorkingState 稳态 p95=${r.steadyState.p95.toFixed(1)}ms | 累计 seeding ${r.cumulativeMs.toFixed(0)}ms (O(M²)实证)\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
