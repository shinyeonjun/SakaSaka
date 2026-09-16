import type { AppState, ContextPacket, Experience, RetrievalIndexEntry } from "./types";

const tokenPattern = /[\p{L}\p{N}_-]{2,}/gu;
const maxEmbeddingTexts = 65;
const maxEmbeddingTextLength = 8_000;

export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

function tokens(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(tokenPattern) ?? []).slice(0, 2_000));
}

function overlap(query: Set<string>, value: string): number {
  const candidate = tokens(value);
  if (!query.size || !candidate.size) return 0;
  let matched = 0;
  for (const token of query) if (candidate.has(token)) matched += 1;
  return matched / Math.max(query.size, candidate.size);
}

function cosine(left: number[] | undefined, right: number[] | undefined): number {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? Math.max(0, dot / Math.sqrt(leftNorm * rightNorm)) : 0;
}

/** Stable local embedding fallback. It is deliberately not a source of truth. */
function hashedEmbedding(value: string, dimensions = 64): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokens(value)) {
    let hash = 2_166_136_261;
    for (let index = 0; index < token.length; index += 1) hash = Math.imul(hash ^ token.charCodeAt(index), 16_777_619);
    const bucket = (hash >>> 0) % dimensions;
    vector[bucket] += hash & 1 ? 1 : -1;
  }
  return vector;
}

function experienceText(experience: Experience): string {
  return [experience.situation, experience.decision, experience.action, experience.outcome].join(" ");
}

export function retrievalQueryText(context: ContextPacket): string {
  return [
    context.rawIntent,
    ...context.constraints,
    ...(context.observationViews ?? []).map((view) => view.compactView),
    ...(context.openHumanItemViews ?? []).map((item) => `${item.title} ${item.summary} ${item.blockingScope.join(" ")}`),
    ...(context.recentEvidenceViews ?? []).map((item) => `${item.verdict} ${item.summary}`),
  ].join(" ").slice(0, maxEmbeddingTextLength);
}

function entryFor(state: AppState, experience: Experience): RetrievalIndexEntry | undefined {
  return state.retrievalIndex.find((entry) => entry.projectId === experience.projectId && entry.sourceRef === experience.id);
}

interface RankedExperience {
  experience: Experience;
  score: number;
}

function rankExperiences(
  state: AppState,
  projectId: string,
  context: ContextPacket,
  experiences: Experience[],
  queryVector: number[] | undefined,
  experienceVectors: number[][] | undefined,
  limit: number,
): Experience[] {
  const queryText = retrievalQueryText(context);
  const queryTokens = tokens(queryText);
  const fallbackQueryEmbedding = queryVector ?? hashedEmbedding(queryText);
  const currentFailure = /fail|uncertain|error|blocked|stalled|unreachable/i.test(queryText);
  const now = Date.now();
  const ranked: RankedExperience[] = experiences.map((experience, index) => {
    const entry = entryFor(state, experience);
    const text = experienceText(experience);
    const lexical = overlap(queryTokens, text);
    const semantic = cosine(fallbackQueryEmbedding, experienceVectors?.[index] ?? entry?.embedding ?? hashedEmbedding(text));
    const outcome = entry?.outcomeQuality ?? (experience.evidenceIds.length ? 0.5 : 0);
    const parsedCreatedAt = Date.parse(experience.createdAt);
    const ageDays = Number.isFinite(parsedCreatedAt) ? Math.max(0, (now - parsedCreatedAt) / 86_400_000) : 365;
    const recency = 1 / (1 + ageDays / 30);
    const failure = currentFailure && /fail|uncertain|error|blocked|stalled/i.test(experience.outcome) ? 0.18 : 0;
    // Relevance is intentionally the dominant signal. A recent but unrelated
    // transition cannot outrank an older transition that matches the gap.
    const score = lexical * 0.58 + semantic * 0.26 + outcome * 0.12 + recency * 0.04 + failure;
    return { experience, score };
  });
  return ranked
    .sort((left, right) => right.score - left.score || Date.parse(right.experience.createdAt) - Date.parse(left.experience.createdAt) || right.experience.id.localeCompare(left.experience.id))
    .slice(0, Math.max(0, limit))
    .map(({ experience }) => experience);
}

