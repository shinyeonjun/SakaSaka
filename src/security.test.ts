import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { getProject, getToolSurface } from "./runtime";
import { redactSecretLikeText, validateActionBoundary } from "./security";

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

  it("does not allow a network tool when the project policy denies egress", () => {
    const project = getProject(createSeedState(), "project-trip-together")!;
    const restricted = { ...project, settings: { ...project.settings, networkPolicy: "deny" as const } };
    const decision = validateActionBoundary(restricted, { type: "ACT", intentRef: project.intentId, worldCursor: "event-816", rationaleSummary: "browser", tool: "browser.playwright", params: { url: "https://example.com" } }, getToolSurface(restricted));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("network policy");
  });

  it("redacts secret-shaped values before tool output is persisted", () => {
    expect(redactSecretLikeText("api_key=sk-test-1234567890 password=hunter2")).toBe("api_key=[REDACTED] password=[REDACTED]");
  });
});
