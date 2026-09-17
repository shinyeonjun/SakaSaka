import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createEmptyState } from "../src/emptyState";
import { runAutonomousDurableCycle, runAutonomousNativeEpisode } from "./autonomousRuntime";
import { recoverTransientProviderFailures, wakeProject } from "../src/runtime";
import { JsonlEventStore } from "./jsonlEventStore";
import { JsonJobQueue } from "./jobQueue";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";
import { withFileLock } from "./fileLock";
import { hydrateManagedProcesses, reconcileManagedProcesses, stopProcessesForRun } from "./processManager";
import type { AppState, EventRecord, ProjectMetrics, ProjectSettings } from "../src/types";

const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const lockPath = `${statePath}.lock`;
const eventJournal = new JsonlEventStore(`${statePath}.events.jsonl`);
const queue = new JsonJobQueue(`${statePath}.queue.json`);
const configuredIntervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "5000");
const intervalMs = Number.isFinite(configuredIntervalMs) ? Math.max(100, configuredIntervalMs) : 5_000;
const configuredConcurrency = Number(process.env.WORKER_MAX_CONCURRENCY ?? "1");
const maxJobsPerTick = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(32, Math.floor(configuredConcurrency))) : 1;

function normalizeProjectSettings(raw: Partial<ProjectSettings> | undefined): ProjectSettings {
  return { budgetLimit: raw?.budgetLimit ?? 30, maxHours: raw?.maxHours ?? 12, maxModelCalls: raw?.maxModelCalls ?? 200, localActions: raw?.localActions ?? true, requireExternalApproval: raw?.requireExternalApproval ?? true, productionBlocked: raw?.productionBlocked ?? true, networkPolicy: raw?.networkPolicy ?? "allowlist", workspacePath: raw?.workspacePath, previewUrl: raw?.previewUrl, allowedDomains: raw?.allowedDomains, sandboxMode: raw?.sandboxMode ?? "process", executionMode: raw?.executionMode ?? "atomic", maxNativeTurns: raw?.maxNativeTurns, maxNativeTokens: raw?.maxNativeTokens, nativeTurnTimeoutMs: raw?.nativeTurnTimeoutMs, modelProvider: raw?.modelProvider ?? "auto", modelName: raw?.modelName, reviewIntervalMinutes: raw?.reviewIntervalMinutes ?? 360, failureThreshold: raw?.failureThreshold ?? 3, noProgressThreshold: raw?.noProgressThreshold ?? 5, cycleDelayMs: raw?.cycleDelayMs ?? 250, approvalTtlMinutes: raw?.approvalTtlMinutes ?? 60, processMaxLifetimeMs: raw?.processMaxLifetimeMs ?? 1_800_000, maxConcurrentProcesses: raw?.maxConcurrentProcesses ?? 4 };
}

function normalizeProjectMetrics(raw: Partial<ProjectMetrics> | undefined): ProjectMetrics {
  return { testsPassed: raw?.testsPassed ?? 0, testsTotal: raw?.testsTotal ?? 0, evidenceCoverage: raw?.evidenceCoverage ?? 0, humanOrchestrationCount: raw?.humanOrchestrationCount ?? 0, initiativeRecall: raw?.initiativeRecall ?? 0, initiativePrecision: raw?.initiativePrecision ?? 0 };
}

