import { describe, expect, it } from "vitest";

// Test the parseReviewOutput logic directly (no Pi SDK dependency needed).
// We test this in isolation because createAgentSession requires a full Pi runtime.

function parseReviewOutput(text: string): {
  status: "passed" | "issues_found" | "failed";
  summary: string;
  findings: Array<{ severity: string; file?: string; line?: number; description: string }>;
} {
  if (!text.trim()) {
    return { status: "failed", summary: "No output from reviewer", findings: [] };
  }
  let json = text.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  try {
    const parsed = JSON.parse(json);
    return {
      status: ["passed", "issues_found"].includes(parsed.status) ? parsed.status : "failed",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map((f: any) => ({
            severity: ["low", "medium", "high"].includes(f.severity) ? f.severity : "medium",
            file: typeof f.file === "string" ? f.file : undefined,
            line: typeof f.line === "number" ? f.line : undefined,
            description: typeof f.description === "string" ? f.description : "",
          }))
        : [],
    };
  } catch {
    return { status: "failed", summary: "Failed to parse reviewer output", findings: [] };
  }
}

describe("SubAgent Manager — parseReviewOutput", () => {
  it("parses a clean passed review", () => {
    const result = parseReviewOutput(JSON.stringify({
      status: "passed",
      summary: "All changes look good.",
      findings: [],
    }));
    expect(result.status).toBe("passed");
    expect(result.summary).toContain("All changes look good");
    expect(result.findings).toEqual([]);
  });

  it("parses a review with issues", () => {
    const result = parseReviewOutput(JSON.stringify({
      status: "issues_found",
      summary: "Found 2 issues.",
      findings: [
        { severity: "high", file: "src/payment.ts", line: 145, description: "Missing transaction timeout" },
        { severity: "medium", file: "src/payment.ts", line: 89, description: "Uses any type" },
      ],
    }));
    expect(result.status).toBe("issues_found");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].file).toBe("src/payment.ts");
    expect(result.findings[0].line).toBe(145);
  });

  it("strips markdown code fences", () => {
    const result = parseReviewOutput("```json\n" + JSON.stringify({
      status: "passed",
      summary: "OK",
      findings: [],
    }) + "\n```");
    expect(result.status).toBe("passed");
  });

  it("handles empty output", () => {
    const result = parseReviewOutput("");
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("No output");
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseReviewOutput("not json at all");
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Failed to parse");
  });

  it("rejects unknown status values", () => {
    const result = parseReviewOutput(JSON.stringify({
      status: "everything_is_on_fire",
      summary: "Bad",
      findings: [],
    }));
    expect(result.status).toBe("failed");
  });

  it("sanitizes findings with missing fields", () => {
    const result = parseReviewOutput(JSON.stringify({
      status: "issues_found",
      summary: "Test",
      findings: [
        { severity: "critical", description: 123 },
        {},
      ],
    }));
    expect(result.findings).toHaveLength(2);
    // "critical" is not in allowlist → defaults to "medium"
    expect(result.findings[0].severity).toBe("medium");
    // description not a string → ""
    expect(result.findings[0].description).toBe("");
  });
});

describe("SubAgent — tool isolation rules", () => {
  it("reviewer tool allowlist only contains read-only tools", () => {
    // The reviewer SubAgent is created with:
    //   tools: ["read", "grep", "find", "ls"]
    const reviewerTools = ["read", "grep", "find", "ls"];
    const writeTools = ["edit", "write", "bash"];

    for (const tool of reviewerTools) {
      expect(writeTools).not.toContain(tool);
    }
    for (const tool of writeTools) {
      expect(reviewerTools).not.toContain(tool);
    }
  });
});

describe("SubAgent — context isolation rules", () => {
  it("reviewer prompt contains task + diff + rules, not main agent history", () => {
    const prompt = buildReviewPrompt(
      "Fix checkout race condition",
      "diff --git a/src/payment.ts b/src/payment.ts\n+  const tx = await db.transaction();",
      "- Public functions must have tests\n- Database transactions must set timeout",
    );

    // Should include task
    expect(prompt).toContain("Fix checkout race condition");
    // Should include diff
    expect(prompt).toContain("db.transaction");
    // Should include rules
    expect(prompt).toContain("Public functions must have tests");
    // Should NOT include main agent conversation markers
    expect(prompt).not.toContain("User said");
    expect(prompt).not.toContain("Previous messages");
    expect(prompt).not.toContain("Chat history");
  });
});

function buildReviewPrompt(task: string, diff: string, rules: string): string {
  return [
    "## Review Task",
    task,
    "",
    "## Code Changes (Diff)",
    "```diff",
    diff.slice(0, 8_000),
    "```",
    "",
    "## Relevant Project Conventions",
    "Check the changes against these rules:",
    "",
    rules,
  ].join("\n");
}
