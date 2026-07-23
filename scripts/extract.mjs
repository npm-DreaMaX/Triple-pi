#!/usr/bin/env node
/**
 * Triple-pi Memory Extractor — OpenClaw-style multi-phase async extraction
 *
 * ============================================================================
 * PIPELINE (inspired by OpenClaw Dreaming)
 * ============================================================================
 *
 * Phase 1 (Light Sleep):   LLM scans transcript → extracts candidates with evidence
 * Phase 2 (Scoring):       6-dim weighted scoring per candidate
 * Phase 2.5 (Deep Sleep):  SECOND LLM call — reviews quality, removes noise,
 *                          merges similar candidates, filters discoverable info
 * Phase 3 (Merge):         Deterministic Jaccard dedup within project
 * Phase 4 (REM):           Cross-category linking notes
 *
 * ============================================================================
 * SCORING FORMULA (same weights as OpenClaw)
 * ============================================================================
 * Score = relevance(0.30) + frequency(0.24) + query_diversity(0.15)
 *       + recency(0.15) + consolidation(0.10) + conceptual_richness(0.06)
 *
 * Only candidates scoring >= 0.5 are promoted to long-term memory.
 *
 * ============================================================================
 * KEY PRINCIPLE
 * ============================================================================
 * Only grounded snippets enter long-term memory. Every memory MUST cite
 * exact evidence from the transcript. No evidence = not saved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Read API key from env or Pi's auth.json
let API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';
let IS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY;

if (!API_KEY) {
  try {
    const authPath = path.join(homedir(), '.pi', 'agent', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      if (auth.deepseek?.key) { API_KEY = auth.deepseek.key; IS_ANTHROPIC = false; }
      else if (auth.anthropic?.key) { API_KEY = auth.anthropic.key; IS_ANTHROPIC = true; }
      else if (auth.openai?.key) { API_KEY = auth.openai.key; IS_ANTHROPIC = false; }
    }
  } catch {}
}

const SCORE_THRESHOLD = 0.35;          // minimum score to save (lower for personal-scale agent)
// Dormancy: project unused for DORMANT_DELETE_DAYS → memories deleted.
// Personal dev cycle is short. 30 days of inactivity = abandoned project.
const DORMANT_DELETE_DAYS = 30;
const MAX_CANDIDATES_PER_RUN = 15;

const ROOT = path.join(homedir(), '.triple-pi', 'memory');
const INDEX = path.join(ROOT, 'MEMORY.md');
const SCORES_FILE = path.join(ROOT, '.scores.json'); // frequency tracking

// ═══════════════════════════════════════════════════════════════
// TRANSCRIPT LOADING
// ═══════════════════════════════════════════════════════════════

function findLatestTranscript() {
  const base = path.join(homedir(), '.pi', 'agent', 'sessions');
  if (!fs.existsSync(base)) return null;

  const files = [];
  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(base, dir.name);
    for (const f of fs.readdirSync(dirPath)) {
      if (f.endsWith('.jsonl')) files.push({ path: path.join(dirPath, f), dir: dir.name });
    }
  }
  files.sort((a, b) => b.path.localeCompare(a.path));
  return files[0] || null;
}

function loadTranscript(jsonlPath) {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const messages = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type !== 'message') continue;

    const msgRaw = entry.message;
    if (!msgRaw) continue;

    let role, textParts = [];

    try {
      const parsed = typeof msgRaw === 'string'
        ? JSON.parse(msgRaw.replace(/'/g, '"'))
        : msgRaw;
      role = parsed.role;
      textParts = Array.isArray(parsed.content)
        ? parsed.content.filter(c => c.type === 'text').map(c => c.text)
        : (typeof parsed.content === 'string' ? [parsed.content] : []);
    } catch {
      const roleMatch = msgRaw.match(/'role':\s*'(\w+)'/);
      role = roleMatch?.[1];
      for (const m of msgRaw.matchAll(/'text':\s*'([^']*)'/g)) {
        textParts.push(m[1]);
      }
    }

    if ((role === 'user' || role === 'assistant') && textParts.length > 0) {
      const text = textParts.join('');
      if (text.trim().length > 0) {
        messages.push({ role, content: text, timestamp: entry.timestamp });
      }
    }
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: LIGHT SLEEP — LLM Extraction
// ═══════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `You are a memory extraction system for a personal coding agent.
Read this conversation and extract ONLY information that should change how the agent behaves in future sessions.

## The "Permanence Test"

Before extracting anything, ask: **"Will this information change how the agent should act 3 months from now?"**

- ✅ "User hates 'any' type" → YES, affects all future code the agent writes
- ✅ "Auth uses JWT because multi-service stateless" → YES, constrains future architecture decisions
- ❌ "We installed prettier-plugin-tailwind" → NO, already in package.json, the agent can read it
- ❌ "The CLI flag is --model not MODEL env var" → NO, one-time config trivia
- ❌ "package name is @earendil-works/pi-agent" → NO, the agent can read package.json

## What TO extract

Only extract information that passes this test:
**"Will this change how the agent should behave 3 months from now, and is this information NOT already stored in a project file?"**

Categories:

1. **knowledge** — The user's knowledge level, what they've already learned or built.
   THIS IS THE MOST IMPORTANT CATEGORY. It determines the agent's starting point.
   - "用户已经读过 agent-loop.ts 源码" → knowledge (don't explain basics again)
   - "用户熟悉 TypeScript 但不太懂 Rust" → knowledge (adjust explanation depth)
   - "用户已经完成了 auth 模块的重构" → knowledge (don't suggest redoing it)
   - "用户第一次接触 Docker" → knowledge (explain Docker concepts from scratch)
   Why this matters: If the agent doesn't know what the user already knows,
   it wastes time explaining things the user already understands — or worse,
   assumes knowledge the user doesn't have.

2. **preference** — Communication style, code style, tools the user likes/dislikes.
   Must be explicitly stated by the user, not inferred.

3. **decision** — WHY something was chosen. Must include the reason.
   Skip: "安装了 X" (config files already record this).

4. **rule** — Constraints the agent must follow. Must be explicitly stated.

5. **fact** — Context that is NOT discoverable from ANY file the agent can read.
   The critical test: "Can the agent find this by reading a file?"
   - "项目要为 10 万并发用户设计" → fact (not in any file)
   - "后端团队 3 个月后要重写这个模块" → fact (not in code)
   - "这个微服务是订单系统的一部分，上游是用户服务" → fact (architecture context)
   - ❌ "项目用 TypeScript" → tsconfig.json exists
   - ❌ "测试框架是 vitest" → package.json exists
   - ❌ "Pi 的 agentLoop 导出路径是 X" → source code exists
   - ❌ ANYTHING the agent can discover by reading source code or config files

## What to SKIP

- Tool/extension installations (already stored in config files)
- Package names, CLI commands, API details (agent can read code/docs)
- One-time configuration steps (done once, never needed again)
- ANYTHING the agent could discover by reading package.json, tsconfig, or other project files
- Debugging, testing, chit-chat, session-only context

## CRITICAL

**The examples in this prompt are EXAMPLES ONLY. Do NOT extract them unless they actually appear in the conversation. Only extract what is ACTUALLY DISCUSSED in this specific transcript.**

## Output format

Return ONLY valid JSON:
{
  "candidates": [
    {
      "category": "preference|decision|rule|fact",
      "title": "short title",
      "content": "what to remember AND why it matters for future behavior",
      "evidence": "exact quote from transcript"
    }
  ]
}

If nothing worth extracting: {"candidates":[]}`;

function buildPrompt(messages) {
  const convo = messages.map(m =>
    `[${m.role.toUpperCase()}]: ${m.content}`
  ).join('\n\n');
  const maxLen = 80000;
  const truncated = convo.length > maxLen
    ? convo.slice(0, maxLen) + '\n\n[... truncated ...]'
    : convo;
  return `Analyze this coding session and extract persistent memories:\n\n${truncated}`;
}

async function callLLM(messages) {
  if (!API_KEY) throw new Error('Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY');

  if (IS_ANTHROPIC) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.1,
        system: EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(messages) }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  // DeepSeek
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat', temperature: 0.1, max_tokens: 4000,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: buildPrompt(messages) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseCandidates(text) {
  let json = text.trim();
  const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) json = fence[1].trim();

  let parsed;
  try { parsed = JSON.parse(json); } catch {
    // Last resort: try to find {...} block
    const m = json.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error(`Bad JSON: ${text.slice(0, 300)}`);
  }

  const validCats = new Set(['preference', 'decision', 'rule', 'fact', 'knowledge']);
  return (parsed.candidates || []).filter(c =>
    validCats.has(c.category) && c.title && c.content && c.evidence
  );
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: SCORING — OpenClaw 6-dim weighted formula
// ═══════════════════════════════════════════════════════════════

function loadScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

/**
 * Score a candidate using OpenClaw's formula.
 *
 * Score = relevance(0.30) + frequency(0.24) + query_diversity(0.15)
 *       + recency(0.15) + consolidation(0.10) + conceptual_richness(0.06)
 */
