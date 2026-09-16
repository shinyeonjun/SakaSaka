import { applyObservedWorld, assembleContextAsync, getMatchingApprovalGrant, getProject, getToolSurface, getWorldSnapshot, recordBoundaryDecision, recordNonToolAction, recordObservedWorldRefresh, recordRuntimeFailure, runCycle } from "../src/runtime";
import { isActiveProcessReference, redactSecretLikeText, validateActionBoundary } from "../src/security";
import type { AppState, ContextPacket, Observation } from "../src/types";
import type { ModelGateway } from "../src/ports";
import { DeterministicEvaluator, DockerSandboxManager, LocalSandboxManager, LocalToolGateway, createLocalWorldAdapters, createModelGateway, estimateLocalActionCost } from "./localAdapters";
import { hydrateManagedProcesses } from "./processManager";
import { JsonlObservabilitySink } from "./observability";

export interface LocalCycleOptions {
  workspacePath?: string;
  previewUrl?: string;
  /** Research harnesses may inject the same provider across isolated variants. */
  modelGateway?: ModelGateway;
  /** Optional projection used by an explicit ablation; the persisted packet is what the model received. */
  contextProjection?: (context: ContextPacket) => ContextPacket;
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
export async function executeLocalCycle(state: AppState, projectId: string, options: LocalCycleOptions = {}): Promise<AppState> {
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
    const assembledContext = await assembleContextAsync(observed.state, projectId);
    if (!assembledContext) {
      spanStatus = "missing-context";
      return observed.state;
    }

    const projectedContext = options.contextProjection?.(assembledContext) ?? assembledContext;
    const context = projectedContext.projectId === projectId && projectedContext.intentRef === assembledContext.intentRef && projectedContext.worldCursor === assembledContext.worldCursor
      ? projectedContext
      : assembledContext;
    const model = options.modelGateway ?? createModelGateway(project);
    const capabilities = await model.capabilities();
    // The packet sent to the provider must identify the provider that will
    // actually decide. Keeping the default local value here would make a
    // remote turn look deterministic in the context/evidence lineage.
    const modelContext = context.modelVersion === capabilities.modelVersion
      ? context
      : { ...context, modelVersion: capabilities.modelVersion };
    const action = await model.decide(modelContext);
    const modelUsage = await model.usage(run.id);
    if (action.intentRef !== modelContext.intentRef || action.worldCursor !== modelContext.worldCursor) {
      spanStatus = "invalid-action-reference";
      const contextState = observed.state.contexts.some((candidate) => candidate.id === modelContext.id) ? observed.state : { ...observed.state, contexts: [...observed.state.contexts, modelContext] };
      return recordBoundaryDecision(contextState, projectId, action, "blocked", "model action references a stale intent or world cursor", modelContext.id, modelUsage);
    }
    if (!isActiveProcessReference(action, modelContext.activeProcessViews?.map((process) => process.id) ?? [])) {
      spanStatus = "invalid-process-reference";
      const contextState = observed.state.contexts.some((candidate) => candidate.id === modelContext.id) ? observed.state : { ...observed.state, contexts: [...observed.state.contexts, modelContext] };
      return recordBoundaryDecision(contextState, projectId, action, "blocked", "process lifecycle action must reference an active process from the current context", modelContext.id, modelUsage);
    }
    if (action.type !== "ACT") {
      const contextState = observed.state.contexts.some((candidate) => candidate.id === modelContext.id) ? observed.state : { ...observed.state, contexts: [...observed.state.contexts, modelContext] };
      const next = recordNonToolAction(contextState, projectId, action, modelContext.id, modelUsage);
      spanStatus = `non-tool-action:${action.type}`;
      return next;
    }
    const boundary = validateActionBoundary(project, action, getToolSurface(project), estimateLocalActionCost(action) + modelUsage.cost, getMatchingApprovalGrant(observed.state, projectId, action));
    if (boundary.status !== "allowed") {
      spanStatus = boundary.status;
      const contextState = observed.state.contexts.some((candidate) => candidate.id === modelContext.id) ? observed.state : { ...observed.state, contexts: [...observed.state.contexts, modelContext] };
      return recordBoundaryDecision(contextState, projectId, action, boundary.status, boundary.reason, modelContext.id, modelUsage);
    }

    sandboxManager = project.settings.sandboxMode === "docker" ? new DockerSandboxManager() : new LocalSandboxManager();
    sandbox = await sandboxManager.create(project, run);
    hydrateManagedProcesses(observed.state.processes);
    const toolGateway = new LocalToolGateway();
    const normalizedAction = { ...action, tool: boundary.normalizedTool ?? action.tool };
    const toolResult = await toolGateway.execute(normalizedAction, sandbox);
    const world = getWorldSnapshot(observed.state, projectId);
    const evaluation = world ? await new DeterministicEvaluator().evaluate(action.rationaleSummary, toolResult.evidence, world) : undefined;
    const next = runCycle(observed.state, projectId, { action: normalizedAction, toolResult, evaluation, modelUsage, context: modelContext });
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
