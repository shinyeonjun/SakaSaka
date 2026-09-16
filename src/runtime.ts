import { ModelGatewayError, modelFailure } from "./modelFailure";
import { withInputSchemas } from "./toolContracts";
import { worldSourceKeys } from "./types";
import type { EvaluatorResult, ModelUsage, ToolResult } from "./ports";
import { scoreExperiment, experimentDefinition } from "./experimentHarness";
import { estimateActionCost, actionFingerprint, canonicalActionParams, isActiveProcessReference, paramsFingerprint, redactSecretLikeText, validateActionBoundary } from "./security";
import { createConfiguredEmbeddingProvider, rebuildRetrievalIndex, retrieveRelevantExperiences, retrieveRelevantExperiencesWithEmbedding } from "./memory";
import type {
  ActionStatus,
  ActionCandidate,
  ActionEnvelope,
  ActionType,
  AgentAction,
  AppState,
  Artifact,
  ArtifactKind,
  ContextPacket,
  EventActor,
  EventRecord,
  EventType,
  Experiment,
  Experience,
  Evidence,
  HumanItem,
  HumanItemKind,
  HumanItemStatus,
  Intent,
  Observation,
  Policy,
  Relation,
  RelationType,
  ResourceLedger,
  RetrievalIndexEntry,
  Project,
  ProjectSettings,
  RiskClass,
  RuntimePhase,
  RuntimeStatus,
  Run,
  WorldSnapshot,
  WorldSource,
  WorldSourceKey,
  ToolCapability,
} from "./types";

export const nowIso = () => new Date().toISOString();

export const RUNTIME_SCHEMA_VERSION = 1 as const;
export const MODEL_VERSION = "local-deterministic-0.1";
export const TOOL_VERSION = "local-tool-gateway-0.1";
export const POLICY_VERSION = 1;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type ExperimentInput = Pick<Experiment, "key" | "title" | "hypothesis" | "description" | "variant"> & Partial<Pick<Experiment, "benchmark" | "budgetLimit" | "hiddenCriteria" | "evaluatorRefs" | "variantConfig">>;
export type HumanAction = "answer" | "approve" | "reject" | "defer" | "acknowledge";

const humanActionNames: HumanAction[] = ["answer", "approve", "reject", "defer", "acknowledge"];

function positiveSetting(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function nonNegativeSetting(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : fallback;
}

function nextLease(project: Project, at = Date.now()): string {
  return new Date(at + positiveSetting(project.settings.maxHours, 12, 168) * 60 * 60 * 1000).toISOString();
}

function sanitizeActionEnvelope(action: ActionEnvelope): ActionEnvelope {
  const params = action.params
    ? Object.fromEntries(Object.entries(action.params).map(([key, value]) => [key,
      typeof value === "string" ? redactSecretLikeText(value).slice(0, 256_000)
        : Array.isArray(value) ? value.map((item) => redactSecretLikeText(item).slice(0, 2_000))
          : value]))
    : undefined;
  return {
    ...action,
    rationaleSummary: redactSecretLikeText(action.rationaleSummary).trim().slice(0, 4_000),
    params,
    evidencePlan: action.evidencePlan?.map((item) => redactSecretLikeText(item).slice(0, 256)),
  };
}

function sanitizeEvidence(evidence: Evidence, projectId: string, actionId: string, createdAt: string): Evidence {
  return {
    ...evidence,
    projectId,
    // A tool result belongs to the dispatch currently being verified. Never
    // let a provider-supplied actionId create a false cross-run lineage.
    actionId,
    summary: redactSecretLikeText(evidence.summary).slice(0, 4_000),
    source: redactSecretLikeText(evidence.source).slice(0, 1_000),
    rawRef: evidence.rawRef ? redactSecretLikeText(evidence.rawRef).slice(0, 2_000) : undefined,
    createdAt: evidence.createdAt || createdAt,
    metadata: evidence.metadata ? Object.fromEntries(Object.entries(evidence.metadata).map(([key, value]) => [key, typeof value === "string" ? redactSecretLikeText(value).slice(0, 1_000) : value])) : undefined,
  };
}

function modelUsagePayload(modelUsage?: ModelUsage): EventRecord["payload"] | undefined {
  if (!modelUsage) return undefined;
  const payload: NonNullable<EventRecord["payload"]> = {
    modelVersion: redactSecretLikeText(modelUsage.modelVersion).slice(0, 256),
    tokens: Number.isFinite(modelUsage.tokens) ? Math.max(0, modelUsage.tokens) : 0,
    cost: Number.isFinite(modelUsage.cost) ? Math.max(0, modelUsage.cost) : 0,
    latencyMs: Number.isFinite(modelUsage.latencyMs) ? Math.max(0, modelUsage.latencyMs) : 0,
    usageKnown: modelUsage.usageKnown === true,
  };
  if (modelUsage.inputTokens !== undefined && Number.isFinite(modelUsage.inputTokens)) payload.inputTokens = Math.max(0, modelUsage.inputTokens);
  if (modelUsage.outputTokens !== undefined && Number.isFinite(modelUsage.outputTokens)) payload.outputTokens = Math.max(0, modelUsage.outputTokens);
  if (modelUsage.rawRef) payload.rawRef = redactSecretLikeText(modelUsage.rawRef).slice(0, 2_000);
  if (modelUsage.requestId) payload.requestId = redactSecretLikeText(modelUsage.requestId).slice(0, 256);
  return payload;
}

export interface RuntimeCycleInput {
  observations?: Observation[];
  action?: ActionEnvelope;
  toolResult?: ToolResult;
  evaluation?: EvaluatorResult;
  modelUsage?: ModelUsage;
  /** The exact model-facing packet used for this dispatch, including remote retrieval when configured. */
  context?: ContextPacket;
  /** Internal executor only: approval and boundary were durably checked before dispatch. */
  dispatchAuthorized?: boolean;
}

export function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function getProject(state: AppState, projectId = state.activeProjectId): Project | undefined {
  return state.projects.find((project) => project.id === projectId);
}

export function getIntent(state: AppState, projectId: string): Intent | undefined {
  const project = getProject(state, projectId);
  return project ? state.intents.find((intent) => intent.id === project.intentId) : undefined;
}

export function getRun(state: AppState, projectId: string): Run | undefined {
  const project = getProject(state, projectId);
  return project ? state.runs.find((run) => run.id === project.activeRunId) : undefined;
}

export function getWorldSnapshot(state: AppState, projectId: string): WorldSnapshot | undefined {
  return state.worldSnapshots
    .filter((snapshot) => snapshot.projectId === projectId && !snapshot.superseded).at(-1);
}

export function getProjectObservations(state: AppState, projectId: string): Observation[] {
  return state.observations
    .filter((observation) => observation.projectId === projectId)
    .reverse().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

export function getProjectContexts(state: AppState, projectId: string): ContextPacket[] {
  return state.contexts
    .filter((context) => context.projectId === projectId)
    .reverse().sort((a, b) => Date.parse(b.assembledAt) - Date.parse(a.assembledAt));
}

export function getActivePolicy(state: AppState, projectId: string): Policy | undefined {
  return state.policies
    .filter((policy) => policy.projectId === projectId && policy.status === "active")
    .sort((a, b) => b.version - a.version)[0];
}

export function getResourceLedger(state: AppState, projectId: string, runId = getRun(state, projectId)?.id): ResourceLedger | undefined {
  return state.resourceLedger
    .filter((ledger) => ledger.projectId === projectId && (!runId || ledger.runId === runId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id))[0];
}

export function getProjectRelations(state: AppState, projectId: string): Relation[] {
  return state.relations.filter((relation) => relation.projectId === projectId);
}

export function getProjectRetrievalEntries(state: AppState, projectId: string): RetrievalIndexEntry[] {
  return state.retrievalIndex
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => b.recency - a.recency || b.outcomeQuality - a.outcomeQuality);
}

export function getMatchingApprovalGrant(state: AppState, projectId: string, action: ActionEnvelope, at = Date.now()): import("./types").ApprovalGrant | undefined {
  return state.approvalGrants
    .filter((grant) => grant.projectId === projectId && grant.singleUse && !grant.consumedAt && Date.parse(grant.expiresAt) > at && grant.tool === action.tool && grant.actionFingerprint === actionFingerprint(action) && grant.paramsFingerprint === paramsFingerprint(action) && grant.paramsCanonical === canonicalActionParams(action) && grant.intentRef === action.intentRef)
    .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt) || right.id.localeCompare(left.id))[0];
}

export function getProjectEvents(state: AppState, projectId: string): EventRecord[] {
  return state.events
    .filter((event) => event.projectId === projectId)
    .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1) || b.createdAt.localeCompare(a.createdAt));
}

export function getProjectHumanItems(state: AppState, projectId: string): HumanItem[] {
  return state.humanItems
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id));
}

export function modelProviderLabel(state: AppState, project: Project): string {
  const latest = state.actions
    .filter((action) => action.projectId === project.id)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id))[0];
  if (latest?.modelVersion.startsWith("openai-compatible:")) return latest.modelVersion;
  if (latest?.modelVersion.startsWith("codex-app-server:")) return latest.modelVersion;
  if (latest?.modelVersion.startsWith("codex-cli:")) return latest.modelVersion;
  if (latest?.modelVersion === "unavailable") return "사용할 수 없음";
  if (latest?.modelVersion === MODEL_VERSION || project.settings.modelProvider === "deterministic") return "결정론적 기준선";
  if (project.settings.modelProvider === "codex-cli") return "Codex CLI · 아직 실행 전";
  if (project.settings.modelProvider === "openai-compatible") return "OpenAI 호환 API · 아직 실행 전";
  if (project.settings.modelProvider === "auto") return "자동 선택 · 아직 실행 전";
  return `${project.settings.modelProvider ?? "auto"} · 아직 확인되지 않음`;
}

export function isOpenHumanItem(item: HumanItem): boolean {
  return item.status === "OPEN" || item.status === "DEFERRED";
}

export const isHumanItemActionable = isOpenHumanItem;

export function getOpenHumanItems(state: AppState, projectId: string): HumanItem[] {
  return getProjectHumanItems(state, projectId).filter(isOpenHumanItem);
}

export function getActionableHumanItems(state: AppState, projectId: string): HumanItem[] {
  return getOpenHumanItems(state, projectId);
}

export function getHumanCounts(state: AppState, projectId: string): Record<HumanItemKind, number> {
  const counts: Record<HumanItemKind, number> = { QUESTION: 0, IDEA: 0, CONCERN: 0, APPROVAL: 0 };
  for (const item of getOpenHumanItems(state, projectId)) counts[item.kind] += 1;
  return counts;
}

function replaceById<T extends { id: string }>(items: T[], replacement: T): T[] {
  return items.map((item) => (item.id === replacement.id ? replacement : item));
}

function appendEvent(
  state: AppState,
  input: Omit<EventRecord, "id" | "schemaVersion"> & { id?: string },
): AppState {
  const record: EventRecord = {
    id: input.id ?? makeId("event"),
    sequence: state.events.reduce((max, event) => Math.max(max, event.sequence ?? -1), -1) + 1,
    ...input,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    modelVersion: input.modelVersion ?? MODEL_VERSION,
    toolVersion: input.toolVersion ?? TOOL_VERSION,
    policyVersion: input.policyVersion ?? POLICY_VERSION,
  };
  return { ...state, events: [...state.events, record] };
}

function updateProject(state: AppState, project: Project): AppState {
  return { ...state, projects: replaceById(state.projects, project) };
}

export function isProviderUnavailableReason(reason: string | undefined): boolean {
  return typeof reason === "string" && /(?:model gateway unavailable|모델 게이트웨이를 사용할 수 없습니다)/i.test(reason);
}

/**
 * A provider failure from an older runtime must not strand a project forever.
 * Preserve the failed action and evidence, but reopen only this transient
 * failure state so the worker can retry with the current gateway protocol.
 */
export function recoverTransientProviderFailures(state: AppState): AppState {
  let next = state;
  for (const project of state.projects) {
    const run = getRun(next, project.id);
    if (project.status !== "STALLED" || !run || run.status !== "STALLED" || run.consecutiveFailures !== 0 || run.lastFailureSignature || !isProviderUnavailableReason(run.stopReason)) continue;
    const updatedAt = nowIso();
    next = updateProject(next, { ...project, status: "ACTIVE", updatedAt, nextReviewAt: undefined });
    next = updateRun(next, {
      ...run,
      status: "ACTIVE",
      phase: "wake",
      consecutiveFailures: 0,
      noProgressCycles: 0,
      lastFailureSignature: undefined,
      stopReason: undefined,
      leaseExpiresAt: nextLease(project, Date.parse(updatedAt)),
    });
    next = appendEvent(next, {
      projectId: project.id,
      type: "RUN_STATE_CHANGED",
      actor: "system",
      summary: "ACTIVE · provider failure recovery",
      detail: "이전 모델 게이트웨이 실패 상태를 보존한 채 현재 Gateway 프로토콜로 재시도합니다.",
      runId: run.id,
      createdAt: updatedAt,
    });
    next = appendEvent(next, {
      projectId: project.id,
      type: "WAKE_TRIGGERED",
      actor: "system",
      summary: "wake · provider failure recovery",
      detail: "프로젝트 재시작 없이 일시적인 provider 실패를 다시 관찰합니다.",
      runId: run.id,
      createdAt: updatedAt,
      payload: { trigger: "provider-recovery" },
    });
  }
  return next;
}

