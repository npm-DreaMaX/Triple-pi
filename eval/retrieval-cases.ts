/**
 * Retrieval Eval — 检索质量评测用例集（Layer 2，确定性，零 LLM）。
 *
 * 与 extraction eval（eval/cases.ts）正交：后者测"抽取管线是否写出正确的记录"，
 * 本文件测"已落盘的记录能否被正确检索到，且相关记录排在前面"。
 *
 * 设计目标（对应审计报告 §3 的问题）：
 *   - M2 相关度排序：旧而相关的记录应排在新而不相关者之前
 *   - M3 词汇鸿沟：缩写 / 同义 / 跨语言 / 部分匹配
 *   - M1 中文检索：CJK 子串与 bigram 行为
 *   - 基线区分度：现状（子串匹配 + recency 排序）在哪些查询上明显丢分，
 *     为后续 BM25/打分/keywords 提供可量化 before/after
 *
 * 每个 case 独立持有一组 records + 一个查询 + 期望命中。多个期望命中时，
 * 排在最前的应排在 expectedOrdered[0]，用于 MRR 计算。
 *
 * 重要的"反例"约束：distractors 必须是当前检索系统会误召回但语义无关的记录，
 * 这样 Recall@k 才能区分"找到了"与"找到一堆噪声"。
 */

export interface RetrievalRecordSeed {
  id: string;
  category: string;
  title: string;
  content: string;
  scope?: "project" | "global";
  keywords?: string[];
  /** ISO updatedAt；recency 排序会把新的排前面——用来构造"新但不相关"反例 */
  updatedAt?: string;
  provenanceScore?: number;
  provenanceReinforcement?: number;
}

export interface RetrievalQueryCase {
  id: string;
  description: string;
  cwd: string;
  /** 直接落盘的记录（不经抽取，绕过 LLM） */
  records: RetrievalRecordSeed[];
  query: string;
  /** 期望命中的记录 id，按相关度从高到低排列（用于 Recall@k 与 MRR） */
  expectedOrdered: string[];
  /** 全局 + 项目记录都会被建立；查询针对该 cwd */
  maxResults?: number;
}

/**
 * 构造一组覆盖关键失败模式的查询用例。
 *
 * 刻意混入"现状会搜不到但语义上应命中"的查询（缩写/同义/跨语言），
 * 作为后续 keywords / 打分 优化的目标。这些 case 的基线 Recall@10 会 < 1，
 * 正是我们要证明改善的地方。
 */
