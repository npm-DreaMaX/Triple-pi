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
  cwd: string;
  user: string;
  assistant: string;
  expected: ExpectedMemory[];
  forbidden: string[];
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "project-rule",
    cwd: "/eval/project-a",
    user: "Always run unit tests before declaring work complete.",
    assistant: "Understood. I will run the tests.",
    expected: [{
      category: "rule", scope: "project", titleIncludes: ["test"],
      contentIncludes: ["unit test"], sourceEntryId: "u1", evidenceIncludes: "Always run unit tests",
    }],
    forbidden: [],
  },
  {
    id: "global-preference",
    cwd: "/eval/project-a",
    user: "Across all my projects, keep explanations concise and lead with the conclusion.",
    assistant: "I will keep responses concise.",
    expected: [{
      category: "preference", scope: "global", titleIncludes: ["concise"],
      contentIncludes: ["conclusion"], sourceEntryId: "u1", evidenceIncludes: "Across all my projects",
    }],
    forbidden: [],
  },
  {
    id: "correction",
    cwd: "/eval/project-a",
    user: "Actually, use JWT instead of server sessions because this service must stay stateless.",
    assistant: "Understood. JWT replaces sessions.",
    expected: [{
      category: "decision", scope: "project", titleIncludes: ["jwt"],
      contentIncludes: ["stateless"], sourceEntryId: "u1", evidenceIncludes: "Actually, use JWT instead",
    }],
    forbidden: ["npm install", "login page"],
  },
  {
    id: "noise-only",
    cwd: "/eval/project-a",
    user: "Try rerunning that command once; this is just temporary debugging.",
    assistant: "The command passed on retry.",
    expected: [],
    forbidden: ["temporary debugging", "command passed"],
  },
  {
    id: "knowledge",
    cwd: "/eval/project-b",
    user: "I have never used Rust before, so explain ownership concepts when they appear.",
    assistant: "I will explain Rust ownership concepts.",
    expected: [{
      category: "knowledge", scope: "project", titleIncludes: ["rust"],
      contentIncludes: ["ownership"], sourceEntryId: "u1", evidenceIncludes: "never used Rust",
    }],
    forbidden: [],
  },
];