export function updateProjectModelSettings(
  state: AppState,
  projectId: string,
  settings: Pick<ProjectSettings, "modelProvider" | "modelName">,
): AppState {
  const project = getProject(state, projectId);
  if (!project) return state;
  const run = getRun(state, projectId);
  const shouldRetryProvider = project.status === "STALLED" && run?.consecutiveFailures === 0 && !run.lastFailureSignature && isProviderUnavailableReason(run.stopReason);
  const modelProvider = settings.modelProvider ?? project.settings.modelProvider ?? "auto";
  if (!(["auto", "deterministic", "openai-compatible", "codex-cli"] as const).includes(modelProvider)) return state;
  const modelName = typeof settings.modelName === "string" ? settings.modelName.trim() || undefined : undefined;
  if (modelName && !modelIdPattern.test(modelName)) return state;
  if (project.settings.modelProvider === modelProvider && project.settings.modelName === modelName) return shouldRetryProvider ? recoverTransientProviderFailures(state) : state;
  const updatedAt = nowIso();
  let next = updateProject(state, {
    ...project,
    settings: { ...project.settings, modelProvider, modelName },
    updatedAt,
  });
  if (project.status === "EQUILIBRIUM") next = setRuntimeStatus(next, projectId, "ACTIVE", "wake", "모델 설정 변경으로 runtime을 다시 시작", "human");
  if (shouldRetryProvider) next = recoverTransientProviderFailures(next);
  const updatedRun = getRun(next, projectId);
  return appendEvent(next, {
    projectId,
    type: "POLICY_CHANGED",
    actor: "human",
    summary: "모델 설정 변경",
    detail: `${modelProvider}${modelName ? ` · ${modelName}` : " · provider 기본 모델"}`,
    runId: updatedRun?.id,
    createdAt: updatedAt,
  });
}

export function deleteProject(state: AppState, projectId: string): AppState {
  if (!state.projects.some((project) => project.id === projectId)) return state;
  const belongsToProject = <T extends { projectId: string }>(items: T[]) => items.filter((item) => item.projectId !== projectId);
  const remainingProjects = state.projects.filter((project) => project.id !== projectId);
  const activeProjectId = state.activeProjectId === projectId ? remainingProjects[0]?.id ?? "" : state.activeProjectId;
  return {
    ...state,
    activeProjectId,
    projects: remainingProjects,
    intents: belongsToProject(state.intents),
    runs: belongsToProject(state.runs),
    actions: belongsToProject(state.actions),
    worldSnapshots: belongsToProject(state.worldSnapshots),
    observations: belongsToProject(state.observations),
    contexts: belongsToProject(state.contexts),
    events: belongsToProject(state.events),
    evidence: belongsToProject(state.evidence),
    humanItems: belongsToProject(state.humanItems),
    artifacts: belongsToProject(state.artifacts),
    experiences: belongsToProject(state.experiences),
    policies: belongsToProject(state.policies),
    resourceLedger: belongsToProject(state.resourceLedger),
    relations: belongsToProject(state.relations),
    retrievalIndex: belongsToProject(state.retrievalIndex),
    experiments: belongsToProject(state.experiments),
    approvalGrants: belongsToProject(state.approvalGrants),
    processes: belongsToProject(state.processes),
  };
}

function updateRun(state: AppState, run: Run): AppState {
  return { ...state, runs: replaceById(state.runs, run) };
}

function withWorldSnapshot(state: AppState, snapshot: WorldSnapshot): AppState {
  const remaining = state.worldSnapshots.filter((candidate) => candidate.id !== snapshot.id);
  return { ...state, worldSnapshots: [...remaining, snapshot] };
}

function moveWorldCursor(state: AppState, projectId: string, cursorEventId: string, observedAt = nowIso()): AppState {
  const snapshot = getWorldSnapshot(state, projectId);
  return snapshot ? withWorldSnapshot(state, { ...snapshot, cursorEventId, observedAt }) : state;
}

function refreshHumanWorld(state: AppState, projectId: string, observedAt: string): AppState {
  const snapshot = getWorldSnapshot(state, projectId);
  if (!snapshot) return state;
  const openCount = getOpenHumanItems(state, projectId).length;
  return withWorldSnapshot(state, {
    ...snapshot,
    observedAt,
    sources: {
      ...snapshot.sources,
      human: {
        ...snapshot.sources.human,
        observedAt,
        summary: openCount ? `${openCount} open item${openCount > 1 ? "s" : ""}` : "all decisions resolved",
        status: openCount ? "warning" : "healthy",
        freshness: "fresh",
        trustLevel: "verified",
      },
    },
  });
}

function activeIncidentRefs(state: AppState, projectId: string): string[] {
  const projectEvents = state.events
    .filter((event) => event.projectId === projectId)
    .sort((a, b) => (a.sequence ?? -1) - (b.sequence ?? -1));
  const active = new Set<string>();
  for (const event of projectEvents) {
    if (event.type === "RUNTIME_ERROR") active.add(event.id);
    if (event.type === "EVIDENCE_RECORDED" && event.evidenceIds?.some((evidenceId) => state.evidence.find((item) => item.id === evidenceId)?.verdict === "PASS")) {
      const successful = state.actions.find((item) => item.id === event.actionId);
      for (const id of active) {
        const incident = projectEvents.find((item) => item.id === id);
        const failed = state.actions.find((item) => item.id === incident?.actionId);
        if (successful?.tool && failed?.tool === successful.tool && canonicalActionParams(failed) === canonicalActionParams(successful)) active.delete(id);
      }
    }
  }
  return [...active].slice(-8);
}

/**
 * Commits fresh adapter observations without pretending that a summary is the
 * authoritative environment state. The event that caused the observation is
 * attached later by the runtime cycle, while raw observation references remain
 * queryable beside the persisted snapshot.
 */
export function applyObservedWorld(state: AppState, projectId: string, observations: Observation[]): AppState {
  const snapshot = getWorldSnapshot(state, projectId);
  if (!snapshot || !observations.length) return state;
  const relevant = observations.filter((item) => item.projectId === projectId && worldSourceKeys.includes(item.source as WorldSourceKey));
  if (!relevant.length) return state;
  const latest = relevant.reduce((current, item) => item.observedAt > current ? item.observedAt : current, snapshot.observedAt);
  const sources = { ...snapshot.sources };
  for (const item of relevant) {
    const key = item.source as WorldSourceKey;
    sources[key] = {
      ...sources[key],
      observedAt: item.observedAt,
      summary: item.compactView,
      status: item.status,
      freshness: item.freshness,
      trustLevel: item.trustLevel,
      relatedEntities: item.relatedEntities,
    };
  }
  const updated: WorldSnapshot = {
    ...snapshot,
    id: makeId("world"),
    observedAt: latest,
    summary: "Direct source observations refreshed; snapshot state and raw references remain linked to the event journal.",
    sources,
  };
  return {
    ...withWorldSnapshot(state, updated),
    observations: [...state.observations, ...relevant],
  };
}

export function recordObservedWorldRefresh(state: AppState, projectId: string, observations: Observation[]): AppState {
  if (!observations.length) return state;
  let next = applyObservedWorld(state, projectId, observations);
  const createdAt = nowIso();
  next = appendEvent(next, {
    projectId,
    type: "OBSERVATION_REFRESHED",
    actor: "agent",
    summary: "Direct world adapters refreshed",
    detail: observations.map((observation) => `${observation.source}:${observation.rawRef}`).join(" · "),
    payload: { observationRefs: observations.map((observation) => observation.id) },
    createdAt,
  });
  const snapshot = getWorldSnapshot(next, projectId);
  if (!snapshot) return next;
  const cursorEventId = next.events.at(-1)?.id ?? snapshot.cursorEventId;
  next = withWorldSnapshot(next, { ...snapshot, cursorEventId, observedAt: createdAt });
  next = appendEvent(next, {
    projectId,
    type: "WORLD_CHANGED",
    actor: "system",
    summary: "World Snapshot updated from direct observations",
    detail: `cursor=${cursorEventId}`,
    createdAt,
  });
  return moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? cursorEventId, createdAt);
}

export function observationsFromSnapshot(snapshot: WorldSnapshot, idPrefix = "observation"): Observation[] {
  return worldSourceKeys.map((key) => {
    const worldSource = snapshot.sources[key];
    return {
      id: `${idPrefix}-${key}`,
      projectId: snapshot.projectId,
      source: key,
      status: worldSource.status,
      observedAt: worldSource.observedAt,
      freshness: worldSource.freshness,
      rawRef: `world://${snapshot.id}/${key}`,
      compactView: worldSource.summary,
      trustLevel: worldSource.trustLevel,
      confidence: worldSource.trustLevel === "verified" ? 0.98 : worldSource.trustLevel === "observed" ? 0.82 : 0.4,
      relatedEntities: worldSource.relatedEntities,
    };
  });
}

export function getToolSurface(project: Project): ToolCapability[] {
  return withInputSchemas([
    { name: "repo.read", description: "실제 workspace의 git status와 diff를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: true, toolVersion: TOOL_VERSION },
    { name: "workspace.list", description: "workspace 내부의 bounded file tree를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "workspace.read", description: "workspace 내부 text file을 line range로 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "workspace.write", description: "workspace 안에 atomic하게 새 파일을 만들거나 명시적으로 덮어씁니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "workspace.patch", description: "검증된 unified patch를 원자적으로 적용합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "workspace.delete", description: "workspace 안의 파일을 backup/ref와 함께 삭제합니다.", riskClass: "P2", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "dependency.install", description: "감지된 Node package manager로 install script 없이 dependency를 설치합니다.", riskClass: "P1", reversible: true, requiresNetwork: true, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "shell.sandbox", description: "격리 workspace에서 명령을 실행합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "browser.playwright", description: "브라우저와 DOM을 관찰·검증합니다.", riskClass: "P1", reversible: true, requiresNetwork: true, sideEffect: false, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "process.start", description: "workspace에 귀속된 managed developer process를 시작합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "process.status", description: "managed process의 실제 lifecycle 상태를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "process.stop", description: "workspace/run에 귀속된 managed process를 종료합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "database.read", description: "연결된 DB 상태를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: true, toolVersion: TOOL_VERSION },
    { name: "deploy.production", description: "production side effect를 실행합니다.", riskClass: "P3", reversible: false, requiresNetwork: true, sideEffect: true, enabled: !project.settings.productionBlocked, toolVersion: TOOL_VERSION },
  ]);
}

export function assembleContext(state: AppState, projectId: string, assembledAt = nowIso()): ContextPacket | undefined {
  const project = getProject(state, projectId);
  const intent = getIntent(state, projectId);
  const run = getRun(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !intent || !run || !world) return undefined;
  const policy = getActivePolicy(state, projectId);
  const openItems = getOpenHumanItems(state, projectId);
  const observations = getProjectObservations(state, projectId).slice(0, 18);
  const recentActions = state.actions.filter((action) => action.projectId === projectId).reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 8);
  const recentEvidence = state.evidence.filter((item) => item.projectId === projectId).reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12);
  const activeGrants = state.approvalGrants.filter((grant) => grant.projectId === projectId && !grant.consumedAt && Date.parse(grant.expiresAt) > Date.now());
  const activeProcesses = state.processes.filter((process) => process.projectId === projectId && process.runId === run.id && (process.status === "starting" || process.status === "running")).slice(0, 16);
  const policyCandidates = state.policies.filter((candidate) => candidate.projectId === projectId && candidate.status === "candidate").sort((left, right) => right.version - left.version).slice(0, 8);
  const preliminary: ContextPacket = {
    id: makeId("context"),
    projectId,
    intentRef: intent.id,
    worldCursor: world.cursorEventId,
    // The immutable Intent remains available in the project record. Context
    // sent to a model is the redacted projection so a human accidentally
    // pasting a credential does not cross the model boundary.
    rawIntent: redactSecretLikeText(intent.rawText),
    constraints: intent.constraints.map((constraint) => redactSecretLikeText(constraint)),
    observationRefs: observations.map((observation) => observation.id),
    openHumanItemRefs: openItems.map((item) => item.id),
    experienceRefs: [],
    runId: run.id,
    observationViews: observations.map((observation) => ({
      id: observation.id,
      source: observation.source,
      status: observation.status,
      observedAt: observation.observedAt,
      freshness: observation.freshness,
      rawRef: observation.rawRef,
      compactView: redactSecretLikeText(observation.compactView),
      trustLevel: observation.trustLevel,
      confidence: observation.confidence,
      relatedEntities: [...observation.relatedEntities],
    })),
    openHumanItemViews: openItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: redactSecretLikeText(item.title),
      summary: redactSecretLikeText(item.summary),
      blockingScope: [...item.blockingScope],
      continuingScope: [...item.continuingScope],
    })),
    relevantExperienceViews: [],
    humanDecisionViews: getProjectHumanItems(state, projectId).filter((item) => !isOpenHumanItem(item)).slice(0, 32).map((item) => ({ id: item.id, kind: item.kind, status: item.status, title: redactSecretLikeText(item.title), answer: item.answerLabel ?? item.answer, updatedAt: item.updatedAt, blockingScope: item.blockingScope })),
    lastModelFailure: run.lastModelFailure,
    recentActionViews: recentActions.map((action) => ({
      id: action.id,
      type: action.type,
      status: action.status,
      tool: action.tool,
      params: action.params ? Object.fromEntries(Object.entries(action.params).map(([key, value]) => [key, typeof value === "string" && value.length > 8_000 ? `${value.slice(0, 8_000)}\n[이전 행동 입력 생략: 원본 파일은 workspace.read로 다시 확인]` : value])) : undefined,
      rationaleSummary: redactSecretLikeText(action.rationaleSummary),
      intentRef: action.intentRef,
      worldCursor: action.worldCursor,
      approvalGrantId: action.approvalGrantId,
      createdAt: action.createdAt,
    })),
    recentEvidenceViews: recentEvidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      verdict: item.verdict,
      summary: redactSecretLikeText(item.summary),
      source: redactSecretLikeText(item.source),
      actionId: item.actionId,
      rawRef: item.rawRef,
      createdAt: item.createdAt,
    })),
    activeApprovalGrantViews: activeGrants.map((grant) => ({ id: grant.id, actionFingerprint: grant.actionFingerprint, tool: grant.tool, expiresAt: grant.expiresAt })),
    activeProcessViews: activeProcesses.map((process) => ({ id: process.id, argv: [...process.argv], status: process.status, pid: process.pid, port: process.port, previewUrl: process.previewUrl, stdoutRawRef: process.stdoutRawRef, stderrRawRef: process.stderrRawRef })),
    activeIncidentRefs: activeIncidentRefs(state, projectId),
    boundary: {
      remainingBudget: Math.max(0, Number((project.settings.budgetLimit - project.budgetSpent).toFixed(2))),
      maxHours: project.settings.maxHours,
      remainingModelCalls: Math.max(0, (project.settings.maxModelCalls ?? 200) - state.events.filter((event) => event.runId === run.id && (event.type === "MODEL_TURN" || event.type === "MODEL_FAILED")).length),
      networkPolicy: project.settings.networkPolicy,
      productionBlocked: project.settings.productionBlocked,
      openApprovalRefs: openItems.filter((item) => item.kind === "APPROVAL").map((item) => item.id),
    },
    toolSurface: getToolSurface(project),
    assembledAt,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    policyVersion: policy?.version ?? POLICY_VERSION,
    policyCandidateViews: policyCandidates.map((candidate) => ({ id: candidate.id, version: candidate.version, representation: redactSecretLikeText(candidate.representation), parentPolicyId: candidate.parentPolicyId, evalRefs: [...candidate.evalRefs], createdAt: candidate.createdAt })),
    untrustedObservationRefs: observations.filter((observation) => observation.trustLevel === "untrusted" || observation.source === "browser" || observation.source === "shell" || observation.source === "logs").map((observation) => observation.id),
  };
  const experiences = retrieveRelevantExperiences(state, projectId, preliminary, 8);
  return { ...preliminary, experienceRefs: experiences.map((experience) => experience.id), relevantExperienceViews: experiences.map((experience) => ({
    id: experience.id,
    situation: redactSecretLikeText(experience.situation),
    decision: redactSecretLikeText(experience.decision),
    action: redactSecretLikeText(experience.action),
    outcome: redactSecretLikeText(experience.outcome),
    evidenceIds: [...experience.evidenceIds],
    risk: experience.risk,
    createdAt: experience.createdAt,
  })) };
}

