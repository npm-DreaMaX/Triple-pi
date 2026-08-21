/**
 * tokenize.ts — 文本归一化分词器（写入侧去重 / 指纹共享）。
 *
 * 修复 M1（审计 §3.3）：原 `[\p{L}\p{N}]+/gu` 在中文上不切词（中文无空格），
 * 整段中文被当成单个 run，导致：
 *   - `semanticFingerprint` 对同义中文生成完全不同的指纹（去重失效）
 *   - `similarity` 对同义中文返回 0（near-duplicate 检测失效）
 *   - 中英混排 `这个项目使用pnpm...` 整串 1 token，pnpm/npm 全丢失
 *
 * 修法：CJK 字符拆成 bigram（图学习→[图学,学习]），ASCII 仍按 `[字母数字]+`
 * 切。bigram 是无分词器时中文相似度的标准近似，覆盖率高、无需词典、确定性。
 * 单字符 bigram 天然 length=2，原 `length>1` 过滤语义保持。
 *
 * 此前 `signals.ts` 与 `consolidation.ts` 各自重复同一段正则；现统一收敛到本文件，
 * 保证指纹相似度口径一致（指纹与相似度用同一分词，是去重一致性的前提）。
 */

const ASCII_TOKEN = /[a-z0-9]+/g;
// CJK 统一表意文字 + 兼容表意 + 扩展 A（覆盖中日韩常用字），不含标点/空格
const CJK_CHAR = /[㐀-鿿豈-﫿]/;

function isCjk(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

/**
 * 将文本切成归一化 token：
 *   - ASCII：连续字母数字一个 token（现有行为）
 *   - CJK：相邻 CJK 字符两两 bigram（"图学习" → ["图学","学习"]）
 *   - 标点/空格：分隔符，消费
 *
 * 大小写归一化在前；返回值未排序去重（调用方按需处理，保持与原行为一致的职责划分）。
 */
export function tokenize(value: string): string[] {
  const lower = value.toLocaleLowerCase();
  const tokens: string[] = [];

  let i = 0;
  while (i < lower.length) {
    const ch = lower[i];
    if (isCjk(ch)) {
      // 聚合连续 CJK run，再切成 bigram
      let j = i;
      while (j < lower.length && isCjk(lower[j])) j += 1;
      const run = lower.slice(i, j);
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let k = 0; k < run.length - 1; k += 1) {
          tokens.push(run.slice(k, k + 2));
        }
      }
      i = j;
    } else if (/[a-z0-9]/.test(ch)) {
      // ASCII run：连续字母数字
      const m = lower.slice(i).match(ASCII_TOKEN);
      if (m && m.length > 0) {
        tokens.push(m[0]);
        i += m[0].length;
      } else {
        i += 1; // 不可达，防御
      }
    } else {
      // 标点/空格/其他：分隔符
      i += 1;
    }
  }

  return tokens.filter((token) => token.length > 1);
}

/**
 * 排序去重后的 token 列表，供指纹使用（与原 normalizedTokens 行为对齐）。
 */
export function normalizedTokens(value: string): string[] {
  return [...new Set(tokenize(value))].sort();
}
