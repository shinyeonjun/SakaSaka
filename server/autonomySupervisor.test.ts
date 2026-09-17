import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject } from "../src/runtime";
import type { AppState } from "../src/types";
import type { CycleStateStore } from "./cycleCoordinator";
import { FileAutonomyStore } from "./autonomyStore";
import { rebaseAutonomyForIntent, runAutonomyPostlude, runAutonomyPrelude } from "./autonomySupervisor";
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

const scoutRunner = async <T,>() => ({ value: { gaps: [{ category: "Security", title: "OAuth token storage", summary: "Storage and rotation have not been verified", impact: .95, uncertainty: .8, novelty: .9, urgency: .9, roleHint: "OAuth security specialist", evidenceNeeded: ["token storage code"], sourceRefs: [] }] } as T, usage: { modelVersion: "test", tokens: 0, cost: 0, latencyMs: 1 } });

describe("autonomy supervisor", () => {
  it("discovers gaps, creates one mission, and publishes UNCERTAIN control-plane evidence without overwriting World runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Build a secure calendar app", "project-test", { workspacePath: directory, modelProvider: "codex-cli", executionMode: "native" });
    const runtimeBefore = initial.worldSnapshots.at(-1)?.sources.runtime.summary;
    const store = memoryStore(initial);
    const autonomy = await runAutonomyPrelude(store, "project-test", { store: fileStore, decisionGateway: gateway, scoutRunner, discoveryParallelism: 1, now: () => new Date("2026-09-17T00:00:00Z") });
    expect(autonomy?.gaps.some((gap) => gap.title === "OAuth token storage")).toBe(true);
    expect(autonomy?.missions.filter((mission) => mission.status === "RUNNING")).toHaveLength(1);
    const controlEvidence = store.read().evidence.find((evidence) => evidence.source === "sakasaka-autonomy");
    expect(controlEvidence).toMatchObject({ kind: "metric", verdict: "UNCERTAIN", evaluator: "autonomy-control-plane" });
    expect(controlEvidence?.rawRef).toMatch(/^autonomy:\/\//);
    expect(store.read().worldSnapshots.at(-1)?.sources.runtime.summary).toBe(runtimeBefore);
    expect(store.read().observations.some((observation) => observation.rawRef.startsWith("autonomy://"))).toBe(false);
  });

  it("does not mutate legacy deterministic provider world state by default", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Legacy deterministic contract", "project-legacy", { workspacePath: directory, modelProvider: "deterministic" });
    const beforeObservations = initial.observations.length;
    const store = memoryStore(initial);
    const result = await runAutonomyPrelude(store, "project-legacy", { store: fileStore, decisionGateway: gateway });
    expect(result).toBeUndefined();
    expect(fileStore.readProject("project-legacy")).toBeUndefined();
    expect(store.read().observations).toHaveLength(beforeObservations);
    expect(store.read().evidence.some((evidence) => evidence.source === "sakasaka-autonomy")).toBe(false);
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

  it("supersedes the old active mission and reopens coverage when Intent version changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Build app v1", "project-rebase", { workspacePath: directory, modelProvider: "codex-cli", executionMode: "native" });
    const store = memoryStore(initial);
    const autonomy = await runAutonomyPrelude(store, "project-rebase", { store: fileStore, decisionGateway: gateway, scoutRunner, discoveryParallelism: 1, now: () => new Date("2026-09-17T00:00:00Z") });
    expect(autonomy?.missions.some((mission) => mission.status === "RUNNING")).toBe(true);
    const rebased = rebaseAutonomyForIntent(autonomy!, 2, "2026-09-17T01:00:00Z");
    expect(rebased.intentVersion).toBe(2);
    expect(rebased.missions.some((mission) => mission.status === "SUPERSEDED")).toBe(true);
    expect(rebased.gaps.filter((gap) => gap.source === "taxonomy").every((gap) => gap.status === "UNEXPLORED")).toBe(true);
    expect(rebased.gaps.some((gap) => gap.title === "Primary intent outcome v1" && gap.status === "DEFERRED")).toBe(true);
    expect(rebased.lastDiscoveryAt).toBeUndefined();
    expect(rebased.lastPublishedDigest).toBeUndefined();
  });

  it("counts scouts and bounded decisions against the project's hard model-call cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-autonomy-test-")); directories.push(directory);
    const fileStore = new FileAutonomyStore(join(directory, "autonomy.json"));
    const initial = createProject(createEmptyState(), "Build app under a strict call cap", "project-call-cap", { workspacePath: directory, modelProvider: "codex-cli", executionMode: "native", maxModelCalls: 1 });
    const store = memoryStore(initial);
    let scoutCalls = 0;
    let decisionCalls = 0;
    const countedScout = async <T,>() => { scoutCalls += 1; return scoutRunner<T>(); };
    const countedGateway: DecisionGateway = { decide: async (request) => { decisionCalls += 1; return gateway.decide(request); } };
    const autonomy = await runAutonomyPrelude(store, "project-call-cap", { store: fileStore, decisionGateway: countedGateway, scoutRunner: countedScout, discoveryParallelism: 3, now: () => new Date("2026-09-17T00:00:00Z") });
    expect(autonomy).toBeDefined();
    expect(scoutCalls).toBe(1);
    expect(decisionCalls).toBe(0);
    const modelTurns = store.read().events.filter((event) => event.projectId === "project-call-cap" && event.type === "MODEL_TURN");
    expect(modelTurns).toHaveLength(1);
  });
});