/**
 * Server-side context assembly can use a configured embedding provider without
 * making the pure/browser reducer asynchronous. A provider outage falls back
 * to the rebuildable lexical/local-vector index for the same cycle.
 */
export async function assembleContextAsync(state: AppState, projectId: string, assembledAt = nowIso()): Promise<ContextPacket | undefined> {
  const fallback = assembleContext(state, projectId, assembledAt);
  const provider = createConfiguredEmbeddingProvider();
  if (!fallback || !provider) return fallback;
  try {
    const experiences = await retrieveRelevantExperiencesWithEmbedding(state, projectId, fallback, provider, 8);
    return {
      ...fallback,
      experienceRefs: experiences.map((experience) => experience.id),
      relevantExperienceViews: experiences.map((experience) => ({
        id: experience.id,
        situation: redactSecretLikeText(experience.situation),
        decision: redactSecretLikeText(experience.decision),
        action: redactSecretLikeText(experience.action),
        outcome: redactSecretLikeText(experience.outcome),
        evidenceIds: [...experience.evidenceIds],
        risk: experience.risk,
        createdAt: experience.createdAt,
      })),
    };
  } catch {
    return fallback;
  }
}

export function selectActionCandidates(state: AppState, projectId: string, context: ContextPacket): ActionCandidate[] {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return [];
  const hasOpenQuestion = context.openHumanItemRefs.some((itemId) => state.humanItems.find((item) => item.id === itemId)?.kind === "QUESTION");
  const latestEvidence = context.recentEvidenceViews?.[0];
  const hasGap = !latestEvidence || latestEvidence.verdict !== "PASS" || context.observationViews?.some((item) => item.status !== "healthy") === true;
  const executable = context.toolSurface.find((tool) => tool.enabled && ["workspace.list", "workspace.read", "repo.read", "shell.sandbox", "browser.playwright"].includes(tool.name));
  const gapScore = hasGap ? 0.78 : 0.12;
  const informationScore = context.observationViews?.length ? 0.32 : 0.72;
  const closure: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "ACT",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: hasGap ? "현재 World의 gap을 실제 capability로 관찰하고 evidence를 확보" : "현재 evidence와 boundary를 다시 확인해 다음 유용한 변화를 판단",
    tool: executable?.name,
    params: executable?.name === "workspace.list" ? { depth: 3, maxEntries: 200 } : executable?.name === "repo.read" ? { commandId: "repo-status" } : undefined,
    expectedValue: Number(Math.max(0, Math.min(1, gapScore)).toFixed(2)),
    riskClass: executable?.riskClass ?? "P0",
    evidencePlan: ["world", "test"],
    force: "closure",
    score: { goalGap: gapScore, informationGain: informationScore, evidenceGain: hasGap ? 0.68 : 0.18, cost: executable ? 0.08 : 0, risk: executable?.riskClass === "P1" ? 0.08 : 0, total: gapScore + informationScore + (hasGap ? 0.68 : 0.18) - (executable ? 0.08 : 0) },
    sourceRefs: context.observationRefs.slice(0, 3),
  };
  const discovery: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "IDEA",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: "현재 Intent 밖의 선택적 개선 가능성을 human에게 비동기로 제안",
    expectedValue: 0.24,
    riskClass: "P0",
    evidencePlan: ["world", "human"],
    force: "discovery",
    score: { goalGap: 0.25, informationGain: 0.62, evidenceGain: 0.3, cost: 0.14, risk: 0.05, total: 0.98 },
    sourceRefs: context.observationRefs.slice(0, 2),
  };
  const question: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "QUESTION",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: "현재 관찰만으로 결정할 수 없는 인간의 선호 또는 business value를 확인",
    expectedValue: 0.52,
    riskClass: "P2",
    evidencePlan: ["human"],
    force: "boundary",
    score: { goalGap: hasOpenQuestion ? 0.42 : 0.12, informationGain: hasOpenQuestion ? 0.7 : 0.2, evidenceGain: 0.25, cost: 0.03, risk: 0.04, total: hasOpenQuestion ? 0.64 : 0.5 },
    sourceRefs: hasOpenQuestion ? context.openHumanItemRefs : [],
  };
  const wait: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "WAIT",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: "현재 evidence와 boundary를 기준으로 즉시 가치 있는 action이 없음",
    force: "wait",
    score: { goalGap: 0.05, informationGain: 0.08, evidenceGain: 0.04, cost: 0, risk: 0, total: 0.17 },
    sourceRefs: [],
  };
  return [closure, question, discovery, wait].sort((a, b) => b.score.total - a.score.total);
}

export function selectNextAction(state: AppState, projectId: string, context: ContextPacket): ActionCandidate | undefined {
  const candidates = selectActionCandidates(state, projectId, context);
  return candidates[0];
}

function source(
  key: WorldSourceKey,
  label: string,
  summary: string,
  observedAt: string,
  status: WorldSource["status"] = "healthy",
  trustLevel: WorldSource["trustLevel"] = "observed",
): WorldSource {
  return {
    key,
    label,
    summary,
    observedAt,
    status,
    freshness: "fresh",
    trustLevel,
    relatedEntities: [],
  };
}

function newWorldSnapshot(projectId: string, observedAt: string): WorldSnapshot {
  return {
    id: makeId("world"),
    projectId,
    cursorEventId: "pending",
    observedAt,
    summary: "새 프로젝트 작업공간을 연결하는 중입니다. 직접 관찰 결과가 들어오면 월드 스냅샷이 갱신됩니다.",
    sources: {
      repo: source("repo", "저장소", "작업공간의 첫 직접 관찰을 기다리는 중", observedAt, "warning"),
      runtime: source("runtime", "런타임", "아직 시작되지 않음", observedAt, "warning"),
      browser: source("browser", "브라우저", "첫 관찰을 기다리는 중", observedAt, "warning"),
      db: source("db", "데이터베이스", "연결되지 않음", observedAt, "warning"),
      logs: source("logs", "로그", "아직 이벤트가 없음", observedAt),
      human: source("human", "사람", "아직 결정이 없음", observedAt),
    },
  };
}

function deriveProjectName(rawIntent: string): { name: string; subtitle: string } {
  const firstSentence = rawIntent.split(/[.!?\n]/)[0]?.trim() || "새 의도";
  return {
    name: firstSentence.length > 24 ? `${firstSentence.slice(0, 24)}…` : firstSentence,
    subtitle: "의도에서 시작한 새로운 월드",
  };
}

export function createProject(
  state: AppState,
  rawIntent: string,
  projectId = makeId("project"),
  settings: Partial<ProjectSettings> = {},
): AppState {
  if (!rawIntent.trim() || state.projects.some((candidate) => candidate.id === projectId)) return state;
  const createdAt = nowIso();
  const intentId = makeId("intent");
  const runId = makeId("run");
  const world = newWorldSnapshot(projectId, createdAt);
  const identity = deriveProjectName(rawIntent);
  const project: Project = {
    id: projectId,
    name: identity.name,
    subtitle: identity.subtitle,
    status: "ACTIVE",
    intentId,
    activeRunId: runId,
    createdAt,
    updatedAt: createdAt,
    budgetSpent: 0,
    settings: {
      budgetLimit: positiveSetting(settings.budgetLimit, 30, 1_000_000),
      maxHours: positiveSetting(settings.maxHours, 12, 168),
      maxModelCalls: positiveSetting(settings.maxModelCalls, 200, 10_000),
      localActions: settings.localActions ?? true,
      requireExternalApproval: settings.requireExternalApproval ?? true,
      productionBlocked: settings.productionBlocked ?? true,
      networkPolicy: settings.networkPolicy ?? "allowlist",
      workspacePath: settings.workspacePath,
      previewUrl: settings.previewUrl,
      // Local preview verification is part of the normal greenfield path.
      // Loopback hosts are explicit, bounded entries; external hosts still
      // require a project-provided allowlist entry.
      allowedDomains: [...new Set([...(settings.allowedDomains ?? []), "registry.npmjs.org", "localhost", "127.0.0.1"])],
      sandboxMode: settings.sandboxMode ?? "process",
      executionMode: settings.executionMode ?? "atomic",
      maxNativeTurns: positiveSetting(settings.maxNativeTurns, 40, 1000),
      maxNativeTokens: positiveSetting(settings.maxNativeTokens, 250000, 10000000),
      nativeTurnTimeoutMs: positiveSetting(settings.nativeTurnTimeoutMs, 300000, 540000),
      modelProvider: settings.modelProvider ?? "auto",
      modelName: settings.modelName?.trim() || undefined,
      reviewIntervalMinutes: positiveSetting(settings.reviewIntervalMinutes, 360, 10_080),
      failureThreshold: positiveSetting(settings.failureThreshold, 3, 32),
      noProgressThreshold: positiveSetting(settings.noProgressThreshold, 5, 128),
      cycleDelayMs: nonNegativeSetting(settings.cycleDelayMs, 250, 60_000),
      approvalTtlMinutes: positiveSetting(settings.approvalTtlMinutes, 60, 10_080),
      processMaxLifetimeMs: positiveSetting(settings.processMaxLifetimeMs, 1_800_000, 86_400_000),
      maxConcurrentProcesses: positiveSetting(settings.maxConcurrentProcesses, 4, 32),
    },
    metrics: {
      testsPassed: 0,
      testsTotal: 0,
      evidenceCoverage: 0,
      humanOrchestrationCount: 0,
      initiativeRecall: 0,
      initiativePrecision: 0,
    },
  };
  const intent: Intent = {
    id: intentId,
    projectId,
    rawText: rawIntent.trim(),
    constraints: [
      "로컬·샌드박스 안에서는 자유롭게 행동",
      "외부 배포 · 결제 · 파괴적 작업은 승인 필요",
    ],
    version: 1,
    createdAt,
  };
  const run: Run = {
    id: runId,
    projectId,
    status: "ACTIVE",
    phase: "wake",
    cycleCount: 0,
    startedAt: createdAt,
    lastCycleAt: createdAt,
    leaseExpiresAt: nextLease(project),
    consecutiveFailures: 0,
    noProgressCycles: 0,
    activeProcessIds: [],
  };
  const policy: Policy = {
    id: makeId("policy"),
    projectId,
    version: POLICY_VERSION,
    representation: "hard constraints → risk → required gap → information gain → opportunity → WAIT",
    status: "active",
    evalRefs: [],
    createdAt,
  };
  const ledger: ResourceLedger = {
    id: makeId("ledger"),
    projectId,
    runId,
    tokens: 0,
    modelCost: 0,
    wallTimeMs: 0,
    toolCalls: 0,
    sandboxSeconds: 0,
    budgetLimit: project.settings.budgetLimit,
    updatedAt: createdAt,
  };

  let next: AppState = {
    ...state,
    activeProjectId: projectId,
    projects: [...state.projects, project],
    intents: [...state.intents, intent],
    runs: [...state.runs, run],
    worldSnapshots: [...state.worldSnapshots, world],
    observations: [...state.observations, ...observationsFromSnapshot(world, `${projectId}-observation`)],
    contexts: [...state.contexts],
    policies: [...state.policies, policy],
    resourceLedger: [...state.resourceLedger, ledger],
    relations: [...state.relations],
    retrievalIndex: [...state.retrievalIndex],
  };
  const initialContext = assembleContext(next, projectId, createdAt);
  if (initialContext) next = { ...next, contexts: [...next.contexts, initialContext] };
  next = { ...next, relations: [...next.relations, { id: makeId("relation"), projectId, fromId: intent.id, relationType: "supports", toId: project.id, createdAt }] };
  next = appendEvent(next, { projectId, type: "PROJECT_CREATED", actor: "human", summary: `${project.name} 프로젝트 생성`, detail: "workspace와 기본 boundary가 설정되었습니다.", createdAt });
  next = appendEvent(next, { projectId, type: "INTENT_CREATED", actor: "human", summary: "원문 Intent 보존", detail: redactSecretLikeText(intent.rawText), createdAt });
  next = appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: "ACTIVE · 첫 wake 준비", detail: "lease와 budget은 runtime이 관리합니다.", createdAt });
  return next;
}

