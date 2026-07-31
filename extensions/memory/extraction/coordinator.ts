import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FilesystemMemoryRepository } from "../repository.ts";
import {
  type MemoryEvidence,
  type MemoryProvenance,
  type MemoryScope,
  type ScopeDecision,
} from "../domain.ts";
import { extractCandidateJson } from "./provider.ts";
import { redactSecrets, validateCandidates } from "./pipeline.ts";
import { reviewCandidates } from "./review.ts";
import { planConsolidation } from "./consolidation.ts";
import { reinforcementKey, scoreCandidate } from "./signals.ts";
import { resolveProjectIdentity } from "../project-identity.ts";
import {
  buildExtractionSourceFromBranch,
  EXTRACTOR_VERSION,
  type ExtractionCheckpoint,
} from "./source.ts";

export interface ExtractionSnapshot {
  cwd: string;
  sessionId: string;
  branch: SessionEntry[];
  branchLeafId: string | null;
  lastProcessedEntryId?: string;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  reviewerEnabled?: boolean;
}

export interface ExtractionRunResult {
  checkpoint?: ExtractionCheckpoint;
  savedCount: number;
  status: "saved" | "no-source" | "no-candidates" | "aborted";
  telemetry?: ExtractionTelemetry;
}

export interface ExtractionTelemetry {
  candidateCount: number;
  reviewedCount: number;
  savedCount: number;
  createCount: number;
  replaceCount: number;
  skipCount: number;
  extractionLatencyMs: number;
  reviewLatencyMs: number;
  consolidationLatencyMs: number;
}

function buildEvidence(
  evidenceText: string,
  sourceEntryId: string,
): MemoryEvidence {
  const quoteHash = createHash("sha256")
    .update(evidenceText)
    .digest("hex")
    .slice(0, 16);
  return {
    quote: evidenceText,
    sourceEntryId,
    role: "user",
    quoteHash,
  };
}

function buildScopeDecision(
  requestedScope: MemoryScope,
  resolvedScope: MemoryScope,
  evidence: MemoryEvidence,
): ScopeDecision {
  const reason = resolvedScope === "global"
    ? "explicit-cross-project-evidence"
    : requestedScope === "global"
      ? "missing-cross-project-evidence"
      : "default-project";
  return {
    requested: requestedScope,
    resolved: resolvedScope,
    reason,
    evidence,
  };
}

