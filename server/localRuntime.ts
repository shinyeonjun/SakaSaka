import { applyObservedWorld, assembleContext, getProject, getToolSurface, getWorldSnapshot, recordBoundaryDecision, recordNonToolAction, recordObservedWorldRefresh, recordRuntimeFailure, runCycle } from "../src/runtime";
import { redactSecretLikeText, validateActionBoundary } from "../src/security";
import type { AppState, Observation } from "../src/types";
import { DeterministicEvaluator, DockerSandboxManager, LocalSandboxManager, LocalToolGateway, createLocalWorldAdapters, createModelGateway, estimateLocalActionCost } from "./localAdapters";
import { JsonlObservabilitySink } from "./observability";

export interface LocalCycleOptions {
  workspacePath?: string;
  previewUrl?: string;
}

async function observeProject(state: AppState, projectId: string): Promise<{ state: AppState; observations: Observation[] }> {
  const project = getProject(state, projectId);
  const run = project ? state.runs.find((candidate) => candidate.id === project.activeRunId) : undefined;
  if (!project || !run) return { state, observations: [] };
  const adapters = createLocalWorldAdapters();
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.observe({ project, run, previousWorld: getWorldSnapshot(state, projectId), state })));
  const observations = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const reason = redactSecretLikeText(result.reason instanceof Error ? result.reason.message : "adapter failed");
    return {
      id: `${projectId}-${adapters[index].source}-error-${Date.now().toString(36)}`,
      projectId,
      source: adapters[index].source,
      status: "warning",
      observedAt: new Date().toISOString(),
      freshness: "stale" as const,
      rawRef: `adapter://${adapters[index].source}/error`,
      compactView: `${adapters[index].source} observation failed · ${reason.replace(/\s+/g, " ").slice(0, 240)}`,
      trustLevel: "untrusted" as const,
      confidence: 0.1,
      relatedEntities: [run.id],
    } satisfies Observation;
  });
  return { state: applyObservedWorld(state, projectId, observations), observations };
}

/** Executes one real local closed-loop cycle for API-created workspace projects. */
export async function executeLocalCycle(state: AppState, projectId: string, _options: LocalCycleOptions = {}): Promise<AppState> {
  const observability = new JsonlObservabilitySink();
  const cycleSpan = observability.span("runtime.cycle", { projectId, mode: "local" });
  let spanStatus = "unknown";
  let currentState = state;
  let sandboxManager: LocalSandboxManager | DockerSandboxManager | undefined;
  let sandbox: Awaited<ReturnType<LocalSandboxManager["create"]>> | undefined;
  try {
    const observed = await observeProject(state, projectId);
    currentState = observed.state;
    const project = getProject(observed.state, projectId);
    const run = project ? observed.state.runs.find((candidate) => candidate.id === project.activeRunId) : undefined;
    if (!project || !run) {
      spanStatus = "missing-project";
      return observed.state;
    }
    if (project.status !== "ACTIVE" && project.status !== "WAITING") {
      spanStatus = `not-active:${project.status}`;
      return observed.state;
    }
    const context = assembleContext(observed.state, projectId);
    if (!context) {
      spanStatus = "missing-context";
      return observed.state;
    }

    const model = createModelGateway(project);
    const action = await model.decide(context);
    const modelUsage = await model.usage(run.id);
    if (action.intentRef !== context.intentRef || action.worldCursor !== context.worldCursor) {
      spanStatus = "invalid-action-reference";
      return recordBoundaryDecision(observed.state, projectId, action, "blocked", "model action references a stale intent or world cursor", context.id);
    }
    if (action.type !== "ACT") {
      const next = recordNonToolAction(observed.state, projectId, action, context.id);
      spanStatus = `non-tool-action:${action.type}`;
      return next;
    }
    const boundary = validateActionBoundary(project, action, getToolSurface(project), estimateLocalActionCost(action) + modelUsage.cost);
    if (boundary.status !== "allowed") {
      spanStatus = boundary.status;
      return recordBoundaryDecision(observed.state, projectId, action, boundary.status, boundary.reason, context.id);
    }

    sandboxManager = project.settings.sandboxMode === "docker" ? new DockerSandboxManager() : new LocalSandboxManager();
    sandbox = await sandboxManager.create(project, run);
    const toolGateway = new LocalToolGateway();
    const normalizedAction = { ...action, tool: boundary.normalizedTool ?? action.tool };
    const toolResult = await toolGateway.execute(normalizedAction, sandbox);
    const world = getWorldSnapshot(observed.state, projectId);
    const evaluation = world ? await new DeterministicEvaluator().evaluate(action.rationaleSummary, toolResult.evidence, world) : undefined;
    const next = runCycle(state, projectId, { observations: observed.observations, action: normalizedAction, toolResult, evaluation, modelUsage });
    observability.metric("runtime.cost", toolResult.cost + modelUsage.cost, { projectId, tool: toolResult.tool, status: toolResult.status });
    observability.metric("runtime.evidence", toolResult.evidence.length, { projectId, verdict: evaluation?.verdict ?? "UNCERTAIN" });
    spanStatus = toolResult.status;
    return next;
  } catch (error: unknown) {
    const reason = redactSecretLikeText(error instanceof Error ? error.message : "unknown local runtime failure");
    spanStatus = "failed";
    if (sandbox && sandboxManager) {
      try { await sandboxManager.kill(sandbox); } catch { spanStatus = "kill-cleanup-failed"; }
    }
    return recordRuntimeFailure(currentState, projectId, "dispatch", reason);
  } finally {
    if (sandbox && sandboxManager) {
      try { await sandboxManager.destroy(sandbox); } catch { spanStatus = "cleanup-failed"; }
    }
    cycleSpan.end({ status: spanStatus });
  }
}

export async function observeLocalWorld(state: AppState, projectId: string): Promise<AppState> {
  const observed = await observeProject(state, projectId);
  return recordObservedWorldRefresh(state, projectId, observed.observations);
}
