import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyState } from "../src/emptyState";
import { addIntent, createProject, getProject, getRun, getWorldSnapshot, pauseProject, resolveHumanItem, recordNonToolAction, runCycle, assembleContext } from "../src/runtime";
import type { ActionEnvelope, AppState, ContextPacket } from "../src/types";
import type { ModelGateway } from "../src/ports";
import { ModelGatewayError, modelFailure } from "../src/modelFailure";
import { runDurableCycle, type CycleStateStore } from "./cycleCoordinator";
import { withFileLock } from "./fileLock";

const roots: string[] = [];
const originalRoot = process.env.WORKSPACE_ROOT, originalRaw = process.env.INTENT_WORLD_RAW_DIR;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = originalRoot;
  if (originalRaw === undefined) delete process.env.INTENT_WORLD_RAW_DIR; else process.env.INTENT_WORLD_RAW_DIR = originalRaw;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sakasaka-coordinator-")); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  process.env.WORKSPACE_ROOT = root; process.env.INTENT_WORLD_RAW_DIR = join(root, "raw");
  const path = join(root, "state.json");
  writeFileSync(path, JSON.stringify(createProject(createEmptyState(), "작은 앱", "p", { workspacePath: workspace, cycleDelayMs: 0 })));
  const store: CycleStateStore = {
    read: () => JSON.parse(readFileSync(path, "utf8")) as AppState,
    transact: (update) => withFileLock(`${path}.lock`, () => { const current = store.read(); const next = update(current); writeFileSync(path, JSON.stringify(next)); return next; }),
  };
  return { store, workspace };
}
function selected(context: ContextPacket, tool?: string, params?: ActionEnvelope["params"]): ActionEnvelope {
  return { type: tool ? "ACT" : "WAIT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: tool ? "테스트 상황의 다음 행동" : "지금 실행할 작업 없음", tool, params };
}
function model(decide: ModelGateway["decide"]): ModelGateway {
  return { decide, capabilities: async () => ({ modelVersion: "fixture", contextWindow: 0, reasoningModes: [], supportsStructuredActions: true }), usage: async () => ({ modelVersion: "fixture", tokens: 5, cost: 0.001, latencyMs: 1, usageKnown: true }) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("short transaction durable cognition", () => {
  it("commits real writes and continues, without discarding another project's update", async () => {
    const { store, workspace } = fixture();
    const entered = deferred(), release = deferred();
    const running = runDurableCycle(store, "p", { modelGateway: model(async (context) => { entered.resolve(); await release.promise; return selected(context, "workspace.write", { path: "hello.txt", content: "안녕" }); }) });
    await entered.promise;
    await store.transact((state) => createProject(state, "다른 제품", "other"));
    release.resolve(); await running;
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe("안녕");
    expect(getProject(store.read(), "other")).toBeDefined();
    expect(getProject(store.read(), "p")?.status).toBe("ACTIVE");
    expect(getRun(store.read(), "p")?.execution).toBeUndefined();
    expect(store.read().contexts[0]?.toolSurface.some((tool) => tool.inputSchema)).toBe(true);
    await runDurableCycle(store, "p", { modelGateway: model(async (context) => selected(context)) });
    expect(getProject(store.read(), "p")?.status).toBe("EQUILIBRIUM");
    const events = store.read().events;
    expect(new Set(events.map((item) => item.id)).size).toBe(events.length);
    expect(events.every((item, index) => index === 0 || item.sequence! > events[index - 1].sequence!)).toBe(true);
  });

  it("does not lock out Pause while a model is pending; a late write decision never executes", async () => {
    const { store, workspace } = fixture();
    const entered = deferred(), release = deferred();
    const running = runDurableCycle(store, "p", { pollMs: 25, modelGateway: model(async (context) => { entered.resolve(); await release.promise; return selected(context, "workspace.write", { path: "must-not-exist", content: "old action" }); }) });
    await entered.promise;
    await Promise.race([store.transact((state) => pauseProject(state, "p")), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Pause blocked by model I/O")), 1_500))]);
    // Even if the provider ignores AbortSignal, the pre-dispatch fence rejects it.
    release.resolve(); await running;
    expect(existsSync(join(workspace, "must-not-exist"))).toBe(false);
    expect(getProject(store.read(), "p")?.status).toBe("PAUSED");
    expect(store.read().events.some((item) => item.type === "CYCLE_DISCARDED")).toBe(true);
  });

  it("allows only one cognition lease for a project", async () => {
    const { store } = fixture(); const entered = deferred(), release = deferred(); let calls = 0;
    const gateway = model(async (context) => { calls++; entered.resolve(); await release.promise; return selected(context); });
    const running = runDurableCycle(store, "p", { modelGateway: gateway });
    await entered.promise;
    expect(await runDurableCycle(store, "p", { modelGateway: gateway })).toBe(false);
    release.resolve(); await running;
    expect(calls).toBe(1);
  });

  it("keeps a new human answer and cancels a decision based on the unanswered question", async () => {
    const { store, workspace } = fixture();
    await store.transact((state) => recordNonToolAction(state, "p", { type: "QUESTION", intentRef: getProject(state, "p")!.intentId, worldCursor: getWorldSnapshot(state, "p")!.cursorEventId, rationaleSummary: "삭제 권한?" }));
    const question = store.read().humanItems[0]; const entered = deferred(), release = deferred();
    const running = runDurableCycle(store, "p", { modelGateway: model(async (context) => { entered.resolve(); await release.promise; return selected(context, "workspace.write", { path: "outdated.txt", content: "old" }); }) });
    await entered.promise;
    await store.transact((state) => resolveHumanItem(state, question.id, "answer", "작성자만"));
    release.resolve(); await running;
    expect(store.read().humanItems[0].answer).toBe("작성자만");
    expect(assembleContext(store.read(), "p")?.humanDecisionViews?.[0].answer).toBe("작성자만");
    expect(existsSync(join(workspace, "outdated.txt"))).toBe(false);
    expect(getProject(store.read(), "p")?.status).toBe("ACTIVE");
  });

  it("records schema rejection as a failure, not WAIT or fake successful action", async () => {
    const { store } = fixture();
    await runDurableCycle(store, "p", { modelGateway: model(async () => { throw new ModelGatewayError(modelFailure("SCHEMA_REJECTED", "params object is open", false, { rawRef: "local-raw://fixture" }), { modelVersion: "fixture", tokens: 3, cost: 0.004, latencyMs: 1, usageKnown: true }); }) });
    expect(store.read().actions).toHaveLength(0);
    expect(getRun(store.read(), "p")?.lastModelFailure?.code).toBe("SCHEMA_REJECTED");
    expect(getProject(store.read(), "p")?.budgetSpent).toBe(0.004);
    expect(getProject(store.read(), "p")?.status).toBe("STALLED");
    expect(store.read().contexts.filter((context) => context.modelVersion === "fixture")).toHaveLength(1);
  });

  it("checks budget before calling a paid model", async () => {
    const { store } = fixture(); let calls = 0;
    await store.transact((state) => ({ ...state, projects: state.projects.map((item) => ({ ...item, settings: { ...item.settings, resourceLimitsDisabled: false }, budgetSpent: item.settings.budgetLimit })) }));
    await runDurableCycle(store, "p", { modelGateway: model(async (context) => { calls++; return selected(context); }) });
    expect(calls).toBe(0); expect(getProject(store.read(), "p")?.status).toBe("STALLED");
  });

  it("does not blindly retry a crashed side-effect lease", async () => {
    const { store } = fixture(); let calls = 0;
    await store.transact((state) => ({ ...state, runs: state.runs.map((run) => ({ ...run, execution: { id: "crashed", owner: "gone", expiresAt: new Date(0).toISOString(), stage: "dispatch", dispatchStarted: true } })) }));
    await runDurableCycle(store, "p", { modelGateway: model(async (context) => { calls++; return selected(context); }) });
    expect(calls).toBe(0); expect(getRun(store.read(), "p")?.stopReason).toContain("끊겼습니다");
  });

  it("consumes the exact approval once before deleting a real file", async () => {
    const { store, workspace } = fixture(); writeFileSync(join(workspace, "obsolete.txt"), "old");
    const envelope = selected(assembleContext(store.read(), "p")!, "workspace.delete", { path: "obsolete.txt" });
    await store.transact((state) => runCycle(state, "p", { action: envelope }));
    const item = store.read().humanItems[0];
    await store.transact((state) => resolveHumanItem(state, item.id, "approve"));
    await runDurableCycle(store, "p", { modelGateway: model(async (context) => selected(context, "workspace.delete", { path: "obsolete.txt" })) });
    expect(existsSync(join(workspace, "obsolete.txt"))).toBe(false);
    expect(store.read().approvalGrants[0].consumedAt).toBeTruthy();
    expect(store.read().events.filter((item) => item.type === "APPROVAL_GRANT_CONSUMED")).toHaveLength(1);
  });
  it("enforces a model call cap even when CLI cost is unknown", async () => {
    const { store } = fixture(); let calls = 0;
    await store.transact((state) => ({ ...state, projects: state.projects.map((project) => ({ ...project, settings: { ...project.settings, maxModelCalls: 1 } })) }));
    const gateway = { ...model(async (context) => { calls++; return selected(context, "workspace.list", {}); }), usage: async () => ({ modelVersion: "fixture", tokens: 0, cost: 0, latencyMs: 1, usageKnown: false }) };
    await runDurableCycle(store, "p", { modelGateway: gateway });
    await runDurableCycle(store, "p", { modelGateway: gateway });
    expect(calls).toBe(1);
    expect(getProject(store.read(), "p")?.status).toBe("STALLED");
  });

});
