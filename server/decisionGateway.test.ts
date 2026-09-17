import { describe, expect, it } from "vitest";
import { CodexDecisionGateway, HybridDecisionGateway, JevDecisionGateway } from "./decisionGateway";

const request = {
  purpose: "test",
  state: { error: "connection reset" },
  questions: {
    retry: { type: "noul" as const, instructions: "Is this retryable?" },
    route: { type: "choice" as const, instructions: "Choose route", criteria: { retry: "Retry", stop: "Stop" } },
    risk: { type: "score" as const, instructions: "Risk", criteria: ["low", "medium", "high"] },
  },
};

const value = {
  answers: {
    retry: { kind: "noul", probability: .8 },
    route: { kind: "choice", choice: "retry", probabilities: { retry: .7, stop: .3 }, confidence: .55 },
    risk: { kind: "score", score: 1, probabilities: [.2, .6, .2], confidence: .5 },
  },
};

describe("decision gateways", () => {
  it("normalizes a Jev response without exposing the API key", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ model: "jev-1-test", answers: {
        retry: { noul: .91 }, route: { choice: "retry", probabilities: { retry: .88, stop: .12 }, confidence: .76 }, risk: { score: 1.2, probabilities: [.1, .6, .3], confidence: .64 },
      }, usage: { input_tokens: 120 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const gateway = new JevDecisionGateway({ apiKey: "secret-key", fetchImpl, endpoint: "https://example.test/v1/systemone" });
    const result = await gateway.decide(request);
    expect(result.answers.retry).toEqual({ kind: "noul", probability: .91 });
    expect(result.answers.route.kind).toBe("choice");
    expect(result.usage.inputTokens).toBe(120);
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("uses Codex structured output for bounded decisions", async () => {
    const gateway = new CodexDecisionGateway(async <T,>() => ({ value: value as T, usage: { modelVersion: "codex-cli:test", tokens: 10, cost: 0, latencyMs: 1 } }));
    const result = await gateway.decide(request);
    expect(result.provider).toBe("codex-cli");
    expect(result.answers.route).toMatchObject({ kind: "choice", choice: "retry" });
  });

  it("hybrid falls back to Codex when Jev is not configured", async () => {
    const jev = new JevDecisionGateway({ apiKey: "" });
    const fallback = { ...value, answers: { ...value.answers, route: { kind: "choice", choice: "stop", probabilities: { retry: .4, stop: .6 }, confidence: .4 } } };
    const codex = new CodexDecisionGateway(async <T,>() => ({ value: fallback as T, usage: { modelVersion: "codex-cli:test", tokens: 5, cost: 0, latencyMs: 1 } }));
    const result = await new HybridDecisionGateway(jev, codex).decide(request);
    expect(result.provider).toBe("hybrid");
    expect(result.fallbackUsed).toBe(true);
  });
});
