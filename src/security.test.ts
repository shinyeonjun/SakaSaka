import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { getProject, getToolSurface } from "./runtime";
import { estimateActionCost, isAllowedNetworkHost, parseActionEnvelope, redactSecretLikeText, validateActionBoundary } from "./security";

describe("action boundary enforcement", () => {
  it("rejects tools that are not exposed by the project capability surface", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const decision = validateActionBoundary(project, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "unknown", tool: "shell.exec" }, getToolSurface(project));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("not exposed");
  });

  it("blocks non-allowlisted commands before any process is started", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const decision = validateActionBoundary(project, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "unsafe", tool: "shell.sandbox", params: { commandId: "rm-rf" } }, getToolSurface(project));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("fixed local allowlist");
  });

  it("does not let a read-only capability smuggle a quality command", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const decision = validateActionBoundary(project, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "smuggled command", tool: "repo.read", params: { commandId: "quality-test" } }, getToolSurface(project));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("repo-status");
    expect(estimateActionCost({ type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "tests", tool: "shell.sandbox", params: { commandId: "quality-test" } })).toBe(0.18);
  });

  it("does not allow a network tool when the project policy denies egress", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const restricted = { ...project, settings: { ...project.settings, networkPolicy: "deny" as const } };
    const decision = validateActionBoundary(restricted, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "browser", tool: "browser.playwright", params: { url: "https://example.com" } }, getToolSurface(restricted));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("network policy");
  });

  it("matches only explicitly allowlisted hosts and rejects credential-bearing URLs", () => {
    expect(isAllowedNetworkHost("https://preview.example.com/app", "allowlist", ["*.example.com"])).toBe(true);
    expect(isAllowedNetworkHost("https://example.com/app", "allowlist", ["*.example.com"])).toBe(false);
    expect(isAllowedNetworkHost("https://preview.example.com.evil.test", "allowlist", ["*.example.com"])).toBe(false);
    expect(isAllowedNetworkHost("https://user:password@preview.example.com", "allowlist", ["*.example.com"])).toBe(false);
  });

  it("binds an action to the current intent and turns P3 approval into a human boundary", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const staleIntent = validateActionBoundary(project, { type: "ACT", intentRef: "intent-stale", worldCursor: "event-816", rationaleSummary: "stale", tool: "repo.read" }, getToolSurface(project));
    expect(staleIntent.status).toBe("blocked");
    expect(staleIntent.reason).toContain("intentRef");
    const approvalRequired = { ...project, settings: { ...project.settings, productionBlocked: false } };
    const approval = validateActionBoundary(approvalRequired, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "deploy", tool: "deploy.production", params: { url: "https://deploy.example.com" } }, getToolSurface(approvalRequired));
    expect(approval.status).toBe("human-approval");
  });

  it("redacts secret-shaped values before tool output is persisted", () => {
    expect(redactSecretLikeText("api_key=sk-test-1234567890 password=hunter2")).toBe("api_key=[REDACTED] password=[REDACTED]");
    expect(redactSecretLikeText("https://user:password@example.com/private")).toBe("https://[REDACTED]@example.com/private");
  });

  it("validates structured model output before it reaches a tool gateway", () => {
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "run tests", params: { commandId: "quality-test" } })?.type).toBe("ACT");
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "run rm", params: { command: { injected: true } } })).toBeUndefined();
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "invalid value", expectedValue: 2 })).toBeUndefined();
  });
});
