import { randomUUID } from "node:crypto";
import type { ActionEnvelope, AppState, EventRecord, Project, RuntimePhase } from "../src/types";
import type { ModelGateway } from "../src/ports";
import { canonicalActionParams, validateActionBoundary, estimateActionCost } from "../src/security";
import { executionBlockReason, getMatchingApprovalGrant, getProject, getRun, getToolSurface, getWorldSnapshot, stallProject } from "../src/runtime";
import { ModelGatewayError, modelFailure } from "../src/modelFailure";
import { executeLocalCycle } from "./localRuntime";
import { stopManagedProcess } from "./processManager";

export interface CycleStateStore {
  read(): AppState;
  /** The callback must contain only bounded state manipulation, never model/tool I/O. */
  transact(update: (state: AppState) => AppState): Promise<AppState>;
}

function fence(state: AppState, projectId: string): string {
  const project = getProject(state, projectId);
  return JSON.stringify({
    project: project && { intentId: project.intentId, activeRunId: project.activeRunId, settings: project.settings, status: project.status, updatedAt: project.updatedAt },
    world: getWorldSnapshot(state, projectId)?.cursorEventId,
    decisions: state.humanItems.filter((item) => item.projectId === projectId).map((item) => [item.id, item.status, item.updatedAt, item.answer]),
  });
}

function event(state: AppState, projectId: string, type: EventRecord["type"], summary: string, detail: string): AppState {
  const run = getRun(state, projectId);
  return { ...state, events: [...state.events, { id: `event-${randomUUID()}`, sequence: state.events.reduce((max, item) => Math.max(max, item.sequence ?? -1), -1) + 1, projectId, type, actor: "system", summary, detail, runId: run?.id, createdAt: new Date().toISOString(), schemaVersion: 1 }] };
}

const dataCollections = ["actions", "worldSnapshots", "observations", "contexts", "evidence", "humanItems", "artifacts", "experiences", "policies", "relations", "retrievalIndex", "approvalGrants", "processes", "experiments"] as const;
const staleAllowed = new Set<string>(["actions", "worldSnapshots", "observations", "contexts", "evidence", "experiences", "relations", "processes"]);

