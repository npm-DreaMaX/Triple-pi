import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FilesystemMemoryRepository } from "../repository.ts";
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
}

export interface ExtractionRunResult {
  checkpoint?: ExtractionCheckpoint;
  savedCount: number;
  status: "saved" | "no-source" | "no-candidates" | "aborted";
}

export async function runExtraction(
  repository: FilesystemMemoryRepository,
  snapshot: ExtractionSnapshot,
  signal: AbortSignal,
): Promise<ExtractionRunResult> {
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
  const raw = await extractCandidateJson({
    model: snapshot.model,
    modelRegistry: snapshot.modelRegistry,
    messages: prepared.redactedMessages,
    signal,
  });
  if (signal.aborted) return { savedCount: 0, status: "aborted" };
  const candidates = validateCandidates(raw, { ...source, messages: prepared.redactedMessages });
  const reviewed = await reviewCandidates({
    model: snapshot.model,
    modelRegistry: snapshot.modelRegistry,
    candidates,
    source: { ...source, messages: prepared.redactedMessages },
    signal,
  });
  if (signal.aborted) return { savedCount: 0, status: "aborted" };

  const [existing, reinforcement] = await Promise.all([
    repository.list(snapshot.cwd),
    repository.loadReinforcement(snapshot.cwd),
  ]);
  const project = resolveProjectIdentity(snapshot.cwd);
  const plans = [] as { key: string; plan: ReturnType<typeof planConsolidation> }[];
  const reservedTargets = new Set<string>();
  for (const candidate of reviewed) {
    const provisional = scoreCandidate(candidate, prepared.redactedMessages, 0);
    const key = reinforcementKey(project.id, candidate.scope, provisional.fingerprint);
    const signals = scoreCandidate(candidate, prepared.redactedMessages, reinforcement[key]?.count || 0);
    const available = existing.filter((record) => !reservedTargets.has(record.id));
    const plan = planConsolidation(candidate, signals, available);
    if (plan.action === "replace" && plan.existing) reservedTargets.add(plan.existing.id);
    plans.push({ key, plan });
  }
  const persistencePlans = plans.filter(({ plan }) => plan.action !== "skip");
  const reinforcementUpdates: Record<string, number> = {};
  for (const { key } of plans) reinforcementUpdates[key] = (reinforcementUpdates[key] || 0) + 1;
  await repository.saveExtractionBatch(
    snapshot.cwd,
    source.sourceHash,
    persistencePlans.map(({ plan }) => ({
      category: plan.candidate.category,
      scope: plan.candidate.scope,
      title: plan.candidate.title,
      content: plan.candidate.content,
      replaceRecordId: plan.action === "replace" ? plan.existing?.id : undefined,
      provenance: {
        source: "extraction",
        sessionId: snapshot.sessionId,
        sourceEntryIds: [plan.candidate.sourceEntryId],
        sourceHash: source.sourceHash,
        fingerprint: plan.signals.fingerprint,
        score: plan.signals.score,
        reinforcement: plan.signals.reinforcement,
        correction: plan.signals.correction,
        revisionOf: plan.action === "replace" ? plan.existing?.id : undefined,
      },
    })),
    signal,
    reinforcementUpdates,
  );

  const checkpoint: ExtractionCheckpoint = {
    version: EXTRACTOR_VERSION,
    sourceHash: source.sourceHash,
    lastEntryId: source.lastEntryId,
    branchLeafId: source.branchLeafId,
    savedCount: persistencePlans.length,
  };
  return {
    checkpoint,
    savedCount: persistencePlans.length,
    status: persistencePlans.length > 0 ? "saved" : "no-candidates",
  };
}
