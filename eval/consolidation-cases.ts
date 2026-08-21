/**
 * Consolidation (dedup) Eval — Layer 2 确定性去重评测（零 LLM）。
 *
 * 1b M1b 的度量基础：对 (candidate, existing) 记录对计算 similarity（Jaccard over
 * tokenize 集合），按预定义标签断言"该不该去重"。用于校准 consolidation.ts 的
 * 0.72 阈值——之前该阈值是盲定的，本集让它在数据上有依据。
 *
 * 标签语义：shouldDedup=true 表示二者是同一记忆的近重述（合并/跳过，不能双存）；
 * false 表示是不同的记忆（哪怕主题相关、同义表达），必须分别保留。
 * 判错方向权衡：误去重（false 判成 true）比漏去重（true 判成 false）更糟——
 * 误去重丢失信息且不可察觉，漏去重只是多一条冗余记录。阈值选择在 §阈值扫描 中
 * 按"零误去重前提下最小漏去重"原则。
 */

export interface ConsolidationPair {
  id: string;
  description: string;
  /** candidate 记录文本（title + content 合并，与 planConsolidation 口径一致） */
  candidate: string;
  /** existing 记录文本 */
  existing: string;
  /** true = 近重述应去重；false = 不同记忆应各自保留 */
  shouldDedup: boolean;
}

export const CONSOLIDATION_CASES: ConsolidationPair[] = [
  {
    id: "zh-near-restatement",
    description: "中文近重述（同义改写、语序调整）——应去重",
    candidate: "部署规范 部署前必须运行全部单元测试，测试通过后才能上线。",
    existing: "部署规范 上线之前必须跑完所有单元测试，测试通过了才能部署。",
    shouldDedup: true,
  },
  {
    id: "zh-punct-space-variant",
    description: "中文标点/空白变体——应去重",
    candidate: "包管理器 这个项目使用pnpm，不要用npm。",
    existing: "包管理器 这个项目使用 pnpm，不要用 npm。",
    shouldDedup: true,
  },
  {
    id: "en-restatement",
    description: "英文重述（语序调整、同义改写）——应去重",
    candidate: "Deployment rule Run all unit tests before deploying to production.",
    existing: "Deployment rule Before you deploy to production, run every unit test.",
    shouldDedup: true,
  },
  {
    id: "zh-same-meaning-detail-shift",
    description: "同一规范、细节增补（数字/版本变化）——应去重（更新而非双存）",
    candidate: "Node版本 要求Node 22以上。",
    existing: "Node版本 要求Node 20以上。",
    shouldDedup: true,
  },
  {
    id: "diff-auth-decisions",
    description: "同主题不同决策（JWT vs OAuth）——不得去重",
    candidate: "认证方式 使用JWT做无状态认证，弃用服务端session。",
    existing: "认证方式 使用OAuth2做第三方授权，内部服务用服务端session。",
    shouldDedup: false,
  },
  {
    id: "related-different-facts",
    description: "相关但不同事实（部署目录 vs 日志目录）——不得去重",
    candidate: "部署目录 应用部署在 /opt/app，端口8080。",
    existing: "日志目录 日志输出到 /var/log/app，按天轮转。",
    shouldDedup: false,
  },
  {
    id: "same-title-divergent-content",
    description: "同标题不同内容——不得去重（同标题已有 exactIdentity 路径，这里是语义层防线）",
    candidate: "数据库规范 迁移脚本必须可回滚。",
    existing: "数据库规范 查询必须走索引，禁止全表扫描。",
    shouldDedup: false,
  },
  {
    id: "zh-synonym-no-shared-token",
    description: "强同义但零共享 token（分词的极限）——不得去重（宁可冗余不可误删）",
    candidate: "测试策略 提交前必须执行自动化测试。",
    existing: "测试策略 代码合入之前要跑 CI 流水线验证。",
    shouldDedup: false,
  },
  {
    id: "zh-cross-category-ish",
    description: "主题相近、结论相反（用 vs 不用）——不得去重",
    candidate: "包管理器 以后统一使用pnpm。",
    existing: "包管理器 不要再使用pnpm，改用npm。",
    shouldDedup: false,
  },
  {
    id: "en-acronym-vs-full",
    description: "缩写 vs 全称（零共享 token 的英文变体）——不得去重（宁可冗余）",
    candidate: "Framework choice Use PyTorch Geometric for graph learning.",
    existing: "Framework choice Use PyG for graph learning.",
    shouldDedup: false,
  },
  {
    id: "zh-short-common-words",
    description: "大量公共词但事实不同——不得去重",
    candidate: "发布流程 发布前必须人工确认变更列表。",
    existing: "发布流程 发布后必须人工检查监控告警。",
    shouldDedup: false,
  },
  {
    id: "zh-partial-overlap-correct-dedup",
    description: "部分重叠但确实是同一记忆的补述——应去重",
    candidate: "发布流程 发布前必须人工确认变更列表，确认后才能上线。",
    existing: "发布流程 发布前必须人工确认变更列表。",
    shouldDedup: true,
  },
];

/**
 * 阈值扫描区间（审计 1b：0.68-0.80）。选择原则：
 *   零误去重（false→true 的 shouldDedup=false 用例全部分开）前提下，
 *   漏去重最少（shouldDedup=true 且 similarity<threshold 的最少）。
 */
export const THRESHOLD_SWEEP_START = 0.68;
export const THRESHOLD_SWEEP_END = 0.80;
export const THRESHOLD_SWEEP_STEP = 0.01;
