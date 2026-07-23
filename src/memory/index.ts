/**
 * Triple-pi Memory System — Core Module
 *
 * ============================================================================
 * DESIGN RATIONALE (for interview reference)
 * ============================================================================
 *
 * Q: Why file-based instead of a database?
 * A: Three reasons:
 *    1. Human-editable — user can vim ~/.triple-pi/memory/prefs/xxx.md
 *    2. Git-trackable — memory changes are version-controlled
 *    3. Zero-dependency — no PostgreSQL, no Redis. Filesystem is enough
 *       for a personal agent (< 500 memories).
 *
 *    When the user's memory grows beyond ~500 entries, we'd introduce
 *    SQLite + vector search (like OpenClaw's GBrain). But that's solving
 *    a problem we don't have yet.
 *
 * Q: Why index + per-file instead of one big MEMORY.md?
 * A: Token budget. The index is < 200 tokens and always injected into
 *    the system prompt. Individual memory files are only read when the
 *    agent needs them (via the Read tool, same as reading any project file).
 *
 *    If all memories were in one file, a year's worth (500KB+) would be
 *    injected into every LLM call, burning tokens and diluting relevance.
 *
 * Q: Why not use Pi's existing session transcript persistence?
 * A: Pi's transcript is a "diary" — complete record of every message.
 *    Our MEMORY.md is a "post-it note" — extracted knowledge.
 *    A diary is for lookup; a post-it is for immediate awareness.
 *    The agent can resume a session from transcript, but it can't
 *    carry key preferences into a brand-new session. That's the gap
 *    we fill.
 *
 * Q: What did you borrow from OpenClaw?
 * A: The index + per-file pattern, and the principle that "only grounded
 *    information enters long-term memory" — the agent can only save
 *    memories when the user explicitly asks or when a significant
 *    decision is made. We don't auto-extract from every conversation
 *    (that's the Dreaming phase, deferred for now).
 *
 * ============================================================================
 * TRADE-OFFS
 * ============================================================================
 *
 * Simplicity vs Scale:
 *   - grep-based search is fast enough for < 500 files
 *   - No vector DB means no extra infrastructure
 *   - Trade-off: semantic search ("find memories about error handling")
 *     won't work well. This is acceptable for a single-user agent where
 *     the user can organize memories into categories.
 *
 * Full injection vs On-demand:
 *   - Index always injected = agent always knows WHAT it remembers
 *   - Details on-demand = saves tokens, but adds one Read tool call
 *   - Trade-off: if the agent frequently needs memory details, it makes
 *     extra Read calls. But in practice, memories are rarely needed —
 *     they're guardrails, not instructions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryIndex,
  MemoryIndexEntry,
  SearchResult,
} from './types.js';
import { CATEGORY_GUIDELINES } from './types.js';

// ============================================================================
// Paths
// ============================================================================

const MEMORY_ROOT = path.join(homedir(), '.triple-pi', 'memory');
const INDEX_FILE = path.join(MEMORY_ROOT, 'MEMORY.md');
const INDEX_HEADER = '# Memory Index\n\n';

const CATEGORY_DIRS: MemoryCategory[] = ['preference', 'decision', 'rule', 'fact'];

// ============================================================================
// Initialization
// ============================================================================

/** Ensure the memory directory structure exists. Idempotent. */
export function ensureMemoryDir(): void {
  fs.mkdirSync(MEMORY_ROOT, { recursive: true });
  for (const cat of CATEGORY_DIRS) {
    fs.mkdirSync(path.join(MEMORY_ROOT, cat), { recursive: true });
  }
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, INDEX_HEADER);
  }
}

// ============================================================================
// Index Operations
// ============================================================================

/**
 * Load and parse the MEMORY.md index file.
 * Called once at agent startup. The raw content is injected into the system prompt.
 *
 * @returns The parsed index, or null if no index exists yet.
 */
export function loadMemoryIndex(): MemoryIndex | null {
  ensureMemoryDir();

  if (!fs.existsSync(INDEX_FILE)) return null;

  const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
  const entries = parseIndexEntries(raw);

  return { raw, entries };
}

/**
 * Parse individual `- [title](path)` entries from the index markdown.
 * Ignores headers, blank lines, and malformed entries.
 */
function parseIndexEntries(raw: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  // Matches: "- [Some Title](preference/some-file.md)"
  const linkRegex = /^-\s*\[(.+?)\]\((.+?)\)/;

  for (const line of raw.split('\n')) {
    const match = line.match(linkRegex);
    if (!match) continue;

    const title = match[1].trim();
    const relPath = match[2].trim();

    // Extract category from path: "preference/xxx.md" → "preference"
    const category = relPath.split('/')[0] as MemoryCategory;
    if (!CATEGORY_DIRS.includes(category)) continue;

    entries.push({ title, path: relPath, category });
  }

  return entries;
}

