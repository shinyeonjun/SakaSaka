import type { ModelUsage } from "../src/ports";
import { runCodexStructured, type CodexStructuredRequest, type CodexStructuredResult } from "./codexStructured";

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { kind: "noul"; probability: number }
  | { kind: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "score"; score: number; probabilities: number[]; confidence: number };

export interface DecisionBatchRequest {
  purpose: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
}

export interface DecisionBatchResult {
  provider: "jev" | "codex-cli" | "hybrid";
  model: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  usage: ModelUsage;
  fallbackUsed?: boolean;
}

export interface DecisionGateway {
  decide(request: DecisionBatchRequest): Promise<DecisionBatchResult>;
}

export interface DecisionProviderStatus {
  requested: "codex-cli" | "jev" | "hybrid";
  effective: "codex-cli" | "jev" | "hybrid" | "unavailable";
  jevConfigured: boolean;
  jevModel: string;
  detail: string;
}

const clamp01 = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function outputSchema(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  const properties = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === "noul") return [key, {
      type: "object", additionalProperties: false, required: ["kind", "probability"],
      properties: { kind: { type: "string", enum: ["noul"] }, probability: { type: "number", minimum: 0, maximum: 1 } },
    }];
    if (question.type === "choice") {
      const choices = Object.keys(question.criteria);
      return [key, {
        type: "object", additionalProperties: false, required: ["kind", "choice", "probabilities", "confidence"],
        properties: {
          kind: { type: "string", enum: ["choice"] }, choice: { type: "string", enum: choices }, confidence: { type: "number", minimum: 0, maximum: 1 },
          probabilities: { type: "object", additionalProperties: false, required: choices, properties: Object.fromEntries(choices.map((choice) => [choice, { type: "number", minimum: 0, maximum: 1 }])) },
        },
      }];
    }
    return [key, {
      type: "object", additionalProperties: false, required: ["kind", "score", "probabilities", "confidence"],
      properties: {
        kind: { type: "string", enum: ["score"] }, score: { type: "number", minimum: 0, maximum: Math.max(0, question.criteria.length - 1) }, confidence: { type: "number", minimum: 0, maximum: 1 },
        probabilities: { type: "array", minItems: question.criteria.length, maxItems: question.criteria.length, items: { type: "number", minimum: 0, maximum: 1 } },
      },
    }];
  }));
  return { type: "object", additionalProperties: false, required: ["answers"], properties: { answers: { type: "object", additionalProperties: false, required: Object.keys(questions), properties } } };
}