function humanStatusForAction(kind: HumanItemKind, action: HumanAction): HumanItemStatus {
  if (action === "defer") return "DEFERRED";
  if (kind === "QUESTION") return "ANSWERED";
  if (kind === "APPROVAL") return action === "approve" ? "APPROVED" : "REJECTED";
  if (kind === "CONCERN") return "ACKNOWLEDGED";
  return action === "reject" ? "REJECTED" : "ACKNOWLEDGED";
}

/**
 * A human item owns a scope, not the whole project. The runtime may only enter
 * WAITING when every open blocking item has no independent continuation. This
 * is the executable form of the FigJam Human Boundary rule: ask once, keep
 * unrelated work moving, and wake the affected scope after the decision.
 */
function humanBoundaryStatus(state: AppState, projectId: string): "ACTIVE" | "WAITING" {
  const openBlockingItems = getOpenHumanItems(state, projectId).filter((item) => item.blockingScope.length > 0);
  return openBlockingItems.length > 0 && openBlockingItems.every((item) => item.continuingScope.length === 0) ? "WAITING" : "ACTIVE";
}

export function isHumanActionAllowed(item: HumanItem, action: HumanAction, answer?: string): boolean {
  if (item.status !== "OPEN" && item.status !== "DEFERRED") return false;
  if (!humanActionNames.includes(action)) return false;
  if (action === "defer") return item.status === "OPEN";
  if (item.kind === "QUESTION") return action === "answer" && Boolean(answer?.trim()) && (item.options.length === 0 || item.responseMode === "choice-and-text" || item.options.some((option) => option.id === answer));
  if (item.kind === "APPROVAL") return action === "approve" || action === "reject";
  return action === "acknowledge" || action === "reject";
}

export function resolveHumanItem(
  state: AppState,
  itemId: string,
  action: HumanAction,
  answer?: string,
): AppState {
  const item = state.humanItems.find((candidate) => candidate.id === itemId);
  if (!item || !isHumanActionAllowed(item, action, answer)) return state;
  const updatedAt = nowIso();
  const option = item.options.find((candidate) => candidate.id === answer);
  const status = humanStatusForAction(item.kind, action);
  const safeAnswer = answer === undefined ? undefined : redactSecretLikeText(answer).trim().slice(0, 4_000);
  const updatedItem: HumanItem = {
    ...item,
    status,
    answer: safeAnswer,
    answerLabel: option?.title ?? safeAnswer,
    responseMode: item.responseMode ?? (item.options.length ? "choice" : "free-text"),
    updatedAt,
  };
  let next: AppState = { ...state, humanItems: replaceById(state.humanItems, updatedItem) };
  const eventType: EventType =
    action === "answer" ? "HUMAN_ANSWERED" : action === "approve" ? "HUMAN_APPROVED" : action === "reject" ? "HUMAN_REJECTED" : "HUMAN_DEFERRED";
  const normalizedEventType: EventType = action === "acknowledge" ? "HUMAN_ACKNOWLEDGED" : eventType;
  const actor: EventActor = "human";
  next = appendEvent(next, {
    projectId: item.projectId,
    type: normalizedEventType,
    actor,
    summary: `${item.id} · ${status.toLowerCase()}`,
    detail: option?.title ?? safeAnswer ?? "Human decision recorded",
    createdAt: updatedAt,
    payload: { itemId: item.id, blockingScope: item.blockingScope },
  });

  const project = getProject(next, item.projectId);
  const run = getRun(next, item.projectId);
  if (item.kind === "APPROVAL" && action === "approve" && item.actionRef && project) {
    const approvedAction = state.actions.find((candidate) => candidate.id === item.actionRef);
    if (approvedAction && !next.approvalGrants.some((candidate) => candidate.approvalItemId === item.id && !candidate.consumedAt)) {
      const ttlMinutes = positiveSetting(project.settings.approvalTtlMinutes, 60, 10_080);
      const grant: import("./types").ApprovalGrant = {
        id: makeId("approval-grant"),
        projectId: item.projectId,
        approvalItemId: item.id,
        originalActionRef: approvedAction.id,
        intentRef: approvedAction.intentRef,
        actionFingerprint: actionFingerprint(approvedAction),
        tool: approvedAction.tool,
        paramsFingerprint: paramsFingerprint(approvedAction),
        paramsCanonical: canonicalActionParams(approvedAction),
        issuedAt: updatedAt,
        expiresAt: new Date(Date.parse(updatedAt) + ttlMinutes * 60_000).toISOString(),
        singleUse: true,
      };
      next = { ...next, approvalGrants: [...next.approvalGrants, grant] };
      next = appendEvent(next, { projectId: item.projectId, type: "APPROVAL_GRANT_ISSUED", actor: "system", summary: `approval grant issued · ${grant.tool ?? "action"}`, detail: `grant=${grant.id} · expires=${grant.expiresAt}`, runId: run?.id, actionId: approvedAction.id, createdAt: updatedAt, payload: { grantId: grant.id, approvalItemId: item.id, actionFingerprint: grant.actionFingerprint } });
    }
  }
  const remainingBlocking = getOpenHumanItems(next, item.projectId).some((candidate) => candidate.blockingScope.length > 0);
  if (project) {
    const nextStatus: RuntimeStatus = project.status === "KILLED"
      ? "KILLED"
      : project.status === "PAUSED"
        ? "PAUSED"
        : project.status === "STALLED"
          ? "STALLED"
        : humanBoundaryStatus(next, item.projectId);
    next = updateProject(next, {
      ...project,
      status: nextStatus,
      updatedAt,
      nextReviewAt: nextStatus === "ACTIVE" ? undefined : project.nextReviewAt,
      metrics: { ...project.metrics, humanOrchestrationCount: project.metrics.humanOrchestrationCount + 1 },
    });
    if (run && nextStatus === "ACTIVE") {
      next = updateRun(next, { ...run, status: "ACTIVE", phase: "wake", lastCycleAt: updatedAt, leaseExpiresAt: nextLease(project, Date.parse(updatedAt)) });
    }
    next = appendEvent(next, {
      projectId: project.id,
      type: "RUN_STATE_CHANGED",
      actor: "system",
      summary: `${nextStatus} · human boundary updated`,
      detail: remainingBlocking ? "영향받는 scope만 대기하고 독립 작업은 계속합니다." : "답변 후 관련 scope를 다시 계획할 수 있습니다.",
      createdAt: updatedAt,
      runId: run?.id,
    });
    if (run && nextStatus === "ACTIVE") {
      next = appendEvent(next, {
        projectId: project.id,
        type: "WAKE_TRIGGERED",
        actor: "system",
        summary: `wake · human ${item.id} resolved`,
        detail: "human-owned decision이 반영되어 영향받은 scope를 새 cycle 대상으로 엽니다.",
        createdAt: updatedAt,
        runId: run.id,
        payload: { trigger: "human-answer", itemId: item.id },
      });
    }
  }
  const snapshot = getWorldSnapshot(next, item.projectId);
  if (snapshot) {
    const human = snapshot.sources.human;
    const openCount = getOpenHumanItems(next, item.projectId).length;
    const refreshedSnapshot: WorldSnapshot = {
      ...snapshot,
      observedAt: updatedAt,
      cursorEventId: next.events.at(-1)?.id ?? snapshot.cursorEventId,
      sources: {
        ...snapshot.sources,
        human: {
          ...human,
          observedAt: updatedAt,
          summary: openCount ? `${openCount} open item${openCount > 1 ? "s" : ""}` : "all decisions resolved",
          status: openCount ? "warning" : "healthy",
        },
      },
    };
    next = withWorldSnapshot(next, refreshedSnapshot);
    next = { ...next, observations: [...next.observations, ...observationsFromSnapshot(refreshedSnapshot, makeId("observation"))] };
  }
  return moveWorldCursor(next, item.projectId, next.events.at(-1)?.id ?? item.id, updatedAt);
}

function updateWorldAfterCycle(snapshot: WorldSnapshot, actionId: string, observedAt: string, cycleCount: number, openHumanCount = 0): WorldSnapshot {
  return {
    ...snapshot,
    id: makeId("world"),
    cursorEventId: actionId,
    observedAt,
    summary: `World cursor advanced after cycle ${cycleCount}; ${openHumanCount ? `${openHumanCount} actionable human item${openHumanCount > 1 ? "s" : ""} remain` : "no actionable human item is currently open"}.`,
    sources: { ...snapshot.sources, human: { ...snapshot.sources.human, observedAt, summary: openHumanCount ? `${openHumanCount} actionable item${openHumanCount > 1 ? "s" : ""}` : "no actionable items", status: openHumanCount ? "warning" : "healthy", freshness: "fresh" } },
  };
}

function updateWorldFromActualObservations(snapshot: WorldSnapshot, observations: Observation[], actionId: string, observedAt: string, openHumanCount: number, verdict: string): WorldSnapshot {
  const sources = { ...snapshot.sources };
  for (const item of observations) {
    if (!worldSourceKeys.includes(item.source as WorldSourceKey)) continue;
    const key = item.source as WorldSourceKey;
    sources[key] = {
      ...sources[key],
      observedAt: item.observedAt,
      summary: item.compactView,
      status: item.status,
      freshness: item.freshness,
      trustLevel: item.trustLevel,
      relatedEntities: item.relatedEntities,
    };
  }
  return {
    ...snapshot,
    id: makeId("world"),
    cursorEventId: actionId,
    observedAt,
    summary: `Direct workspace observations committed · verification ${verdict.toLowerCase()} · ${observations.length} sources refreshed.`,
    sources,
  };
}

function testCountsForCycle(toolResult: ToolResult | undefined, evidence: Evidence): { testsPassed: number; testsTotal: number } {
  const output = toolResult?.output ?? evidence.summary;
  const match = output.match(/(?:Tests?|Specs?)\s*[:=]?\s*(\d+)\s*(?:passed|pass)?[^\n]*?(?:of|\/)\s*(\d+)|(?:^|\s)(\d+)\s+(?:tests?|specs?)\s+(?:passed|pass)/i);
  if (!match) return { testsPassed: 0, testsTotal: 0 };
  const passed = Number(match[1] ?? match[3] ?? 0);
  const total = Number(match[2] ?? match[3] ?? passed);
  return Number.isFinite(passed) && Number.isFinite(total) ? { testsPassed: Math.max(0, passed), testsTotal: Math.max(passed, total) } : { testsPassed: 0, testsTotal: 0 };
}

