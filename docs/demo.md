# Demo Guide — review_current_changes 端到端验证

> 验证完整链路：Git Diff → Memory 检索 → Reviewer SubAgent → 结构化 ReviewResult

## 前置条件

- Pi Runtime 已构建（`npm run setup`）
- 至少配置一个可用模型
- Memory Extension 和 SubAgent Extension 已安装

## 步骤

### 1. 创建临时项目

```bash
mkdir /tmp/review-demo
cd /tmp/review-demo
git init
npm init -y
```

### 2. 保存项目 Memory

在 Pi 中执行：

```
记住：TypeScript 代码禁止使用 any 类型
记住：数据库事务必须设置 timeout
```

确认两条 Memory 已保存（`/memory-status`）。

### 3. 创建违规代码

创建 `src/payment.ts`：

```typescript
export async function processPayment(input: any) {
  return db.transaction(async (tx) => {
    return tx.payment.create({ data: input });
  });
}
```

Stage 文件后修改（制造未提交 diff）：

```bash
git add src/payment.ts
git commit -m "initial"
# 修改文件：给 input 加 any 类型，去掉 transaction timeout
```

### 4. 调用 review_current_changes

在 Pi 中：

```
审查当前改动
```

Agent 应调用 `review_current_changes` tool。

### 5. 验收清单

□ Git Diff 自动读取成功
□ Memory 检索到相关规则（至少含"禁止 any"和"事务 timeout"）
□ Reviewer SubAgent 创建成功
□ findings 包含：
  - 使用了 `any` 类型
  - `transaction()` 缺少 timeout
□ Reviewer 没有修改任何文件（`git status` 显示修改仍在）
□ 返回结构化 JSON ReviewResult
□ 耗时在预期范围内

## 预期输出

```json
{
  "status": "issues_found",
  "summary": "Found 2 issues in payment.ts",
  "findings": [
    {
      "severity": "high",
      "file": "src/payment.ts",
      "line": 1,
      "description": "Parameter 'input' uses 'any' type, which is prohibited by project rules"
    },
    {
      "severity": "high", 
      "file": "src/payment.ts",
      "line": 2,
      "description": "Database transaction is missing timeout configuration"
    }
  ]
}
```

## 验收记录

| 项目 | 值 |
|---|---|
| Commit SHA | |
| 模型 | |
| Diff 是否自动读取 | |
| Memory 检索条数 | |
| Reviewer 创建成功 | |
| Findings 数量 | |
| 是否修改文件 | |
| 耗时 | |
| 工具调用次数 | |