function validateAnswers(value: unknown, questions: Record<string, DecisionQuestion>): Record<string, DecisionAnswer> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decision result must be an object");
  const answersValue = (value as Record<string, unknown>).answers;
  if (!answersValue || typeof answersValue !== "object" || Array.isArray(answersValue)) throw new Error("Decision result has no answers object");
  const raw = answersValue as Record<string, unknown>;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const item = raw[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Missing decision answer: ${key}`);
    const answer = item as Record<string, unknown>;
    if (question.type === "noul") {
      if (answer.kind !== "noul" || typeof answer.probability !== "number") throw new Error(`Invalid noul answer: ${key}`);
      answers[key] = { kind: "noul", probability: clamp01(answer.probability) };
      continue;
    }
    if (question.type === "choice") {
      const choices = Object.keys(question.criteria);
      if (answer.kind !== "choice" || typeof answer.choice !== "string" || !choices.includes(answer.choice)) throw new Error(`Invalid choice answer: ${key}`);
      const probabilitiesRaw = answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities) ? answer.probabilities as Record<string, unknown> : {};
      answers[key] = { kind: "choice", choice: answer.choice, probabilities: Object.fromEntries(choices.map((choice) => [choice, clamp01(probabilitiesRaw[choice])])), confidence: clamp01(answer.confidence) };
      continue;
    }
    if (answer.kind !== "score" || typeof answer.score !== "number") throw new Error(`Invalid score answer: ${key}`);
    const probabilities = Array.isArray(answer.probabilities) ? answer.probabilities.map(clamp01).slice(0, question.criteria.length) : [];
    while (probabilities.length < question.criteria.length) probabilities.push(0);
    answers[key] = { kind: "score", score: Math.max(0, Math.min(Math.max(0, question.criteria.length - 1), answer.score)), probabilities, confidence: clamp01(answer.confidence) };
  }
  return answers;
}

export type StructuredRunner = <T>(request: CodexStructuredRequest) => Promise<CodexStructuredResult<T>>;

export class CodexDecisionGateway implements DecisionGateway {
  constructor(private readonly runner: StructuredRunner = runCodexStructured) {}

  async decide(request: DecisionBatchRequest): Promise<DecisionBatchResult> {
    const startedAt = Date.now();
    const instruction = [
      "You are SakaSaka's bounded semantic decision layer.",
      "Do not invent new options, tasks, facts, permissions, or requirements. Only evaluate the supplied STATE and declared criteria.",
      "Probabilities are estimates, not permission grants. Hard policy and real-world verification are outside your authority.",
      "For choice questions, return a probability for every supplied option. For noul, probability means P(criteria is true).",
    ].join("\n");
    const result = await this.runner<{ answers: Record<string, DecisionAnswer> }>({
      instruction,
      state: { purpose: request.purpose, state: request.state, questions: request.questions },
      schema: outputSchema(request.questions),
      purpose: `decision-${request.purpose}`,
      signal: request.signal,
    });
    return { provider: "codex-cli", model: result.usage.modelVersion, answers: validateAnswers(result.value, request.questions), latencyMs: Date.now() - startedAt, usage: result.usage };
  }
}

export interface JevGatewayOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type JevWireQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string | null; false?: string | null } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

function jevWireQuestions(questions: Record<string, DecisionQuestion>): Record<string, JevWireQuestion> {
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === "noul") return [key, {
      type: "noul" as const,
      instructions: question.instructions,
      ...(question.criteria ? { criteria: { true: question.criteria, false: `The condition is not established: ${question.criteria}` } } : {}),
    }];
    if (question.type === "choice") return [key, { type: "choice" as const, instructions: question.instructions, criteria: question.criteria }];
    return [key, { type: "score" as const, instructions: question.instructions, criteria: question.criteria }];
  }));
}

function scoreProbabilities(value: unknown, count: number): number[] {
  const result: number[] = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < count; index += 1) result.push(clamp01(value[index]));
    return result;
  }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  for (let index = 0; index < count; index += 1) result.push(clamp01(record[String(index)]));
  return result;
}

function jevEndpoint(optionsEndpoint?: string): string {
  if (optionsEndpoint?.trim()) return optionsEndpoint.trim();
  if (process.env.TYPESAFE_API_URL?.trim()) return process.env.TYPESAFE_API_URL.trim();
  const base = (process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
  return `${base}/v1/systemone`;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfterMs = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(60_000, retryAfterMs);
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(60_000, retryAfter * 1_000);
  return Math.min(5_000, 500 * (2 ** attempt));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class JevDecisionGateway implements DecisionGateway {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevGatewayOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
    this.endpoint = jevEndpoint(options.endpoint);
    this.model = options.model ?? process.env.TYPESAFE_JEV_MODEL?.trim() ?? process.env.TYPESAFE_DEFAULT_MODEL?.trim() ?? "jev-latest";
    this.fetchImpl = options.fetchImpl ?? fetch;
    const rawTimeout = options.timeoutMs ?? Number(process.env.TYPESAFE_TIMEOUT_MS ?? 20_000);
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number.isFinite(rawTimeout) ? rawTimeout : 20_000));
  }

  isConfigured(): boolean { return Boolean(this.apiKey); }

  async decide(request: DecisionBatchRequest): Promise<DecisionBatchResult> {
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const body = JSON.stringify({ model: this.model, state: request.state, questions: jevWireQuestions(request.questions) });
      let response: Response | undefined;
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
          body,
          signal: controller.signal,
        });
        if (response.ok || !isRetryableStatus(response.status) || attempt === 2) break;
        const delay = retryDelay(response, attempt);
        await new Promise<void>((resolve, reject) => {
          const retryTimer = setTimeout(resolve, delay);
          const onAbort = () => { clearTimeout(retryTimer); reject(new Error("Jev decision request cancelled")); };
          if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!response?.ok) throw new Error(`Jev API ${response?.status ?? "unknown"}: ${response ? (await response.text()).slice(0, 500) : "no response"}`);
      const value = await response.json() as Record<string, unknown>;
      const rawAnswers = value.answers && typeof value.answers === "object" && !Array.isArray(value.answers) ? value.answers as Record<string, unknown> : {};
      const normalized: Record<string, DecisionAnswer> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const item = rawAnswers[key];
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Jev response missing answer: ${key}`);
        const answer = item as Record<string, unknown>;
        if (question.type === "noul") {
          if (answer.type !== undefined && answer.type !== "noul") throw new Error(`Jev returned wrong answer type for ${key}`);
          normalized[key] = { kind: "noul", probability: clamp01(answer.noul) };
        } else if (question.type === "choice") {
          if (answer.type !== undefined && answer.type !== "choice") throw new Error(`Jev returned wrong answer type for ${key}`);
          const choice = String(answer.choice ?? "");
          if (!Object.hasOwn(question.criteria, choice)) throw new Error(`Jev returned unknown choice for ${key}`);
          const rawProb = answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities) ? answer.probabilities as Record<string, unknown> : {};
          normalized[key] = { kind: "choice", choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, clamp01(rawProb[option])])), confidence: clamp01(answer.confidence) };
        } else {
          if (answer.type !== undefined && answer.type !== "score") throw new Error(`Jev returned wrong answer type for ${key}`);
          normalized[key] = { kind: "score", score: typeof answer.score === "number" ? Math.max(0, Math.min(question.criteria.length - 1, answer.score)) : 0, probabilities: scoreProbabilities(answer.probabilities, question.criteria.length), confidence: clamp01(answer.confidence) };
        }
      }
      const usageRaw = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : {};
      const inputTokens = Math.max(0, Number(usageRaw.input_tokens ?? 0) || 0);
      const outputTokens = Math.max(0, Number(usageRaw.output_tokens ?? 0) || 0);
      const price = Math.max(0, Number(process.env.JEV_COST_PER_MILLION ?? 0.042) || 0.042);
      const usage: ModelUsage = {
        modelVersion: `jev:${String(value.model ?? this.model)}`,
        tokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        usageKnown: inputTokens + outputTokens > 0,
        cost: Number(((inputTokens / 1_000_000) * price).toFixed(6)),
        latencyMs: Date.now() - startedAt,
      };
      return { provider: "jev", model: String(value.model ?? this.model), answers: normalized, latencyMs: Date.now() - startedAt, usage };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