/** Three-way commit: never overwrite a newer user's intent, pause, answer or another project. */
export function mergeCycleResult(current: AppState, base: AppState, result: AppState, projectId: string, valid: boolean, releaseExecution = true): AppState {
  let next = { ...current };
  const beforeProject = getProject(base, projectId), afterProject = getProject(result, projectId), liveProject = getProject(current, projectId);
  if (!beforeProject || !afterProject || !liveProject) return current;
  for (const key of dataCollections) {
    if (!valid && !staleAllowed.has(key)) continue;
    const previous = new Map<string, unknown>((base[key] as Array<{ id: string }>).map((item) => [item.id, item]));
    const changes = (result[key] as Array<{ id: string; projectId: string }>).filter((item) => item.projectId === projectId && JSON.stringify(previous.get(item.id)) !== JSON.stringify(item));
    const merged = new Map<string, unknown>((current[key] as Array<{ id: string }>).map((item) => [item.id, item]));
    for (const item of changes) {
      if (key === "approvalGrants" && current.approvalGrants.find((old) => old.id === item.id)?.consumedAt) continue;
      if (valid || !merged.has(item.id)) merged.set(item.id, !valid && key === "worldSnapshots" ? { ...item, superseded: true } : item);
    }
    (next as unknown as Record<string, unknown>)[key] = [...merged.values()];
  }
  const costDelta = Math.max(0, afterProject.budgetSpent - beforeProject.budgetSpent);
  const project: Project = { ...(valid ? afterProject : liveProject), budgetSpent: Number((liveProject.budgetSpent + costDelta).toFixed(6)) };
  next.projects = current.projects.map((item) => item.id === projectId ? project : item);
  const baseRun = getRun(base, projectId), resultRun = getRun(result, projectId), liveRun = getRun(current, projectId);
  if (releaseExecution && liveRun && baseRun?.id === liveRun.id) next.runs = current.runs.map((item) => item.id === liveRun.id ? { ...(valid && resultRun ? resultRun : item), execution: undefined } : item);
  // Usage occurred even if its decision became stale; keep it accounted exactly once.
  const beforeLedger = base.resourceLedger.find((item) => item.runId === baseRun?.id);
  const afterLedger = result.resourceLedger.find((item) => item.runId === baseRun?.id);
  if (beforeLedger && afterLedger) next.resourceLedger = current.resourceLedger.map((item) => item.id !== beforeLedger.id ? item : {
    ...item, tokens: item.tokens + Math.max(0, afterLedger.tokens - beforeLedger.tokens), modelCost: item.modelCost + Math.max(0, afterLedger.modelCost - beforeLedger.modelCost), wallTimeMs: item.wallTimeMs + Math.max(0, afterLedger.wallTimeMs - beforeLedger.wallTimeMs), toolCalls: item.toolCalls + Math.max(0, afterLedger.toolCalls - beforeLedger.toolCalls), sandboxSeconds: item.sandboxSeconds + Math.max(0, afterLedger.sandboxSeconds - beforeLedger.sandboxSeconds), updatedAt: new Date().toISOString(),
  });
  const baselineIds = new Set(base.events.map((item) => item.id));
  const currentIds = new Set(current.events.map((item) => item.id));
  let sequence = current.events.reduce((max, item) => Math.max(max, item.sequence ?? -1), -1);
  const events = result.events.filter((item) => item.projectId === projectId && !baselineIds.has(item.id) && !currentIds.has(item.id) && !(item.type === "APPROVAL_GRANT_CONSUMED" && current.events.some((old) => old.type === "APPROVAL_GRANT_CONSUMED" && old.payload?.grantId && old.payload.grantId === item.payload?.grantId))).filter((item) => valid || !["RUN_STATE_CHANGED", "WORLD_CHANGED", "EQUILIBRIUM_ENTERED", "WAKE_TRIGGERED", "HUMAN_ITEM_CREATED", "QUESTION_CREATED"].includes(item.type)).map((item) => ({ ...item, sequence: ++sequence }));
  next.events = [...current.events, ...events];
  if (!valid) next = event(next, projectId, "CYCLE_DISCARDED", "이전 컨텍스트의 실행 결과를 현재 상태에 덮어쓰지 않았습니다.", "사용자 변경·일시 정지·종료를 유지했습니다. 이미 발생한 도구 결과와 사용량은 감사 기록에 남습니다.");
  return next;
}

export interface DurableCycleOptions { modelGateway?: ModelGateway; pollMs?: number; leaseMs?: number; signal?: AbortSignal }

