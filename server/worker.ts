import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSeedState } from "../src/seed";
import { executeLocalCycle } from "./localRuntime";
import { wakeProject } from "../src/runtime";
import { JsonlEventStore } from "./jsonlEventStore";
import { JsonJobQueue } from "./jobQueue";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";
import { withFileLock } from "./fileLock";
import type { AppState } from "../src/types";

const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const lockPath = `${statePath}.lock`;
const eventJournal = new JsonlEventStore(`${statePath}.events.jsonl`);
const queue = new JsonJobQueue(`${statePath}.queue.json`);
const intervalMs = Math.max(1000, Number(process.env.WORKER_INTERVAL_MS ?? "5000"));

function normalizeState(candidate: unknown): AppState {
  const value = candidate as Partial<AppState>;
  if (!Array.isArray(value.projects) || !Array.isArray(value.intents) || !Array.isArray(value.runs) || !Array.isArray(value.events)) throw new Error("state snapshot is missing required collections");
  return {
    ...(value as AppState),
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
  if (!existsSync(statePath)) return createSeedState();
  const candidate = readJsonWithBackup<unknown>(statePath, isRecoverableState);
  if (candidate === undefined) throw new Error(`state snapshot is unreadable and no valid backup exists: ${statePath}`);
  return normalizeState(candidate);
}

function persistState(state: AppState): void {
  writeJsonAtomically(statePath, state);
  for (const event of state.events) eventJournal.appendSync(event);
}

export async function runWorkerOnce(): Promise<{ processed: string[] }> {
  try {
    return await withFileLock(lockPath, async () => {
      const state = loadState();
      let next = state;
      const processed: string[] = [];
      for (const project of state.projects.filter((candidate) => candidate.settings.workspacePath && (candidate.status === "ACTIVE" || candidate.status === "EQUILIBRIUM" && candidate.nextReviewAt && Date.parse(candidate.nextReviewAt) <= Date.now()))) {
        await queue.enqueue({ projectId: project.id, runId: project.activeRunId, trigger: project.status === "EQUILIBRIUM" ? "scheduled-review" : "signal" });
      }
      const workerId = `worker-${process.pid}`;
      const job = await queue.lease(workerId, 120_000);
      if (job) {
        try {
          const queuedProject = next.projects.find((candidate) => candidate.id === job.projectId);
          if (queuedProject?.status === "EQUILIBRIUM") next = wakeProject(next, job.projectId, job.trigger);
          if (next.projects.find((candidate) => candidate.id === job.projectId)?.status === "ACTIVE") {
            next = await executeLocalCycle(next, job.projectId);
            processed.push(job.projectId);
          }
          await queue.ack(job.id, workerId);
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\//, ""))) {
  console.log(`Intent World worker polling every ${intervalMs}ms`);
  void runWorkerOnce();
  const timer = setInterval(() => { void runWorkerOnce(); }, intervalMs);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
