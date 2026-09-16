import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createEmptyState } from "../src/emptyState";
import { executeLocalCycle } from "./localRuntime";
import { recoverTransientProviderFailures, wakeProject } from "../src/runtime";
import { JsonlEventStore } from "./jsonlEventStore";
import { JsonJobQueue } from "./jobQueue";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";
import { withFileLock } from "./fileLock";
import { hydrateManagedProcesses, stopProcessesForRun } from "./processManager";
import type { AppState, ProjectMetrics, ProjectSettings } from "../src/types";

const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const lockPath = `${statePath}.lock`;
const eventJournal = new JsonlEventStore(`${statePath}.events.jsonl`);
const queue = new JsonJobQueue(`${statePath}.queue.json`);
const configuredIntervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "5000");
const intervalMs = Number.isFinite(configuredIntervalMs) ? Math.max(100, configuredIntervalMs) : 5_000;
const configuredConcurrency = Number(process.env.WORKER_MAX_CONCURRENCY ?? "1");
const maxJobsPerTick = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(32, Math.floor(configuredConcurrency))) : 1;

function normalizeProjectSettings(raw: Partial<ProjectSettings> | undefined): ProjectSettings {
  return { budgetLimit: raw?.budgetLimit ?? 30, maxHours: raw?.maxHours ?? 12, localActions: raw?.localActions ?? true, requireExternalApproval: raw?.requireExternalApproval ?? true, productionBlocked: raw?.productionBlocked ?? true, networkPolicy: raw?.networkPolicy ?? "allowlist", workspacePath: raw?.workspacePath, previewUrl: raw?.previewUrl, allowedDomains: raw?.allowedDomains, sandboxMode: raw?.sandboxMode ?? "process", modelProvider: raw?.modelProvider ?? "auto", modelName: raw?.modelName, reviewIntervalMinutes: raw?.reviewIntervalMinutes ?? 360, failureThreshold: raw?.failureThreshold ?? 3, noProgressThreshold: raw?.noProgressThreshold ?? 5, cycleDelayMs: raw?.cycleDelayMs ?? 250, approvalTtlMinutes: raw?.approvalTtlMinutes ?? 60, processMaxLifetimeMs: raw?.processMaxLifetimeMs ?? 1_800_000, maxConcurrentProcesses: raw?.maxConcurrentProcesses ?? 4 };
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
  writeJsonAtomically(statePath, state, isRecoverableState);
  for (const event of state.events) eventJournal.appendSync(event);
}

export async function runWorkerOnce(): Promise<{ processed: string[] }> {
  try {
    return await withFileLock(lockPath, async () => {
      const loadedState = loadState();
      const state = recoverTransientProviderFailures(loadedState);
      if (state !== loadedState) persistState(state);
      hydrateManagedProcesses(state.processes);
      let next = state;
      const processed: string[] = [];
      for (const project of state.projects.filter((candidate) => candidate.settings.workspacePath && candidate.status === "ACTIVE")) {
        await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: "signal", availableAt: new Date(Date.now() + Math.max(0, Number(project.settings.cycleDelayMs ?? 250))).toISOString() });
      }
      for (const project of state.projects.filter((candidate) => candidate.settings.workspacePath && candidate.status === "EQUILIBRIUM" && candidate.nextReviewAt && Date.parse(candidate.nextReviewAt) <= Date.now())) {
        await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: "scheduled-review" });
      }
      const workerId = `worker-${process.pid}`;
      for (let jobIndex = 0; jobIndex < maxJobsPerTick; jobIndex += 1) {
        const job = await queue.lease(workerId, 120_000);
        if (!job) break;
        try {
          const queuedProject = next.projects.find((candidate) => candidate.id === job.projectId);
          if (queuedProject?.activeRunId !== job.runId) {
            await queue.ack(job.id, workerId);
            continue;
          }
          if (queuedProject?.status === "EQUILIBRIUM") next = wakeProject(next, job.projectId, job.trigger);
          let continuation: AppState["projects"][number] | undefined;
          if (next.projects.find((candidate) => candidate.id === job.projectId)?.status === "ACTIVE") {
            next = await executeLocalCycle(next, job.projectId);
            processed.push(job.projectId);
            continuation = next.projects.find((candidate) => candidate.id === job.projectId);
          } else if (queuedProject) {
            const queuedRun = next.runs.find((run) => run.id === queuedProject.activeRunId);
            if (queuedRun) {
              await stopProcessesForRun(next.processes, queuedRun.id);
              next = { ...next, runs: next.runs.map((candidate) => candidate.id === queuedRun.id ? { ...candidate, activeProcessIds: [] } : candidate) };
            }
          }
          await queue.ack(job.id, workerId);
          if (continuation?.status === "ACTIVE" && continuation.settings.workspacePath) {
            await queue.enqueue({ projectId: continuation.id, runId: continuation.activeRunId, trigger: "signal", availableAt: new Date(Date.now() + Math.max(0, Number(continuation.settings.cycleDelayMs ?? 250))).toISOString() });
          }
        } catch (error) {
          await queue.retry(job.id, Math.min(60_000, 2_000 * job.attempts), workerId);
          console.error(`worker job ${job.id} failed`, error);
        }
      }
      if (next !== state) persistState(next);
      return { processed };
    });
  } catch (error) {
    console.error("worker state lock unavailable", error);
    return { processed: [] };
  }
}

export function startWorker(): void {
  console.log(`Intent World worker polling every ${intervalMs}ms`);
  void runWorkerOnce();
  const timer = setInterval(() => { void runWorkerOnce(); }, intervalMs);
  const stop = () => {
    clearInterval(timer);
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
