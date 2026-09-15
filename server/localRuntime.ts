import { applyObservedWorld, assembleContext, getProject, getToolSurface, getWorldSnapshot, recordBoundaryDecision, runCycle } from "../src/runtime";
import { validateActionBoundary } from "../src/security";
import type { AppState, Observation } from "../src/types";
import { DeterministicEvaluator, DeterministicLocalModelGateway, LocalSandboxManager, LocalToolGateway, createLocalWorldAdapters } from "./localAdapters";

export interface LocalCycleOptions {
  workspacePath?: string;
  previewUrl?: string;
}

async function observeProject(state: AppState, projectId: string): Promise<{ state: AppState; observations: Observation[] }> {
  const project = getProject(state, projectId);
  const run = project ? state.runs.find((candidate) => candidate.id === project.activeRunId) : undefined;
  if (!project || !run) return { state, observations: [] };
  const observations = await Promise.all(createLocalWorldAdapters().map((adapter) => adapter.observe({ project, run, previousWorld: getWorldSnapshot(state, projectId), state })));
  return { state: applyObservedWorld(state, projectId, observations), observations };
}

/** Executes one real local closed-loop cycle for API-created workspace projects. */
export async function executeLocalCycle(state: AppState, projectId: string, _options: LocalCycleOptions = {}): Promise<AppState> {
  const observed = await observeProject(state, projectId);
  const project = getProject(observed.state, projectId);
  const run = project ? observed.state.runs.find((candidate) => candidate.id === project.activeRunId) : undefined;
  if (!project || !run) return observed.state;
  const context = assembleContext(observed.state, projectId);
  if (!context) return observed.state;

  const model = new DeterministicLocalModelGateway();
  const action = await model.decide(context);
  const boundary = validateActionBoundary(project, action, getToolSurface(project), action.type === "ACT" ? 0.2 : 0);
  if (boundary.status !== "allowed") return recordBoundaryDecision(observed.state, projectId, action, boundary.status, boundary.reason, context.id);

  const sandboxManager = new LocalSandboxManager();
  const sandbox = await sandboxManager.create(project, run);
  const toolGateway = new LocalToolGateway();
  const toolResult = await toolGateway.execute({ ...action, tool: boundary.normalizedTool ?? action.tool }, sandbox);
  const world = getWorldSnapshot(observed.state, projectId);
  const evaluation = world ? await new DeterministicEvaluator().evaluate(action.rationaleSummary, toolResult.evidence, world) : undefined;
  const next = runCycle(state, projectId, { observations: observed.observations, action: { ...action, tool: boundary.normalizedTool ?? action.tool }, toolResult, evaluation });
  await sandboxManager.destroy(sandbox);
  return next;
}

export async function observeLocalWorld(state: AppState, projectId: string): Promise<AppState> {
  return (await observeProject(state, projectId)).state;
}
