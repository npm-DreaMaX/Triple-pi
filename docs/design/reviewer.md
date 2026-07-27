# Reviewer 设计摘要

## 统一接线

Reviewer 通过 `review_current_changes` 工具自动触发。流程：

1. `collectGitChanges()`：读取 staged (`git diff --cached`) + unstaged (`git diff`) + untracked (`git ls-files --others`) 变更
2. `extractReviewSearchTerms()`：从 task 描述、文件路径、diff 符号中提取关键词，去重排序
3. `searchRelevantMemories()`：在 FilesystemMemoryRepository 中搜索匹配的记忆（按 title hit > hit terms > category > scope > updatedAt 排序）
4. `formatRelevantMemories()`：格式化搜索结果
5. `buildReviewerInput()`：构建 system prompt + user message（含 task/diff/memory 三部分 XML 标签包裹）
6. `buildReviewChunks()`：按 12KB 分片（staged 优先）
7. `SubAgentManager.review()`：对每 chunk 执行隔离审查

## Git 变更

- staged：`git diff --cached --no-ext-diff`
- unstaged：`git diff --no-ext-diff`
- untracked：`git ls-files --others --exclude-standard -z`
- binary detection：检测 null bytes
- 排序：staged > unstaged > untracked

## Memory 检索

关键词来源：task 文本（>3 字符非停用词）、文件路径（snake_case/camelCase 拆分）、diff 中的符号（函数/类/方法名）。上限 8-12 词。搜索按 title hit > hit terms 数 > 规则/决策优先 > project scope 优先 > updatedAt 倒序排序。

## Chunk / Coverage

每 chunk 上限 12KB（可配）。单 chunk 为 complete coverage；多 chunk 为 partial coverage。跨 chunk 同一 finding 自动去重（SHA-256 of file+line+description），保留最高 severity。

## 只读 Session

使用 `createAgentSession` + `SessionManager.inMemory()` + `DefaultResourceLoader({noExtensions,noSkills,noPromptTemplates,noThemes,noContextFiles})` 创建完全隔离的 Reviewer Session。

工具白名单（代码级，非 prompt 约束）：
- read
- grep
- find
- ls

## Strict Parser

`parseReviewerOutput()` 多层校验：

1. 去除 markdown code fence
2. JSON 解析
3. Schema：仅允许 status/summary/findings 字段
4. status：passed | issues_found
5. summary：非空字符串
6. findings：数组，每项 severity(high/medium/low), file(string), line(正整数), description(非空字符串)
7. 一致性：passed 不能有 findings；issues_found 必须有 findings

任何失败返回 ParseFailure（含原始文本）。

## Timeout / Cancel

`Promise.race` 硬超时：调用方在 timeoutMs 后必定拿回 timeout 结果。`session.abort()` 触发协作式取消。底层 HTTP 可能继续但调用方不等待。`session.dispose()` 清理资源。支持 parent AbortSignal 传播。

## 隔离模型

通过 `ReviewOptions` 传入 model + modelRegistry。使用当前项目的真实模型和认证，不硬编码 provider。Reviewer Session 独立于主 Agent Session——不共享对话历史、工具状态和 system prompt。