export function runCycle(state: AppState, projectId: string, input: RuntimeCycleInput = {}): AppState {
  const observedState = input.observations?.length ? applyObservedWorld(state, projectId, input.observations) : state;
  const project = getProject(observedState, projectId);
  const run = getRun(observedState, projectId);
  const previousWorld = getWorldSnapshot(observedState, projectId);
  if (!project || !run || !previousWorld || project.status === "PAUSED" || project.status === "STALLED" || project.status === "KILLED") return observedState;

  const createdAt = nowIso();
  if (input.toolResult && !["succeeded", "failed", "blocked"].includes(input.toolResult.status)) {
    return recordRuntimeFailure(observedState, projectId, "verify", "tool returned an invalid execution status");
  }
  const toolResult = input.toolResult ? {
    ...input.toolResult,
    tool: redactSecretLikeText(input.toolResult.tool).slice(0, 256),
    toolVersion: redactSecretLikeText(input.toolResult.toolVersion).slice(0, 256),
    outputRef: redactSecretLikeText(input.toolResult.outputRef).slice(0, 2_000),
    summary: redactSecretLikeText(input.toolResult.summary).slice(0, 4_000),
    output: input.toolResult.output ? redactSecretLikeText(input.toolResult.output).slice(0, 256_000) : input.toolResult.output,
    blockedReason: input.toolResult.blockedReason ? redactSecretLikeText(input.toolResult.blockedReason).slice(0, 2_000) : input.toolResult.blockedReason,
  } : undefined;
  const modelUsage = input.modelUsage ? {
    ...input.modelUsage,
    modelVersion: redactSecretLikeText(input.modelUsage.modelVersion).slice(0, 256),
  } : undefined;
  const toolCost = typeof toolResult?.cost === "number" && Number.isFinite(toolResult.cost) ? Math.max(0, toolResult.cost) : 0;
  const modelCost = typeof modelUsage?.cost === "number" && Number.isFinite(modelUsage.cost) ? Math.max(0, modelUsage.cost) : 0;
  const cost = Number((toolCost + modelCost).toFixed(6));
  if (!toolResult && project.budgetSpent + cost > project.settings.budgetLimit) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "budget hard stop · 추가 실행 비용이 상한을 초과");
  }
  if (!toolResult && Date.parse(run.leaseExpiresAt) <= Date.now()) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "lease expired · 새 wake가 필요");
  }
  const startedAt = Date.parse(run.startedAt);
  if (!toolResult && Number.isFinite(startedAt) && Date.now() - startedAt > project.settings.maxHours * 60 * 60 * 1000) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "wall time hard stop · 최대 실행 시간이 초과");
  }
  const nextCycle = run.cycleCount + 1;
  const contextCandidate = input.context;
  const context = contextCandidate
    && contextCandidate.projectId === projectId
    && contextCandidate.intentRef === (getIntent(observedState, projectId)?.id ?? "")
    && contextCandidate.worldCursor === previousWorld.cursorEventId
    ? contextCandidate
    : assembleContext(observedState, projectId, createdAt);
  if (!context) return observedState;
  if (input.action && (input.action.intentRef !== context.intentRef || input.action.worldCursor !== context.worldCursor)) {
    return recordBoundaryDecision(observedState, projectId, input.action, "blocked", "model action references a stale intent or world cursor", context.id);
  }
  if (input.action && !isActiveProcessReference(input.action, context.activeProcessViews?.map((process) => process.id) ?? [])) {
    return recordBoundaryDecision(observedState, projectId, input.action, "blocked", "process lifecycle action must reference an active process from the current context", context.id);
  }
  if (toolResult?.evidence.some((item) => item.projectId !== projectId)) {
    return recordRuntimeFailure(observedState, projectId, "verify", "tool returned evidence for a different project");
  }
  let boundaryDecision: ReturnType<typeof validateActionBoundary> | undefined;
  const matchingApprovalGrant = input.action ? getMatchingApprovalGrant(observedState, projectId, input.action) : undefined;
  if (input.action && !input.dispatchAuthorized) {
    boundaryDecision = validateActionBoundary(project, input.action, getToolSurface(project), estimateActionCost(input.action), matchingApprovalGrant);
    if (boundaryDecision.status !== "allowed") return recordBoundaryDecision(observedState, projectId, input.action, boundaryDecision.status, boundaryDecision.reason, context.id);
  }
  if (input.action && input.action.type !== "ACT") return recordNonToolAction(observedState, projectId, input.action, context.id);
  const defaultSelected = input.action ? undefined : selectNextAction(observedState, projectId, context);
  const selected = input.action ? {
    ...(defaultSelected ?? {
      id: makeId("candidate"),
      projectId,
      force: "closure" as const,
      score: { goalGap: 0, informationGain: 0, evidenceGain: 0, cost, risk: 0, total: 0 },
      sourceRefs: context.observationRefs,
    }),
    ...input.action,
    id: defaultSelected?.id ?? makeId("candidate"),
    projectId,
    tool: boundaryDecision?.normalizedTool ?? input.action.tool,
    riskClass: boundaryDecision?.capability?.riskClass ?? input.action.riskClass,
  } : defaultSelected;
  if (!selected) return observedState;
  const actionId = makeId("action");
  const safeSelected = sanitizeActionEnvelope(selected);
  const copy = { summary: safeSelected.rationaleSummary, detail: input.action ? `actual tool dispatch · ${safeSelected.tool ?? "none"}` : "runtime selected a capability candidate; no external tool result was supplied", tool: safeSelected.tool ?? "none" };
  const rawEvidence = toolResult?.evidence ?? [];
  const evidenceKinds = new Set(["test", "browser", "screenshot", "world", "metric", "human"]);
  const evidenceVerdicts = new Set(["PASS", "FAIL", "UNCERTAIN"]);
  const incomingEvidenceIds = rawEvidence.map((item) => item.id);
  if (rawEvidence.some((item) => typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256 || !evidenceKinds.has(item.kind) || !evidenceVerdicts.has(item.verdict)) || new Set(incomingEvidenceIds).size !== incomingEvidenceIds.length || incomingEvidenceIds.some((id) => observedState.evidence.some((item) => item.id === id))) {
    return recordRuntimeFailure(observedState, projectId, "verify", "tool returned an invalid or duplicate evidence id");
  }
  const suppliedEvidence = rawEvidence.map((item) => sanitizeEvidence(item, projectId, actionId, createdAt));
  const firstEvidence = suppliedEvidence[0];
  const inferredEvidenceVerdict = suppliedEvidence.some((item) => item.verdict === "FAIL")
    ? "FAIL"
    : suppliedEvidence.some((item) => item.verdict === "UNCERTAIN")
      ? "UNCERTAIN"
      : suppliedEvidence.length
        ? "PASS"
        : "UNCERTAIN";
  const evaluatorRefsValid = !input.evaluation || (input.evaluation.evidenceRefs.length > 0 && input.evaluation.evidenceRefs.every((ref) => incomingEvidenceIds.includes(ref)));
  const evaluationVerdict: "PASS" | "FAIL" | "UNCERTAIN" = toolResult?.status === "failed" || inferredEvidenceVerdict === "FAIL" || input.evaluation?.verdict === "FAIL"
    ? "FAIL"
    : !suppliedEvidence.length || !evaluatorRefsValid || toolResult?.status === "blocked" || inferredEvidenceVerdict === "UNCERTAIN" || input.evaluation?.verdict === "UNCERTAIN"
      ? "UNCERTAIN"
      : "PASS";
  const evaluationSummary = input.evaluation && evaluationVerdict === input.evaluation.verdict ? input.evaluation.summary : undefined;
  const cycleHasFailure = toolResult?.status === "failed" || toolResult?.status === "blocked" || evaluationVerdict === "FAIL";
  const cycleIsUncertain = !toolResult || evaluationVerdict === "UNCERTAIN";
  const action: AgentAction = {
    id: actionId,
    projectId,
    runId: run.id,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    candidateId: selected.id,
    type: safeSelected.type,
    intentRef: safeSelected.intentRef,
    worldCursor: safeSelected.worldCursor,
    rationaleSummary: safeSelected.rationaleSummary,
    tool: safeSelected.tool,
    params: safeSelected.params,
    expectedValue: safeSelected.expectedValue,
    riskClass: safeSelected.riskClass,
    evidencePlan: safeSelected.evidencePlan,
    status: toolResult?.status === "blocked" ? "BLOCKED" : toolResult?.status === "failed" || evaluationVerdict === "FAIL" ? "FAILED" : evaluationVerdict === "UNCERTAIN" ? "UNCERTAIN" : "VERIFIED",
    cost,
    modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: context.policyVersion,
    contextId: context.id,
    createdAt,
    completedAt: createdAt,
    toolResultRef: toolResult?.outputRef,
    boundaryDecision: toolResult?.status === "blocked" ? "blocked" : "allowed",
    approvalGrantId: matchingApprovalGrant?.id,
  };
  const evidenceId = firstEvidence?.id ?? makeId("evidence");
  const linkedEvidenceIds = [...new Set([evidenceId, ...suppliedEvidence.map((item) => item.id)])];
  const cycleEvidence: Evidence = {
    ...(firstEvidence ?? {}),
    id: evidenceId,
    projectId,
    kind: firstEvidence?.kind ?? "world",
    verdict: evaluationVerdict,
    summary: redactSecretLikeText([
      firstEvidence?.summary ?? toolResult?.summary ?? "No verification evidence was returned for this action",
      evaluationSummary && evaluationSummary !== firstEvidence?.summary ? `evaluator: ${evaluationSummary}` : undefined,
    ].filter(Boolean).join(" · ")).slice(0, 4_000),
    source: firstEvidence?.source ?? copy.tool,
    createdAt,
    actionId,
    evaluator: input.evaluation ? "local-deterministic-evaluator" : firstEvidence?.evaluator ?? "deterministic world adapter",
    evaluatorVersion: input.evaluation?.evaluatorVersion ?? firstEvidence?.evaluatorVersion,
  };

  const evidenceById = new Map(observedState.evidence.map((item) => [item.id, item]));
  for (const item of suppliedEvidence) evidenceById.set(item.id, item);
  evidenceById.set(evidenceId, cycleEvidence);
  let next: AppState = {
    ...observedState,
    actions: [...observedState.actions, action],
    evidence: [...evidenceById.values()],
    contexts: [...observedState.contexts, context],
  };
  if (toolResult?.process) {
    const processRecord = toolResult.process;
    const existingProcess = next.processes.some((candidate) => candidate.id === processRecord.id);
    next = { ...next, processes: existingProcess ? replaceById(next.processes, processRecord) : [...next.processes, processRecord] };
  }
  if (matchingApprovalGrant && toolResult) {
    const consumedAt = createdAt;
    next = {
      ...next,
      approvalGrants: replaceById(next.approvalGrants, { ...matchingApprovalGrant, consumedAt }),
    };
    next = appendEvent(next, { projectId, type: "APPROVAL_GRANT_CONSUMED", actor: "system", summary: `approval grant consumed · ${matchingApprovalGrant.tool ?? "action"}`, detail: `grant=${matchingApprovalGrant.id}`, runId: run.id, actionId, createdAt: consumedAt, payload: { grantId: matchingApprovalGrant.id, actionFingerprint: matchingApprovalGrant.actionFingerprint } });
  }
  const eventSteps: Array<{ type: EventType; summary: string; detail?: string; actor?: EventActor; payload?: EventRecord["payload"] }> = [
    { type: "WAKE_TRIGGERED", summary: `cycle ${nextCycle} · lease and budget checked`, detail: "project/world cursor fixed before context assembly", payload: { trigger: "cycle", worldCursor: context.worldCursor } },
    { type: "OBSERVE", summary: input.observations?.length ? `${input.observations.length} direct source observations` : "current World sources re-observed", detail: copy.detail, payload: { observationRefs: input.observations?.map((observation) => observation.id) ?? context.observationRefs } },
    { type: "CONTEXT_ASSEMBLED", summary: "raw intent + fresh world + open human items + boundary", detail: "retrieved experience is evidence, not an instruction", payload: { contextId: context.id, observationRefs: context.observationRefs, openHumanItemRefs: context.openHumanItemRefs, experienceRefs: context.experienceRefs } },
    { type: "MODEL_TURN", summary: "행동 후보를 evidence 기반으로 비교", detail: "hard constraints → risk → required gap → information gain → opportunity", payload: modelUsagePayload(modelUsage) },
    { type: "ACTION_SELECTED", summary: copy.summary, detail: `ActionEnvelope ACT · ${copy.tool}` },
    { type: "TOOL_CALLED", summary: `${copy.tool} 호출`, detail: "capability surface와 sandbox boundary를 통과한 실행 요청" },
    { type: "ACTION_EXECUTED", summary: "sandbox action dispatched", detail: toolResult ? `${toolResult.tool} · ${toolResult.status}` : "P1 local reversible action" },
    { type: "TOOL_RESULT", summary: toolResult?.summary ?? "tool result returned", detail: toolResult ? `${toolResult.outputRef} · raw output은 untrusted evidence provenance와 함께 보존` : "raw output은 evidence provenance와 함께 보존", payload: toolResult ? { outputRef: toolResult.outputRef, status: toolResult.status } : undefined },
    { type: "VERIFY", summary: cycleEvidence.summary, detail: "deterministic evidence plan completed" },
    { type: "EVIDENCE_RECORDED", summary: "world evidence linked to action", detail: `${evidenceId} · evaluator=${cycleEvidence.evaluator}` },
  ];
  if (cycleHasFailure || cycleIsUncertain) eventSteps.splice(4, 0, { type: "GAP_FOUND", summary: "verification gap recorded from actual tool evidence", detail: cycleEvidence.summary });
  if (toolResult?.changedPaths?.length) eventSteps.splice(5, 0, { type: "WORKSPACE_CHANGED", summary: `workspace changed · ${toolResult.changedPaths.length} path(s)`, detail: toolResult.changedPaths.join(" · ") });
  if (toolResult?.process) {
    const processEvent: EventType | undefined = safeSelected.tool === "process.start"
      ? "PROCESS_STARTED"
      : safeSelected.tool === "process.stop" || ["exited", "stopped", "failed"].includes(toolResult.process.status)
        ? "PROCESS_EXITED"
        : undefined;
    if (processEvent) eventSteps.splice(6, 0, { type: processEvent, summary: `${processEvent === "PROCESS_STARTED" ? "process started" : "process lifecycle changed"} · ${toolResult.process.id}`, detail: toolResult.process.previewUrl ?? toolResult.process.error ?? toolResult.process.status });
  }
  for (const step of eventSteps) {
    next = appendEvent(next, {
      projectId,
      type: step.type,
      actor: step.actor ?? "agent",
      summary: step.summary,
      detail: step.detail,
      createdAt,
      runId: run.id,
      actionId,
      evidenceIds: step.type === "EVIDENCE_RECORDED" || step.type === "VERIFY" || step.type === "TOOL_RESULT" ? linkedEvidenceIds : undefined,
      payload: step.payload,
      modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION,
      toolVersion: toolResult?.toolVersion ?? TOOL_VERSION,
      policyVersion: context.policyVersion,
    });
  }

  const actualObservations = [...(input.observations ?? []), ...(toolResult?.observations ?? [])].filter((observation) => observation.projectId === projectId);
  const knownObservationIds = new Set(next.observations.map((observation) => observation.id));
  const newToolObservations = actualObservations.filter((observation) => !knownObservationIds.has(observation.id));
  const nextWorld = actualObservations.length
    ? updateWorldFromActualObservations(previousWorld, actualObservations, actionId, createdAt, getOpenHumanItems(next, projectId).length, evaluationVerdict)
    : updateWorldAfterCycle(previousWorld, actionId, createdAt, nextCycle, getOpenHumanItems(next, projectId).length);
  next = withWorldSnapshot(next, nextWorld);
  next = {
    ...next,
    observations: [...next.observations, ...newToolObservations, ...(toolResult ? [] : observationsFromSnapshot(nextWorld, `${actionId}-observation`))],
    relations: [
      ...next.relations,
      { id: makeId("relation"), projectId, fromId: context.id, relationType: "derived-from", toId: actionId, createdAt },
      { id: makeId("relation"), projectId, fromId: actionId, relationType: "verified-by", toId: evidenceId, createdAt },
      { id: makeId("relation"), projectId, fromId: actionId, relationType: "caused", toId: nextWorld.id, createdAt },
    ],
  };
  next = appendEvent(next, {
    projectId,
    type: "WORLD_CHANGED",
    actor: "system",
    summary: nextWorld.summary,
    detail: `cursor=${actionId}`,
    createdAt,
    runId: run.id,
    actionId,
    evidenceIds: [evidenceId],
  });
  next = moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? actionId, createdAt);

  const previousLedger = getResourceLedger(observedState, projectId, run.id);
  const updatedLedger: ResourceLedger = {
    id: previousLedger?.id ?? makeId("ledger"),
    projectId,
    runId: run.id,
    tokens: (previousLedger?.tokens ?? 0) + (typeof modelUsage?.tokens === "number" && Number.isFinite(modelUsage.tokens) ? Math.max(0, modelUsage.tokens) : 0),
    modelCost: Number(((previousLedger?.modelCost ?? 0) + modelCost).toFixed(6)),
    wallTimeMs: (previousLedger?.wallTimeMs ?? 0) + ((toolResult?.wallTimeMs ?? 0) + (modelUsage?.latencyMs ?? 0)),
    toolCalls: (previousLedger?.toolCalls ?? 0) + (toolResult ? 1 : 0),
    sandboxSeconds: (previousLedger?.sandboxSeconds ?? 0) + (toolResult ? Math.max(0, Math.ceil((toolResult.wallTimeMs ?? 0) / 1000)) : 0),
    budgetLimit: project.settings.budgetLimit,
    updatedAt: createdAt,
  };
  next = {
    ...next,
    resourceLedger: previousLedger ? replaceById(next.resourceLedger, updatedLedger) : [...next.resourceLedger, updatedLedger],
  };

  const hasExecutionFailure = cycleHasFailure;
  const hasVerificationGap = cycleIsUncertain;
  const readOnly = ["workspace.list", "workspace.read", "repo.read", "database.read", "process.status"].includes(toolResult?.tool ?? "");
  const contentViews = (toolResult?.observations ?? []).map((item) => `${item.source}|${item.compactView}`);
  const hasNewObservation = contentViews.some((view) => !observedState.observations.some((old) => old.projectId === projectId && `${old.source}|${old.compactView}` === view));
  const meaningfulProgress = readOnly
    ? hasNewObservation || (!contentViews.length && Boolean(toolResult?.output) && !observedState.evidence.some((old) => old.projectId === projectId && old.source === firstEvidence?.source && old.summary === firstEvidence?.summary))
    : (toolResult?.changedPaths?.length ?? 0) > 0 || toolResult?.progress === "meaningful" || (evaluationVerdict === "PASS" && Boolean(firstEvidence) && !observedState.evidence.some((old) => old.projectId === projectId && old.source === firstEvidence?.source && old.summary === firstEvidence?.summary));
  const failureSignature = hasExecutionFailure || hasVerificationGap
    ? `${toolResult?.tool ?? selected.tool ?? "none"}|${toolResult?.status ?? "none"}|${evaluationVerdict}|${toolResult?.blockedReason ? "blocked" : "execution"}`
    : undefined;
  const consecutiveFailures = failureSignature
    ? (run.lastFailureSignature === failureSignature ? run.consecutiveFailures : 0) + 1
    : 0;
  const noProgressCycles = meaningfulProgress ? 0 : run.noProgressCycles + 1;
  const failureThreshold = positiveSetting(project.settings.failureThreshold, 3, 32);
  const noProgressThreshold = positiveSetting(project.settings.noProgressThreshold, 5, 128);
  const hardLimitReached = project.budgetSpent + cost >= project.settings.budgetLimit || Date.parse(run.leaseExpiresAt) <= Date.now() || Date.now() - Date.parse(run.startedAt) >= project.settings.maxHours * 60 * 60 * 1000;
  const thresholdStalled = hardLimitReached || consecutiveFailures >= failureThreshold || noProgressCycles >= noProgressThreshold;
  const hasBlockingHumanItem = getOpenHumanItems(next, projectId).some((item) => item.blockingScope.length > 0);
  const nextStatus: RuntimeStatus = thresholdStalled
    ? "STALLED"
    : "ACTIVE";
  const nextPhase: RuntimePhase = "sleep";
  const updatedRun: Run = {
    ...run,
    status: nextStatus,
    phase: nextPhase,
    cycleCount: nextCycle,
    lastCycleAt: createdAt,
    consecutiveFailures,
    noProgressCycles,
    lastMeaningfulProgressAt: meaningfulProgress ? createdAt : run.lastMeaningfulProgressAt,
    lastFailureSignature: failureSignature,
    lastModelFailure: undefined,
    retryAfter: undefined,
    stopReason: nextStatus === "STALLED" ? (hardLimitReached ? "실행 예산 또는 시간이 소진되었습니다." : consecutiveFailures >= failureThreshold ? `도구 실패가 ${consecutiveFailures}회 반복되었습니다: ${cycleEvidence.summary}` : `새로운 관찰이나 상태 변화가 ${noProgressCycles}회 연속 없었습니다.`) : undefined,
    activeProcessIds: toolResult?.process
      ? toolResult.process.status === "running" || toolResult.process.status === "starting"
        ? [...new Set([...run.activeProcessIds, toolResult.process.id])]
        : run.activeProcessIds.filter((id) => id !== toolResult.process?.id)
      : run.activeProcessIds,
  };
  const testCounts = testCountsForCycle(toolResult, cycleEvidence);
  const actionCount = next.actions.filter((candidate) => candidate.projectId === projectId).length;
  const linkedActionCount = next.evidence.filter((candidate) => candidate.projectId === projectId && candidate.actionId).map((candidate) => candidate.actionId).filter((id, index, all) => id && all.indexOf(id) === index).length;
  const updatedProject: Project = {
    ...project,
    settings: toolResult?.process?.previewUrl ? { ...project.settings, previewUrl: toolResult.process.previewUrl } : project.settings,
    status: nextStatus,
    currentActionId: actionId,
    updatedAt: createdAt,
    budgetSpent: Number((project.budgetSpent + cost).toFixed(6)),
    nextReviewAt: undefined,
    metrics: {
      ...project.metrics,
      testsPassed: Math.max(project.metrics.testsPassed, testCounts.testsPassed),
      testsTotal: Math.max(project.metrics.testsTotal, testCounts.testsTotal),
      evidenceCoverage: actionCount ? Number((linkedActionCount / actionCount).toFixed(2)) : 0,
    },
  };
  next = updateRun(next, updatedRun);
  next = updateProject(next, updatedProject);
  next = appendEvent(next, {
    projectId,
    type: "RUN_STATE_CHANGED",
    actor: "system",
    summary: `${nextStatus} · cycle ${nextCycle} complete`,
    detail: nextStatus === "STALLED" ? `실패 evidence를 보존했습니다 · consecutiveFailures=${consecutiveFailures}` : "ACT 결과를 반영했습니다. project는 다음 cognition cycle을 위해 ACTIVE로 유지됩니다.",
    createdAt,
    runId: run.id,
  });
  if (hasExecutionFailure || hasVerificationGap) {
    next = appendEvent(next, {
      projectId,
      type: "RUNTIME_ERROR",
      actor: "system",
      summary: `Runtime verification ${hasExecutionFailure ? "failed" : "is uncertain"}`,
      detail: cycleEvidence.summary,
      createdAt,
      runId: run.id,
      actionId,
      evidenceIds: linkedEvidenceIds,
    });
  }
  const experience: Experience = {
    id: makeId("experience"),
    projectId,
    situation: copy.detail,
    decision: copy.summary,
    action: `${copy.tool} sandbox dispatch`,
    outcome: cycleEvidence.summary,
    evidenceIds: [evidenceId],
    cost,
    risk: selected.riskClass ?? "P1",
    humanIntervention: false,
    createdAt,
    worldBeforeRef: previousWorld.id,
    worldAfterRef: nextWorld.id,
    intentRef: context.intentRef,
    actionType: selected.type,
    actionPayloadRef: actionId,
    modelVersion: action.modelVersion,
    toolVersion: action.toolVersion,
    policyVersion: context.policyVersion,
  };
  const retrievalEntry: RetrievalIndexEntry = {
    id: makeId("retrieval"),
    projectId,
    entityId: experience.id,
    sourceRef: experience.id,
    metadata: { actionType: selected.type, tool: selected.tool ?? "none", verdict: cycleEvidence.verdict },
    recency: 1,
    outcomeQuality: cycleEvidence.verdict === "PASS" ? 1 : 0,
    createdAt,
  };
  next = {
    ...next,
    experiences: [...next.experiences, experience],
    retrievalIndex: rebuildRetrievalIndex({ ...next, experiences: [...next.experiences, experience] }, projectId),
    relations: [
      ...next.relations,
      { id: makeId("relation"), projectId, fromId: experience.id, relationType: "derived-from", toId: actionId, createdAt },
      { id: makeId("relation"), projectId, fromId: experience.id, relationType: "verified-by", toId: evidenceId, createdAt },
    ],
  };
  return next;
}