/**
 * Add an entry to the MEMORY.md index. Deduplicates by file path.
 * Called automatically by saveMemory().
 */
function addToIndex(category: MemoryCategory, filename: string, title: string): void {
  const relPath = `${category}/${filename}`;
  const entry = `- [${title}](${relPath})`;

  let content: string;
  if (fs.existsSync(INDEX_FILE)) {
    content = fs.readFileSync(INDEX_FILE, 'utf-8');
    // Dedup: if this path already exists, replace the old entry
    const lines = content.split('\n');
    const existingIdx = lines.findIndex((l) => l.includes(`(${relPath})`));
    if (existingIdx >= 0) {
      lines[existingIdx] = entry;
      content = lines.join('\n');
    } else {
      // Don't add duplicate titles
      if (lines.some((l) => l === entry)) return;
      content = content.trimEnd() + '\n' + entry + '\n';
    }
  } else {
    content = INDEX_HEADER + entry + '\n';
  }

  fs.writeFileSync(INDEX_FILE, content);
}

// ============================================================================
// Memory CRUD
// ============================================================================

/**
 * Persist a new memory to disk and update the index.
 *
 * Each memory is stored as a markdown file with YAML-style frontmatter
 * (not real YAML — just human-readable metadata in a code block).
 * The agent reads these files with the Read tool when needed.
 *
 * @param category - Type of memory (preference, decision, rule, fact)
 * @param title    - Short human-readable title, used in the index
 * @param content  - The body of the memory (markdown)
 */
export function saveMemory(
  category: MemoryCategory,
  title: string,
  content: string,
): string {
  ensureMemoryDir();

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const filename = titleToFilename(title);
  const filepath = path.join(MEMORY_ROOT, category, filename);

  // If file already exists, read existing created date
  let createdDate = dateStr;
  if (fs.existsSync(filepath)) {
    const existing = fs.readFileSync(filepath, 'utf-8');
    const createdMatch = existing.match(/created:\s*(.+)/);
    if (createdMatch) createdDate = createdMatch[1].trim();
  }

  // Write memory file with structured metadata header
  const body = [
    '---',
    `category: ${category}`,
    `created: ${createdDate}`,
    `updated: ${dateStr}`,
    '---',
    '',
    `# ${title}`,
    '',
    content,
  ].join('\n');

  fs.writeFileSync(filepath, body);

  // Update the index
  addToIndex(category, filename, title);

  return filepath;
}

/**
 * Read a single memory entry from disk by its relative path.
 * Used when the agent needs to load a specific memory's full content.
 */
export function readMemory(relPath: string): MemoryEntry | null {
  const fullPath = path.join(MEMORY_ROOT, relPath);

  // Path traversal protection
  if (!fullPath.startsWith(MEMORY_ROOT)) return null;
  if (!fs.existsSync(fullPath)) return null;

  const content = fs.readFileSync(fullPath, 'utf-8');
  const category = relPath.split('/')[0] as MemoryCategory;
  const title = path.basename(relPath, '.md');

  // Extract metadata from the frontmatter block
  const createdMatch = content.match(/created:\s*(.+)/);
  const updatedMatch = content.match(/updated:\s*(.+)/);

  return {
    path: relPath,
    category,
    title,
    createdAt: createdMatch?.[1]?.trim() ?? 'unknown',
    updatedAt: updatedMatch?.[1]?.trim() ?? 'unknown',
    content,
  };
}

/**
 * List all memory entries, optionally filtered by category.
 */
export function listMemories(category?: MemoryCategory): MemoryEntry[] {
  ensureMemoryDir();

  const results: MemoryEntry[] = [];
  const cats = category ? [category] : CATEGORY_DIRS;

  for (const cat of cats) {
    const dir = path.join(MEMORY_ROOT, cat);
    if (!fs.existsSync(dir)) continue;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relPath = `${cat}/${entry.name}`;
      const mem = readMemory(relPath);
      if (mem) results.push(mem);
    }
  }

  return results;
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search memories by keyword.
 *
 * Current implementation: case-insensitive substring match across all
 * memory files. This is intentionally simple — for a single-user agent
 * with < 500 memories, grep-style search is fast and has zero dependencies.
 *
 * Upgrade path (when needed):
 *   - > 500 memories: add SQLite FTS (full-text search)
 *   - Need semantic search: add embedding + vector similarity (pgvector)
 */
export function searchMemory(keyword: string, maxResults = 5): SearchResult[] {
  ensureMemoryDir();

  const results: SearchResult[] = [];
  const lowerKeyword = keyword.toLowerCase();

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        const content = fs.readFileSync(full, 'utf-8');
        const lowerContent = content.toLowerCase();
        const idx = lowerContent.indexOf(lowerKeyword);
        if (idx >= 0) {
          const relPath = path.relative(MEMORY_ROOT, full);
          const mem = readMemory(relPath);
          if (!mem) continue;

          // Extract a snippet around the match location
          const start = Math.max(0, idx - 50);
          const end = Math.min(content.length, idx + keyword.length + 100);
          let snippet = content.slice(start, end);
          if (start > 0) snippet = '…' + snippet;
          if (end < content.length) snippet = snippet + '…';

          results.push({ entry: mem, snippet });
        }
      }
    }
  };

  walk(MEMORY_ROOT);

  // Sort by modification time, newest first
  results.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));

  return results.slice(0, maxResults);
}