function scoreCandidate(candidate, messages, existingMemories, scores) {
  const evidence = candidate.evidence.toLowerCase();
  const title = candidate.title.toLowerCase();
  const content = candidate.content.toLowerCase();
  const allText = messages.map(m => m.content.toLowerCase()).join(' ');

  // ── Frequency (0.24): how many times was this topic mentioned ──
  // Knowledge statements are typically stated once — don't penalize them
  const keywords = title.split(/\s+/).filter(w => w.length > 2);
  const mentions = keywords.reduce((sum, kw) => {
    const matches = allText.split(kw).length - 1;
    return sum + matches;
  }, 0) / Math.max(1, keywords.length);
  // Cross-session accumulated frequency: combine this session's mentions
  // with historical counts from .scores.json. Same weight as OpenClaw.
  const sessionMentions = Math.min(1, mentions / 3);
  const historicalHits = scores[candidate.title.toLowerCase()] || 0;
  const accumulated = Math.min(1, sessionMentions + historicalHits * 0.15);
  const freqScore = accumulated * 0.24;

  // ── Relevance (0.30): is this about tech/code/work or casual chat? ──
  const techTerms = ['typescript', 'javascript', 'python', 'api', 'auth', 'token',
    'database', 'test', 'deploy', 'git', 'docker', 'config', 'component', 'function',
    'module', 'package', 'build', 'lint', 'format', 'refactor', 'architecture',
    '接口', '认证', '数据库', '测试', '部署', '配置', '组件', '函数', '模块', '架构'];
  const relMatches = techTerms.filter(t => content.includes(t)).length;
  const relScore = Math.min(1, relMatches / 3) * 0.30;  // cap at 3 terms

  // ── Recency (0.15): was this mentioned recently? ──
  const msgTimestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp).getTime());
  const latest = msgTimestamps.length > 0 ? Math.max(...msgTimestamps) : Date.now();
  const evidencePos = allText.indexOf(evidence.slice(0, 30).toLowerCase());
  const evidenceIndex = evidencePos >= 0
    ? Math.floor(evidencePos / Math.max(1, allText.length) * messages.length)
    : messages.length / 2;
  const recencyRatio = 1 - (evidenceIndex / Math.max(1, messages.length));
  const recencyScore = Math.max(0, recencyRatio) * 0.15;

  // ── Query diversity (0.15): does it appear in different contexts? ──
  const userMsgs = messages.filter(m => m.role === 'user');
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  const inUser = userMsgs.some(m => m.content.toLowerCase().includes(evidence.slice(0, 20).toLowerCase()));
  const inAssistant = assistantMsgs.some(m => m.content.toLowerCase().includes(evidence.slice(0, 20).toLowerCase()));
  const diversityScore = ((inUser ? 0.075 : 0) + (inAssistant ? 0.075 : 0));

  // ── Consolidation (0.10): is this linked to existing memories? ──
  let consolidationMatches = 0;
  for (const [existingTitle, existingContent] of Object.entries(existingMemories)) {
    const et = existingTitle.toLowerCase();
    const ec = (existingContent || '').toLowerCase();
    const shared = keywords.filter(kw => et.includes(kw) || ec.includes(kw));
    if (shared.length >= 2) consolidationMatches++;
  }
  const consolidationScore = Math.min(0.1, consolidationMatches * 0.025);

  // ── Conceptual richness (0.06): detail and specificity ──
  const contentLen = candidate.content.length;
  const hasRationale = /因为|because|由于|so that|in order to|因此|选择/.test(content);
  const hasContext = /项目|project|模块|module|服务|service|文件|file/.test(content);
  const richnessBase = Math.min(1, contentLen / 200);  // 200 chars = full score
  const richnessBonus = (hasRationale ? 0.02 : 0) + (hasContext ? 0.02 : 0);
  const richnessScore = Math.min(0.06, richnessBase * 0.02 + richnessBonus);

  const total = freqScore + relScore + recencyScore + diversityScore + consolidationScore + richnessScore;

  return {
    total: Math.round(total * 1000) / 1000,
    breakdown: {
      frequency: Math.round(freqScore * 1000) / 1000,
      relevance: Math.round(relScore * 1000) / 1000,
      recency: Math.round(recencyScore * 1000) / 1000,
      query_diversity: Math.round(diversityScore * 1000) / 1000,
      consolidation: Math.round(consolidationScore * 1000) / 1000,
      conceptual_richness: Math.round(richnessScore * 1000) / 1000,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2b: GROUNDED SNIPPET VALIDATION
// ═══════════════════════════════════════════════════════════════

function validateEvidence(candidate, messages) {
  const fullText = messages.map(m => m.content).join(' ').toLowerCase();
  // Exact substring match (case-insensitive)
  const evidence = candidate.evidence.trim().toLowerCase();
  if (fullText.includes(evidence)) return true;

  // Fuzzy: extract key terms from BOTH evidence and candidate content
  const allSignal = (candidate.content + ' ' + evidence).toLowerCase();
  // Extract meaningful tokens (Chinese: 2+ chars, English: 4+ chars)
  const tokens = [
    ...allSignal.matchAll(/[一-鿿]{2,}/g),
    ...allSignal.matchAll(/[a-z]{4,}/g),
  ].map(m => m[0]).filter(t => t.length > 1);

  if (tokens.length === 0) return false;
  const matched = tokens.filter(t => fullText.includes(t));
  // 60% of key terms must appear in transcript
  return matched.length / tokens.length >= 0.6;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2.5: DEEP SLEEP — LLM Quality Review
// ═══════════════════════════════════════════════════════════════
//
// SECOND LLM CALL. Takes scored candidates and asks LLM to:
// 1. Merge candidates that say the same thing differently
// 2. Remove low-quality or redundant candidates
// 3. Keep only genuinely useful memories
//
// WHY: scoring formula can count keywords but can't judge usefulness.
// Only LLM can tell "agent-loop.ts export path" is less useful than
// "user read agent-loop.ts and understands the architecture".

const DEEP_SLEEP_PROMPT = `You are a memory quality reviewer. Review these candidate memories
extracted from a coding session. Your job is to FILTER and MERGE.

## What to REMOVE

1. **Discoverable information**: Anything the agent can find by reading source code or config files
   - "项目用 TypeScript" → REMOVE (tsconfig.json exists)
   - "测试框架是 vitest" → REMOVE (package.json exists)
   - "Pi 工具接口是 AgentTool" → REMOVE (source code exists)

2. **Trivia**: Interesting but not useful for future work
   - "Pi 的 CLI 用 --model 参数" → REMOVE (one-time config fact)

3. **Extension/tool installs**: Already encoded in config files
   - "装了 prettier" → REMOVE

## What to MERGE

Candidates that say the same thing in different words:
- "Pi 没有 MEMORY.md" + "Pi 没有跨 session 记忆" → MERGE into one
- "用户偏好简洁" + "用户不喜欢冗长解释" → MERGE into one

## What to KEEP

1. **User knowledge**: What the user has learned, their expertise level
2. **User preferences**: Communication style, code style — explicitly stated
3. **Decisions with reasons**: WHY something was chosen
4. **Project rules**: Constraints the agent must follow
5. **Context not in code**: Project background, future plans, architecture decisions

## Input format

You will receive a list of candidates with scores and evidence.

## Output format

Return ONLY valid JSON:
{
  "approved": [
    {
      "category": "knowledge|preference|decision|rule|fact",
      "title": "short title",
      "content": "merged and refined content",
      "merged_from": ["original titles that were merged"]  // optional
    }
  ]
}

Aim for 3-8 approved candidates. When in doubt, REMOVE.`;

async function deepSleepReview(candidates, apiKey) {
  if (candidates.length === 0) return [];
  if (candidates.length <= 2) return candidates; // too few to need review

  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.category}] "${c.title}" (score: ${c.score})\n` +
    `   Content: ${c.content.slice(0, 150)}\n` +
    `   Evidence: "${c.evidence.slice(0, 100)}"`
  ).join('\n\n');

  const isAnthropic = apiKey.startsWith('sk-ant-');
  let text;

  if (isAnthropic) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 2000, temperature: 0.2,
        system: DEEP_SLEEP_PROMPT,
        messages: [{ role: 'user', content: `Review these candidates:\n\n${candidateList}` }],
      }),
    });
    if (!res.ok) throw new Error(`Deep Sleep Anthropic: ${res.status}`);
    const data = await res.json();
    text = data.content?.[0]?.text || '';
  } else {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.2, max_tokens: 2000,
        messages: [
          { role: 'system', content: DEEP_SLEEP_PROMPT },
          { role: 'user', content: `Review these candidates:\n\n${candidateList}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Deep Sleep DeepSeek: ${res.status}`);
    const data = await res.json();
    text = data.choices?.[0]?.message?.content || '';
  }

  // Parse response
  let json = text.trim();
  const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) json = fence[1].trim();

  let parsed;
  try { parsed = JSON.parse(json); } catch {
    // If parsing fails, return original candidates (fail open — don't lose memories)
    console.log('   ⚠️  Deep Sleep response unparseable, keeping original candidates');
    return candidates;
  }

  const approved = parsed.approved || [];
  if (approved.length === 0) {
    console.log('   Deep Sleep rejected all candidates');
    return [];
  }

  // Map back to original candidate objects where possible
  const result = [];
  for (const a of approved) {
    const existing = candidates.find(c =>
      c.title.toLowerCase() === a.title.toLowerCase() ||
      (a.merged_from || []).some((m) => c.title.toLowerCase() === m.toLowerCase())
    );
    result.push({
      category: a.category || existing?.category || 'fact',
      title: a.title,
      content: a.content,
      evidence: existing?.evidence || '',
      score: existing?.score || 0,
      breakdown: existing?.breakdown || {},
      evidenceValid: true,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: DEEP SLEEP — Merge & Dedup (deterministic Jaccard pass)
// ═══════════════════════════════════════════════════════════════

function loadExistingMemories() {
  const memories = {};
  for (const cat of ['preference', 'decision', 'rule', 'fact', 'knowledge']) {
    const dir = path.join(ROOT, cat);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1] : f.replace('.md', '');
      memories[title] = content;
    }
  }
  return memories;
}

function similarity(a, b) {
  // Jaccard similarity on 3-grams
  const grams = s => {
    const g = new Set();
    for (let i = 0; i < s.length - 2; i++) g.add(s.slice(i, i + 3));
    return g;
  };
  const ga = grams(a.toLowerCase());
  const gb = grams(b.toLowerCase());
  const intersection = new Set([...ga].filter(x => gb.has(x)));
  const union = new Set([...ga, ...gb]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function shouldMerge(c1, c2) {
  return c1.category === c2.category && similarity(c1.title + c1.content, c2.title + c2.content) > 0.6;
}

function mergeMemories(candidates, existing) {
  const toSave = [];
  const merged = [];

  for (const c of candidates) {
    let isDuplicate = false;

    // Check against existing
    for (const [existingTitle, existingContent] of Object.entries(existing)) {
      const existingObj = { title: existingTitle, content: existingContent, category: c.category };
      if (shouldMerge(c, existingObj)) {
        merged.push({ existing: existingTitle, candidate: c.title, action: 'update' });
        // Update existing: append new content if different
        const existingFile = findMemoryFile(c.category, existingTitle);
        if (existingFile) {
          const updated = existingContent.trimEnd() + '\n\n### Updated ' + new Date().toISOString().split('T')[0] + '\n\n' + c.content;
          fs.writeFileSync(existingFile, updated);
        }
        isDuplicate = true;
        break;
      }
    }

    // Check against other candidates in this batch
    if (!isDuplicate) {
      for (const other of toSave) {
        if (shouldMerge(c, other)) {
          merged.push({ candidate1: c.title, candidate2: other.title, action: 'merge' });
          // Merge into the first one
          other.content += '\n\n' + c.content;
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) toSave.push(c);
  }

  return { toSave, merged };
}

function findMemoryFile(category, title) {
  const dir = path.join(ROOT, category);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    const titleMatch = content.match(/^#\s+(.+)/m);
    if (titleMatch && titleMatch[1] === title) return path.join(dir, f);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4: REM — Cross-category linking notes
// ═══════════════════════════════════════════════════════════════

function generateCrossLinks(candidates) {
  const links = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.category !== b.category && similarity(a.content, b.content) > 0.4) {
        links.push({
          from: `[${a.category}] ${a.title}`,
          to: `[${b.category}] ${b.title}`,
          reason: 'related concepts',
        });
      }
    }
  }
  return links;
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// DORMANCY: per-project activity tracking & cleanup
// ═══════════════════════════════════════════════════════════════

function getProjectFromSession(sessionPath) {
  // Extract project dir name from session path like .../sessions/--home-xxx--project/
  const dir = sessionPath.split('/sessions/')[1]?.split('/')[0] || '';
  // Convert Pi's session dir naming back to project name
  const parts = dir.split('--').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

function touchProjectActivity(projectSlug) {
  const marker = path.join(ROOT, projectSlug, '.last-active');
  fs.mkdirSync(path.join(ROOT, projectSlug), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());
}

function getDormancyDays(projectSlug) {
  const marker = path.join(ROOT, projectSlug, '.last-active');
  if (!fs.existsSync(marker)) return -1;
  const t = new Date(fs.readFileSync(marker, 'utf-8').trim());
  return Math.floor((Date.now() - t.getTime()) / (1000 * 60 * 60 * 24));
}

function cleanupDormantProjects() {
  const deleted = [];
  if (!fs.existsSync(ROOT)) return deleted;
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'global') continue;
    const days = getDormancyDays(entry.name);
    if (days > DORMANT_DELETE_DAYS) {
      fs.rmSync(path.join(ROOT, entry.name), { recursive: true, force: true });
      deleted.push({ project: entry.name, days });
    }
  }
  return deleted;
}

function checkDormancyWarnings() {
  // Simplified: >30 days = delete. No warning tier.
  return [];
}

// ═══════════════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════════════

function saveMemory(category, title, content) {
  fs.mkdirSync(path.join(ROOT, category), { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = title.toLowerCase()
    .replace(/[一-鿿]+/g, m => '-' + Buffer.from(m).toString('hex') + '-')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '.md';

  const body = ['---', `category: ${category}`, `created: ${date}`, `updated: ${date}`, '---', '', `# ${title}`, '', content].join('\n');
  fs.writeFileSync(path.join(ROOT, category, filename), body);

  // Mark project active
  const projectDir = path.dirname(path.dirname(path.join(ROOT, category, filename)));
  touchProjectActivity(path.basename(projectDir));

  // Update index
  const rel = `${category}/${filename}`;
  const entry = `- [${title}](${rel})`;
  let idx = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf-8') : '# Memory Index\n\n';
  const lines = idx.split('\n');
  const dup = lines.findIndex(l => l.includes(`(${rel})`));
  if (dup >= 0) lines[dup] = entry;
  else if (!lines.includes(entry)) lines.push(entry);
  fs.writeFileSync(INDEX, lines.join('\n').trimEnd() + '\n');
}

function updateIndexForRetired(retiredItems) {
  // Deprecated: dormancy-based cleanup now handles this.
  // Projects > 90 days dormant are deleted entirely.
}

// ═══════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════

// Check if there's a session from today (worth extracting)
function hasSessionToday() {
  const base = path.join(homedir(), '.pi', 'agent', 'sessions');
  if (!fs.existsSync(base)) return false;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(base, dir.name))) {
      if (f.endsWith('.jsonl') && f >= today) return true;
    }
  }
  return false;
}

