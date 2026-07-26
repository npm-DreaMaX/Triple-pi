import type { MemoryCategory, MemoryScope } from "../extensions/memory/domain.ts";

export interface ExpectedMemory {
  category: MemoryCategory;
  scope: MemoryScope;
  titleIncludes: string[];
  contentIncludes: string[];
  evidenceIncludes: string;
  sourceEntryId: string;
}

export interface EvalCase {
  id: string;
  description: string;
  cwd: string;
  user: string;
  assistant: string;
  expected: ExpectedMemory[];
  forbidden: string[];
}

/**
 * 10 个 Live Eval 用例，覆盖以下场景：
 *
 *  01 project-rule          明确项目规则
 *  02 global-preference     跨项目全局偏好
 *  03 correction            用户纠正旧决策
 *  04 noise-only            临时调试信息不应提取
 *  05 knowledge             用户知识状态
 *  06 implicit-convention   隐式约定（未说"记住"）
 *  07 mixed-noise           长对话中夹杂的规则
 *  08 chinese-convention    中文场景
 *  09 multi-rule            对话包含多条规则
 *  10 code-constraint       代码级约束
 */
export const EVAL_CASES: EvalCase[] = [
  {
    id: "project-rule",
    description: "用户明确要求记住项目规则",
    cwd: "/eval/project-a",
    user: "Always run unit tests before declaring work complete.",
    assistant: "Understood. I will run the tests before completing any task.",
    expected: [{
      category: "rule",
      scope: "project",
      titleIncludes: ["test"],
      contentIncludes: ["unit test"],
      sourceEntryId: "u1",
      evidenceIncludes: "Always run unit tests",
    }],
    forbidden: [],
  },
  {
    id: "global-preference",
    description: "跨所有项目的全局偏好",
    cwd: "/eval/project-a",
    user: "Across all my projects, keep explanations concise and lead with the conclusion.",
    assistant: "Got it. I will keep responses concise and upfront across all your projects.",
    expected: [{
      category: "preference",
      scope: "global",
      titleIncludes: ["concise"],
      contentIncludes: ["conclusion"],
      sourceEntryId: "u1",
      evidenceIncludes: "Across all my projects",
    }],
    forbidden: [],
  },
  {
    id: "correction",
    description: "用户纠正之前的决策",
    cwd: "/eval/project-a",
    user: "Actually, use JWT instead of server sessions because this service must stay stateless.",
    assistant: "Understood. Switching authentication from server sessions to JWT for stateless operation.",
    expected: [{
      category: "decision",
      scope: "project",
      titleIncludes: ["jwt"],
      contentIncludes: ["stateless"],
      sourceEntryId: "u1",
      evidenceIncludes: "Actually, use JWT instead",
    }],
    forbidden: ["npm install", "login page"],
  },
  {
    id: "noise-only",
    description: "纯临时调试对话，不应提取任何记忆",
    cwd: "/eval/project-a",
    user: "Try rerunning that command once; this is just temporary debugging.",
    assistant: "The command passed on retry. It was a transient network error.",
    expected: [],
    forbidden: ["temporary debugging", "command passed", "transient network"],
  },
  {
    id: "knowledge",
    description: "用户声明自己不熟悉某项技术",
    cwd: "/eval/project-b",
    user: "I have never used Rust before, so explain ownership concepts when they appear.",
    assistant: "I'll explain Rust ownership concepts as they come up.",
    expected: [{
      category: "knowledge",
      scope: "project",
      titleIncludes: ["rust"],
      contentIncludes: ["ownership"],
      sourceEntryId: "u1",
      evidenceIncludes: "never used Rust",
    }],
    forbidden: [],
  },
  {
    id: "implicit-convention",
    description: "用户没有说'记住'，但表达了重要的隐含约定",
    cwd: "/eval/project-c",
    user: "In this codebase we never use console.log for logging — always use the pino logger instead.",
    assistant: "Understood. Using pino for all logging, no console.log.",
    expected: [{
      category: "rule",
      scope: "project",
      titleIncludes: ["pino", "log"],
      contentIncludes: ["console"],
      sourceEntryId: "u1",
      evidenceIncludes: "never use console.log",
    }],
    forbidden: [],
  },
  {
    id: "mixed-noise",
    description: "长对话中夹杂的规则，周围有大量噪声信息",
    cwd: "/eval/project-a",
    user: [
      "Can you check why the build failed?",
      "Actually never mind the build, the real issue is the database connection pool is too small.",
      "By the way, for this project we always use PostgreSQL advisory locks for concurrency control — don't use Redis locks.",
      "And can you also look at the CI pipeline? I think it's running the wrong Node version.",
      "Also remind me to update the README later.",
    ].join("\n"),
    assistant: [
      "Let me check the database pool configuration.",
      "Understood about PostgreSQL advisory locks — that's the project standard for concurrency.",
      "Looking at the CI pipeline now...",
    ].join("\n"),
    expected: [{
      category: "decision",
      scope: "project",
      titleIncludes: ["postgresql", "lock"],
      contentIncludes: ["advisory"],
      sourceEntryId: "u1",
      evidenceIncludes: "always use PostgreSQL advisory locks",
    }],
    forbidden: ["build failed", "Node version", "README", "Redis"],
  },
  {
    id: "chinese-convention",
    description: "中文对话中的项目约定",
    cwd: "/eval/project-a",
    user: "这个项目的所有 API 返回值必须用统一的格式：{ code: number, data: any, message: string }，不要每个接口自己定义返回结构。",
    assistant: "明白了，所有 API 返回值统一使用 { code, data, message } 格式。我会在写接口时保持一致。",
    expected: [{
      category: "rule",
      scope: "project",
      titleIncludes: ["api", "返回"],
      contentIncludes: ["统一"],
      sourceEntryId: "u1",
      evidenceIncludes: "所有 API 返回值必须用统一的格式",
    }],
    forbidden: [],
  },
  {
    id: "multi-rule",
    description: "对话包含多条可提取的规则",
    cwd: "/eval/project-d",
    user: [
      "A few things to remember for this project:",
      "1. All database migrations go through goose, not raw SQL files.",
      "2. We use Tailwind CSS for all UI styling — no custom CSS files.",
      "3. Error messages must be in English, never in Chinese.",
    ].join("\n"),
    assistant: "Noted. I'll use goose for migrations, Tailwind for styling, and English for all error messages.",
    expected: [
      {
        category: "rule",
        scope: "project",
        titleIncludes: ["database", "migration"],
        contentIncludes: ["goose"],
        sourceEntryId: "u1",
        evidenceIncludes: "All database migrations go through goose",
      },
      {
        category: "rule",
        scope: "project",
        titleIncludes: ["tailwind", "css"],
        contentIncludes: ["styling"],
        sourceEntryId: "u1",
        evidenceIncludes: "use Tailwind CSS for all UI styling",
      },
      {
        category: "rule",
        scope: "project",
        titleIncludes: ["error", "english"],
        contentIncludes: ["English"],
        sourceEntryId: "u1",
        evidenceIncludes: "Error messages must be in English",
      },
    ],
    forbidden: [],
  },
  {
    id: "code-constraint",
    description: "代码级约束，涉及具体技术栈限制",
    cwd: "/eval/project-a",
    user: "Important: this service runs on AWS Lambda with a 10-second timeout, so all handlers must complete within 8 seconds and use async/await patterns — no synchronous blocking calls.",
    assistant: "Understood. All handlers target <8 seconds completion, async/await only, no blocking calls. This is critical for the Lambda environment.",
    expected: [{
      category: "rule",
      scope: "project",
      titleIncludes: ["lambda", "timeout"],
      contentIncludes: ["async"],
      sourceEntryId: "u1",
      evidenceIncludes: "all handlers must complete within 8 seconds",
    }],
    forbidden: [],
  },
];