export async function runDurableCycle(store: CycleStateStore, projectId: string, options: DurableCycleOptions = {}): Promise<boolean> {
  const id = randomUUID(), owner = `${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(2_000, options.leaseMs ?? 120_000);
  let claimed = false;
  const base = await store.transact((state) => {
    const project = getProject(state, projectId), run = getRun(state, projectId);
    if (!project || !run || project.status !== "ACTIVE") return state;
    if (run.retryAfter && Date.parse(run.retryAfter) > Date.now()) return state;
    if (run.execution) {
      if (Date.parse(run.execution.expiresAt) > Date.now()) return state;
      // Unknown side-effect outcome after a crash must never be blindly replayed.
      if (run.execution.dispatchStarted) return stallProject(state, projectId, "이전 실행이 도구 처리 중 끊겼습니다. 실제 작업 폴더와 결과를 확인한 뒤 재개하십시오.");
    }
    const block = executionBlockReason(state, projectId);
    if (block) return stallProject(state, projectId, block);
    claimed = true;
    return { ...state, runs: state.runs.map((item) => item.id === run.id ? { ...item, phase: "wake", execution: { id, owner, expiresAt: new Date(Date.now() + leaseMs).toISOString(), stage: "wake" } } : item) };
  });
  if (!claimed) return false;
  const initialFence = fence(base, projectId);
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const owned = (state: AppState) => getRun(state, projectId)?.execution?.id === id;
  const valid = (state: AppState) => owned(state) && fence(state, projectId) === initialFence && !controller.signal.aborted;
  const cancelled = () => new ModelGatewayError(modelFailure("CANCELLED", "실행 중 사용자 상태가 바뀌었거나 실행 허가가 폐기되었습니다.", false));
  let heartbeatAt = Date.now(), heartbeatBusy = false;
  const timer = setInterval(() => {
    try {
      if (!valid(store.read())) { controller.abort(); return; }
      if (!heartbeatBusy && Date.now() - heartbeatAt > leaseMs / 3) {
        heartbeatBusy = true;
        void store.transact((state) => {
          if (!valid(state)) { controller.abort(); return state; }
          return { ...state, runs: state.runs.map((run) => run.execution?.id === id ? { ...run, execution: { ...run.execution, expiresAt: new Date(Date.now() + leaseMs).toISOString() } } : run) };
        }).then(() => { heartbeatAt = Date.now(); }).catch(() => controller.abort()).finally(() => { heartbeatBusy = false; });
      }
    } catch { controller.abort(); }
  }, Math.max(25, options.pollMs ?? 100));
  timer.unref();
  try {
    const onPhase = async (phase: RuntimePhase, working: AppState) => {
      await store.transact((state) => {
        if (!valid(state)) throw cancelled();
        const newContexts = working.contexts.filter((context) => context.projectId === projectId && !state.contexts.some((old) => old.id === context.id));
        const newObservations = working.observations.filter((item) => item.projectId === projectId && !state.observations.some((old) => old.id === item.id));
        const newWorlds = working.worldSnapshots.filter((item) => item.projectId === projectId && !state.worldSnapshots.some((old) => old.id === item.id));
        const next = { ...state, contexts: [...state.contexts, ...newContexts], observations: [...state.observations, ...newObservations], worldSnapshots: [...state.worldSnapshots, ...newWorlds], runs: state.runs.map((run) => run.execution?.id === id ? { ...run, phase, execution: { ...run.execution, stage: phase } } : run) };
        return event(next, projectId, "CYCLE_PHASE", `실행 단계 · ${phase}`, `cycle=${id}`);
      });
    };
    const beforeDispatch = async (_working: AppState, action: ActionEnvelope) => {
      await store.transact((state) => {
        if (!valid(state) || executionBlockReason(state, projectId)) throw cancelled();
        const project = getProject(state, projectId)!;
        const grant = getMatchingApprovalGrant(state, projectId, action);
        const boundary = validateActionBoundary(project, action, getToolSurface(project), estimateActionCost(action), grant);
        if (boundary.status !== "allowed") throw cancelled();
        let next = state;
        if (grant) {
          // Consume durably BEFORE the external side effect. A crash cannot reuse it.
          next = { ...next, approvalGrants: next.approvalGrants.map((item) => item.id === grant.id ? { ...item, consumedAt: new Date().toISOString() } : item) };
          next = event(next, projectId, "APPROVAL_GRANT_CONSUMED", "승인된 행동의 1회 실행권을 사용했습니다.", `grant=${grant.id} · tool=${action.tool}`);
          next.events[next.events.length - 1] = { ...next.events[next.events.length - 1], payload: { grantId: grant.id } };
        }
        return { ...next, runs: next.runs.map((run) => run.execution?.id === id ? { ...run, execution: { ...run.execution, stage: "dispatch", dispatchStarted: boundary.capability?.sideEffect ?? true, action } } : run) };
      });
    };
    const result = await executeLocalCycle(base, projectId, { modelGateway: options.modelGateway, signal: controller.signal, onPhase, beforeDispatch });
    let accepted = false;
    await store.transact((state) => {
      if (!owned(state)) return state;
      accepted = valid(state);
      return mergeCycleResult(state, base, result, projectId, accepted);
    });
    if (!accepted) {
      const previousIds = new Set(base.processes.map((item) => item.id));
      const added = result.processes.filter((item) => item.projectId === projectId && !previousIds.has(item.id));
      for (const process of added) await stopManagedProcess(process.id);
      if (added.length) await store.transact((state) => ({ ...state, processes: state.processes.map((item) => added.some((added) => added.id === item.id) ? { ...item, status: "stopped", endedAt: new Date().toISOString() } : item) }));
    }
    return true;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", externalAbort);
    // Exceptions in storage retain the durable lease. A later worker handles recovery.
  }
}