async function main() {
  console.log('🧠 Triple-pi Memory Extractor');
  console.log('   Pipeline: Light Sleep → Scoring → Deep Sleep → REM\n');

  // Accept transcript path as CLI argument (for manual testing)
  const cliPath = process.argv[2];

  // If running automatically (no CLI arg), skip when no session today
  if (!cliPath && !hasSessionToday()) {
    console.log('⏭  No sessions today. Skipping extraction.\n');
    process.exit(0);
  }

  // Find transcript
  console.log('🔍 Phase 0: Finding latest Pi session...');
  const t = cliPath ? { path: cliPath } : findLatestTranscript();
  if (!t) { console.log('   No transcripts found. Run ./pi-test.sh first.\n'); process.exit(1); }
  console.log(`   ${t.path}\n`);

  // Load
  console.log('📖 Loading transcript...');
  const messages = loadTranscript(t.path);
  const userCount = messages.filter(m => m.role === 'user').length;
  const asstCount = messages.filter(m => m.role === 'assistant').length;
  console.log(`   ${messages.length} messages (${userCount} user, ${asstCount} assistant)\n`);

  if (messages.length < 4) {
    console.log('   Too short (< 4 messages). Nothing to extract.\n');
    process.exit(0);
  }

  // Phase 1: Light Sleep
  console.log('🌙 Phase 1: Light Sleep — LLM extraction...');
  const text = await callLLM(messages);
  const candidates = parseCandidates(text);
  console.log(`   Extracted ${candidates.length} candidates\n`);

  if (candidates.length === 0) {
    console.log('   No memories worth extracting. Session was likely testing/exploration.\n');
    process.exit(0);
  }

  // Phase 2: Scoring + Evidence Validation
  console.log('📊 Phase 2: Scoring & Validation...');
  const scores = loadScores();
  const existingMemories = loadExistingMemories();

  const scored = candidates
    .map(c => {
      const score = scoreCandidate(c, messages, existingMemories, scores);
      const valid = validateEvidence(c, messages);
      return { ...c, score: score.total, breakdown: score.breakdown, evidenceValid: valid };
    });

  // Show ALL candidates with their status
  console.log(`   All ${scored.length} candidates:`);
  for (const c of scored) {
    const icon = c.evidenceValid ? (c.score >= SCORE_THRESHOLD ? '✅' : '📉') : '❌';
    const reason = !c.evidenceValid ? 'evidence not in transcript'
      : c.score < SCORE_THRESHOLD ? `score ${c.score.toFixed(3)} < ${SCORE_THRESHOLD}`
      : 'PASSED';
    console.log(`   ${icon} [${c.category}] "${c.title}"`);
    console.log(`      ${reason} | freq:${c.breakdown.frequency.toFixed(2)} rel:${c.breakdown.relevance.toFixed(2)} rec:${c.breakdown.recency.toFixed(2)} div:${c.breakdown.query_diversity.toFixed(2)} con:${c.breakdown.consolidation.toFixed(2)} rich:${c.breakdown.conceptual_richness.toFixed(2)}`);
  }

  const filtered = scored
    .filter(c => c.evidenceValid && c.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_PER_RUN);

  console.log(`\n   After filtering (evidence ✓ + score ≥ ${SCORE_THRESHOLD}): ${filtered.length} candidates\n`);

  if (filtered.length === 0) {
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best) console.log(`   Best candidate: "${best.title}" (score ${best.score.toFixed(3)}, evidence: ${best.evidenceValid})\n`);
    process.exit(0);
  }

  // Phase 2.5: Deep Sleep — LLM quality review
  console.log('💤 Phase 2.5: Deep Sleep — LLM quality review...');
  const reviewed = await deepSleepReview(filtered, API_KEY);
  console.log(`   ${filtered.length} candidates → ${reviewed.length} after review`);
  if (reviewed.length < filtered.length) {
    const removed = filtered.filter(c => !reviewed.find(r => r.title === c.title));
    for (const r of removed) console.log(`   ❌ Removed: "${r.title}"`);
  }
  console.log('');

  // Phase 3: Merge & Dedup
  console.log('🔗 Phase 3: Merge & Dedup...');
  const { toSave, merged } = mergeMemories(reviewed, existingMemories);
  console.log(`   Merged/updated: ${merged.length} | New to save: ${toSave.length}`);
  for (const m of merged) {
    console.log(`   🔗 ${m.action}: "${m.existing || m.candidate1}" ↔ "${m.candidate || m.candidate2}"`);
  }
  console.log('');

  // Save
  let saved = 0;
  for (const c of toSave) {
    saveMemory(c.category, c.title, c.content);
    console.log(`   ✅ [${c.category}] "${c.title}" (score: ${c.score.toFixed(3)})`);
    saved++;
  }

  // Phase 4: REM
  console.log('\n🌈 Phase 4: REM — Cross-linking...');
  const links = generateCrossLinks(scored);
  if (links.length > 0) {
    for (const l of links) console.log(`   🔗 ${l.from} ↔ ${l.to} (${l.reason})`);
  } else {
    console.log('   No cross-category links found.');
  }

  // Touch current project activity
  const currentProject = getProjectFromSession(cliPath || t.path);
  touchProjectActivity(currentProject);

  // Dormancy: >30 days inactivity → delete project memories
  console.log('\n🗂️  Dormancy check (>30 days → delete)...');
  const cleaned = cleanupDormantProjects();
  for (const c of cleaned) {
    console.log(`   🗑️  ${c.project}: deleted (dormant ${c.days} days)`);
  }
  if (cleaned.length === 0) {
    console.log('   All projects active (within 30 days).');
  }

  // Update scores for frequency tracking
  for (const c of scored) {
    const key = c.title.toLowerCase();
    scores[key] = (scores[key] || 0) + 1;
  }
  saveScores(scores);

  console.log(`\n📊 Summary: saved ${saved}, merged ${merged.length}, filtered ${candidates.length - reviewed.length}, deleted ${cleaned.length}`);
  console.log(`   Score threshold: ≥${SCORE_THRESHOLD} | Max per run: ${MAX_CANDIDATES_PER_RUN}\n`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