export class HybridDecisionGateway implements DecisionGateway {
  constructor(private readonly jev: JevDecisionGateway, private readonly codex: DecisionGateway = new CodexDecisionGateway()) {}
  async decide(request: DecisionBatchRequest): Promise<DecisionBatchResult> {
    if (this.jev.isConfigured()) {
      try { const result = await this.jev.decide(request); return { ...result, provider: "hybrid" }; }
      catch { /* bounded judgment can safely fall back; hard policy is never delegated here */ }
    }
    const result = await this.codex.decide(request);
    return { ...result, provider: "hybrid", fallbackUsed: true };
  }
}

export function requestedDecisionProvider(): "codex-cli" | "jev" | "hybrid" {
  const configured = process.env.SAKASAKA_DECISION_PROVIDER?.trim().toLowerCase();
  return configured === "jev" || configured === "hybrid" ? configured : "codex-cli";
}

export function createDecisionGateway(): DecisionGateway {
  const requested = requestedDecisionProvider();
  if (requested === "jev") return new JevDecisionGateway();
  if (requested === "hybrid") return new HybridDecisionGateway(new JevDecisionGateway());
  return new CodexDecisionGateway();
}

export function decisionProviderStatus(): DecisionProviderStatus {
  const requested = requestedDecisionProvider();
  const jev = new JevDecisionGateway();
  const configured = jev.isConfigured();
  const jevModel = process.env.TYPESAFE_JEV_MODEL?.trim() || process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";
  if (requested === "jev") return { requested, effective: configured ? "jev" : "unavailable", jevConfigured: configured, jevModel, detail: configured ? "Jev bounded decision layer is configured." : "Set TYPESAFE_API_KEY to enable Jev." };
  if (requested === "hybrid") return { requested, effective: configured ? "hybrid" : "codex-cli", jevConfigured: configured, jevModel, detail: configured ? "Jev is primary and Codex is the decision fallback." : "Jev is not configured; Codex decision fallback is active." };
  return { requested, effective: "codex-cli", jevConfigured: configured, jevModel, detail: "Codex CLI handles bounded decisions. Set SAKASAKA_DECISION_PROVIDER=jev or hybrid after Jev access is approved." };
}