export function recordBoundaryDecision(
  state: AppState,
  projectId: string,
  actionEnvelope: ActionEnvelope,
  decision: "blocked" | "human-approval",
  reason: string,
  contextId?: string,
  modelUsage?: ModelUsage,
): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  const intent = getIntent(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !run || !intent || !world) return state;
  const createdAt = nowIso();
  const actionId = makeId("action");
  const safeEnvelope = sanitizeActionEnvelope(actionEnvelope);
  const safeReason = redactSecretLikeText(reason).slice(0, 4_000);
  const action: AgentAction = {
    ...safeEnvelope,
    id: actionId,
    projectId,
    runId: run.id,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    intentRef: safeEnvelope.intentRef || intent.id,
    worldCursor: safeEnvelope.worldCursor || world.cursorEventId,
    status: "BLOCKED",
    cost: 0,
    modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
    contextId,
    createdAt,
    completedAt: createdAt,
    boundaryDecision: decision,
  };
  let next: AppState = accountModelUsage({ ...state, actions: [...state.actions, action] }, projectId, modelUsage);
  next = appendEvent(next, { projectId, type: "ACTION_SELECTED", actor: "agent", summary: `${safeEnvelope.type} blocked at boundary`, detail: safeReason, actionId, runId: run.id, createdAt, payload: modelUsagePayload(modelUsage) });
  next = appendEvent(next, { projectId, type: "TOOL_RESULT", actor: "system", summary: `BLOCKED · ${safeEnvelope.tool ?? "side effect"}`, detail: safeReason, actionId, runId: run.id, createdAt });
  let nextStatus: RuntimeStatus = "STALLED";
  let duplicateApproval = false;
  if (decision === "human-approval") {
    const duplicate = next.humanItems.find((candidate) => candidate.projectId === projectId && candidate.kind === "APPROVAL" && isOpenHumanItem(candidate) && candidate.actionRef !== undefined && next.actions.some((existing) => existing.id === candidate.actionRef && actionFingerprint(existing) === actionFingerprint(safeEnvelope)));
    if (duplicate) {
      duplicateApproval = true;
      next = { ...next, relations: [...next.relations, { id: makeId("relation"), projectId, fromId: duplicate.id, relationType: "blocked-by", toId: actionId, createdAt }] };
    } else {
      const item: HumanItem = {
        id: makeId("APPROVAL"),
        projectId,
        kind: "APPROVAL",
        status: "OPEN",
        title: `${safeEnvelope.tool ?? "외부 작업"} 실행 승인`,
        summary: "실제 외부 영향이 있는 작업은 실행 전에 승인이 필요합니다.",
        actionRef: actionId,
        rationale: safeReason,
        blockingScope: [safeEnvelope.tool ?? "external-side-effect"],
        continuingScope: ["관찰", "검증 계획", "문서화"],
        options: [],
        responseMode: "choice",
        priority: "high",
        createdAt,
        updatedAt: createdAt,
        evidenceRefs: [],
      };
      next = { ...next, humanItems: [...next.humanItems, item] };
      next = appendEvent(next, { projectId, type: "HUMAN_ITEM_CREATED", actor: "agent", summary: `Approval ${item.id} · boundary decision required`, detail: item.rationale, runId: run.id, createdAt });
      next = {
        ...next,
        relations: [...next.relations, { id: makeId("relation"), projectId, fromId: item.id, relationType: "blocked-by", toId: actionId, createdAt }],
      };
    }
    nextStatus = humanBoundaryStatus(next, projectId);
  }
  const noProgressCycles = duplicateApproval ? run.noProgressCycles + 1 : 0;
  if (duplicateApproval && noProgressCycles >= positiveSetting(project.settings.noProgressThreshold, 5, 128)) nextStatus = "STALLED";
  next = updateProject(next, { ...(getProject(next, projectId) ?? project), status: nextStatus, updatedAt: createdAt, currentActionId: actionId, nextReviewAt: undefined });
  next = updateRun(next, { ...run, status: nextStatus, phase: "sleep", cycleCount: run.cycleCount + 1, lastCycleAt: createdAt, noProgressCycles, lastMeaningfulProgressAt: duplicateApproval ? run.lastMeaningfulProgressAt : createdAt, stopReason: nextStatus === "STALLED" ? (decision === "blocked" ? safeReason : `repeated boundary request made no progress for ${noProgressCycles} cycles`) : undefined });
  next = appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: `${nextStatus} · boundary enforcement`, detail: safeReason, runId: run.id, createdAt });
  next = refreshHumanWorld(next, projectId, createdAt);
  return moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? actionId, createdAt);
}