/** Hybrid lexical + local-vector retrieval used when no remote embedding is configured. */
export function retrieveRelevantExperiences(state: AppState, projectId: string, context: ContextPacket, limit = 8): Experience[] {
  return rankExperiences(state, projectId, context, state.experiences.filter((experience) => experience.projectId === projectId), undefined, undefined, limit);
}

/**
 * Optional OpenAI-compatible embeddings. The gateway is query-time and bounded:
 * if it is unavailable, callers can safely fall back to the deterministic index.
 */
export function createConfiguredEmbeddingProvider(): EmbeddingProvider | undefined {
  const runtimeProcess = typeof process === "undefined" ? undefined : process;
  const endpoint = runtimeProcess?.env.EMBEDDING_API_URL?.trim();
  const apiKey = runtimeProcess?.env.EMBEDDING_API_KEY?.trim();
  if (!endpoint || !apiKey) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  const model = runtimeProcess?.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  return {
    name: `openai-compatible:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length || texts.length > maxEmbeddingTexts) throw new Error("embedding batch is outside the configured bound");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ model, input: texts.map((text) => text.slice(0, maxEmbeddingTextLength)) }),
      });
      if (!response.ok) throw new Error(`embedding provider returned HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> };
      if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error("embedding provider returned an incomplete batch");
      const ordered = [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const vectors = ordered.map((item) => item.embedding);
      if (vectors.some((vector) => !Array.isArray(vector) || vector.length === 0 || vector.length > 4_096 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("embedding provider returned an invalid vector");
      return vectors as number[][];
    },
  };
}

/** Hybrid retrieval with provider vectors for configured server runtimes. */
export async function retrieveRelevantExperiencesWithEmbedding(
  state: AppState,
  projectId: string,
  context: ContextPacket,
  provider: EmbeddingProvider,
  limit = 8,
): Promise<Experience[]> {
  const experiences = state.experiences.filter((experience) => experience.projectId === projectId);
  if (!experiences.length) return [];
  const vectors = await provider.embed([retrievalQueryText(context), ...experiences.map((experience) => experienceText(experience))]);
  if (vectors.length !== experiences.length + 1) throw new Error("embedding provider returned an invalid vector count");
  return rankExperiences(state, projectId, context, experiences, vectors[0], vectors.slice(1), limit);
}

export function rebuildRetrievalIndex(state: AppState, projectId?: string): RetrievalIndexEntry[] {
  const now = Date.now();
  const existing = state.retrievalIndex.filter((entry) => projectId ? entry.projectId !== projectId : false);
  const experiences = state.experiences.filter((experience) => !projectId || experience.projectId === projectId);
  const derived = experiences.map((experience) => {
    const evidence = state.evidence.filter((item) => experience.evidenceIds.includes(item.id));
    const pass = evidence.filter((item) => item.verdict === "PASS").length;
    const fail = evidence.filter((item) => item.verdict === "FAIL").length;
    const outcomeQuality = evidence.length ? (pass / evidence.length) * (fail ? 0.5 : 1) : 0;
    const createdAtMs = Date.parse(experience.createdAt);
    return {
      id: `retrieval-${experience.id}`,
      projectId: experience.projectId,
      entityId: experience.id,
      sourceRef: experience.id,
      embedding: hashedEmbedding(experienceText(experience)),
      metadata: { actionType: experience.actionType ?? "unknown", verdict: fail ? "FAIL" : pass ? "PASS" : "UNCERTAIN" },
      recency: 1 / (1 + Math.max(0, (now - (Number.isFinite(createdAtMs) ? createdAtMs : now)) / 86_400_000) / 30),
      outcomeQuality: Number(outcomeQuality.toFixed(3)),
      createdAt: experience.createdAt,
    } satisfies RetrievalIndexEntry;
  });
  return [...existing, ...derived];
}
