import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";
import { resolveProjectIdentity } from "../../extensions/memory/project-identity.ts";

let tempDir: string;
let repository: FilesystemMemoryRepository;
const projectA = path.join(path.sep, "workspace", "project-a");
const projectB = path.join(path.sep, "workspace", "project-b");

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-memory-"));
  repository = new FilesystemMemoryRepository({ root: tempDir });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("FilesystemMemoryRepository", () => {
  it("isolates project memories and shares global memories", async () => {
    await repository.save({
      category: "rule",
      scope: "project",
      cwd: projectA,
      title: "Project A Rule",
      content: "Only project A may see this.",
    });
    await repository.save({
      category: "preference",
      scope: "global",
      cwd: projectA,
      title: "Global Preference",
      content: "All projects may see this.",
    });

    expect((await repository.list(projectA)).map((entry) => entry.title)).toEqual([
      "Global Preference",
      "Project A Rule",
    ]);
    expect((await repository.list(projectB)).map((entry) => entry.title)).toEqual([
      "Global Preference",
    ]);
  });

  it("preserves createdAt when the same title is updated", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    repository = new FilesystemMemoryRepository({ root: tempDir, now: () => current });
    const first = await repository.save({
      category: "decision",
      scope: "project",
      cwd: projectA,
      title: "API Style",
      content: "Use REST.",
    });
    current = new Date("2026-01-02T00:00:00.000Z");
    const updated = await repository.save({
      category: "decision",
      scope: "project",
      cwd: projectA,
      title: "API Style",
      content: "Use GraphQL.",
    });

    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect((await repository.search("GraphQL", projectA))[0]?.record.content).toBe("Use GraphQL.");
    const revisions = await repository.listRevisions(updated.id, projectA);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revisionId).toBe(updated.provenance.revision?.previousRevisionId);
    expect(revisions[0].content).toBe("Use REST.");
  });

  it("builds a traversable revision chain across manual and batch replacements", async () => {
    const first = await repository.save({
      category: "decision", scope: "project", cwd: projectA,
      title: "Revision chain", content: "Version one.",
    });
    const second = await repository.save({
      category: "decision", scope: "project", cwd: projectA,
      title: "Revision chain", content: "Version two.",
    });
    const [third] = await repository.saveExtractionBatch(projectA, "d".repeat(64), [{
      category: "decision", scope: "project", title: "Revision chain", content: "Version three.",
      replaceRecordId: first.id, provenance: { source: "extraction" },
    }]);

    expect(third.provenance.revision?.previousRevisionId).toBe(second.provenance.revision?.revisionId);
    const previous = await repository.getRevision(first.id, third.provenance.revision!.previousRevisionId!, projectA);
    expect(previous?.content).toBe("Version two.");
    expect(previous?.provenance.revision?.previousRevisionId).toBe(first.provenance.revision?.revisionId);
    expect((await repository.listRevisions(first.id, projectA)).map((revision) => revision.content)).toEqual([
      "Version one.",
      "Version two.",
    ]);
  });

  it("rejects invalid runtime categories at the repository boundary", async () => {
    await expect(repository.save({
      category: "../../escape" as any,
      scope: "project",
      cwd: projectA,
      title: "Bad category",
      content: "Must not escape.",
    })).rejects.toThrow("无效分类");
    expect(await repository.list(projectA)).toEqual([]);
  });

  it("keeps untrusted titles out of filesystem paths", async () => {
    const record = await repository.save({
      category: "fact",
      scope: "project",
      cwd: projectA,
      title: "../../escape [link](file)",
      content: "The title is data, not a path.",
    });
    const project = resolveProjectIdentity(projectA);
    const expected = path.join(tempDir, "projects", project.id, "entries", "fact", `${record.id}.md`);

    expect(await fs.readFile(expected, "utf8")).toContain("# ../../escape [link](file)");
    await expect(fs.access(path.join(tempDir, "escape [link](file).md"))).rejects.toThrow();
  });

  it("rebuilds a deleted index from authoritative entry files", async () => {
    await repository.save({
      category: "knowledge",
      scope: "project",
      cwd: projectA,
      title: "TypeScript Experience",
      content: "Experienced with strict TypeScript.",
    });
    const project = resolveProjectIdentity(projectA);
    const indexPath = path.join(tempDir, "projects", project.id, "MEMORY.md");
    // 写放大修复后 save 只标脏不建索引（文件可能不存在），显式 rebuildIndex 仍须重建。
    await fs.rm(indexPath, { force: true });

    await repository.rebuildIndex("project", projectA);
    expect(await fs.readFile(indexPath, "utf8")).toContain("TypeScript Experience");
  });

  it("keeps healthy records available when one entry is damaged", async () => {
    await repository.save({
      category: "rule",
      scope: "project",
      cwd: projectA,
      title: "Healthy Rule",
      content: "This record remains available.",
    });
    const project = resolveProjectIdentity(projectA);
    const damaged = path.join(tempDir, "projects", project.id, "entries", "rule", "damaged.md");
    await fs.writeFile(damaged, "truncated", "utf8");

    expect((await repository.list(projectA)).map((record) => record.title)).toEqual(["Healthy Rule"]);
    expect((await repository.buildPrompt(projectA)).prompt).toContain("Healthy Rule");
  });

  it("reports a successful save when only the derived index cannot update", async () => {
    const project = resolveProjectIdentity(projectA);
    const base = path.join(tempDir, "projects", project.id);
    await fs.mkdir(path.join(base, "MEMORY.md"), { recursive: true });

    const record = await repository.save({
      category: "fact",
      scope: "project",
      cwd: projectA,
      title: "Authoritative Entry",
      content: "The entry file is the source of truth.",
    });

    expect(record.title).toBe("Authoritative Entry");
    expect((await repository.list(projectA)).map((entry) => entry.title)).toContain("Authoritative Entry");
  });

  it("does not let extraction create overwrite an existing manual record", async () => {
    await repository.save({
      category: "rule", scope: "project", cwd: projectA,
      title: "Authoritative rule", content: "Manual authoritative value",
    });
    await expect(repository.saveExtractionBatch(projectA, "e".repeat(64), [{
      category: "rule", scope: "project", title: "Authoritative rule",
      content: "Unrelated extracted replacement", provenance: { source: "extraction" },
    }])).rejects.toThrow("explicit replacement is required");
    expect((await repository.search("Manual authoritative", projectA))).toHaveLength(1);
  });

  it("rejects unsafe or out-of-bound replacement record ids", async () => {
    await expect(repository.saveExtractionBatch(projectA, "a".repeat(64), [{
      category: "rule",
      scope: "project",
      title: "Unsafe replace",
      content: "Must stay bounded.",
      replaceRecordId: "../../escape",
      provenance: { source: "extraction" },
    }])).rejects.toThrow("Invalid replacement record ID");
  });

  it("rolls back every target and leaves no manifest after an injected write failure", async () => {
    let writes = 0;
    repository = new FilesystemMemoryRepository({
      root: tempDir,
      beforeWrite: (filepath) => {
        if (!filepath.includes("MEMORY.md") && ++writes === 3) throw new Error("injected write failure");
      },
    });
    const project = resolveProjectIdentity(projectA);

    await expect(repository.saveExtractionBatch(projectA, "f".repeat(64), [{
      category: "rule", scope: "project", title: "Atomic batch", content: "Must roll back.",
      provenance: { source: "extraction" },
    }], undefined, { key: 1 })).rejects.toThrow("injected write failure");

    expect(await repository.list(projectA)).toEqual([]);
    await expect(fs.access(path.join(tempDir, "signals", project.id, "reinforcement.json"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "projects", project.id, "project.json"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "extractions", project.id, `${"f".repeat(64)}.json`))).rejects.toThrow();
  });

  it("reports extraction attempts, successes, failures, and live scheduler state", async () => {
    repository.updateExtractionDiagnostics({ running: true, pending: true, attempted: true });
    let diagnostics = await repository.diagnose(projectA);
    expect(diagnostics).toMatchObject({ extractionRunning: true, extractionPending: true });
    expect(diagnostics.lastExtractionAttemptAt).toEqual(expect.any(String));

    repository.updateExtractionDiagnostics({ running: false, pending: false, failureStage: "review", failureCode: "BAD_OUTPUT" });
    diagnostics = await repository.diagnose(projectA);
    expect(diagnostics).toMatchObject({
      lastExtractionFailureStage: "review",
      lastExtractionFailureCode: "BAD_OUTPUT",
      consecutiveExtractionFailures: 1,
    });

    repository.updateExtractionDiagnostics({ succeeded: true });
    diagnostics = await repository.diagnose(projectA);
    expect(diagnostics.consecutiveExtractionFailures).toBe(0);
    expect(diagnostics.lastExtractionSuccessAt).toEqual(expect.any(String));
  });

  it("increments reinforcement inside the repository lock", async () => {
    await repository.saveExtractionBatch(projectA, "b".repeat(64), [], undefined, { "project:key": 1 });
    await repository.saveExtractionBatch(projectA, "c".repeat(64), [], undefined, { "project:key": 1 });
    expect((await repository.loadReinforcement(projectA))["project:key"].count).toBe(2);
  });

  it("serializes concurrent writers without losing entries", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => repository.save({
      category: "fact",
      scope: "project",
      cwd: projectA,
      title: `Fact ${index}`,
      content: `Content ${index}`,
    })));

    expect(await repository.list(projectA)).toHaveLength(20);
    const project = resolveProjectIdentity(projectA);
    // 写放大修复：MEMORY.md 不再每 save 全量重建，而是脏标记 + 延迟刷新。
    await repository.rebuildPendingIndexes(projectA);
    const index = await fs.readFile(path.join(tempDir, "projects", project.id, "MEMORY.md"), "utf8");
    expect(index.match(/^- \[/gm)).toHaveLength(20);
  });

  it("builds an empty prompt for a new project", async () => {
    expect(await repository.buildPrompt(projectA)).toMatchObject({ prompt: "", count: 0 });
  });
});
