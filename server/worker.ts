import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSeedState } from "../src/seed";
import { executeLocalCycle } from "./localRuntime";
import type { AppState } from "../src/types";

const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const lockPath = `${statePath}.worker.lock`;
const intervalMs = Math.max(1000, Number(process.env.WORKER_INTERVAL_MS ?? "5000"));

function normalizeState(candidate: unknown): AppState {
  const value = candidate as Partial<AppState>;
  if (!Array.isArray(value.projects) || !Array.isArray(value.intents) || !Array.isArray(value.runs) || !Array.isArray(value.events)) return createSeedState();
  return {
    ...(value as AppState),
    observations: Array.isArray(value.observations) ? value.observations : [],
    contexts: Array.isArray(value.contexts) ? value.contexts : [],
    policies: Array.isArray(value.policies) ? value.policies : [],
    resourceLedger: Array.isArray(value.resourceLedger) ? value.resourceLedger : [],
    relations: Array.isArray(value.relations) ? value.relations : [],
    retrievalIndex: Array.isArray(value.retrievalIndex) ? value.retrievalIndex : [],
  };
}

function loadState(): AppState {
  if (!existsSync(statePath)) return createSeedState();
  try { return normalizeState(JSON.parse(readFileSync(statePath, "utf8"))); } catch { return createSeedState(); }
}

function persistState(state: AppState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.worker.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporaryPath, statePath);
}

function tryLock(): number | undefined {
  try { return openSync(lockPath, "wx"); } catch { return undefined; }
}

export async function runWorkerOnce(): Promise<{ processed: string[] }> {
  const lockHandle = tryLock();
  if (lockHandle === undefined) return { processed: [] };
  try {
    const state = loadState();
    let next = state;
    const processed: string[] = [];
    for (const project of state.projects.filter((candidate) => candidate.status === "ACTIVE" && candidate.settings.workspacePath)) {
      next = await executeLocalCycle(next, project.id);
      processed.push(project.id);
    }
    if (next !== state) persistState(next);
    return { processed };
  } finally {
    closeSync(lockHandle);
    try { unlinkSync(lockPath); } catch {}
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