function normalizeState(candidate: unknown): AppState {
  const value = candidate as Partial<AppState>;
  if (!Array.isArray(value.projects) || !Array.isArray(value.intents) || !Array.isArray(value.runs) || !Array.isArray(value.events)) throw new Error("state snapshot is missing required collections");
  return {
    ...(value as AppState),
    projects: value.projects.map((project) => ({
      ...project,
      settings: normalizeProjectSettings(project.settings),
      metrics: normalizeProjectMetrics(project.metrics),
    })),
    runs: value.runs.map((run) => ({
      ...run,
      consecutiveFailures: Number.isFinite(run.consecutiveFailures) ? run.consecutiveFailures : 0,
      noProgressCycles: Number.isFinite(run.noProgressCycles) ? run.noProgressCycles : 0,
      activeProcessIds: Array.isArray(run.activeProcessIds) ? run.activeProcessIds : [],
    })),
    actions: Array.isArray(value.actions) ? value.actions.map((action) => ({ ...action, schemaVersion: 1 as const })) : [],
    worldSnapshots: Array.isArray(value.worldSnapshots) ? value.worldSnapshots : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    humanItems: Array.isArray(value.humanItems) ? value.humanItems : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    experiences: Array.isArray(value.experiences) ? value.experiences : [],
    experiments: Array.isArray(value.experiments) ? value.experiments : [],
    observations: Array.isArray(value.observations) ? value.observations.map((observation) => ({
      ...observation,
      status: observation.status ?? (observation.trustLevel === "untrusted" || /unconfigured|unreachable|unanswered|awaiting|blocked|not connected/i.test(observation.compactView) ? "warning" : "healthy"),
    })) : [],
    contexts: Array.isArray(value.contexts) ? value.contexts.map((context) => ({ ...context, schemaVersion: 1 as const })) : [],
    policies: Array.isArray(value.policies) ? value.policies : [],
    resourceLedger: Array.isArray(value.resourceLedger) ? value.resourceLedger : [],
    relations: Array.isArray(value.relations) ? value.relations : [],
    retrievalIndex: Array.isArray(value.retrievalIndex) ? value.retrievalIndex : [],
    approvalGrants: Array.isArray(value.approvalGrants) ? value.approvalGrants : [],
    processes: Array.isArray(value.processes) ? value.processes : [],
  };
}

function isRecoverableState(candidate: unknown): boolean {
  try {
    normalizeState(candidate);
    return true;
  } catch {
    return false;
  }
}

function loadState(): AppState {
  if (!existsSync(statePath)) return createEmptyState();
  const candidate = readJsonWithBackup<unknown>(statePath, isRecoverableState);
  if (candidate === undefined) throw new Error(`state snapshot is unreadable and no valid backup exists: ${statePath}`);
  return normalizeState(candidate);
}

function persistState(state: AppState): void {
  state.revision = Math.max(state.revision ?? 0, loadState().revision ?? 0) + 1;
  writeJsonAtomically(statePath, state, isRecoverableState);
  for (const event of state.events) eventJournal.appendSync(event);
}

function reconcileProcessState(state: AppState): AppState {
  const processes = reconcileManagedProcesses(state.processes);
  const processById = new Map(processes.map((process) => [process.id, process]));
  const changed = processes.some((process, index) => JSON.stringify(process) !== JSON.stringify(state.processes[index]));
  const runs = state.runs.map((run) => ({
    ...run,
    activeProcessIds: run.activeProcessIds.filter((id) => {
      const process = processById.get(id);
      return process?.status === "starting" || process?.status === "running";
    }),
  }));
  const runsChanged = runs.some((run, index) => JSON.stringify(run.activeProcessIds) !== JSON.stringify(state.runs[index]?.activeProcessIds));
  if (!changed && !runsChanged) return state;

  let sequence = state.events.reduce((max, event) => Math.max(max, event.sequence ?? -1), -1);
  const exitedEvents: EventRecord[] = state.processes.flatMap((previous) => {
    const current = processById.get(previous.id);
    if (!current || (previous.status !== "starting" && previous.status !== "running") || !["exited", "stopped", "failed"].includes(current.status)) return [];
    return [{
      id: `event-${randomUUID()}`,
      sequence: ++sequence,
      projectId: current.projectId,
      type: "PROCESS_EXITED",
      actor: "system",
      summary: `managed process ${current.status} · ${current.id}`,
      detail: current.error ?? (current.exitCode === undefined ? "process lifecycle changed" : `exit code ${current.exitCode}`),
      createdAt: current.endedAt ?? new Date().toISOString(),
      runId: current.runId,
      schemaVersion: 1,
    }];
  });
  return { ...state, processes, runs, events: exitedEvents.length ? [...state.events, ...exitedEvents] : state.events };
}

