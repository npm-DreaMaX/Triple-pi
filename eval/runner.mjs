#!/usr/bin/env node
/**
 * Triple-pi Memory Eval Runner
 *
 * Runs extractor against synthetic transcripts with known ground truth.
 * Verifies: precision (what we extract is correct), recall (what should be
 * extracted IS extracted), noise rejection (what shouldn't be extracted isn't).
 *
 * Run: node eval/runner.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const RESULTS_DIR = path.join(__dirname, 'results');

// ═══════════════════════════════════════════════════════════════
// Case definitions
// ═══════════════════════════════════════════════════════════════

const cases = [
  {
    id: 'basic-extraction',
    name: '基础提取：偏好 + 决策 + 规则 + knowledge',
    transcript: 'basic-extraction.jsonl',
    expect: {
      minTotal: 4,
      mustContain: [
        { category: 'knowledge', reason: '用户明确说了读过 agent-loop.ts' },
        { category: 'preference', reason: '用户明确表达了代码风格偏好' },
        { category: 'rule', reason: '用户明确说了禁止 git push' },
        { category: 'decision', reason: '用户做出了技术选型并说明了原因' },
      ],
      mustNotContain: [
        { reason: '装了 prettier —— 配置信息，package.json 里就有' },
        { reason: '随便试试这个能不能编译 —— 调试过程' },
        { reason: '今天天气不错 —— 闲聊' },
      ],
    },
  },

  {
    id: 'noise-rejection',
    name: '噪音拒绝：纯调试/闲聊不应提取',
    transcript: 'noise-rejection.jsonl',
    expect: {
      maxTotal: 1, // at most 1 very weak candidate, ideally 0
      mustNotContain: [
        { reason: '全是调试和闲聊，没有值得跨会话记住的信息' },
      ],
    },
  },

  {
    id: 'knowledge-recall',
    name: 'Knowledge 召回：用户知识声明必须被提取',
    transcript: 'knowledge-recall.jsonl',
    expect: {
      minTotal: 2,
      mustContain: [
        { category: 'knowledge', reason: '用户说了读过源码' },
        { category: 'knowledge', reason: '用户说了不太懂 Docker' },
      ],
    },
  },

  {
    id: 'correction-signal',
    name: '纠正信号：用户纠正 Agent 比普通陈述更值得记住',
    transcript: 'correction-signal.jsonl',
    expect: {
      mustContain: [
        { category: 'preference', reason: '用户纠正了 Agent：不要用 session，用 JWT' },
        { category: 'rule', reason: '用户纠正了 Agent：永远不要改 .env' },
      ],
      mustNotContain: [
        { reason: '临时性的登录页面需求描述' },
        { reason: 'npm install 命令执行 —— 一次性操作' },
      ],
    },
  },

  {
    id: 'discoverable-filter',
    name: '可发现性过滤：代码/配置里的信息不该存',
    transcript: 'discoverable-filter.jsonl',
    expect: {
      mustContain: [
        { category: 'fact', reason: '项目要迁移到 Go —— 这个信息不在任何代码文件里' },
      ],
      mustNotContain: [
        { reason: '项目用 TypeScript —— tsconfig.json 里就有' },
        { reason: '测试框架是 vitest —— package.json 里就有' },
        { reason: '装了什么 extension —— 配置目录里已有' },
        { reason: 'Node 版本要求 20+ —— package.json engines 字段里已有' },
      ],
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

async function runEval() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('🧪 Triple-pi Memory Eval\n');
  console.log(`   ${cases.length} test suites\n`);

  // Eval uses a temp HOME to avoid touching real memory files.
  const evalHome = path.join(__dirname, '.eval-home');
  if (fs.existsSync(evalHome)) fs.rmSync(evalHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(evalHome, '.triple-pi', 'memory'), { recursive: true });

  // Copy auth.json so extractor can access LLM API key
  const realAuth = path.join(process.env.HOME, '.pi', 'agent', 'auth.json');
  if (fs.existsSync(realAuth)) {
    fs.mkdirSync(path.join(evalHome, '.pi', 'agent'), { recursive: true });
    fs.copyFileSync(realAuth, path.join(evalHome, '.pi', 'agent', 'auth.json'));
  }

  let totalPassed = 0;
  let totalFailed = 0;

  for (const testCase of cases) {
    const transcriptPath = path.join(TRANSCRIPTS_DIR, testCase.transcript);
    if (!fs.existsSync(transcriptPath)) {
      console.log(`⏭  ${testCase.id}: transcript not found (${testCase.transcript})`);
      totalFailed++;
      continue;
    }

    console.log(`📋 ${testCase.id}: ${testCase.name}`);
    console.log(`   Transcript: ${testCase.transcript}`);

    // Run extractor against this transcript
    const result = await runExtraction(transcriptPath);
    const saved = result.saved || [];

    // Save result for inspection
    const resultPath = path.join(RESULTS_DIR, `${testCase.id}.json`);
    fs.writeFileSync(resultPath, JSON.stringify({ testCase: testCase.id, saved, timestamp: new Date().toISOString() }, null, 2));

    console.log(`   Extracted ${saved.length} memories`);

    // Run assertions
    const failures = [];
    const { expect: e } = testCase;

    // Check min/max
    if (e.minTotal !== undefined && saved.length < e.minTotal) {
      failures.push(`Expected ≥${e.minTotal} memories, got ${saved.length}`);
    }
    if (e.maxTotal !== undefined && saved.length > e.maxTotal) {
      failures.push(`Expected ≤${e.maxTotal} memories, got ${saved.length} (noise rejection failed)`);
    }

    // Check mustContain
    if (e.mustContain) {
      for (const must of e.mustContain) {
        const found = saved.find(s => {
          if (must.category && s.category !== must.category) return false;
          return true;
        });
        if (!found) {
          failures.push(`Missing: should contain [${must.category || 'any'}] memory (${must.reason})`);
        }
      }
    }

    // Check mustNotContain (simplified: check if any saved memory's title/content matches noise patterns)
    if (e.mustNotContain) {
      for (const mustNot of e.mustNotContain) {
        const fullText = saved.map(s => `${s.title} ${s.content}`).join(' ').toLowerCase();
        // Extract keywords from the reason
        const keywords = mustNot.reason.match(/[a-z一-鿿]{3,}/gi) || [];
        const matched = keywords.filter(kw => fullText.includes(kw.toLowerCase()));
        if (matched.length >= 2) {
          failures.push(`Noise not filtered: ${mustNot.reason.slice(0, 60)}...`);
        }
      }
    }

    // Report
    if (failures.length === 0) {
      console.log(`   ✅ PASSED\n`);
      totalPassed++;
    } else {
      console.log(`   ❌ FAILED`);
      for (const f of failures) console.log(`      - ${f}`);
      console.log('');
      totalFailed++;
    }

    // Show extracted memories
    for (const s of saved) {
      console.log(`      [${s.category}] "${s.title}"`);
    }
    console.log('');
  }

  console.log('═'.repeat(50));
  console.log(`\n📊 Results: ${totalPassed}/${cases.length} passed, ${totalFailed} failed`);
  if (totalPassed === cases.length) {
    console.log('✅ All memory eval tests passed!\n');
  } else {
    console.log(`❌ ${totalFailed} test(s) failed. Check eval/results/ for details.\n`);
  }

  return totalFailed === 0;
}

// ═══════════════════════════════════════════════════════════════
// Helper: run the extractor script against a specific transcript
// ═══════════════════════════════════════════════════════════════

async function runExtraction(transcriptPath) {
  const extractScript = path.join(PROJECT_DIR, 'scripts', 'extract.mjs');
  const absoluteTranscript = path.resolve(transcriptPath);

  // Run extractor with temp HOME so eval doesn't touch real memory files
  const evalHome = path.join(__dirname, '.eval-home');
  const env = { ...process.env, HOME: evalHome };

  try {
    const output = execSync(
      `node "${extractScript}" "${absoluteTranscript}" 2>&1`,
      { cwd: PROJECT_DIR, timeout: 120000, encoding: 'utf-8', env }
    );

    // Parse saved memories from the output
    return parseExtractorOutput(output);
  } catch (err) {
    console.error(`   ⚠️  Extractor error: ${err.message}`);
    return { saved: [], output: err.stderr || err.message };
  }
}

function parseExtractorOutput(output) {
  const saved = [];

  // Method 1: candidates after Phase 2.5 review (before merge dedup)
  // Line: "X candidates → Y after review"
  // Then each line: ✅ [cat] "title" (score) — saved (not merged away)
  // OR 🔗 lines for merged items
  // Fallback: if Phase 2.5 output is empty, use Phase 3 "Saved" lines

  // Collect ALL candidates: first from ✅ lines, then from 🔗 merge lines
  const candidateRegex = /✅\s+\[(\w+)\]\s+"(.+?)"\s+\(score:\s*([\d.]+)\)/g;
  const mergeRegex = /🔗\s+\w+:\s+"(.+?)"\s+↔\s+"(.+?)"/g;

  let match;
  const seen = new Set();

  while ((match = candidateRegex.exec(output)) !== null) {
    const title = match[2];
    if (!seen.has(title)) {
      seen.add(title);
      saved.push({ category: match[1], title, score: parseFloat(match[3]) });
    }
  }

  while ((match = mergeRegex.exec(output)) !== null) {
    const title = match[2]; // the candidate that was merged into existing
    if (!seen.has(title)) {
      seen.add(title);
      saved.push({ category: 'merged', title, score: 0 });
    }
  }

  return { saved, raw: output };
}

// ═══════════════════════════════════════════════════════════════

runEval().then(allPassed => {
  process.exit(allPassed ? 0 : 1);
}).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
