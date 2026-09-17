import { describe, expect, it } from "vitest";
import type { AutonomyProjectState } from "./autonomyDomain";
import { projectAutonomyState } from "./autonomyProjection";

describe("autonomy UI projection", () => {
  it("returns an explicit unavailable projection when no autonomy project exists", () => {
    expect(projectAutonomyState("p-1", undefined)).toEqual({
      available: false,
      projectId: "p-1",
      gaps: [],
      missions: [],
      decisions: [],
      coverageSnapshots: [],
    });
  });

  it("keeps control-plane fields but excludes decision result/raw refs", () => {
    const project: AutonomyProjectState = {
      version: 1,
      projectId: "p-1",
      intentVersion: 2,
      updatedAt: "2026-09-18T00:00:00.000Z",
      gaps: [{
        id: "gap-1", key: "security:test", projectId: "p-1", category: "Security", title: "Threat model", summary: "Review boundaries",
        status: "OPEN", source: "scout", priority: .91, impact: .95, uncertainty: .8, novelty: .4, urgency: .9,
        evidenceNeeded: ["threat model"], sourceRefs: ["world-1"], createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:01:00.000Z",
      }],
      missions: [{
        id: "mission-1", projectId: "p-1", gapId: "gap-1", role: "security critic", objective: "Close threat-model gap",
        evidenceContract: ["verified boundary test"], status: "RUNNING", priority: .91, attempt: 1, startCycle: 4,
        createdAt: "2026-09-18T00:02:00.000Z", updatedAt: "2026-09-18T00:03:00.000Z",
      }],
      decisions: [{
        id: "decision-1", projectId: "p-1", purpose: "prioritize", provider: "codex-cli", model: "test-model",
        result: { selected: "gap-1", hidden: "do-not-project" }, confidence: .82, latencyMs: 42, rawRef: "raw/private.json", createdAt: "2026-09-18T00:04:00.000Z",
      }],
      coverageSnapshots: [{
        id: "coverage-1", projectId: "p-1", open: 1, unexplored: 2, investigating: 0, blocked: 0, resolved: 3,
        highPriorityOpen: 1, risk: .91, convergence: .5, createdAt: "2026-09-18T00:05:00.000Z",
      }],
    };

    const projection = projectAutonomyState("p-1", project);
    expect(projection.available).toBe(true);
    expect(projection.gaps[0]).toMatchObject({ id: "gap-1", status: "OPEN", priority: .91 });
    expect(projection.missions[0]).toMatchObject({ id: "mission-1", status: "RUNNING", gapId: "gap-1" });
    expect(projection.decisions[0]).toEqual({
      id: "decision-1", purpose: "prioritize", provider: "codex-cli", model: "test-model", confidence: .82, latencyMs: 42, createdAt: "2026-09-18T00:04:00.000Z",
    });
    expect("result" in projection.decisions[0]).toBe(false);
    expect("rawRef" in projection.decisions[0]).toBe(false);
  });
});
