import { describe, expect, it } from "vitest";
import { CodexDecisionGateway, HybridDecisionGateway, JevDecisionGateway } from "./decisionGateway";

const request = {
  purpose: "test",
  state: { error: "connection reset" },
  questions: {
    retry: { type: "noul" as const, instructions: "Is this retryable?", criteria: "The failure is transient and a repeat attempt may succeed without changing the request." },
    route: { type: "choice" as const, instructions: "Choose route", criteria: { retry: "Retry the same operation", stop: "Stop or change approach" } },
    risk: { type: "score" as const, instructions: "Risk", criteria: ["No material impact", "Recoverable impact", "Potential irreversible impact"] },
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
  it("uses the official TypeSafe System One wire format and never exposes the API key", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ model: "jev-1-test", answers: {
        retry: { type: "noul", noul: .91 },
        route: { type: "choice", choice: "retry", probabilities: { retry: .88, stop: .12 }, confidence: .76 },
        risk: { type: "score", score: 1.2, probabilities: { "0": .1, "1": .6, "2": .3 }, confidence: .64, legend: { "0": "No material impact", "1": "Recoverable impact", "2": "Potential irreversible impact" } },
      }, usage: { input_tokens: 120, output_tokens: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const gateway = new JevDecisionGateway({ apiKey: "secret-key", fetchImpl, endpoint: "https://example.test/v1/systemone" });
    const result = await gateway.decide(request);
    expect(result.answers.retry).toEqual({ kind: "noul", probability: .91 });
    expect(result.answers.route).toMatchObject({ kind: "choice", choice: "retry" });
    expect(result.answers.risk).toEqual({ kind: "score", score: 1.2, probabilities: [.1, .6, .3], confidence: .64 });
    expect(result.usage.inputTokens).toBe(120);
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(String(calls[0].body)) as any;
    expect(body.model).toBe("jev-latest");
    expect(body.questions.retry).toEqual({
      type: "noul",
      instructions: "Is this retryable?",
      criteria: {
        true: "The failure is transient and a repeat attempt may succeed without changing the request.",
        false: "The condition is not established: The failure is transient and a repeat attempt may succeed without changing the request.",
      },
    });
    expect(body.questions.risk.criteria).toEqual(request.questions.risk.criteria);
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