export function recordNonToolAction(state: AppState, projectId: string, actionEnvelope: ActionEnvelope, contextId?: string, modelUsage?: ModelUsage): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  const intent = getIntent(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !run || !intent || !world) return state;
  const createdAt = nowIso();
  const actionId = makeId("action");
  const safeEnvelope = sanitizeActionEnvelope(actionEnvelope);
  const action: AgentAction = {
    ...safeEnvelope,
    id: actionId,
    projectId,
    runId: run.id,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    intentRef: safeEnvelope.intentRef || intent.id,
    worldCursor: safeEnvelope.worldCursor || world.cursorEventId,
    status: "PROPOSED",
    cost: 0,
    modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
    contextId,
    createdAt,
  };
  let next: AppState = accountModelUsage({ ...state, actions: [...state.actions, action] }, projectId, modelUsage);
  const duplicateHumanItem = action.type === "QUESTION" || action.type === "IDEA" || action.type === "CONCERN"
    ? state.humanItems.find((item) => item.projectId === projectId && item.kind === action.type && isOpenHumanItem(item) && item.actionRef !== undefined && state.actions.some((existing) => existing.id === item.actionRef && actionFingerprint(existing) === actionFingerprint(safeEnvelope)))
    : undefined;
  let createdHumanItem = false;
  next = appendEvent(next, { projectId, type: "WAKE_TRIGGERED", actor: "system", summary: `cycle ${run.cycleCount + 1} · wake`, detail: "persistent cognition cycle started", actionId, runId: run.id, createdAt });
  next = appendEvent(next, { projectId, type: "OBSERVE", actor: "agent", summary: "current World observed before non-tool decision", detail: `world cursor=${world.cursorEventId}`, actionId, runId: run.id, createdAt });
  next = appendEvent(next, { projectId, type: "CONTEXT_ASSEMBLED", actor: "agent", summary: "Intent + World + boundary context assembled", detail: contextId ? `context=${contextId}` : "context was not persisted by the caller", actionId, runId: run.id, createdAt });
  next = appendEvent(next, { projectId, type: "MODEL_TURN", actor: "agent", summary: `${action.type} selected from the current context`, detail: "non-tool action protocol; no fixed role or workflow was imposed", actionId, runId: run.id, createdAt, modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION, payload: modelUsagePayload(modelUsage) });
  next = appendEvent(next, { projectId, type: "ACTION_SELECTED", actor: "agent", summary: `${action.type} · ${action.rationaleSummary}`, detail: "model output is a proposal; no tool side effect was dispatched", actionId, runId: run.id, createdAt });
  if (action.type === "QUESTION" || action.type === "IDEA" || action.type === "CONCERN") {
    const kind = action.type;
    const configuredOptions = Array.isArray(action.params?.options) ? action.params.options.filter((option): option is string => typeof option === "string").slice(0, 16) : [];
    const responseMode = configuredOptions.length && (action.params?.responseMode === "choice" || action.params?.responseMode === "choice-and-text") ? action.params.responseMode : configuredOptions.length ? "choice" : "free-text";
    const configuredBlockingScope = Array.isArray(action.params?.blockingScope) ? action.params.blockingScope.filter((scope): scope is string => typeof scope === "string").slice(0, 16) : undefined;
    const configuredContinuingScope = Array.isArray(action.params?.continuingScope) ? action.params.continuingScope.filter((scope): scope is string => typeof scope === "string").slice(0, 16) : undefined;
    const blockingScope = kind === "QUESTION" ? configuredBlockingScope ?? (typeof action.params?.scope === "string" ? [action.params.scope] : ["intent-decision"]) : [];
    const continuingScope = configuredContinuingScope ?? [];
    const linkedContext = contextId ? state.contexts.find((context) => context.id === contextId) : undefined;
    const linkedEvidenceRefs = (linkedContext?.recentEvidenceViews ?? []).map((view) => view.id).filter((id) => state.evidence.some((item) => item.id === id && item.projectId === projectId));
    if (!duplicateHumanItem) {
      const item: HumanItem = {
        id: makeId(kind),
        projectId,
        kind,
        status: "OPEN",
        title: action.rationaleSummary,
        actionRef: actionId,
        summary: kind === "QUESTION" ? "현재 관찰만으로 인간의 의도·가치를 결정할 수 없습니다." : kind === "IDEA" ? "현재 요구사항 밖이지만 더 나은 상태의 가능성이 관찰되었습니다." : "지금 실패는 아니지만 위험 또는 부채가 관찰되었습니다.",
        rationale: `model action ${action.type} · world cursor ${world.cursorEventId}`,
        blockingScope,
        continuingScope,
        options: configuredOptions.map((title, index) => ({ id: `option-${index + 1}`, title: redactSecretLikeText(title).slice(0, 256), description: "model-provided option; human remains the decision maker" })),
        responseMode,
        priority: kind === "QUESTION" ? "high" : "medium",
        createdAt,
        updatedAt: createdAt,
        evidenceRefs: linkedEvidenceRefs,
      };
      createdHumanItem = true;
      next = { ...next, humanItems: [...next.humanItems, item] };
      next = appendEvent(next, { projectId, type: "HUMAN_ITEM_CREATED", actor: "agent", summary: `${kind} ${item.id} · ${item.title}`, detail: item.rationale, actionId, runId: run.id, createdAt });
      if (kind === "QUESTION") next = appendEvent(next, { projectId, type: "QUESTION_CREATED", actor: "agent", summary: `Question ${item.id} · human-only decision`, detail: item.rationale, actionId, runId: run.id, createdAt });
    } else {
      next = appendEvent(next, { projectId, type: "GAP_FOUND", actor: "system", summary: `${kind} duplicate suppressed`, detail: `existing human item ${duplicateHumanItem.id} remains actionable`, actionId, runId: run.id, createdAt });
    }
  }
  next = refreshHumanWorld(next, projectId, createdAt);
  const hasBlocking = getOpenHumanItems(next, projectId).some((item) => item.blockingScope.length > 0);
  const consecutiveFailures = 0;
  const noProgressCycles = action.type === "WAIT" || createdHumanItem ? 0 : run.noProgressCycles + 1;
  const noProgressThreshold = positiveSetting(project.settings.noProgressThreshold, 5, 128);
  const nextStatus: RuntimeStatus = action.type === "WAIT" ? (hasBlocking ? "WAITING" : "EQUILIBRIUM") : noProgressCycles >= noProgressThreshold ? "STALLED" : "ACTIVE";
  const experience: Experience = {
    id: makeId("experience"),
    projectId,
    situation: `context ${contextId ?? "unlinked"} · world cursor ${world.cursorEventId}`,
    decision: action.rationaleSummary,
    action: `${action.type} recorded without tool dispatch`,
    outcome: nextStatus === "WAITING" ? "human boundary opened for the affected scope" : nextStatus === "EQUILIBRIUM" ? "model selected WAIT; signal-based wake remains enabled" : "non-tool decision recorded while independent work remains active",
    evidenceIds: [],
    cost: 0,
    risk: action.riskClass ?? "P0",
    humanIntervention: action.type === "QUESTION",
    createdAt,
    worldBeforeRef: world.id,
    worldAfterRef: world.id,
    intentRef: intent.id,
    actionType: action.type,
    actionPayloadRef: actionId,
    modelVersion: modelUsage?.modelVersion ?? MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
  };
  const experiences = [...next.experiences, experience];
  next = {
    ...next,
    experiences,
    retrievalIndex: rebuildRetrievalIndex({ ...next, experiences }, projectId),
    relations: [...next.relations, { id: makeId("relation"), projectId, fromId: experience.id, relationType: "derived-from", toId: actionId, createdAt }],
  };
  const updatedProject: Project = { ...(getProject(next, projectId) ?? project), status: nextStatus, currentActionId: actionId, updatedAt: createdAt, nextReviewAt: nextStatus === "EQUILIBRIUM" ? new Date(Date.now() + (project.settings.reviewIntervalMinutes ?? 360) * 60_000).toISOString() : undefined };
  next = updateProject(next, updatedProject);
  next = updateRun(next, { ...run, status: nextStatus, phase: "sleep", cycleCount: run.cycleCount + 1, lastCycleAt: createdAt, consecutiveFailures, lastFailureSignature: undefined, lastModelFailure: undefined, retryAfter: undefined, noProgressCycles, lastMeaningfulProgressAt: createdHumanItem ? createdAt : run.lastMeaningfulProgressAt, stopReason: nextStatus === "STALLED" ? `non-tool action made no new progress for ${noProgressCycles} cycles` : undefined, leaseExpiresAt: nextStatus === "STALLED" ? run.leaseExpiresAt : nextLease(project, Date.parse(createdAt)) });
  next = appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: `${nextStatus} · model action recorded`, detail: action.type === "WAIT" ? "no valuable action now; signal-based wake remains enabled" : "human side-channel updated without stopping independent work", runId: run.id, createdAt });
  if (nextStatus === "EQUILIBRIUM") next = appendEvent(next, { projectId, type: "EQUILIBRIUM_ENTERED", actor: "system", summary: "EQUILIBRIUM · no tool dispatch required", detail: "새 signal, human answer, incident, 또는 scheduled review가 오면 다시 wake합니다.", runId: run.id, createdAt });
  return moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? actionId, createdAt);
}

export function refreshWorld(state: AppState, projectId: string): AppState {
  const snapshot = getWorldSnapshot(state, projectId);
  if (!snapshot) return state;
  const observedAt = nowIso();
  const updated = updateWorldAfterCycle(snapshot, snapshot.cursorEventId, observedAt, 2, getOpenHumanItems(state, projectId).length);
  let next = withWorldSnapshot(state, updated);
  next = { ...next, observations: [...next.observations, ...observationsFromSnapshot(updated, makeId("observation"))] };
  next = appendEvent(next, {
    projectId,
    type: "OBSERVATION_REFRESHED",
    actor: "agent",
    summary: "World sources refreshed",
    detail: "local adapter refresh is unavailable for this browser-only project; existing source values were preserved",
    createdAt: observedAt,
  });
  next = appendEvent(next, {
    projectId,
    type: "WORLD_CHANGED",
    actor: "system",
    summary: "World Snapshot cursor advanced",
    detail: updated.summary,
    createdAt: observedAt,
  });
  return moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? updated.cursorEventId, observedAt);
}

function setRuntimeStatus(state: AppState, projectId: string, status: RuntimeStatus, phase: RuntimePhase, detail: string, actor: EventActor = "human"): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return state;
  if (project.status === "KILLED" && status !== "KILLED") return state;
  const updatedAt = nowIso();
  const leaseExpiresAt = status === "ACTIVE" ? nextLease(project, Date.parse(updatedAt)) : status === "KILLED" ? updatedAt : run.leaseExpiresAt;
  let next = updateProject(state, { ...project, status, updatedAt, nextReviewAt: status === "EQUILIBRIUM" ? project.nextReviewAt : undefined });
  next = updateRun(next, { ...run, status, phase, lastCycleAt: updatedAt, leaseExpiresAt,
    // Native episodes use the project status tuple as their resume boundary.
    // Revoke that lease on pause/stop/stall so an old episode cannot regain
    // the same control tuple and write into the resumed run. The short
    // transaction coordinator keeps its own fence until it records discard.
    execution: run.execution?.owner.startsWith("native-") && (status === "PAUSED" || status === "KILLED" || status === "STALLED") ? undefined : run.execution,
    stopReason: status === "KILLED" || status === "STALLED" ? detail : undefined,
    ...(status === "ACTIVE" ? { ...(run.execution && Date.parse(run.execution.expiresAt) <= Date.now() ? { execution: undefined } : {}), consecutiveFailures: 0, noProgressCycles: 0, lastFailureSignature: undefined, lastModelFailure: undefined, retryAfter: undefined } : {}),
  });
  return appendEvent(next, {
    projectId,
    type: "RUN_STATE_CHANGED",
    actor,
    summary: `${status} · ${detail}`,
    detail,
    createdAt: updatedAt,
    runId: run.id,
  });
}

export const pauseProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "PAUSED", "sleep", "사용자가 실행을 일시 정지");
export const resumeProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "ACTIVE", "wake", "사용자가 runtime을 다시 시작");
export function wakeProject(state: AppState, projectId: string, trigger = "signal"): AppState {
  const next = setRuntimeStatus(state, projectId, "ACTIVE", "wake", `runtime wake · ${trigger}`, "system");
  if (next === state) return state;
  const run = getRun(next, projectId);
  return appendEvent(next, { projectId, type: "WAKE_TRIGGERED", actor: "system", summary: `wake · ${trigger}`, detail: "lease, budget, world cursor를 새 cycle 기준으로 고정", runId: run?.id, createdAt: nowIso(), payload: { trigger } });
}
export const stallProject = (state: AppState, projectId: string, reason = "반복 실패 또는 진전 없음") => setRuntimeStatus(state, projectId, "STALLED", "sleep", reason);
export const killProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "KILLED", "sleep", "Run 강제 종료 · lease revoked");

export function accountModelUsage(state: AppState, projectId: string, usage?: ModelUsage): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run || !usage) return state;
  const cost = Number.isFinite(usage.cost) ? Math.max(0, usage.cost) : 0;
  const previous = getResourceLedger(state, projectId, run.id);
  const updated: ResourceLedger = {
    id: previous?.id ?? makeId("ledger"), projectId, runId: run.id,
    tokens: (previous?.tokens ?? 0) + (Number.isFinite(usage.tokens) ? Math.max(0, usage.tokens) : 0),
    modelCost: Number(((previous?.modelCost ?? 0) + cost).toFixed(6)),
    wallTimeMs: (previous?.wallTimeMs ?? 0) + Math.max(0, usage.latencyMs || 0),
    toolCalls: previous?.toolCalls ?? 0, sandboxSeconds: previous?.sandboxSeconds ?? 0,
    budgetLimit: project.settings.budgetLimit, updatedAt: nowIso(),
  };
  return { ...updateProject(state, { ...project, budgetSpent: Number((project.budgetSpent + cost).toFixed(6)) }), resourceLedger: previous ? replaceById(state.resourceLedger, updated) : [...state.resourceLedger, updated] };
}

export function executionBlockReason(state: AppState, projectId: string): string | undefined {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return "프로젝트 또는 실행을 찾을 수 없습니다.";
  if (project.status !== "ACTIVE" && project.status !== "WAITING") return `실행 상태: ${project.status}`;
  if (state.events.filter((event) => event.runId === run.id && (event.type === "MODEL_TURN" || event.type === "MODEL_FAILED")).length >= (project.settings.maxModelCalls ?? 200)) return "최대 모델 호출 횟수에 도달했습니다.";
  if (project.budgetSpent >= project.settings.budgetLimit) return "실행 예산이 소진되었습니다.";
  if (!Number.isFinite(Date.parse(run.leaseExpiresAt)) || Date.parse(run.leaseExpiresAt) <= Date.now()) return "실행 허가 시간이 만료되었습니다.";
  if (Date.now() - Date.parse(run.startedAt) >= project.settings.maxHours * 3_600_000) return "최대 실행 시간이 지났습니다.";
  return undefined;
}

