import { accountModelUsage, applyObservedWorld, assembleContextAsync, executionBlockReason, getMatchingApprovalGrant, getProject, getRun, getToolSurface, getWorldSnapshot, recordBoundaryDecision, recordModelFailure, recordNonToolAction, recordObservedWorldRefresh, recordRuntimeFailure, runCycle, stallProject } from "../src/runtime";
import { isActiveProcessReference, redactSecretLikeText, validateActionBoundary } from "../src/security";
import { validateActionInput } from "../src/toolContracts";
import { ModelGatewayError, modelFailure } from "../src/modelFailure";
import type { ActionEnvelope, AppState, ContextPacket, Observation, RuntimePhase } from "../src/types";
import type { ModelGateway, ModelUsage, SandboxContext } from "../src/ports";
import { DeterministicEvaluator, DockerSandboxManager, LocalSandboxManager, LocalToolGateway, createLocalWorldAdapters, createModelGateway, estimateLocalActionCost } from "./localAdapters";
import { hydrateManagedProcesses } from "./processManager";
import { JsonlObservabilitySink } from "./observability";

export interface LocalCycleOptions {
  workspacePath?: string;
  previewUrl?: string;
  modelGateway?: ModelGateway;
  contextProjection?: (context: ContextPacket) => ContextPacket;
  signal?: AbortSignal;
  /** Durable runtime hooks. No model/tool work is performed while committing these. */
  onPhase?: (phase: RuntimePhase, state: AppState) => Promise<void>;
  beforeDispatch?: (state: AppState, action: ActionEnvelope) => Promise<void>;
}

async function observeProject(state: AppState, projectId: string): Promise<{ state: AppState; observations: Observation[] }> {
  const project = getProject(state, projectId), run = getRun(state, projectId);
  if (!project || !run) return { state, observations: [] };
  const adapters = createLocalWorldAdapters();
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.observe({ project, run, previousWorld: getWorldSnapshot(state, projectId), state })));
  const observations = results.map((result, index): Observation => result.status === "fulfilled" ? result.value : {
    id: `${projectId}-${adapters[index].source}-error-${crypto.randomUUID()}`, projectId, source: adapters[index].source, status: "warning",
    observedAt: new Date().toISOString(), freshness: "stale", rawRef: `adapter://${adapters[index].source}/error`,
    compactView: `${adapters[index].source} 관찰 실패 · ${redactSecretLikeText(result.reason instanceof Error ? result.reason.message : "adapter failed").slice(0, 240)}`,
    trustLevel: "untrusted", confidence: 0.1, relatedEntities: [run.id],
  });
  return { state: applyObservedWorld(state, projectId, observations), observations };
}

