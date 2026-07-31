/**
 * SubAgent Manager tests — 使用生产 parseReviewerOutput 和 review-core，
 * 不复制实现。
 */

import { describe, expect, it } from "vitest";
import { parseReviewerOutput, extractReviewSearchTerms, buildReviewChunks } from "../../extensions/subagent/review-core.ts";
import { REVIEWER_TOOLS } from "../../extensions/subagent/manager.ts";
import type { SubagentTask, ChangeFile } from "../../extensions/subagent/types.ts";

// ═══════════════════════════════════════════════════════════════
// parseReviewerOutput — 生产 parser 的所有边界
// ═══════════════════════════════════════════════════════════════

describe("parseReviewerOutput — production parser", () => {
  it("parses a clean passed review", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "passed",
      summary: "All changes look good.",
      findings: [],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.status).toBe("passed");
      expect(result.review.summary).toContain("All changes look good");
      expect(result.review.findings).toEqual([]);
    }
  });

  it("parses a review with issues", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "issues_found",
      summary: "Found 2 issues.",
      findings: [
        { severity: "high", file: "src/payment.ts", line: 145, description: "Missing transaction timeout" },
        { severity: "medium", file: "src/payment.ts", line: 89, description: "Uses any type" },
      ],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.status).toBe("issues_found");
      expect(result.review.findings).toHaveLength(2);
      expect(result.review.findings[0].severity).toBe("high");
      expect(result.review.findings[0].file).toBe("src/payment.ts");
      expect(result.review.findings[0].line).toBe(145);
    }
  });

  it("strips markdown code fences", () => {
    const result = parseReviewerOutput("```json\n" + JSON.stringify({
      status: "passed",
      summary: "OK",
      findings: [],
    }) + "\n```");
    expect(result.ok).toBe(true);
  });

  it("strips fences with no language tag", () => {
    const result = parseReviewerOutput("```\n" + JSON.stringify({
      status: "passed",
      summary: "OK",
      findings: [],
    }) + "\n```");
    expect(result.ok).toBe(true);
  });

  it("handles empty output gracefully", () => {
    const result = parseReviewerOutput("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("parse-failed");
  });

  it("handles whitespace-only output", () => {
    const result = parseReviewerOutput("   \n  \n  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("parse-failed");
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseReviewerOutput("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("parse-failed");
  });

  it("rejects unknown status values", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "everything_is_on_fire",
      summary: "Bad",
      findings: [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("schema-failed");
  });

  it("rejects wrong schema with missing summary", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "passed",
      findings: [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("schema-failed");
  });

  it("rejects passed with non-empty findings", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "passed",
      summary: "Looks fine",
      findings: [{ severity: "low", file: "x.ts", line: 1, description: "Issue" }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("schema-failed");
  });

  it("rejects issues_found with empty findings", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "issues_found",
      summary: "Problems exist",
      findings: [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("schema-failed");
  });

  it("handles missing description field", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "issues_found",
      summary: "Test",
      findings: [
        { severity: "high", file: "src/x.ts", line: 1, description: "Some issue" },
        { severity: "medium", file: "src/y.ts", line: 5 },
      ],
    }));
    expect(result.ok).toBe(false); // missing description → schema error
  });

  it("rejects negative line number", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "issues_found",
      summary: "Negative line",
      findings: [
        { severity: "high", file: "src/x.ts", line: -1, description: "Bad" },
      ],
    }));
    expect(result.ok).toBe(false); // negative line → schema error
  });

  it("rejects fractional line number", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "issues_found",
      summary: "Fractional line",
      findings: [
        { severity: "high", file: "src/x.ts", line: 1.5, description: "Bad" },
      ],
    }));
    expect(result.ok).toBe(false); // non-integer line → schema error
  });

  it("rejects unknown fields in JSON", () => {
    const result = parseReviewerOutput(JSON.stringify({
      status: "passed",
      summary: "OK",
      findings: [],
      extraField: "should be rejected",
    }));
    expect(result.ok).toBe(false);
  });

  it("handles valid JSON with prose around it (non-code-fence)", () => {
    // Prose around JSON without markdown fences will fail strict parsing
    const result = parseReviewerOutput("Some text before\n" + JSON.stringify({
      status: "passed",
      summary: "OK",
      findings: [],
    }) + "\nSome text after");
    // Without fences, this is not valid JSON — expect parse failure
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// extractReviewSearchTerms — production
// ═══════════════════════════════════════════════════════════════

describe("extractReviewSearchTerms — production", () => {
  it("extracts deduplicated terms from task and files", () => {
    const changes: ChangeFile[] = [{
      path: "src/payment.ts",
      status: "staged",
      diff: "diff --git a/src/payment.ts b/src/payment.ts\n@@ ... @@\n+function process() {}",
      content: "dummy",
      binary: false,
      unreadable: false,
      skipped: false,
    }];
    const terms = extractReviewSearchTerms("Fix checkout race condition", changes);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain("checkout");
    expect(terms).toContain("payment");
    expect(terms).toContain("condition");
  });

  it("returns unique terms", () => {
    const changes: ChangeFile[] = [{
      path: "src/payment.ts",
      status: "staged",
      diff: "+function process() {}",
      content: "dummy",
      binary: false,
      unreadable: false,
      skipped: false,
    }];
    const terms = extractReviewSearchTerms("fix fix fix", changes);
    // "fix" should appear only once despite being in the task 3 times
    const fixCount = terms.filter(t => t === "fix").length;
    expect(fixCount).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildReviewChunks — production
// ═══════════════════════════════════════════════════════════════

describe("buildReviewChunks — production", () => {
  it("splits changes into chunks", () => {
    const changes: ChangeFile[] = [
      {
        path: "src/a.ts",
        status: "staged",
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        content: "content",
        binary: false,
        unreadable: false,
        skipped: false,
      },
      {
        path: "src/b.ts",
        status: "unstaged",
        diff: "diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-old\n+new",
        content: "content",
        binary: false,
        unreadable: false,
        skipped: false,
      },
    ];
    const result = buildReviewChunks(changes, 50000);
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toEqual([]);
  });

  it("marks skipped/binary files", () => {
    const changes: ChangeFile[] = [
      {
        path: "src/secret.bin",
        status: "unstaged",
        diff: "",
        content: undefined,
        binary: true,
        unreadable: false,
        skipped: true,
      },
    ];
    const result = buildReviewChunks(changes, 50000);
    expect(result.skipped).toHaveLength(1);
    expect(result.chunks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// SubagentTask shape
// ═══════════════════════════════════════════════════════════════

describe("SubagentTask required fields", () => {
  it("carries required fields", () => {
    const task: SubagentTask = {
      id: "review-001",
      role: "reviewer",
      prompt: "Review checkout fix",
      workingDirectory: "/tmp/project",
      timeoutMs: 120_000,
    };
    expect(task.id).toBeTruthy();
    expect(task.prompt).toBeTruthy();
    expect(task.timeoutMs).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool allowlist
// ═══════════════════════════════════════════════════════════════

describe("SubAgent — tool isolation constants", () => {
  it("reviewer tools are read-only", () => {
    const writeTools = ["edit", "write", "bash"];

    for (const tool of REVIEWER_TOOLS) {
      expect(writeTools).not.toContain(tool);
    }
    for (const tool of writeTools) {
      expect(REVIEWER_TOOLS).not.toContain(tool);
    }
  });
});
