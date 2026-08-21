import type { Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtractionMessage } from "./source.ts";

const EXTRACTION_SYSTEM_PROMPT = `You extract durable coding-agent memories from a completed conversation segment.

Return ONLY a JSON array. Each item must have exactly:
- category: preference | decision | rule | fact | knowledge
- title: short durable title
- content: self-contained memory
- evidence: an exact verbatim substring from one user message
- sourceEntryId: the entry ID of that user message
- scope: project | global
- keywords: array of 0-5 short retrieval terms (≤60 chars each) covering aliases, acronyms and synonyms someone would search with — e.g. ["PyG", "GNN", "图神经网络"] for "PyTorch Geometric", or ["鉴权", "auth", "JWT"] for "使用JWT认证". Omit the key when nothing beyond the title itself applies; never include secrets.

Rules:
- Extract only facts explicitly supported by USER text. Assistant statements are context, never evidence.
- Do not extract secrets, credentials, tokens, temporary debugging state, task progress, or information directly discoverable from repository files.
- Prefer project scope. Use global only for explicit cross-project communication preferences.
- Return [] when nothing is durable. Never add commentary or Markdown fences.`;

export interface ExtractionProviderInput {
  model: Model<any>;
  modelRegistry: ModelRegistry;
  messages: ExtractionMessage[];
  signal: AbortSignal;
}

export async function extractCandidateJson(input: ExtractionProviderInput): Promise<string> {
  const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) throw new Error(auth.error);
  const resolved = await input.modelRegistry.getProviderAuth(input.model.provider);
  const provider = input.modelRegistry.getProvider(input.model.provider);
  if (!provider) throw new Error(`Provider unavailable: ${input.model.provider}`);
  const requestModel = resolved?.auth.baseUrl
    ? { ...input.model, baseUrl: resolved.auth.baseUrl }
    : input.model;

  const transcript = input.messages.map((message) => [
    `<message entryId="${message.entryId}" role="${message.role}">`,
    message.content,
    "</message>",
  ].join("\n")).join("\n\n");
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: transcript }],
    timestamp: Date.now(),
  };
  const response = await provider.streamSimple(
    requestModel,
    { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage], tools: [] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: input.signal,
    },
  ).result();
  if (response.stopReason !== "stop") {
    throw new Error(response.errorMessage || `Memory extraction stopped: ${response.stopReason}`);
  }
  return response.content
    .filter((content): content is TextContent => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}
