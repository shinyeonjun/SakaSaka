import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject } from "../src/runtime";
import type { AppState } from "../src/types";
import type { CycleStateStore } from "./cycleCoordinator";
import { FileAutonomyStore } from "./autonomyStore";
import { runAutonomyPostlude, runAutonomyPrelude } from "./autonomySupervisor";
import type { DecisionGateway } from "./decisionGateway";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function memoryStore(initial: AppState): CycleStateStore {
  let state = initial;
  return { read: () => state, transact: async (update) => (state = update(state)) };
}

const gateway: DecisionGateway = {
  decide: async (request) => ({
    provider: "codex-cli", model: "test", latencyMs: 1, usage: { modelVersion: "test", tokens: 0, cost: 0, latencyMs: 1 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => question.type === "choice"
      ? [key, { kind: "choice", choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((choice, index) => [choice, index === 0 ? 1 : 0])), confidence: 1 }]
      : question.type === "score" ? [key, { kind: "score", score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 1 }]
        : [key, { kind: "noul", probability: key === "coverageConverged" ? 0 : 0.2 }])) as never,
  }),
};

describe("autonomy supervisor", () => {
  it("discovers gaps, creates one mission, and publishes runtime observation for Codex projects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Build a secure calendar app", "project-test", { workspacePath: directory, modelProvider: "codex-cli", executionMode: "native" });
    const store = memoryStore(initial);
    const scoutRunner = async <T,>() => ({ value: { gaps: [{ category: "Security", title: "OAuth token storage", summary: "Storage and rotation have not been verified", impact: .95, uncertainty: .8, novelty: .9, urgency: .9, roleHint: "OAuth security specialist", evidenceNeeded: ["token storage code"], sourceRefs: [] }] } as T, usage: { modelVersion: "test", tokens: 0, cost: 0, latencyMs: 1 } });
    const autonomy = await runAutonomyPrelude(store, "project-test", { store: fileStore, decisionGateway: gateway, scoutRunner, discoveryParallelism: 1, now: () => new Date("2026-09-17T00:00:00Z") });
    expect(autonomy?.gaps.some((gap) => gap.title === "OAuth token storage")).toBe(true);
    expect(autonomy?.missions.filter((mission) => mission.status === "RUNNING")).toHaveLength(1);
    expect(store.read().observations.some((observation) => observation.rawRef.startsWith("autonomy://"))).toBe(true);
  });

  it("does not mutate legacy deterministic provider world state by default", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Legacy deterministic contract", "project-legacy", { workspacePath: directory, modelProvider: "deterministic" });
    const store = memoryStore(initial);
    const result = await runAutonomyPrelude(store, "project-legacy", { store: fileStore, decisionGateway: gateway });
    expect(result).toBeUndefined();
    expect(fileStore.readProject("project-legacy")).toBeUndefined();
    expect(store.read().observations).toHaveLength(0);
  });

  it("wakes equilibrium when Codex coverage still has material unresolved work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    let initial = createProject(createEmptyState(), "Build app", "project-wake", { workspacePath: directory, modelProvider: "codex-cli", executionMode: "native" });
    initial = { ...initial, projects: initial.projects.map((project) => project.id === "project-wake" ? { ...project, status: "EQUILIBRIUM" } : project) };
    const store = memoryStore(initial);
    const project = getProject(store.read(), "project-wake")!;
    await fileStore.putProject({ version: 1, projectId: project.id, intentVersion: 1, gaps: [{ id: "g1", key: "x", projectId: project.id, category: "Security", title: "gap", summary: "gap", impact: 1, uncertainty: 1, novelty: 1, urgency: 1, status: "OPEN", source: "scout", priority: 1, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z" }], missions: [], decisions: [], coverageSnapshots: [], updatedAt: "2026-09-17T00:00:00Z" });
    await runAutonomyPostlude(store, "project-wake", { store: fileStore });
    expect(getProject(store.read(), "project-wake")?.status).toBe("ACTIVE");
  });
});
