import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { containsSecret, type ExtractedCandidate } from "./pipeline.ts";
import type { ExtractionSource } from "./source.ts";

const REVIEW_PROMPT = `Review extracted coding-agent memories for durability and grounding.
Return ONLY a JSON array with the same number and order as the candidates.
Each item must have exactly:
- action: keep | remove
- reason: short explanation
- title: unchanged candidate title
- content: unchanged candidate content
- evidence: unchanged exact evidence
- sourceEntryId: unchanged source entry ID

Remove temporary progress, repository-discoverable facts, secrets, vague claims, and unsupported memories.
You may NOT rewrite, merge, or invent content. Grounded rewriting is handled deterministically elsewhere.`;

export interface ReviewDecision {
  action: "keep" | "remove";
  reason: string;
  title: string;
  content: string;
  evidence: string;
  sourceEntryId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function reviewCandidates(input: {
  model: Model<any>;
  modelRegistry: ModelRegistry;
  candidates: ExtractedCandidate[];
  source: ExtractionSource;
  signal: AbortSignal;
}): Promise<ExtractedCandidate[]> {
  if (input.candidates.length === 0) return [];
  const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) throw new Error(auth.error);
  const resolved = await input.modelRegistry.getProviderAuth(input.model.provider);
  const provider = input.modelRegistry.getProvider(input.model.provider);
  if (!provider) throw new Error(`Provider unavailable: ${input.model.provider}`);
  const requestModel = resolved?.auth.baseUrl ? { ...input.model, baseUrl: resolved.auth.baseUrl } : input.model;
  const response = await provider.streamSimple(
    requestModel,
    {
      systemPrompt: REVIEW_PROMPT,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: JSON.stringify({
            userMessages: input.source.messages
              .filter((message) => message.role === "user")
              .map((message) => ({ entryId: message.entryId, content: message.content })),
            candidates: input.candidates,
          }),
        }],
        timestamp: Date.now(),
      }],
      tools: [],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: input.signal },
  ).result();
  if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Memory review stopped: ${response.stopReason}`);
  const raw = response.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
  // Strip markdown fences — some models (DeepSeek, etc.) wrap JSON in ``` fences
  const stripped = raw.startsWith("```") ? raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "") : raw;
  let parsed: unknown;
  try { parsed = JSON.parse(stripped); } catch { throw new Error("Memory review output is not valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length !== input.candidates.length) throw new Error("Memory review result count mismatch");

  const userMessages = new Map(input.source.messages.filter((message) => message.role === "user").map((message) => [message.entryId, message.content]));
  const kept: ExtractedCandidate[] = [];
  parsed.forEach((value, index) => {
    if (!isObject(value)) throw new Error("Invalid memory review item");
    const keys = Object.keys(value).sort();
    const expected = ["action", "content", "evidence", "reason", "sourceEntryId", "title"];
    if (keys.length !== expected.length || keys.some((key, position) => key !== expected[position])) throw new Error("Invalid memory review schema");
    const candidate = input.candidates[index];
    const { action, reason, title, content, evidence, sourceEntryId } = value;
    if ((action !== "keep" && action !== "remove") || typeof reason !== "string") throw new Error("Invalid memory review decision");
    if (title !== candidate.title || content !== candidate.content || evidence !== candidate.evidence || sourceEntryId !== candidate.sourceEntryId) {
      throw new Error("Memory review attempted to rewrite grounded candidate");
    }
    if (!userMessages.get(candidate.sourceEntryId)?.includes(candidate.evidence)) throw new Error("Memory review lost grounding");
    if (containsSecret(candidate.title) || containsSecret(candidate.content) || containsSecret(candidate.evidence)) throw new Error("Memory review contains secret");
    if (action === "keep") kept.push(candidate);
  });
  return kept;
}