export const RETRIEVAL_CASES: RetrievalQueryCase[] = [
  {
    id: "relevance-over-recency",
    description: "标题+多次命中+高信号的旧记录应排在新而弱相关者之前（M2 相关度排序）",
    cwd: "/retrieval/relevance",
    records: [
      // 高度相关（标题命中 + 多次命中 + 高信号），但最旧
      { id: "r1", category: "rule", title: "测试策略", content: "提交前必须跑单元测试再声明完成，测试不通过禁止合并。", updatedAt: "2026-01-01T00:00:00Z", provenanceScore: 0.8, provenanceReinforcement: 3 },
      // 弱相关（仅内容含一次"测试"，标题无关），但更新
      { id: "r2", category: "fact", title: "日志路径", content: "日志输出到 /var/log/app.log，测试环境用 /tmp。", updatedAt: "2026-08-01T00:00:00Z" },
      // 弱相关，最新
      { id: "r3", category: "knowledge", title: "会议纪要", content: "本周讨论了发布节奏，下周上线，测试组同步排期。", updatedAt: "2026-08-18T00:00:00Z" },
    ],
    // 三条都含"测试"避免被子串过滤；期望只有高度相关的 r1 排第一。
    // 现状基线：recency 排序 → 首位是 r3（最新）→ recall@1=0 / MRR=1/3，正是要修复的 M2。
    // 修复后打分排序 → 首位 r1 → recall@1=1 / MRR=1。
    query: "测试",
    expectedOrdered: ["r1"],
    maxResults: 10,
  },
  {
    id: "chinese-substring",
    description: "中文子串部分匹配应命中（字符级，现状即可，回归保护）",
    cwd: "/retrieval/cn-sub",
    records: [
      // 内容明确含"神经网络"四字，查询"神经网"是其子串
      { id: "c1", category: "decision", title: "模型选型", content: "首选图神经网络相关栈，已评估PyTorch Geometric。", updatedAt: "2026-08-01T00:00:00Z" },
      { id: "c2", category: "fact", title: "数据库连接", content: "使用PostgreSQL作为主库。", updatedAt: "2026-08-02T00:00:00Z" },
    ],
    query: "神经网",
    expectedOrdered: ["c1"],
  },
  {
    id: "acronym-vocabulary-gap",
    description: "缩写 PyG 应命中 PyTorch Geometric（M3 词汇鸿沟；现状基线预期 Miss，keywords 修复后命中）",
    cwd: "/retrieval/acronym",
    records: [
      { id: "a1", category: "decision", title: "图学习框架选型", content: "以后统一使用PyTorch Geometric，不要再用DGL。", keywords: ["PyG", "GNN", "图神经网络"], updatedAt: "2026-08-01T00:00:00Z" },
    ],
    query: "PyG",
    expectedOrdered: ["a1"],
    maxResults: 10,
  },
  {
    id: "cross-language-vocabulary-gap",
    description: "中文查询'图神经网络库'应命中英文 PyTorch Geometric（M3 跨语言；现状基线预期 Miss，keywords 修复后命中）",
    cwd: "/retrieval/xlang",
    records: [
      { id: "x1", category: "decision", title: "图学习框架选型", content: "以后统一使用PyTorch Geometric，不要再用DGL。", keywords: ["PyG", "GNN", "图神经网络库"], updatedAt: "2026-08-01T00:00:00Z" },
    ],
    query: "图神经网络库",
    expectedOrdered: ["x1"],
  },
  {
    id: "synonym-vocabulary-gap",
    description: "同义改写'鉴权'应命中'认证'相关记录（M3 同义；现状基线预期 Miss，keywords 修复后命中）",
    cwd: "/retrieval/synonym",
    records: [
      { id: "s1", category: "rule", title: "认证方式", content: "使用JWT做无状态认证，弃用服务端session。", updatedAt: "2026-06-01T00:00:00Z", keywords: ["鉴权", "登录", "auth"] },
      { id: "s2", category: "fact", title: "部署目录", content: "应用部署在 /opt/app，端口8080。", updatedAt: "2026-08-01T00:00:00Z" },
    ],
    query: "鉴权",
    expectedOrdered: ["s1"],
  },
  {
    id: "mixed-cjk-ascii-token",
    description: "中英混排记录的检索（M1 分词边界回归保护）",
    cwd: "/retrieval/mixed",
    records: [
      { id: "m1", category: "preference", title: "包管理器", content: "这个项目使用pnpm作为包管理器，不要用npm。", updatedAt: "2026-07-01T00:00:00Z" },
      { id: "m2", category: "fact", title: "Node版本", content: "要求Node 22以上。", updatedAt: "2026-08-01T00:00:00Z" },
    ],
    query: "pnpm",
    expectedOrdered: ["m1"],
  },
  {
    id: "title-vs-content-weight",
    description: "标题命中的记录应排在仅内容命中的记录之前（M2 标题加权）",
    cwd: "/retrieval/title-weight",
    records: [
      // 仅内容命中、但更新
      { id: "t1", category: "knowledge", title: "杂项笔记", content: "数据库迁移时记得备份。", updatedAt: "2026-08-15T00:00:00Z" },
      // 标题命中、但更旧
      { id: "t2", category: "rule", title: "数据库迁移规范", content: "迁移脚本必须可回滚。", updatedAt: "2026-01-01T00:00:00Z" },
    ],
    // 两条都含"数据库迁移"。期望标题命中的 t2 排第一。
    // 现状基线：recency 排序 → 首位 t1（新）→ recall@1=0 / MRR=1/2，正是要修复的 M2。
    // 修复后标题加权 → 首位 t2 → recall@1=1 / MRR=1。
    query: "数据库迁移",
    expectedOrdered: ["t2"],
    maxResults: 10,
  },
  {
    id: "signal-tiebreak",
    description: "同文本相关度时，高 reinforcement 信号记录应排前（M4 信号消费）",
    cwd: "/retrieval/signal",
    records: [
      // 两条标题都命中"部署"，内容相关度相同——唯高信号者应排第一。
      { id: "g1", category: "rule", title: "部署规范", content: "部署前必须跑冒烟测试。", updatedAt: "2026-01-01T00:00:00Z", provenanceScore: 0.9, provenanceReinforcement: 5 },
      { id: "g2", category: "rule", title: "部署清单", content: "部署后必须回滚验证。", updatedAt: "2026-08-01T00:00:00Z" },
    ],
    // M4：写时信号（score/reinforcement）读时曾被忽略。修复后信号加成让 g1 胜出。
    query: "部署",
    expectedOrdered: ["g1"],
  },
  {
    id: "keyword-noise-precision",
    description: "错误关键词（LLM 误加）不得压过标题命中的正确记录（M3 精度负例）",
    cwd: "/retrieval/noise",
    records: [
      // 正确记录：标题+内容双命中
      { id: "n1", category: "rule", title: "数据库迁移规范", content: "数据库迁移脚本必须可回滚。", updatedAt: "2026-01-01T00:00:00Z" },
      // 噪声记录：内容无关，但被误加了等于查询词的关键词，且更新（recency 也会把它顶上来）
      { id: "n2", category: "fact", title: "部署目录", content: "应用部署在 /opt/app。", keywords: ["数据库迁移"], updatedAt: "2026-08-01T00:00:00Z" },
    ],
    // keyword 权重 = 标题权重（×2）且多命中文本匹配压过单关键词命中——
    // 错误的 keywords 不得让无关记录排到正确记录前面。
    query: "数据库迁移",
    expectedOrdered: ["n1"],
  },
  {
    id: "m3-audit-acceptance",
    description: "审计原文验收：search(\"图学习框架\") 命中带 keywords 的记录（标题路径）",
    cwd: "/retrieval/audit-m3",
    records: [
      { id: "k1", category: "decision", title: "图学习框架选型", content: "以后统一使用PyTorch Geometric，不要再用DGL。", keywords: ["PyG", "图神经网络", "GNN framework"], updatedAt: "2026-08-01T00:00:00Z" },
    ],
    query: "图学习框架",
    expectedOrdered: ["k1"],
  },
];
