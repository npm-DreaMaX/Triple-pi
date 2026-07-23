#!/usr/bin/env node
/**
 * Memory Extractor — post-session async memory extraction.
 *
 * Run after a Pi session:  npm run extract
 * Or:  node scripts/extract.mjs
 *
 * Loads the latest session transcript and uses LLM to extract
 * grounded memories. Inspired by OpenClaw's Dreaming / Light Sleep.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const IS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY;

// ── Find latest transcript ──────────────────────────────────

function findLatestTranscript() {
  const base = path.join(homedir(), '.pi', 'agent', 'sessions');
  if (!fs.existsSync(base)) throw new Error(`No Pi sessions directory: ${base}`);

  // Collect all .jsonl files across all session dirs
  const files = [];
  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(base, dir.name))) {
      if (f.endsWith('.jsonl')) {
        files.push({ path: path.join(base, dir.name, f), dir: dir.name });
      }
    }
  }

  // Sort by filename (which starts with ISO date)
  files.sort((a, b) => b.path.localeCompare(a.path));
  return files[0] || null;
}

// ── Load transcript ─────────────────────────────────────────

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
        messages.push({ role, content: text });
      }
    }
  }

  return messages;
}

// ── LLM call ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction system. Read this conversation between a user and their coding agent, and extract ONLY information that should persist across sessions.

## What to extract
1. User preferences (communication style, code style, tools)
2. Technical decisions (architecture, technology choices, reasons)
3. Project rules (constraints like "never push to main")
4. Important facts (project structure, key patterns)

## What to SKIP
- Debugging attempts and errors
- Work-in-progress discussions
- Chit-chat and greetings
- Session-only information
- Test/experimental content

## Rules
- Every memory MUST cite evidence from the transcript
- When in doubt, SKIP. Better to miss than to save junk.
- Be conservative. A personal agent typically has 20-50 memories total.

## Output
Return ONLY valid JSON:
{"candidates":[{"category":"preference|decision|rule|fact","title":"short title","content":"what to remember","evidence":"exact quote from transcript","confidence":"high|medium|low"}]}
If nothing worth extracting: {"candidates":[]}`;

function buildPrompt(messages) {
  const convo = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  const maxLen = 80000;
  const truncated = convo.length > maxLen
    ? convo.slice(0, maxLen) + '\n\n[... truncated ...]'
    : convo;
  return `Extract persistent memories from this conversation:\n\n${truncated}`;
}

async function callLLM(messages) {
  if (!API_KEY) throw new Error('Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY');

  if (IS_ANTHROPIC) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.1, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: buildPrompt(messages) }] }),
    });
    if (!res.ok) throw new Error(`Anthropic: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  // DeepSeek
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, max_tokens: 4000, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildPrompt(messages) }] }),
  });
  if (!res.ok) throw new Error(`DeepSeek: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Parse & validate ────────────────────────────────────────

function parseResponse(text) {
  let json = text.trim();
  const fence = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) json = fence[1].trim();

  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error(`Bad JSON: ${text.slice(0, 300)}`); }

  const valid = ['preference', 'decision', 'rule', 'fact'];
  return (parsed.candidates || []).filter(c =>
    valid.includes(c.category) && c.title && c.content && c.evidence
  );
}

function validateEvidence(candidate, messages) {
  const full = messages.map(m => m.content).join(' ');
  const words = candidate.evidence.split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return false;
  const matched = words.filter(w => full.toLowerCase().includes(w.toLowerCase()));
  return matched.length / words.length >= 0.7;
}

// ── Save ─────────────────────────────────────────────────────

function saveMemory(category, title, content) {
  const ROOT = path.join(homedir(), '.triple-pi', 'memory');
  const INDEX = path.join(ROOT, 'MEMORY.md');

  fs.mkdirSync(path.join(ROOT, category), { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = title.toLowerCase()
    .replace(/[一-鿿]+/g, m => '-' + Buffer.from(m).toString('hex') + '-')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '.md';

  const body = ['---', `category: ${category}`, `created: ${date}`, `updated: ${date}`, '---', '', `# ${title}`, '', content].join('\n');
  fs.writeFileSync(path.join(ROOT, category, filename), body);

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

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Finding latest Pi session...');
  const t = findLatestTranscript();
  if (!t) { console.log('No transcripts found.'); process.exit(1); }
  console.log(`   ${t.path}`);

  console.log('📖 Loading transcript...');
  const messages = loadTranscript(t.path);
  console.log(`   ${messages.length} messages (${messages.filter(m => m.role === 'user').length} user, ${messages.filter(m => m.role === 'assistant').length} assistant)`);

  if (messages.length < 4) {
    console.log('   Too short, nothing to extract.');
    process.exit(0);
  }

  console.log('🤖 Calling LLM to extract memories...');
  const text = await callLLM(messages);
  const candidates = parseResponse(text);
  console.log(`   ${candidates.length} candidates returned`);

  let saved = 0;
  for (const c of candidates) {
    if (c.confidence === 'low') {
      console.log(`   ⏭  Low confidence: "${c.title}"`);
      continue;
    }
    if (!validateEvidence(c, messages)) {
      console.log(`   ⏭  Evidence not found: "${c.title}"`);
      continue;
    }
    try {
      saveMemory(c.category, c.title, c.content);
      console.log(`   ✅ [${c.category}] "${c.title}"`);
      saved++;
    } catch (err) {
      console.log(`   ❌ Failed: "${c.title}" — ${err.message}`);
    }
  }

  console.log(`\n📊 Saved ${saved} memories, skipped ${candidates.length - saved}.`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