// ============================================================================
// Compaction (Simplified "Dreaming" Lite)
// ============================================================================

/**
 * Merge duplicate or near-duplicate memories within the same category.
 *
 * This is a simplified version of OpenClaw's "Deep Sleep" phase.
 * We detect duplicates by identical titles (case-insensitive), and
 * merge their content.
 *
 * Full Dreaming (semantic similarity detection, cross-category linking)
 * is deferred until memory volume justifies the LLM call cost.
 *
 * @returns Number of duplicates merged.
 */
export function deduplicateMemories(): number {
  ensureMemoryDir();

  let merged = 0;

  for (const cat of CATEGORY_DIRS) {
    const dir = path.join(MEMORY_ROOT, cat);
    if (!fs.existsSync(dir)) continue;

    const seen = new Map<string, string>(); // lowerTitle → filename

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const title = path.basename(entry.name, '.md').toLowerCase();
      const existing = seen.get(title);

      if (existing) {
        // Merge: append content of duplicate to original, delete duplicate
        const originalPath = path.join(dir, existing);
        const dupPath = path.join(dir, entry.name);

        const originalContent = fs.readFileSync(originalPath, 'utf-8');
        const dupContent = fs.readFileSync(dupPath, 'utf-8');

        // Extract just the body (after the metadata block and title)
        const dupBody = dupContent.split('---').slice(2).join('---').trim();
        const mergedContent = originalContent.trimEnd() + '\n\n### Updated\n\n' + dupBody;

        fs.writeFileSync(originalPath, mergedContent);
        fs.unlinkSync(dupPath);

        merged++;
      } else {
        seen.set(title, entry.name);
      }
    }
  }

  return merged;
}

// ============================================================================
// System Prompt Assembly
// ============================================================================

/**
 * Build the memory portion of the system prompt.
 *
 * This is the key integration point: the returned string is appended
 * to Pi's system prompt via `appendSystemPromptOverride`.
 *
 * Design decision: Only the INDEX is injected (not full memory contents).
 * The index tells the agent WHAT it remembers. When the agent needs a
 * specific memory, it uses the Read tool to load the file.
 *
 * Token cost analysis:
 *   - Index only: ~150-400 tokens (for ~20-50 memories)
 *   - Full contents: easily 5000+ tokens for the same memories
 *   - Savings: >90% token reduction while maintaining awareness
 */
export function buildMemorySystemPrompt(): string {
  const index = loadMemoryIndex();
  const entries = index?.entries ?? [];

  const categorySummary = CATEGORY_DIRS.map((c) => {
    const count = entries.filter((e) => e.category === c).length;
    return `${c}(${count})`;
  }).join(', ');

  let prompt = '## Persistent Memory\n\n';

  if (entries.length === 0) {
    prompt += 'No persistent memories yet. ';
    prompt += 'As you work with the user, important preferences, decisions, ';
    prompt += 'and project rules will be saved here across sessions.\n\n';
    prompt += 'To save a memory, use the SaveMemory tool when the user ';
    prompt += 'explicitly asks to remember something, or when a significant ';
    prompt += 'decision is made.\n';
    return prompt;
  }

  prompt += `You have ${entries.length} persistent memories (${categorySummary}).\n`;
  prompt += 'These survive across sessions. The index below shows what you remember.\n';
  prompt += 'To read a specific memory, use the Read tool with the full path.\n\n';
  prompt += `Memory root: ${MEMORY_ROOT}\n\n`;

  // Category guidelines — tell the agent when to write each type
  prompt += '### When to Save Memories\n\n';
  for (const cat of CATEGORY_DIRS) {
    prompt += `- **${cat}**: ${CATEGORY_GUIDELINES[cat]}\n`;
  }
  prompt += '\n';

  // The index itself
  prompt += '### Memory Index\n\n';
  prompt += index!.raw;

  return prompt;
}

// ============================================================================
// Utility
// ============================================================================

/** Convert a human-readable title to a filesystem-safe filename. */
function titleToFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[一-鿿]+/g, (m) => '-' + Buffer.from(m).toString('hex') + '-') // encode CJK
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    + '.md';
}

/** Get the absolute path to a memory file given a relative path from the index. */
export function memoryPath(relPath: string): string {
  const full = path.join(MEMORY_ROOT, relPath);
  if (!full.startsWith(MEMORY_ROOT)) {
    throw new Error(`Path traversal denied: ${relPath}`);
  }
  return full;
}
