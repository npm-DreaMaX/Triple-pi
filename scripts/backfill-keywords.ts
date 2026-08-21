/**
 * 3a M3 — 存量记录 keywords 回填脚本。
 *
 * keywords 字段上线前的存量记录没有检索关键词。本脚本扫描指定 memory root 下
 * 全部记录文件，对缺失 keywords 的记录做**机械回填**（可推导的候选词），语义回填
 * （如 "PyG" ↔ "PyTorch Geometric"）交给下一次抽取/合并——抽取提示词已产出
 * keywords，consolidation replace 时并集保留旧词。
 *
 * 机械推导规则（只加确定有检索价值的词，宁可少加不可加错）：
 *   1. 标题/内容中的 ASCII 技术词（CamelCase/snake_case/全大写缩写，如 JWT、PyTorch）
 *   2. 标题中的 CJK bigram（标题是记录最像关键词的部分）
 *   均去停用词、去重、≤10 个、每个 ≤40 字符；不覆盖已有 keywords。
 *
 * ⚠ 本脚本内联了记录磁盘格式的解析/序列化（与 repository.ts 的 serializeRecord/
 * parseRecord 保持一致）。改仓库格式时同步此处。
 *
 * 用法（干跑，只报告）：
 *   node --experimental-strip-types scripts/backfill-keywords.ts <memory-root>
 * 写回：
 *   node --experimental-strip-types scripts/backfill-keywords.ts <memory-root> --write
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const RECORD_START = "<!-- triple-pi-memory";
const RECORD_END = "-->";

interface RecordMeta {
  schemaVersion: number;
  id: string;
  category: string;
  scope: string;
  projectId: string;
  title: string;
  content?: string;
  keywords?: string[];
  createdAt: string;
  updatedAt: string;
  provenance: unknown;
  [key: string]: unknown;
}

function parseRecordFile(raw: string, filepath: string): RecordMeta {
  if (!raw.startsWith(`${RECORD_START}\n`)) throw new Error(`Invalid memory record: ${filepath}`);
  const end = raw.indexOf(`\n${RECORD_END}\n`);
  if (end < 0) throw new Error(`Invalid memory metadata: ${filepath}`);
  const metadata = JSON.parse(raw.slice(RECORD_START.length + 1, end)) as RecordMeta;
  const body = raw.slice(end + `\n${RECORD_END}\n\n`.length);
  const titleEnd = body.indexOf("\n\n");
  const title = body.startsWith("# ") ? body.slice(2, titleEnd) : metadata.title;
  const content = titleEnd >= 0 ? body.slice(titleEnd + 2).trim() : "";
  return { ...metadata, title, content };
}

function serializeRecordFile(meta: RecordMeta): string {
  const { title, content, ...metadata } = meta;
  return `${RECORD_START}\n${JSON.stringify(metadata, null, 2)}\n${RECORD_END}\n\n# ${title}\n\n${content ?? ""}\n`;
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "use", "using", "not", "are", "was", "you", "your"]);

function asciiTerms(text: string): string[] {
  const tokens = text.match(/[A-Za-z][A-Za-z0-9_]{1,39}/g) ?? [];
  return tokens.filter((t) => /[A-Z0-9]/.test(t) && t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
}

function cjkBigrams(text: string): string[] {
  const cjk = text.replace(/[^一-鿿]/g, "");
  const out: string[] = [];
  for (let i = 0; i < cjk.length - 1; i += 1) out.push(cjk.slice(i, i + 2));
  return out;
}

function deriveKeywords(title: string, content: string): string[] {
  const candidates = [...asciiTerms(`${title} ${content}`), ...cjkBigrams(title).slice(0, 6)];
  return [...new Set(candidates)].slice(0, 5);
}

async function findRecordFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await findRecordFiles(p, out);
    else if (e.name.endsWith(".md") && !e.name.startsWith("MEMORY")) out.push(p);
  }
}

async function main(): Promise<void> {
  const root = process.argv[2];
  const write = process.argv.includes("--write");
  if (!root) {
    console.error("用法: backfill-keywords.ts <memory-root> [--write]");
    process.exit(1);
  }
  const files: string[] = [];
  await findRecordFiles(root, files);

  let missing = 0;
  let filled = 0;
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const meta = parseRecordFile(raw, file);
    if (meta.keywords && meta.keywords.length > 0) continue;
    missing += 1;
    const keywords = deriveKeywords(meta.title, meta.content ?? "");
    if (keywords.length === 0) continue;
    console.log(`${write ? "回填" : "可回填"} [${meta.category}] ${meta.title} → ${keywords.join(", ")}`);
    filled += 1;
    if (write) {
      await fs.writeFile(file, serializeRecordFile({ ...meta, keywords }));
    }
  }
  console.log(`\n共 ${files.length} 条记录，缺 keywords 的 ${missing} 条，可机械回填 ${filled} 条${write ? "（已写回）" : "（加 --write 写回）"}。`);
  console.log("语义级 keywords（缩写/同义改写）需经抽取管线或手工补充——下一次 consolidation 会并集保留。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
