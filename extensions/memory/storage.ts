/**
 * Memory Storage Layer
 *
 * Index + per-file persistence. Same design as before, extracted into
 * a standalone module so both the Pi Extension and SDK entry can use it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

// Types
export type MemoryCategory = 'preference' | 'decision' | 'rule' | 'fact';

export interface MemoryEntry {
  path: string;
  category: MemoryCategory;
  title: string;
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  snippet: string;
}

// Paths
const ROOT = path.join(homedir(), '.triple-pi', 'memory');
const INDEX = path.join(ROOT, 'MEMORY.md');
const CATS: MemoryCategory[] = ['preference', 'decision', 'rule', 'fact'];

// Init
export function ensureDir(): void {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const c of CATS) fs.mkdirSync(path.join(ROOT, c), { recursive: true });
  if (!fs.existsSync(INDEX)) fs.writeFileSync(INDEX, '# Memory Index\n\n');
}

// Index
export function loadIndex(): string | null {
  ensureDir();
  return fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf-8') : null;
}

// Save
export function save(category: MemoryCategory, title: string, content: string): string {
  ensureDir();
  const date = new Date().toISOString().split('T')[0];
  const filename = title
    .toLowerCase()
    .replace(/[一-鿿]+/g, (m) => '-' + Buffer.from(m).toString('hex') + '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') + '.md';
  const filepath = path.join(ROOT, category, filename);
  const body = [
    '---',
    `category: ${category}`,
    `created: ${date}`,
    `updated: ${date}`,
    '---', '', `# ${title}`, '', content,
  ].join('\n');
  fs.writeFileSync(filepath, body);

  // Update index
  const rel = `${category}/${filename}`;
  const entry = `- [${title}](${rel})`;
  let idx = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf-8') : '# Memory Index\n\n';
  const lines = idx.split('\n');
  const dup = lines.findIndex((l) => l.includes(`(${rel})`));
  if (dup >= 0) lines[dup] = entry;
  else if (!lines.includes(entry)) lines.push(entry);
  fs.writeFileSync(INDEX, lines.join('\n').trimEnd() + '\n');

  return filepath;
}

// Search
export function search(keyword: string, max = 5): SearchResult[] {
  ensureDir();
  const results: SearchResult[] = [];
  const lower = keyword.toLowerCase();

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
        const c = fs.readFileSync(full, 'utf-8');
        const i = c.toLowerCase().indexOf(lower);
        if (i >= 0) {
          const rel = path.relative(ROOT, full);
          const start = Math.max(0, i - 50);
          const end = Math.min(c.length, i + keyword.length + 100);
          results.push({
            entry: {
              path: rel,
              category: rel.split('/')[0] as MemoryCategory,
              title: path.basename(e.name, '.md'),
              createdAt: (c.match(/created:\s*(.+)/)?.[1] ?? '').trim(),
              updatedAt: (c.match(/updated:\s*(.+)/)?.[1] ?? '').trim(),
              content: c,
            },
            snippet: (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : ''),
          });
        }
      }
    }
  };
  walk(ROOT);
  results.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  return results.slice(0, max);
}

// Build system prompt (used when injecting via SDK, not needed for Extension)
export function buildPrompt(): string {
  const idx = loadIndex();
  const entries = (idx?.match(/^-\s*\[/gm) ?? []).length;
  if (entries === 0) {
    return '## Persistent Memory\n\nNo memories yet. They will be extracted after each session.\n';
  }
  return `## Persistent Memory\n\n${entries} memories across sessions. Index:\n\n${idx}`;
}