export function recordModelFailure(state: AppState, projectId: string, error: ModelGatewayError, contextId?: string): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return state;
  const failure = { ...error.failure, message: redactSecretLikeText(error.message).slice(0, 4_000) };
  const createdAt = nowIso();
  let next = accountModelUsage(state, projectId, error.usage);
  next = appendEvent(next, { projectId, type: "MODEL_FAILED", actor: "system", summary: `모델 호출 실패 · ${failure.code}`, detail: failure.message, runId: run.id, createdAt, modelVersion: error.usage?.modelVersion, payload: { ...modelUsagePayload(error.usage), errorCode: failure.code, retryable: failure.retryable, ...(failure.rawRef ? { rawRef: failure.rawRef } : {}), ...(contextId ? { contextId } : {}) } });
  if (["PAUSED", "KILLED"].includes(project.status) || failure.code === "CANCELLED") return next;
  const count = (run.lastFailureSignature === `model:${failure.code}` ? run.consecutiveFailures : 0) + 1;
  const threshold = positiveSetting(project.settings.failureThreshold, 3, 32);
  const exhausted = (getProject(next, projectId)?.budgetSpent ?? 0) >= project.settings.budgetLimit;
  const status: RuntimeStatus = !failure.retryable || exhausted || count >= threshold ? "STALLED" : "ACTIVE";
  const retryAfter = status === "ACTIVE" ? new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** (count - 1))).toISOString() : undefined;
  next = updateProject(next, { ...getProject(next, projectId)!, status, updatedAt: createdAt, nextReviewAt: undefined });
  next = updateRun(next, { ...run, status, phase: "sleep", lastCycleAt: createdAt, cycleCount: run.cycleCount + 1, consecutiveFailures: count, noProgressCycles: run.noProgressCycles + 1, lastFailureSignature: `model:${failure.code}`, lastModelFailure: failure, retryAfter, stopReason: status === "STALLED" ? failure.message : undefined });
  return appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: `${status} · 모델 오류 ${count}/${threshold}`, detail: failure.message, runId: run.id, createdAt });
}

export function recordRuntimeFailure(state: AppState, projectId: string, phase: RuntimePhase, reason: string): AppState {
  const detail = redactSecretLikeText(reason).replace(/\s+/g, " ").trim().slice(0, 500) || "runtime failure";
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run || project.status === "PAUSED" || project.status === "KILLED") return state;
  const signature = `${phase}|${detail.toLowerCase().replace(/\d+/g, "#").slice(0, 160)}`;
  const consecutiveFailures = (run.lastFailureSignature === signature ? run.consecutiveFailures : 0) + 1;
  const threshold = positiveSetting(project.settings.failureThreshold, 3, 32);
  const nextStatus: RuntimeStatus = consecutiveFailures >= threshold || run.noProgressCycles + 1 >= positiveSetting(project.settings.noProgressThreshold, 5, 128) ? "STALLED" : "ACTIVE";
  const updatedAt = nowIso();
  let next = updateRun(state, { ...run, status: nextStatus, phase: "sleep", lastCycleAt: updatedAt, consecutiveFailures, lastFailureSignature: signature, noProgressCycles: run.noProgressCycles + 1, stopReason: nextStatus === "STALLED" ? `${phase} failed · ${detail}` : undefined, leaseExpiresAt: nextStatus === "ACTIVE" ? nextLease(project, Date.parse(updatedAt)) : run.leaseExpiresAt });
  next = updateProject(next, { ...project, status: nextStatus, updatedAt, currentActionId: project.currentActionId, nextReviewAt: undefined });
  next = appendEvent(next, {
    projectId,
    type: "RUNTIME_ERROR",
    actor: "system",
    summary: `Runtime failure · ${phase}`,
    detail,
    runId: run?.id,
    createdAt: updatedAt,
  });
  return appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: `${nextStatus} · ${phase} failure ${consecutiveFailures}/${threshold}`, detail, runId: run.id, createdAt: updatedAt });
}

export function createArtifact(
  state: AppState,
  projectId: string,
  kind: ArtifactKind,
  name: string,
  description: string,
): AppState {
  const updatedAt = nowIso();
  const artifact: Artifact = {
    id: makeId("artifact"),
    projectId,
    kind,
    name,
    description,
    status: "ready",
    updatedAt,
    sourceRef: "runtime:artifact",
    sizeLabel: "—",
  };
  let next = { ...state, artifacts: [...state.artifacts, artifact] };
  return appendEvent(next, {
    projectId,
    type: "ARTIFACT_CREATED",
    actor: "agent",
    summary: `${kind} artifact ready · ${name}`,
    detail: description,
    createdAt: updatedAt,
  });
}

export function runExperiment(state: AppState, experimentId: string): AppState {
  const experiment = state.experiments.find((candidate) => candidate.id === experimentId);
  if (!experiment) return state;
  const updatedAt = nowIso();
  const activeRun = getRun(state, experiment.projectId);
  const evidenceRefs = state.evidence.filter((item) => item.projectId === experiment.projectId).map((item) => item.id);
  const evaluatedExperiment: Experiment = {
    ...experiment,
    runIds: [...new Set([...(experiment.runIds ?? []), ...(activeRun ? [activeRun.id] : [])])],
    evaluationEvidenceRefs: [...new Set([...(experiment.evaluationEvidenceRefs ?? []), ...evidenceRefs])],
  };
  const result = scoreExperiment(state, evaluatedExperiment);
  const updatedExperiment: Experiment = {
    ...evaluatedExperiment,
    status: result.passed ? "passed" : "needs-review",
    score: result.score,
    evaluatorRefs: result.evaluatorRefs,
    updatedAt,
  };
  let next = { ...state, experiments: replaceById(state.experiments, updatedExperiment) };
  next = appendEvent(next, { projectId: experiment.projectId, type: "EXPERIMENT_STARTED", actor: "human", summary: `${experiment.key} · ${experiment.title} experiment evaluated`, detail: `${experiment.hypothesis} · evaluators=${result.evaluatorRefs.join(" · ") || "none"}`, createdAt: updatedAt });
  if (!result.passed) return next;
  const activePolicy = getActivePolicy(state, experiment.projectId);
  const candidatePolicy: Policy = {
    id: makeId("policy"),
    projectId: experiment.projectId,
    version: (activePolicy?.version ?? POLICY_VERSION) + 1,
    representation: `${experiment.key} · ${experiment.variant} · evidence-gated candidate`,
    status: "candidate",
    parentPolicyId: activePolicy?.id,
    evalRefs: [experiment.id, ...result.evaluatorRefs],
    createdAt: updatedAt,
  };
  next = { ...next, policies: [...next.policies, candidatePolicy] };
  return appendEvent(next, { projectId: experiment.projectId, type: "POLICY_CHANGED", actor: "agent", summary: `${experiment.key} completed · ${updatedExperiment.score}`, detail: `policy candidate v${candidatePolicy.version} recorded; activation requires independent evidence`, createdAt: updatedAt, payload: { policyId: candidatePolicy.id, experimentId: experiment.id } });
}

export function createExperiment(
  state: AppState,
  projectId: string,
  input: ExperimentInput,
): AppState {
  if (!getProject(state, projectId)) return state;
  const createdAt = nowIso();
  const experiment: Experiment = {
    id: makeId("experiment"),
    projectId,
    key: input.key,
    title: input.title,
    hypothesis: input.hypothesis,
    description: input.description,
    variant: input.variant,
    status: "ready",
    score: "—",
    updatedAt: createdAt,
    benchmark: input.benchmark ?? "unassigned",
    budgetLimit: input.budgetLimit ?? 5,
    hiddenCriteria: input.hiddenCriteria ?? ["deterministic evidence", "blind evaluator", "failure retained"],
    evaluatorRefs: input.evaluatorRefs ?? experimentDefinition(input.key)?.evaluatorRefs ?? [],
    variantConfig: input.variantConfig,
  };
  const next = { ...state, experiments: [...state.experiments, experiment] };
  return appendEvent(next, {
    projectId,
    type: "EXPERIMENT_CREATED",
    actor: "human",
    summary: `${experiment.key} · ${experiment.title} experiment created`,
    detail: experiment.hypothesis,
    createdAt,
  });
}

export interface CreateIntentResult {
  intent: Intent;
  state: AppState;
}

export function addIntent(state: AppState, projectId: string, rawText: string): CreateIntentResult {
  const project = getProject(state, projectId);
  if (!project || !rawText.trim()) return { intent: getIntent(state, projectId)!, state };
  const createdAt = nowIso();
  const intent: Intent = {
    id: makeId("intent"),
    projectId,
    rawText: rawText.trim(),
    constraints: getIntent(state, projectId)?.constraints ?? [],
    version: (getIntent(state, projectId)?.version ?? 0) + 1,
    createdAt,
  };
  let next: AppState = { ...state, intents: [...state.intents, intent] };
  next = updateProject(next, { ...project, intentId: intent.id, status: project.status === "KILLED" ? "KILLED" : "ACTIVE", updatedAt: createdAt, nextReviewAt: undefined });
  next = appendEvent(next, { projectId, type: "INTENT_CREATED", actor: "human", summary: `Intent v${intent.version} created`, detail: redactSecretLikeText(intent.rawText), createdAt });
  if (project.status !== "KILLED") next = wakeProject(next, projectId, "intent");
  return { intent, state: next };
}

export function eventTone(type: EventType): string {
  if (type === "OBSERVE" || type === "CONTEXT_ASSEMBLED") return "blue";
  if (type === "ACTION_SELECTED" || type === "ACTION_EXECUTED") return "mint";
  if (type === "TOOL_CALLED" || type === "TOOL_RESULT") return "mint";
  if (type === "VERIFY" || type === "EVIDENCE_RECORDED") return "mint";
  if (type === "HUMAN_ITEM_CREATED" || type === "QUESTION_CREATED" || type.startsWith("HUMAN_")) return "pink";
  if (type === "WORLD_CHANGED" || type === "OBSERVATION_REFRESHED") return "purple";
  if (type === "WORKSPACE_CHANGED" || type === "PROCESS_STARTED" || type === "PROCESS_EXITED") return "mint";
  if (type === "APPROVAL_GRANT_ISSUED" || type === "APPROVAL_GRANT_CONSUMED" || type === "JOB_ENQUEUED") return "blue";
  if (type === "GAP_FOUND" || type === "RUNTIME_ERROR" || type === "MODEL_FAILED") return "orange";
  if (type === "EXPERIMENT_CREATED" || type === "EXPERIMENT_STARTED" || type === "POLICY_CHANGED") return "purple";
  if (type === "RUN_STATE_CHANGED") return "yellow";
  return "neutral";
}

export function eventLabel(type: EventType): string {
  const labels: Partial<Record<EventType, string>> = {
    PROJECT_CREATED: "프로젝트",
    INTENT_CREATED: "의도",
    WAKE_TRIGGERED: "깨우기",
    OBSERVE: "관찰",
    CONTEXT_ASSEMBLED: "컨텍스트",
    MODEL_TURN: "판단",
    MODEL_FAILED: "모델 오류",
    CYCLE_PHASE: "실행 단계",
    CYCLE_DISCARDED: "이전 결정 폐기",
    RUNTIME_ERROR: "오류",
    GAP_FOUND: "공백",
    TOOL_CALLED: "도구",
    TOOL_RESULT: "도구 결과",
    ACTION_SELECTED: "행동 선택",
    ACTION_EXECUTED: "행동 실행",
    VERIFY: "검증",
    EVIDENCE_RECORDED: "증거",
    WORLD_CHANGED: "월드",
    OBSERVATION_REFRESHED: "월드 새로고침",
    WORKSPACE_CHANGED: "작업공간",
    PROCESS_STARTED: "프로세스 시작",
    PROCESS_EXITED: "프로세스 종료",
    APPROVAL_GRANT_ISSUED: "승인 발급",
    APPROVAL_GRANT_CONSUMED: "승인 사용",
    JOB_ENQUEUED: "큐",
    HUMAN_ITEM_CREATED: "도움 필요",
    QUESTION_CREATED: "질문",
    HUMAN_ANSWERED: "답변",
    HUMAN_APPROVED: "승인",
    HUMAN_REJECTED: "거절",
    HUMAN_ACKNOWLEDGED: "확인",
    EXPERIMENT_CREATED: "실험 생성",
    EXPERIMENT_STARTED: "실험 시작",
    RUN_STATE_CHANGED: "상태 변경",
    EQUILIBRIUM_ENTERED: "균형",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

export function statusLabel(status: RuntimeStatus): string {
  return { ACTIVE: "활성", WAITING: "도움 필요", EQUILIBRIUM: "균형", STALLED: "중단", PAUSED: "일시 정지", KILLED: "종료" }[status];
}

export function statusTone(status: RuntimeStatus): string {
  return {
    ACTIVE: "mint",
    WAITING: "pink",
    EQUILIBRIUM: "equilibrium",
    STALLED: "orange",
    PAUSED: "gray",
    KILLED: "red",
  }[status];
}

export function humanTone(kind: HumanItemKind): string {
  return { QUESTION: "pink", IDEA: "yellow", CONCERN: "orange", APPROVAL: "red" }[kind];
}

export function humanLabel(kind: HumanItemKind): string {
  return { QUESTION: "질문", IDEA: "아이디어", CONCERN: "우려", APPROVAL: "승인" }[kind];
}

export function actionStatusLabel(status: ActionStatus): string {
  return { PROPOSED: "제안됨", RUNNING: "실행 중", VERIFIED: "검증됨", UNCERTAIN: "확인 불가", FAILED: "실패", BLOCKED: "차단됨" }[status];
}

export function riskLabel(risk: RiskClass): string {
  return { P0: "읽기 전용", P1: "로컬·되돌릴 수 있음", P2: "외부·되돌릴 수 있음", P3: "파괴적·운영 환경" }[risk];
}

export function phaseLabel(phase: RuntimePhase): string {
  return { idle: "대기", wake: "깨우기", observe: "관찰", assemble: "컨텍스트 구성", decide: "판단", dispatch: "실행", verify: "검증", govern: "경계 적용", sleep: "대기" }[phase];
}

export function allWorldSources(snapshot: WorldSnapshot | undefined): WorldSource[] {
  if (!snapshot) return [];
  return worldSourceKeys.map((key) => snapshot.sources[key]);
}
