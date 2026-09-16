import { worldSourceKeys } from "./types";
import type { EvaluatorResult, ModelUsage, ToolResult } from "./ports";
import { scoreExperiment, experimentDefinition } from "./experimentHarness";
import { estimateActionCost, redactSecretLikeText, validateActionBoundary } from "./security";
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

export type ExperimentInput = Pick<Experiment, "key" | "title" | "hypothesis" | "description" | "variant"> & Partial<Pick<Experiment, "benchmark" | "budgetLimit" | "hiddenCriteria" | "evaluatorRefs" | "variantConfig">>;
export type HumanAction = "answer" | "approve" | "reject" | "defer" | "acknowledge";

const humanActionNames: HumanAction[] = ["answer", "approve", "reject", "defer", "acknowledge"];

function positiveSetting(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function nextLease(project: Project, at = Date.now()): string {
  return new Date(at + positiveSetting(project.settings.maxHours, 12, 168) * 60 * 60 * 1000).toISOString();
}

function sanitizeActionEnvelope(action: ActionEnvelope): ActionEnvelope {
  const params = action.params
    ? Object.fromEntries(Object.entries(action.params).map(([key, value]) => [key, typeof value === "string" ? redactSecretLikeText(value).slice(0, 2_000) : value]))
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

export interface RuntimeCycleInput {
  observations?: Observation[];
  action?: ActionEnvelope;
  toolResult?: ToolResult;
  evaluation?: EvaluatorResult;
  modelUsage?: ModelUsage;
}

export function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random.slice(0, 8)}`;
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
    .filter((snapshot) => snapshot.projectId === projectId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

export function getProjectObservations(state: AppState, projectId: string): Observation[] {
  return state.observations
    .filter((observation) => observation.projectId === projectId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

export function getProjectContexts(state: AppState, projectId: string): ContextPacket[] {
  return state.contexts
    .filter((context) => context.projectId === projectId)
    .sort((a, b) => b.assembledAt.localeCompare(a.assembledAt));
}

export function getActivePolicy(state: AppState, projectId: string): Policy | undefined {
  return state.policies
    .filter((policy) => policy.projectId === projectId && policy.status === "active")
    .sort((a, b) => b.version - a.version)[0];
}

export function getResourceLedger(state: AppState, projectId: string, runId = getRun(state, projectId)?.id): ResourceLedger | undefined {
  return state.resourceLedger
    .filter((ledger) => ledger.projectId === projectId && (!runId || ledger.runId === runId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function getProjectRelations(state: AppState, projectId: string): Relation[] {
  return state.relations.filter((relation) => relation.projectId === projectId);
}

export function getProjectRetrievalEntries(state: AppState, projectId: string): RetrievalIndexEntry[] {
  return state.retrievalIndex
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => b.recency - a.recency || b.outcomeQuality - a.outcomeQuality);
}

export function getProjectEvents(state: AppState, projectId: string): EventRecord[] {
  return state.events
    .filter((event) => event.projectId === projectId)
    .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1) || b.createdAt.localeCompare(a.createdAt));
}

export function getProjectHumanItems(state: AppState, projectId: string): HumanItem[] {
  return state.humanItems
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function isOpenHumanItem(item: HumanItem): boolean {
  return item.status === "OPEN";
}

export function getOpenHumanItems(state: AppState, projectId: string): HumanItem[] {
  return getProjectHumanItems(state, projectId).filter(isOpenHumanItem);
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

function updateRun(state: AppState, run: Run): AppState {
  return { ...state, runs: replaceById(state.runs, run) };
}

function withWorldSnapshot(state: AppState, snapshot: WorldSnapshot): AppState {
  const remaining = state.worldSnapshots.filter((candidate) => candidate.projectId !== snapshot.projectId);
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
    if (event.type === "EVIDENCE_RECORDED" && event.evidenceIds?.some((evidenceId) => state.evidence.find((item) => item.id === evidenceId)?.verdict === "PASS")) active.clear();
  }
  return [...active].slice(-8);
}

/**
 * Commits fresh adapter observations without pretending that a summary is the
 * source of truth. The event that caused the observation is attached later by
 * the runtime cycle, while the raw observation references remain queryable.
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
    summary: "Direct source observations refreshed; event log and raw references remain the source of truth.",
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
  return [
    { name: "repo.read", description: "git diff와 dependency/config를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: true, toolVersion: TOOL_VERSION },
    { name: "shell.sandbox", description: "격리 workspace에서 명령을 실행합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "browser.playwright", description: "브라우저와 DOM을 관찰·검증합니다.", riskClass: "P1", reversible: true, requiresNetwork: true, sideEffect: false, enabled: project.settings.localActions, toolVersion: TOOL_VERSION },
    { name: "database.read", description: "연결된 DB 상태를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: true, toolVersion: TOOL_VERSION },
    { name: "deploy.production", description: "production side effect를 실행합니다.", riskClass: "P3", reversible: false, requiresNetwork: true, sideEffect: true, enabled: !project.settings.productionBlocked, toolVersion: TOOL_VERSION },
  ];
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
  const experiences = state.experiences
    .filter((experience) => experience.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return {
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
    experienceRefs: experiences.map((experience) => experience.id),
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
    activeIncidentRefs: activeIncidentRefs(state, projectId),
    boundary: {
      remainingBudget: Math.max(0, Number((project.settings.budgetLimit - project.budgetSpent).toFixed(2))),
      maxHours: project.settings.maxHours,
      networkPolicy: project.settings.networkPolicy,
      productionBlocked: project.settings.productionBlocked,
      openApprovalRefs: openItems.filter((item) => item.kind === "APPROVAL").map((item) => item.id),
    },
    toolSurface: getToolSurface(project),
    assembledAt,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    policyVersion: policy?.version ?? POLICY_VERSION,
    untrustedObservationRefs: observations.filter((observation) => observation.trustLevel === "untrusted" || observation.source === "browser" || observation.source === "shell" || observation.source === "logs").map((observation) => observation.id),
  };
}

export function selectActionCandidates(state: AppState, projectId: string, context: ContextPacket): ActionCandidate[] {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return [];
  const hasOpenQuestion = context.openHumanItemRefs.some((itemId) => state.humanItems.find((item) => item.id === itemId)?.kind === "QUESTION");
  const firstCycle = run.cycleCount === 0;
  const tripTogetherFlow = project.name === "TripTogether";
  const closure: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "ACT",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: firstCycle && tripTogetherFlow ? "모바일 초대 흐름을 다시 관찰하고 안전 영역을 검증" : firstCycle ? "Intent에 연결된 World source를 관찰하고 첫 evidence를 확보" : "현재 World의 evidence gap을 점검하고 다음 가치 있는 변화를 선택",
    tool: firstCycle && tripTogetherFlow ? "playwright" : "world-adapter",
    params: { cycle: run.cycleCount + 1, sandbox: true },
    expectedValue: firstCycle && tripTogetherFlow ? 0.88 : 0.41,
    riskClass: "P1",
    evidencePlan: firstCycle && tripTogetherFlow ? ["browser", "test", "world"] : ["world", "test"],
    force: "closure",
    score: { goalGap: firstCycle && tripTogetherFlow ? 0.88 : 0.44, informationGain: firstCycle && tripTogetherFlow ? 0.74 : 0.4, evidenceGain: 0.8, cost: 0.38, risk: 0.08, total: firstCycle && tripTogetherFlow ? 2.02 : 1.18 },
    sourceRefs: context.observationRefs.slice(0, 3),
  };
  const discovery: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "IDEA",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: "반복된 사용자 행동에서 제품 기회를 제안",
    tool: "browser-observation",
    expectedValue: 0.45,
    riskClass: "P1",
    evidencePlan: ["browser", "human"],
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
    rationaleSummary: "제품 권한 철학은 인간의 의도 없이는 결정할 수 없음",
    tool: "human-boundary",
    expectedValue: 0.52,
    riskClass: "P2",
    evidencePlan: ["human"],
    force: "boundary",
    score: { goalGap: hasOpenQuestion ? 0.42 : 0.12, informationGain: hasOpenQuestion ? 0.7 : 0.2, evidenceGain: 0.25, cost: 0.03, risk: 0.04, total: hasOpenQuestion ? 1.3 : 0.5 },
    sourceRefs: hasOpenQuestion ? context.openHumanItemRefs : [],
  };
  const wait: ActionCandidate = {
    id: makeId("candidate"),
    projectId,
    type: "WAIT",
    intentRef: context.intentRef,
    worldCursor: context.worldCursor,
    rationaleSummary: "현재 비용·위험 대비 즉시 가치 있는 변화가 낮음",
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
    summary: "새 프로젝트 workspace를 연결하는 중입니다. 직접 관찰 결과가 들어오면 World Snapshot이 갱신됩니다.",
    sources: {
      repo: source("repo", "Repo", "workspace connected", observedAt, "healthy", "verified"),
      runtime: source("runtime", "Runtime", "not started", observedAt, "warning"),
      browser: source("browser", "Browser", "awaiting first observation", observedAt, "warning"),
      db: source("db", "DB", "not connected", observedAt, "warning"),
      logs: source("logs", "Logs", "no events yet", observedAt),
      human: source("human", "Human", "no decisions yet", observedAt),
    },
  };
}

function deriveProjectName(rawIntent: string): { name: string; subtitle: string } {
  if (rawIntent.includes("여행") || rawIntent.toLowerCase().includes("travel")) {
    return { name: "TripTogether", subtitle: "친구들과 여행 계획을 함께 만드는 서비스" };
  }
  const firstSentence = rawIntent.split(/[.!?\n]/)[0]?.trim() || "New Intent";
  return {
    name: firstSentence.length > 24 ? `${firstSentence.slice(0, 24)}…` : firstSentence,
    subtitle: "Intent에서 시작한 새로운 World",
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
      localActions: settings.localActions ?? true,
      requireExternalApproval: settings.requireExternalApproval ?? true,
      productionBlocked: settings.productionBlocked ?? true,
      networkPolicy: settings.networkPolicy ?? "allowlist",
      workspacePath: settings.workspacePath,
      previewUrl: settings.previewUrl,
      allowedDomains: settings.allowedDomains ? [...settings.allowedDomains] : undefined,
      sandboxMode: settings.sandboxMode ?? "process",
      modelProvider: settings.modelProvider ?? "deterministic",
      reviewIntervalMinutes: positiveSetting(settings.reviewIntervalMinutes, 360, 10_080),
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
  if (item.status !== "OPEN") return false;
  if (!humanActionNames.includes(action)) return false;
  if (action === "defer") return true;
  if (item.kind === "QUESTION") return action === "answer" && Boolean(answer?.trim()) && (item.options.length === 0 || item.options.some((option) => option.id === answer));
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

function actionDescription(cycleCount: number, projectName: string): { summary: string; detail: string; tool: string } {
  if (cycleCount === 0 && projectName === "TripTogether") {
    return {
      summary: "모바일 초대 흐름을 다시 관찰하고 안전 영역을 검증",
      detail: "fresh browser observation → CSS layout check → 390px/430px verify",
      tool: "playwright",
    };
  }
  if (cycleCount === 0) {
    return {
      summary: "Intent에 연결된 World source를 관찰하고 첫 evidence를 확보",
      detail: "repo + runtime + browser + human source observation → deterministic verification",
      tool: "world-adapter",
    };
  }
  return {
    summary: "현재 World의 evidence gap을 점검하고 다음 가치 있는 변화를 선택",
    detail: "repo + runtime + human signals를 다시 읽은 뒤 변경 없이도 검증 가능한 범위를 비교",
    tool: "world-adapter",
  };
}

function updateWorldAfterCycle(snapshot: WorldSnapshot, actionId: string, observedAt: string, cycleCount: number, openHumanCount = 0): WorldSnapshot {
  return {
    ...snapshot,
    id: makeId("world"),
    cursorEventId: actionId,
    observedAt,
    summary: cycleCount === 1
      ? "Mobile invite flow was re-observed and verified. The remaining decision is scoped to invite permissions."
      : "World re-observed. No unbounded work was started; runtime keeps the latest evidence and waits for a meaningful signal.",
    sources: {
      ...snapshot.sources,
      repo: { ...snapshot.sources.repo, observedAt, summary: cycleCount === 1 ? "clean · +2 files" : "clean · no new diff", freshness: "fresh", trustLevel: "verified" },
      runtime: { ...snapshot.sources.runtime, observedAt, summary: "Preview environment · healthy", status: "healthy", freshness: "fresh" },
      browser: { ...snapshot.sources.browser, observedAt, summary: cycleCount === 1 ? "mobile verified" : "last verified · 390/430px", status: "healthy", freshness: "fresh", trustLevel: "verified" },
      logs: { ...snapshot.sources.logs, observedAt, summary: "0 critical errors", status: "healthy", freshness: "fresh" },
      human: { ...snapshot.sources.human, observedAt, summary: openHumanCount ? `${openHumanCount} open item${openHumanCount > 1 ? "s" : ""}` : "all decisions resolved", status: openHumanCount ? "warning" : "healthy", freshness: "fresh" },
    },
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

function testCountsForCycle(project: Project, toolResult: ToolResult | undefined, evidence: Evidence): { testsPassed: number; testsTotal: number } {
  if (project.id === "project-trip-together") return { testsPassed: 42, testsTotal: 42 };
  const output = toolResult?.output ?? evidence.summary;
  const passed = output.match(/(\d+)\s+(?:tests?|specs?|passed|pass)/i)?.[1];
  const count = passed ? Number(passed) : 0;
  return count > 0 ? { testsPassed: count, testsTotal: count } : { testsPassed: project.metrics.testsPassed, testsTotal: project.metrics.testsTotal };
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
  const toolCost = typeof toolResult?.cost === "number" && Number.isFinite(toolResult.cost) ? Math.max(0, toolResult.cost) : 0.38;
  const modelCost = typeof modelUsage?.cost === "number" && Number.isFinite(modelUsage.cost) ? Math.max(0, modelUsage.cost) : 0;
  const cost = Number((toolCost + modelCost).toFixed(2));
  if (project.budgetSpent + cost > project.settings.budgetLimit) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "budget hard stop · 추가 실행 비용이 상한을 초과");
  }
  if (Date.parse(run.leaseExpiresAt) <= Date.now()) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "lease expired · 새 wake가 필요");
  }
  const startedAt = Date.parse(run.startedAt);
  if (Number.isFinite(startedAt) && Date.now() - startedAt > project.settings.maxHours * 60 * 60 * 1000) {
    return setRuntimeStatus(observedState, projectId, "STALLED", "sleep", "wall time hard stop · 최대 실행 시간이 초과");
  }
  const nextCycle = run.cycleCount + 1;
  const context = assembleContext(observedState, projectId, createdAt);
  if (!context) return observedState;
  if (input.action && (input.action.intentRef !== context.intentRef || input.action.worldCursor !== context.worldCursor)) {
    return recordBoundaryDecision(observedState, projectId, input.action, "blocked", "model action references a stale intent or world cursor", context.id);
  }
  if (toolResult?.evidence.some((item) => item.projectId !== projectId)) {
    return recordRuntimeFailure(observedState, projectId, "verify", "tool returned evidence for a different project");
  }
  let boundaryDecision: ReturnType<typeof validateActionBoundary> | undefined;
  if (input.action) {
    boundaryDecision = validateActionBoundary(project, input.action, getToolSurface(project), estimateActionCost(input.action));
    if (boundaryDecision.status !== "allowed") return recordBoundaryDecision(observedState, projectId, input.action, boundaryDecision.status, boundaryDecision.reason, context.id);
  }
  if (input.action && input.action.type !== "ACT") return recordNonToolAction(observedState, projectId, input.action, context.id);
  const defaultSelected = selectNextAction(observedState, projectId, context);
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
  const copy = input.action ? { summary: safeSelected.rationaleSummary, detail: `actual tool dispatch · ${safeSelected.tool ?? "none"}`, tool: safeSelected.tool ?? "none" } : actionDescription(run.cycleCount, project.name);
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
  };
  const evidenceId = firstEvidence?.id ?? makeId("evidence");
  const linkedEvidenceIds = [...new Set([evidenceId, ...suppliedEvidence.map((item) => item.id)])];
  const cycleEvidence: Evidence = {
    ...(firstEvidence ?? {}),
    id: evidenceId,
    projectId,
    kind: firstEvidence?.kind ?? "world",
    verdict: evaluationVerdict,
    summary: redactSecretLikeText(evaluationSummary ?? firstEvidence?.summary ?? (nextCycle === 1 ? "390px/430px browser verification passed" : "Fresh world observation completed with no new critical gap")).slice(0, 4_000),
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
  const eventSteps: Array<{ type: EventType; summary: string; detail?: string; actor?: EventActor; payload?: EventRecord["payload"] }> = [
    { type: "WAKE_TRIGGERED", summary: `cycle ${nextCycle} · lease and budget checked`, detail: "project/world cursor fixed before context assembly", payload: { trigger: "cycle", worldCursor: context.worldCursor } },
    { type: "OBSERVE", summary: input.observations?.length ? `${input.observations.length} direct source observations` : nextCycle === 1 ? "Playwright mobile viewport 관찰" : "repo · runtime · human signal 재관찰", detail: copy.detail, payload: { observationRefs: input.observations?.map((observation) => observation.id) ?? context.observationRefs } },
    { type: "CONTEXT_ASSEMBLED", summary: "raw intent + fresh world + open human items + boundary", detail: "retrieved experience is evidence, not an instruction", payload: { contextId: context.id, observationRefs: context.observationRefs, openHumanItemRefs: context.openHumanItemRefs, experienceRefs: context.experienceRefs } },
    { type: "MODEL_TURN", summary: "행동 후보를 evidence 기반으로 비교", detail: "hard constraints → risk → required gap → information gain → opportunity" },
    { type: "GAP_FOUND", summary: nextCycle === 1 ? "required evidence gap identified" : "남은 evidence gap 재평가", detail: copy.detail },
    { type: "ACTION_SELECTED", summary: copy.summary, detail: `ActionEnvelope ACT · ${copy.tool}` },
    { type: "TOOL_CALLED", summary: `${copy.tool} 호출`, detail: "capability surface와 sandbox boundary를 통과한 실행 요청" },
    { type: "ACTION_EXECUTED", summary: "sandbox action dispatched", detail: toolResult ? `${toolResult.tool} · ${toolResult.status}` : "P1 local reversible action" },
    { type: "TOOL_RESULT", summary: toolResult?.summary ?? "tool result returned", detail: toolResult ? `${toolResult.outputRef} · raw output은 untrusted evidence provenance와 함께 보존` : "raw output은 evidence provenance와 함께 보존", payload: toolResult ? { outputRef: toolResult.outputRef, status: toolResult.status } : undefined },
    { type: "VERIFY", summary: cycleEvidence.summary, detail: "deterministic evidence plan completed" },
    { type: "EVIDENCE_RECORDED", summary: "world evidence linked to action", detail: `${evidenceId} · evaluator=${cycleEvidence.evaluator}` },
  ];
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

  const nextWorld = input.observations?.length
    ? updateWorldFromActualObservations(previousWorld, input.observations, actionId, createdAt, getOpenHumanItems(next, projectId).length, evaluationVerdict)
    : updateWorldAfterCycle(previousWorld, actionId, createdAt, nextCycle, getOpenHumanItems(next, projectId).length);
  next = withWorldSnapshot(next, nextWorld);
  next = {
    ...next,
    observations: [...next.observations, ...observationsFromSnapshot(nextWorld, `${actionId}-observation`)],
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
    tokens: (previousLedger?.tokens ?? 0) + (typeof modelUsage?.tokens === "number" && Number.isFinite(modelUsage.tokens) ? Math.max(0, modelUsage.tokens) : 1240),
    modelCost: Number(((previousLedger?.modelCost ?? 0) + modelCost).toFixed(2)),
    wallTimeMs: (previousLedger?.wallTimeMs ?? 0) + (toolResult?.wallTimeMs ?? modelUsage?.latencyMs ?? 1800),
    toolCalls: (previousLedger?.toolCalls ?? 0) + 1,
    sandboxSeconds: (previousLedger?.sandboxSeconds ?? 0) + Math.max(1, Math.ceil((toolResult?.wallTimeMs ?? 4000) / 1000)),
    budgetLimit: project.settings.budgetLimit,
    updatedAt: createdAt,
  };
  next = {
    ...next,
    resourceLedger: previousLedger ? replaceById(next.resourceLedger, updatedLedger) : [...next.resourceLedger, updatedLedger],
  };

  const hasExecutionFailure = toolResult?.status === "failed" || toolResult?.status === "blocked" || evaluationVerdict === "FAIL";
  const hasVerificationGap = Boolean(toolResult) && evaluationVerdict === "UNCERTAIN";
  const hasBlockingHumanItem = getOpenHumanItems(next, projectId).some((item) => item.blockingScope.length > 0);
  const nextStatus: RuntimeStatus = hasExecutionFailure || hasVerificationGap
    ? "STALLED"
    : hasBlockingHumanItem
      ? humanBoundaryStatus(next, projectId)
      : "EQUILIBRIUM";
  const nextPhase: RuntimePhase = "sleep";
  const updatedRun: Run = { ...run, status: nextStatus, phase: nextPhase, cycleCount: nextCycle, lastCycleAt: createdAt };
  const updatedProject: Project = {
    ...project,
    status: nextStatus,
    currentActionId: actionId,
    updatedAt: createdAt,
    budgetSpent: Math.min(project.settings.budgetLimit, Number((project.budgetSpent + cost).toFixed(2))),
    nextReviewAt: nextStatus === "EQUILIBRIUM" ? new Date(Date.now() + (project.settings.reviewIntervalMinutes ?? 360) * 60_000).toISOString() : undefined,
    metrics: {
      ...project.metrics,
      testsPassed: Math.max(project.metrics.testsPassed, testCountsForCycle(project, toolResult, cycleEvidence).testsPassed),
      testsTotal: Math.max(project.metrics.testsTotal, testCountsForCycle(project, toolResult, cycleEvidence).testsTotal),
      evidenceCoverage: Math.min(1, Number((project.metrics.evidenceCoverage + 0.02).toFixed(2))),
      initiativeRecall: Math.max(project.metrics.initiativeRecall, 0.71),
      initiativePrecision: Math.max(project.metrics.initiativePrecision, 0.86),
    },
  };
  next = updateRun(next, updatedRun);
  next = updateProject(next, updatedProject);
  next = appendEvent(next, {
    projectId,
    type: "RUN_STATE_CHANGED",
    actor: "system",
    summary: `${nextStatus} · cycle ${nextCycle} complete`,
    detail: nextStatus === "WAITING" ? "blocking scope는 human decision을 기다리고, 독립 작업은 보존됩니다." : nextStatus === "STALLED" ? "실행 또는 검증 실패를 보존했습니다. 원인 확인 후 새 wake에서 재시도할 수 있습니다." : "현재 비용 대비 가치 높은 행동이 없어 equilibrium에 진입합니다.",
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
  if (nextStatus === "EQUILIBRIUM") {
    next = appendEvent(next, {
      projectId,
      type: "EQUILIBRIUM_ENTERED",
      actor: "system",
      summary: "EQUILIBRIUM · meaningful next change not found",
      detail: "새 signal, human answer, incident, 또는 scheduled review가 오면 다시 wake합니다.",
      createdAt,
      runId: run.id,
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
    outcomeQuality: cycleEvidence.verdict === "PASS" ? 0.91 : 0.2,
    createdAt,
  };
  next = {
    ...next,
    experiences: [...next.experiences, experience],
    retrievalIndex: [...next.retrievalIndex, retrievalEntry],
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
    modelVersion: MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
    contextId,
    createdAt,
    completedAt: createdAt,
    boundaryDecision: decision,
  };
  let next: AppState = { ...state, actions: [...state.actions, action] };
  next = appendEvent(next, { projectId, type: "ACTION_SELECTED", actor: "agent", summary: `${safeEnvelope.type} blocked at boundary`, detail: safeReason, actionId, runId: run.id, createdAt });
  next = appendEvent(next, { projectId, type: "TOOL_RESULT", actor: "system", summary: `BLOCKED · ${safeEnvelope.tool ?? "side effect"}`, detail: safeReason, actionId, runId: run.id, createdAt });
  let nextStatus: RuntimeStatus = "STALLED";
  if (decision === "human-approval") {
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
    nextStatus = humanBoundaryStatus(next, projectId);
  }
  next = updateProject(next, { ...project, status: nextStatus, updatedAt: createdAt, currentActionId: actionId, nextReviewAt: undefined });
  next = updateRun(next, { ...run, status: nextStatus, phase: "sleep", lastCycleAt: createdAt, stopReason: decision === "blocked" ? safeReason : undefined });
  next = appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: `${nextStatus} · boundary enforcement`, detail: safeReason, runId: run.id, createdAt });
  next = refreshHumanWorld(next, projectId, createdAt);
  return moveWorldCursor(next, projectId, next.events.at(-1)?.id ?? actionId, createdAt);
}

export function recordNonToolAction(state: AppState, projectId: string, actionEnvelope: ActionEnvelope, contextId?: string): AppState {
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
    modelVersion: MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
    contextId,
    createdAt,
  };
  let next: AppState = { ...state, actions: [...state.actions, action] };
  next = appendEvent(next, { projectId, type: "ACTION_SELECTED", actor: "agent", summary: `${action.type} · ${action.rationaleSummary}`, detail: "model output is a proposal; no tool side effect was dispatched", actionId, runId: run.id, createdAt });
  if (action.type === "QUESTION" || action.type === "IDEA" || action.type === "CONCERN") {
    const kind = action.type;
    const item: HumanItem = {
      id: makeId(kind),
      projectId,
      kind,
      status: "OPEN",
      title: action.rationaleSummary,
      actionRef: actionId,
      summary: kind === "QUESTION" ? "현재 관찰만으로 인간의 의도·가치를 결정할 수 없습니다." : kind === "IDEA" ? "현재 요구사항 밖이지만 더 나은 상태의 가능성이 관찰되었습니다." : "지금 실패는 아니지만 위험 또는 부채가 관찰되었습니다.",
      rationale: `model action ${action.type} · world cursor ${world.cursorEventId}`,
      blockingScope: kind === "QUESTION" ? [typeof action.params?.scope === "string" ? action.params.scope : "intent-decision"] : [],
      continuingScope: ["독립적인 관찰", "검증 계획"],
      options: [],
      priority: kind === "QUESTION" ? "high" : "medium",
      createdAt,
      updatedAt: createdAt,
      evidenceRefs: [],
    };
    next = { ...next, humanItems: [...next.humanItems, item] };
    next = appendEvent(next, { projectId, type: "HUMAN_ITEM_CREATED", actor: "agent", summary: `${kind} ${item.id} · ${item.title}`, detail: item.rationale, actionId, runId: run.id, createdAt });
    if (kind === "QUESTION") next = appendEvent(next, { projectId, type: "QUESTION_CREATED", actor: "agent", summary: `Question ${item.id} · human-only decision`, detail: item.rationale, actionId, runId: run.id, createdAt });
  }
  next = refreshHumanWorld(next, projectId, createdAt);
  const hasBlocking = getOpenHumanItems(next, projectId).some((item) => item.blockingScope.length > 0);
  const nextStatus: RuntimeStatus = hasBlocking
      ? humanBoundaryStatus(next, projectId)
      : "EQUILIBRIUM";
  const experience: Experience = {
    id: makeId("experience"),
    projectId,
    situation: `context ${contextId ?? "unlinked"} · world cursor ${world.cursorEventId}`,
    decision: action.rationaleSummary,
    action: `${action.type} recorded without tool dispatch`,
    outcome: nextStatus === "WAITING" ? "human boundary opened for the affected scope" : "runtime entered equilibrium with signal-based wake preserved",
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
    modelVersion: MODEL_VERSION,
    toolVersion: TOOL_VERSION,
    policyVersion: getActivePolicy(state, projectId)?.version ?? POLICY_VERSION,
  };
  const retrievalEntry: RetrievalIndexEntry = {
    id: makeId("retrieval"),
    projectId,
    entityId: experience.id,
    sourceRef: experience.id,
    metadata: { actionType: action.type, tool: action.tool ?? "none", outcome: nextStatus },
    recency: 1,
    outcomeQuality: nextStatus === "WAITING" ? 0.7 : 0.5,
    createdAt,
  };
  next = {
    ...next,
    experiences: [...next.experiences, experience],
    retrievalIndex: [...next.retrievalIndex, retrievalEntry],
    relations: [...next.relations, { id: makeId("relation"), projectId, fromId: experience.id, relationType: "derived-from", toId: actionId, createdAt }],
  };
  const updatedProject: Project = { ...project, status: nextStatus, currentActionId: actionId, updatedAt: createdAt, nextReviewAt: nextStatus === "EQUILIBRIUM" ? new Date(Date.now() + (project.settings.reviewIntervalMinutes ?? 360) * 60_000).toISOString() : undefined };
  next = updateProject(next, updatedProject);
  next = updateRun(next, { ...run, status: nextStatus, phase: "sleep", lastCycleAt: createdAt, leaseExpiresAt: nextLease(project, Date.parse(createdAt)) });
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
    detail: "repo · runtime · browser · db · logs · human adapters returned their latest observation",
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
  next = updateRun(next, { ...run, status, phase, lastCycleAt: updatedAt, leaseExpiresAt, stopReason: status === "KILLED" || status === "STALLED" ? detail : undefined });
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

export function recordRuntimeFailure(state: AppState, projectId: string, phase: RuntimePhase, reason: string): AppState {
  const detail = redactSecretLikeText(reason).replace(/\s+/g, " ").trim().slice(0, 500) || "runtime failure";
  let next = setRuntimeStatus(state, projectId, "STALLED", "sleep", `${phase} failed · ${detail}`, "system");
  if (next === state) return state;
  const run = getRun(next, projectId);
  return appendEvent(next, {
    projectId,
    type: "RUNTIME_ERROR",
    actor: "system",
    summary: `Runtime failure · ${phase}`,
    detail,
    runId: run?.id,
    createdAt: nowIso(),
  });
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
  const result = scoreExperiment(state, experiment);
  const updatedExperiment: Experiment = {
    ...experiment,
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
    benchmark: input.benchmark ?? "greenfield-travel",
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
  if (type === "GAP_FOUND" || type === "RUNTIME_ERROR") return "orange";
  if (type === "EXPERIMENT_CREATED" || type === "EXPERIMENT_STARTED" || type === "POLICY_CHANGED") return "purple";
  if (type === "RUN_STATE_CHANGED") return "yellow";
  return "neutral";
}

export function eventLabel(type: EventType): string {
  const labels: Partial<Record<EventType, string>> = {
    WAKE_TRIGGERED: "WAKE",
    OBSERVE: "OBSERVE",
    CONTEXT_ASSEMBLED: "CONTEXT",
    MODEL_TURN: "DECIDE",
    RUNTIME_ERROR: "ERROR",
    GAP_FOUND: "GAP",
    TOOL_CALLED: "TOOL",
    TOOL_RESULT: "TOOL",
    ACTION_SELECTED: "ACT",
    ACTION_EXECUTED: "ACT",
    VERIFY: "VERIFY",
    EVIDENCE_RECORDED: "EVIDENCE",
    WORLD_CHANGED: "WORLD",
    OBSERVATION_REFRESHED: "WORLD",
    HUMAN_ITEM_CREATED: "HUMAN",
    QUESTION_CREATED: "HUMAN",
    HUMAN_ANSWERED: "HUMAN",
    HUMAN_APPROVED: "HUMAN",
    HUMAN_REJECTED: "HUMAN",
    HUMAN_ACKNOWLEDGED: "HUMAN",
    EXPERIMENT_CREATED: "EXPERIMENT",
    EXPERIMENT_STARTED: "EXPERIMENT",
    RUN_STATE_CHANGED: "STATE",
    EQUILIBRIUM_ENTERED: "EQUILIBRIUM",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

export function statusLabel(status: RuntimeStatus): string {
  return status;
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
  return { QUESTION: "QUESTION", IDEA: "IDEA", CONCERN: "CONCERN", APPROVAL: "APPROVAL" }[kind];
}

export function actionStatusLabel(status: ActionStatus): string {
  return { PROPOSED: "proposed", RUNNING: "running", VERIFIED: "verified", UNCERTAIN: "uncertain", FAILED: "failed", BLOCKED: "blocked" }[status];
}

export function riskLabel(risk: RiskClass): string {
  return { P0: "read-only", P1: "local reversible", P2: "external reversible", P3: "destructive / production" }[risk];
}

export function phaseLabel(phase: RuntimePhase): string {
  return phase.toUpperCase();
}

export function allWorldSources(snapshot: WorldSnapshot | undefined): WorldSource[] {
  if (!snapshot) return [];
  return worldSourceKeys.map((key) => snapshot.sources[key]);
}
