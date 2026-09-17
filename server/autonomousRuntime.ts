import type { CycleStateStore, DurableCycleOptions } from "./cycleCoordinator";
import { runDurableCycle } from "./cycleCoordinator";
import type { NativeRuntimeOptions } from "./nativeRuntime";
import { runNativeEpisode } from "./nativeRuntime";
import { runAutonomyPostlude, runAutonomyPrelude } from "./autonomySupervisor";

async function prelude(store: CycleStateStore, projectId: string): Promise<void> {
  try { await runAutonomyPrelude(store, projectId); }
  catch (error: unknown) { console.warn("autonomy prelude failed; core runtime will continue", error instanceof Error ? error.message : error); }
}

async function postlude(store: CycleStateStore, projectId: string): Promise<void> {
  try { await runAutonomyPostlude(store, projectId); }
  catch (error: unknown) { console.warn("autonomy postlude failed; verified runtime state is preserved", error instanceof Error ? error.message : error); }
}

export async function runAutonomousNativeEpisode(store: CycleStateStore, projectId: string, options: NativeRuntimeOptions = {}): Promise<boolean> {
  await prelude(store, projectId);
  const ran = await runNativeEpisode(store, projectId, options);
  if (ran) await postlude(store, projectId);
  return ran;
}

export async function runAutonomousDurableCycle(store: CycleStateStore, projectId: string, options: DurableCycleOptions = {}): Promise<boolean> {
  await prelude(store, projectId);
  const ran = await runDurableCycle(store, projectId, options);
  if (ran) await postlude(store, projectId);
  return ran;
}