export async function runExtraction(
  repository: FilesystemMemoryRepository,
  snapshot: ExtractionSnapshot,
  signal: AbortSignal,
): Promise<ExtractionRunResult> {
  const t0 = performance.now();
  const source = buildExtractionSourceFromBranch(
    snapshot.branch,
    snapshot.branchLeafId,
    snapshot.lastProcessedEntryId,
  );
  if (!source) return { savedCount: 0, status: "no-source" };
  if (signal.aborted) return { savedCount: 0, status: "aborted" };
  if (await repository.hasExtractionSource(snapshot.cwd, source.sourceHash)) {
    const checkpoint: ExtractionCheckpoint = {
      version: EXTRACTOR_VERSION,
      sourceHash: source.sourceHash,
      lastEntryId: source.lastEntryId,
      branchLeafId: source.branchLeafId,
      savedCount: 0,
    };
    return { checkpoint, savedCount: 0, status: "no-candidates" };
  }

  const prepared = redactSecrets(source.messages);
  const tExtraction = performance.now();
  const raw = await extractCandidateJson({
    model: snapshot.model,
    modelRegistry: snapshot.modelRegistry,
    messages: prepared.redactedMessages,
    signal,
  });
  const extractionLatencyMs = performance.now() - tExtraction;
  if (signal.aborted) return { savedCount: 0, status: "aborted" };
  const candidates = validateCandidates(raw, { ...source, messages: prepared.redactedMessages });
  const tReview = performance.now();
  const reviewedOutput = snapshot.reviewerEnabled !== false
    ? await reviewCandidates({
        model: snapshot.model,
        modelRegistry: snapshot.modelRegistry,
        candidates,
        source: { ...source, messages: prepared.redactedMessages },
        signal,
      })
    : candidates;
  // Keep compatibility with reviewers recorded before requested/resolved scope
  // became explicit, while canonicalizing the shape at this boundary.
  const reviewed = reviewedOutput.map((candidate) => ({
    ...candidate,
    requestedScope: candidate.requestedScope ?? candidate.scope,
    resolvedScope: candidate.resolvedScope ?? candidate.scope,
  }));
  const reviewLatencyMs = performance.now() - tReview;
  if (signal.aborted) return { savedCount: 0, status: "aborted" };

  const tConsolidation = performance.now();
  const [existing, reinforcement] = await Promise.all([
    repository.list(snapshot.cwd),
    repository.loadReinforcement(snapshot.cwd),
  ]);
  const project = resolveProjectIdentity(snapshot.cwd);
  const plans = [] as { key: string; plan: ReturnType<typeof planConsolidation> }[];
  const reservedTargets = new Set<string>();
  for (const candidate of reviewed) {
    const provisional = scoreCandidate(candidate, prepared.redactedMessages, 0);
    const key = reinforcementKey(project.id, candidate.resolvedScope, provisional.fingerprint);
    const signals = scoreCandidate(candidate, prepared.redactedMessages, reinforcement[key]?.count || 0);
    const available = existing.filter((record) => !reservedTargets.has(record.id));
    const plan = planConsolidation(candidate, signals, available);
    if (plan.action === "replace" && plan.existing) reservedTargets.add(plan.existing.id);
    plans.push({ key, plan });
  }
  const persistencePlans = plans.filter(({ plan }) => plan.action !== "skip");
  const reinforcementUpdates: Record<string, number> = {};
  for (const { key } of plans) reinforcementUpdates[key] = (reinforcementUpdates[key] || 0) + 1;

  const createCount = persistencePlans.filter(({ plan }) => plan.action === "create").length;
  const replaceCount = persistencePlans.filter(({ plan }) => plan.action === "replace").length;
  const skipCount = plans.filter(({ plan }) => plan.action === "skip").length;

  await repository.saveExtractionBatch(
    snapshot.cwd,
    source.sourceHash,
    persistencePlans.map(({ plan }) => {
      const grounding = buildEvidence(plan.candidate.evidence, plan.candidate.sourceEntryId);
      const evidence: MemoryEvidence[] = [grounding];
      const scopeDecision: ScopeDecision = buildScopeDecision(
        plan.candidate.requestedScope,
        plan.candidate.resolvedScope,
        grounding,
      );

      const provenance: MemoryProvenance = {
        source: "extraction",
        sessionId: snapshot.sessionId,
        sourceEntryIds: [plan.candidate.sourceEntryId],
        sourceHash: source.sourceHash,
        fingerprint: plan.signals.fingerprint,
        score: plan.signals.score,
        reinforcement: plan.signals.reinforcement,
        correction: plan.signals.correction,
        evidence,
        scopeDecision,
      };
      return {
        category: plan.candidate.category,
        scope: plan.candidate.resolvedScope,
        title: plan.candidate.title,
        content: plan.candidate.content,
        replaceRecordId: plan.action === "replace" ? plan.existing?.id : undefined,
        provenance,
      };
    }),
    signal,
    reinforcementUpdates,
  );

  const consolidationLatencyMs = performance.now() - tConsolidation;

  const checkpoint: ExtractionCheckpoint = {
    version: EXTRACTOR_VERSION,
    sourceHash: source.sourceHash,
    lastEntryId: source.lastEntryId,
    branchLeafId: source.branchLeafId,
    savedCount: persistencePlans.length,
  };

  // Notify repository about extraction telemetry via diagnostics if available
  const telemetry: ExtractionTelemetry = {
    candidateCount: candidates.length,
    reviewedCount: reviewed.length,
    savedCount: persistencePlans.length,
    createCount,
    replaceCount,
    skipCount,
    extractionLatencyMs: Math.round(extractionLatencyMs),
    reviewLatencyMs: Math.round(reviewLatencyMs),
    consolidationLatencyMs: Math.round(consolidationLatencyMs),
  };

  return {
    checkpoint,
    savedCount: persistencePlans.length,
    status: persistencePlans.length > 0 ? "saved" : "no-candidates",
    telemetry,
  };
}
