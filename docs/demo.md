# Demo — review_current_changes 端到端验证 Runbook

## 前置条件

- Node.js >= 22.19.0
- 已执行 `npm run setup`
- 已配置 Pi 模型（可通过 `pi` CLI 交互确认模型可用）
- Git 仓库 `/tmp/review-demo` 已初始化并有 staged/unstaged 变更

## Step 1: 准备环境

```bash
# 初始化 demo 仓库
mkdir -p /tmp/review-demo
cd /tmp/review-demo
git init
git config user.email demo@test
git config user.name Demo

# 创建原始代码
cat > src/payment.ts << 'EOF'
export class PaymentRequest {
  constructor(public amount: number) {}
}

export async function processPayment(req: PaymentRequest) {
  return db.transaction(async (tx) => {
    return tx.payment.create({ data: { amount: req.amount } });
  });
}
EOF

git add -A && git commit -m "init"
```

## Step 2: 引入违规修改

```bash
# 引入 any 类型和移除 timeout
cat > src/payment.ts << 'EOF'
export class PaymentRequest {
  constructor(public amount: any) {}
}

export async function processPayment(req: PaymentRequest) {
  return db.transaction(async (tx) => {
    return tx.payment.create({ data: { amount: req.amount } });
  });
}
EOF
```

## Step 3: 注入项目规则

```bash
cd /home/FangWang/Triple-pi

# 配置临时 Memory root（不污染真实记忆）
export TRIPLE_PI_MEMORY_ROOT=/tmp/review-demo-memory

# 插入规则
node --experimental-strip-types -e "
import { FilesystemMemoryRepository } from './extensions/memory/repository.ts';
const repo = new FilesystemMemoryRepository({ root: '/tmp/review-demo-memory' });
await repo.save({ category: 'rule', scope: 'project', cwd: '/tmp/review-demo', title: '禁止使用 any 类型', content: '所有 TypeScript 代码禁止使用 any 类型。' });
await repo.save({ category: 'rule', scope: 'project', cwd: '/tmp/review-demo', title: '数据库事务必须设置 timeout', content: '所有数据库事务必须显式设置 timeout 参数。' });
console.log('Rules injected.');
"
```

## Step 4: 运行 Demo

```bash
node --experimental-strip-types scripts/demo.mjs
```

## Step 5: 预期输出

```
=== Memory: 2 rules, diff ready ===
=== Creating Reviewer Session ===

=== Raw Output (N chars) ===
{ "status": "issues_found", "summary": "...", "findings": [...] }

=== Parsed Result ===
Status: issues_found
Summary: Found 2 issues
Findings:
  - [high] src/payment.ts — 禁止使用 any 类型
  - [high] src/payment.ts — 数据库事务必须设置 timeout

Elapsed: ~2000ms
Git status: (no modification by reviewer)
=== DEMO COMPLETE ===
```

## 验证要点

| 验收项 | 方法 |
|---|---|
| Memory 自动检索 | 日志显示 "2 rules" 且搜索返回 2/2 命中 |
| Reviewer Session 创建 | 日志无 "Error" 或 "Failed" |
| 发现 any 类型违规 | findings 包含对应描述 |
| 发现 timeout 缺失 | findings 包含对应描述 |
| 未修改文件 | `git status --short` 保持原始状态 |
| 响应时间 | 通常 1-5 秒 |

## 离线模式（不调用真实 LLM）

使用 `eval:recorded` 验证接线：

```bash
npm run eval:recorded
```

使用 fixture 验证指标计算：

```bash
npx vitest run test/eval
```