let inFlight = false;
const workerStop = new AbortController();

export async function runWorkerOnce(): Promise<{ processed: string[] }> {
  if (inFlight || workerStop.signal.aborted) return { processed: [] };
  inFlight = true;
  const processed: string[] = [];
  const transact = (update: (state: AppState) => AppState): Promise<AppState> => withFileLock(lockPath, () => {
    const before = loadState(), next = update(before);
    if (next !== before) persistState(next);
    return next;
  });
  try {
    await withFileLock(lockPath, async () => {
      const loaded = loadState();
      const recovered = recoverTransientProviderFailures(loaded);
      const state = reconcileProcessState(recovered);
      if (state !== loaded) persistState(state);
      for (const project of state.projects.filter((item) => item.settings.workspacePath)) {
        const run = state.runs.find((item) => item.id === project.activeRunId);
        if (project.status === "ACTIVE") await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: "signal", availableAt: new Date(Math.max(Date.now() + Math.max(0, Number(project.settings.cycleDelayMs ?? 250)), Date.parse(run?.retryAfter ?? "") || 0)).toISOString() });
        if (project.status === "EQUILIBRIUM" && project.nextReviewAt && Date.parse(project.nextReviewAt) <= Date.now()) await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: "scheduled-review" });
      }
    });
    const workerId = `worker-${process.pid}`;
    for (let index = 0; index < maxJobsPerTick; index++) {
      const job = await withFileLock(lockPath, () => queue.lease(workerId, 600_000));
      if (!job) break;
      try {
        await transact((state) => {
          const project = state.projects.find((item) => item.id === job.projectId);
          return project?.activeRunId === job.runId && project.status === "EQUILIBRIUM" ? wakeProject(state, job.projectId, job.trigger) : state;
        });
        const candidate = loadState().projects.find((item) => item.id === job.projectId);
        if (candidate?.activeRunId === job.runId) {
          const execute = candidate.settings.executionMode === "native" ? runAutonomousNativeEpisode : runAutonomousDurableCycle;
          if (await execute({ read: loadState, transact }, job.projectId, { signal: workerStop.signal })) processed.push(job.projectId);
        }
        await withFileLock(lockPath, async () => {
          await queue.ack(job.id, workerId);
          const state = loadState();
          const project = state.projects.find((item) => item.id === job.projectId);
          const run = state.runs.find((item) => item.id === project?.activeRunId);
          if (project?.status === "ACTIVE" && project.settings.workspacePath) await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: "signal", availableAt: new Date(Math.max(Date.now() + (project.settings.cycleDelayMs ?? 250), Date.parse(run?.retryAfter ?? "") || 0)).toISOString() });
        });
      } catch (error) {
        await withFileLock(lockPath, () => queue.retry(job.id, Math.min(60_000, 2_000 * job.attempts), workerId));
        console.error(`worker job ${job.id} failed`, error);
      }
    }
    return { processed };
  } finally { inFlight = false; }
}

export function startWorker(): void {
  console.log(`Intent World worker polling every ${intervalMs}ms`);
  void runWorkerOnce().catch((error) => console.error("worker tick failed", error));
  const timer = setInterval(() => { void runWorkerOnce().catch((error) => console.error("worker tick failed", error)); }, intervalMs);
  const stop = () => {
    clearInterval(timer);
    workerStop.abort();
    void withFileLock(lockPath, async () => {
      const current = loadState();
      hydrateManagedProcesses(current.processes);
      for (const run of current.runs) await stopProcessesForRun(current.processes, run.id);
      persistState({ ...current, runs: current.runs.map((run) => ({ ...run, activeProcessIds: [] })) });
    }).catch((error: unknown) => console.error(error instanceof Error ? error.message : "managed process shutdown persistence failed")).finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