/** One cognition cycle. The coordinator owns durable reservation/commit and cancellation. */
export async function executeLocalCycle(state: AppState, projectId: string, options: LocalCycleOptions = {}): Promise<AppState> {
  const span = new JsonlObservabilitySink().span("runtime.cycle", { projectId });
  let current = state;
  let phase: RuntimePhase = "wake";
  let modelUsage: ModelUsage | undefined;
  let context: ContextPacket | undefined;
  let sandbox: SandboxContext | undefined;
  let manager: LocalSandboxManager | undefined;
  const checkpoint = async (next: RuntimePhase) => {
    if (options.signal?.aborted) throw new ModelGatewayError(modelFailure("CANCELLED", "사용자 변경으로 실행이 취소되었습니다.", false), modelUsage);
    phase = next;
    await options.onPhase?.(next, current);
  };
  try {
    const initialProject = getProject(state, projectId);
    if (!initialProject || !["ACTIVE", "WAITING"].includes(initialProject.status)) return state;
    const blocked = executionBlockReason(state, projectId);
    if (blocked) return stallProject(state, projectId, blocked);
    const initialRun = getRun(state, projectId);
    if (initialRun?.retryAfter && Date.parse(initialRun.retryAfter) > Date.now()) return state;
    await checkpoint("observe");
    const observed = await observeProject(current, projectId);
    current = observed.state;
    const project = getProject(current, projectId)!, run = getRun(current, projectId)!;
    await checkpoint("assemble");
    const assembled = await assembleContextAsync(current, projectId);
    if (!assembled) throw new Error("모델 컨텍스트를 구성하지 못했습니다.");
    const projected = options.contextProjection?.(assembled) ?? assembled;
    context = projected.projectId === projectId && projected.intentRef === assembled.intentRef && projected.worldCursor === assembled.worldCursor ? projected : assembled;
    const model = options.modelGateway ?? createModelGateway(project);
    const capabilities = await model.capabilities();
    context = { ...context, modelVersion: capabilities.modelVersion };
    current = { ...current, contexts: [...current.contexts, context] };
    await checkpoint("decide");
    const action = await model.decide(context, { signal: options.signal });
    modelUsage = await model.usage(run.id);
    if (options.signal?.aborted) throw new ModelGatewayError(modelFailure("CANCELLED", "새로운 사용자 상태로 이전 결정을 취소했습니다.", false), modelUsage);
    const contractError = validateActionInput(action);
    if (contractError) throw new ModelGatewayError(modelFailure("INVALID_OUTPUT", contractError, true), modelUsage);
    if (action.intentRef !== context.intentRef || action.worldCursor !== context.worldCursor) throw new ModelGatewayError(modelFailure("INVALID_OUTPUT", "모델이 현재 Intent 또는 World 커서를 잘못 반환했습니다.", true), modelUsage);
    if (!isActiveProcessReference(action, context.activeProcessViews?.map((process) => process.id) ?? [])) throw new ModelGatewayError(modelFailure("INVALID_OUTPUT", "프로세스 ID가 현재 activeProcessViews에 없습니다.", true), modelUsage);
    if (action.type !== "ACT") {
      await checkpoint("govern");
      const next = recordNonToolAction(current, projectId, action, context.id, modelUsage);
      return getProject(next, projectId)!.budgetSpent >= project.settings.budgetLimit ? stallProject(next, projectId, "모델 사용 후 실행 예산이 소진되었습니다.") : next;
    }
    const limit = executionBlockReason(current, projectId);
    if (limit) return stallProject(accountModelUsage(current, projectId, modelUsage), projectId, limit);
    const boundary = validateActionBoundary(project, action, getToolSurface(project), estimateLocalActionCost(action) + modelUsage.cost, getMatchingApprovalGrant(current, projectId, action));
    if (boundary.status !== "allowed") return recordBoundaryDecision(current, projectId, action, boundary.status, boundary.reason, context.id, modelUsage);
    await checkpoint("dispatch");
    await options.beforeDispatch?.(current, action);
    if (options.signal?.aborted) throw new ModelGatewayError(modelFailure("CANCELLED", "도구 실행 전에 취소되었습니다.", false), modelUsage);
    manager = project.settings.sandboxMode === "docker" ? new DockerSandboxManager() : new LocalSandboxManager();
    sandbox = await manager.create(project, run);
    hydrateManagedProcesses(current.processes);
    const normalizedAction = { ...action, tool: boundary.normalizedTool ?? action.tool };
    const toolResult = await new LocalToolGateway().execute(normalizedAction, sandbox, { signal: options.signal });
    // Even if cancelled while a tool ran, preserve its actual result. The coordinator
    // prevents old work from overwriting newer human state and cleans up new processes.
    phase = "verify";
    if (!options.signal?.aborted) {
      try { await options.onPhase?.(phase, current); }
      catch (error) {
        // A completed side effect is evidence even when a human changes state
        // just before verification. Let the coordinator retain it as stale.
        if (!(error instanceof ModelGatewayError) || error.failure.code !== "CANCELLED") throw error;
      }
    }
    const evaluation = await new DeterministicEvaluator().evaluate(action.rationaleSummary, toolResult.evidence, getWorldSnapshot(current, projectId)!);
    return runCycle(current, projectId, { action: normalizedAction, toolResult, evaluation, modelUsage, context, dispatchAuthorized: true });
  } catch (error) {
    if (error instanceof ModelGatewayError) return recordModelFailure(current, projectId, error, context?.id);
    return recordRuntimeFailure(accountModelUsage(current, projectId, modelUsage), projectId, phase, redactSecretLikeText(error instanceof Error ? error.message : "실행 오류"));
  } finally {
    if (sandbox && manager) await manager.destroy(sandbox);
    span.end({ phase });
  }
}

export async function observeLocalWorld(state: AppState, projectId: string): Promise<AppState> {
  const observed = await observeProject(state, projectId);
  return recordObservedWorldRefresh(state, projectId, observed.observations);
}
