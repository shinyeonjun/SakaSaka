import { worldSourceKeys } from "./types";
import type {
  ActionStatus,
  ActionType,
  AgentAction,
  AppState,
  Artifact,
  ArtifactKind,
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
  Project,
  ProjectSettings,
  RiskClass,
  RuntimePhase,
  RuntimeStatus,
  Run,
  WorldSnapshot,
  WorldSource,
  WorldSourceKey,
} from "./types";

export const nowIso = () => new Date().toISOString();

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

export function getProjectEvents(state: AppState, projectId: string): EventRecord[] {
  return state.events
    .filter((event) => event.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    schemaVersion: 1,
    ...input,
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
      budgetLimit: settings.budgetLimit ?? 30,
      maxHours: settings.maxHours ?? 12,
      localActions: settings.localActions ?? true,
      requireExternalApproval: settings.requireExternalApproval ?? true,
      productionBlocked: settings.productionBlocked ?? true,
      networkPolicy: settings.networkPolicy ?? "allowlist",
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
    leaseExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  };

  let next: AppState = {
    ...state,
    activeProjectId: projectId,
    projects: [...state.projects, project],
    intents: [...state.intents, intent],
    runs: [...state.runs, run],
    worldSnapshots: [...state.worldSnapshots, world],
  };
  next = appendEvent(next, { projectId, type: "PROJECT_CREATED", actor: "human", summary: `${project.name} 프로젝트 생성`, detail: "workspace와 기본 boundary가 설정되었습니다.", createdAt });
  next = appendEvent(next, { projectId, type: "INTENT_CREATED", actor: "human", summary: "원문 Intent 보존", detail: intent.rawText, createdAt });
  next = appendEvent(next, { projectId, type: "RUN_STATE_CHANGED", actor: "system", summary: "ACTIVE · 첫 wake 준비", detail: "lease와 budget은 runtime이 관리합니다.", createdAt });
  return next;
}

function humanStatusForAction(kind: HumanItemKind, action: "answer" | "approve" | "reject" | "defer" | "acknowledge"): HumanItemStatus {
  if (action === "defer") return "DEFERRED";
  if (kind === "QUESTION") return "ANSWERED";
  if (kind === "APPROVAL") return action === "approve" ? "APPROVED" : "REJECTED";
  if (kind === "CONCERN") return "ACKNOWLEDGED";
  return action === "reject" ? "REJECTED" : "ACKNOWLEDGED";
}

export function resolveHumanItem(
  state: AppState,
  itemId: string,
  action: "answer" | "approve" | "reject" | "defer" | "acknowledge",
  answer?: string,
): AppState {
  const item = state.humanItems.find((candidate) => candidate.id === itemId);
  if (!item) return state;
  const updatedAt = nowIso();
  const option = item.options.find((candidate) => candidate.id === answer);
  const status = humanStatusForAction(item.kind, action);
  const updatedItem: HumanItem = {
    ...item,
    status,
    answer,
    answerLabel: option?.title ?? answer,
    updatedAt,
  };
  let next: AppState = { ...state, humanItems: replaceById(state.humanItems, updatedItem) };
  const eventType: EventType =
    action === "answer" ? "HUMAN_ANSWERED" : action === "approve" ? "HUMAN_APPROVED" : action === "reject" ? "HUMAN_REJECTED" : "HUMAN_DEFERRED";
  const actor: EventActor = "human";
  next = appendEvent(next, {
    projectId: item.projectId,
    type: eventType,
    actor,
    summary: `${item.id} · ${status.toLowerCase()}`,
    detail: option?.title ?? answer ?? "Human decision recorded",
    createdAt: updatedAt,
    payload: { itemId: item.id, blockingScope: item.blockingScope },
  });

  const project = getProject(next, item.projectId);
  const run = getRun(next, item.projectId);
  const remainingBlocking = getOpenHumanItems(next, item.projectId).some((candidate) => candidate.blockingScope.length > 0);
  if (project) {
    const nextStatus: RuntimeStatus = project.status === "KILLED" ? "KILLED" : remainingBlocking ? "WAITING" : "ACTIVE";
    next = updateProject(next, { ...project, status: nextStatus, updatedAt });
    next = appendEvent(next, {
      projectId: project.id,
      type: "RUN_STATE_CHANGED",
      actor: "system",
      summary: `${nextStatus} · human boundary updated`,
      detail: remainingBlocking ? "영향받는 scope만 대기하고 독립 작업은 계속합니다." : "답변 후 관련 scope를 다시 계획할 수 있습니다.",
      createdAt: updatedAt,
      runId: run?.id,
    });
  }
  const snapshot = getWorldSnapshot(next, item.projectId);
  if (snapshot) {
    const human = snapshot.sources.human;
    const openCount = getOpenHumanItems(next, item.projectId).length;
    next = withWorldSnapshot(next, {
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
    });
  }
  return next;
}

function actionDescription(cycleCount: number): { summary: string; detail: string; tool: string } {
  if (cycleCount === 0) {
    return {
      summary: "모바일 초대 흐름을 다시 관찰하고 안전 영역을 검증",
      detail: "fresh browser observation → CSS layout check → 390px/430px verify",
      tool: "playwright",
    };
  }
  return {
    summary: "현재 World의 evidence gap을 점검하고 다음 가치 있는 변화를 선택",
    detail: "repo + runtime + human signals를 다시 읽은 뒤 변경 없이도 검증 가능한 범위를 비교",
    tool: "world-adapter",
  };
}

function updateWorldAfterCycle(snapshot: WorldSnapshot, actionId: string, observedAt: string, cycleCount: number): WorldSnapshot {
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
    },
  };
}

export function runCycle(state: AppState, projectId: string): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  const previousWorld = getWorldSnapshot(state, projectId);
  if (!project || !run || !previousWorld || project.status === "PAUSED" || project.status === "KILLED") return state;

  const createdAt = nowIso();
  const nextCycle = run.cycleCount + 1;
  const actionId = makeId("action");
  const cost = 0.38;
  const copy = actionDescription(run.cycleCount);
  const action: AgentAction = {
    id: actionId,
    projectId,
    runId: run.id,
    type: "ACT",
    intentRef: project.intentId,
    worldCursor: previousWorld.cursorEventId,
    rationaleSummary: copy.summary,
    tool: copy.tool,
    params: { cycle: nextCycle, sandbox: true },
    expectedValue: nextCycle === 1 ? 0.88 : 0.41,
    riskClass: "P1",
    evidencePlan: ["browser", "test", "world"],
    status: "VERIFIED",
    cost,
    createdAt,
    completedAt: createdAt,
  };
  const evidenceId = makeId("evidence");
  const cycleEvidence: Evidence = {
    id: evidenceId,
    projectId,
    kind: "world",
    verdict: "PASS",
    summary: nextCycle === 1 ? "390px/430px browser verification passed" : "Fresh world observation completed with no new critical gap",
    source: copy.tool,
    createdAt,
    actionId,
    evaluator: "deterministic world adapter",
  };

  let next: AppState = {
    ...state,
    actions: [...state.actions, action],
    evidence: [...state.evidence, cycleEvidence],
  };
  const eventSteps: Array<{ type: EventType; summary: string; detail?: string; actor?: EventActor }> = [
    { type: "WAKE_TRIGGERED", summary: `cycle ${nextCycle} · lease and budget checked`, detail: "project/world cursor fixed before context assembly" },
    { type: "OBSERVE", summary: nextCycle === 1 ? "Playwright mobile viewport 관찰" : "repo · runtime · human signal 재관찰", detail: copy.detail },
    { type: "CONTEXT_ASSEMBLED", summary: "raw intent + fresh world + open human items + boundary", detail: "retrieved experience is evidence, not an instruction" },
    { type: "MODEL_TURN", summary: "행동 후보를 evidence 기반으로 비교", detail: "hard constraints → risk → required gap → information gain → opportunity" },
    { type: "ACTION_SELECTED", summary: copy.summary, detail: `ActionEnvelope ACT · ${copy.tool}` },
    { type: "ACTION_EXECUTED", summary: "sandbox action dispatched", detail: "P1 local reversible action" },
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
      evidenceIds: step.type === "EVIDENCE_RECORDED" || step.type === "VERIFY" ? [evidenceId] : undefined,
    });
  }

  const nextWorld = updateWorldAfterCycle(previousWorld, actionId, createdAt, nextCycle);
  next = withWorldSnapshot(next, nextWorld);
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

  const hasBlockingHumanItem = getOpenHumanItems(next, projectId).some((item) => item.blockingScope.length > 0);
  const nextStatus: RuntimeStatus = hasBlockingHumanItem ? "WAITING" : "EQUILIBRIUM";
  const nextPhase: RuntimePhase = nextStatus === "EQUILIBRIUM" || nextStatus === "WAITING" ? "sleep" : "govern";
  const updatedRun: Run = { ...run, status: nextStatus, phase: nextPhase, cycleCount: nextCycle, lastCycleAt: createdAt };
  const updatedProject: Project = {
    ...project,
    status: nextStatus,
    currentActionId: actionId,
    updatedAt: createdAt,
    budgetSpent: Math.min(project.settings.budgetLimit, Number((project.budgetSpent + cost).toFixed(2))),
    metrics: {
      ...project.metrics,
      testsPassed: Math.max(project.metrics.testsPassed, 42),
      testsTotal: Math.max(project.metrics.testsTotal, 42),
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
    detail: nextStatus === "WAITING" ? "blocking scope는 human decision을 기다리고, 독립 작업은 보존됩니다." : "현재 비용 대비 가치 높은 행동이 없어 equilibrium에 진입합니다.",
    createdAt,
    runId: run.id,
  });
  const experience: Experience = {
    id: makeId("experience"),
    projectId,
    situation: copy.detail,
    decision: copy.summary,
    action: `${copy.tool} sandbox dispatch`,
    outcome: cycleEvidence.summary,
    evidenceIds: [evidenceId],
    cost,
    risk: "P1",
    humanIntervention: false,
    createdAt,
  };
  next = { ...next, experiences: [...next.experiences, experience] };
  return next;
}

export function refreshWorld(state: AppState, projectId: string): AppState {
  const snapshot = getWorldSnapshot(state, projectId);
  if (!snapshot) return state;
  const observedAt = nowIso();
  const updated = updateWorldAfterCycle(snapshot, snapshot.cursorEventId, observedAt, 2);
  let next = withWorldSnapshot(state, updated);
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
  return next;
}

function setRuntimeStatus(state: AppState, projectId: string, status: RuntimeStatus, phase: RuntimePhase, detail: string): AppState {
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !run) return state;
  const updatedAt = nowIso();
  let next = updateProject(state, { ...project, status, updatedAt });
  next = updateRun(next, { ...run, status, phase, lastCycleAt: updatedAt, stopReason: status === "KILLED" ? detail : undefined });
  return appendEvent(next, {
    projectId,
    type: "RUN_STATE_CHANGED",
    actor: "human",
    summary: `${status} · ${detail}`,
    detail,
    createdAt: updatedAt,
    runId: run.id,
  });
}

export const pauseProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "PAUSED", "sleep", "사용자가 실행을 일시 정지");
export const resumeProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "ACTIVE", "wake", "사용자가 runtime을 다시 시작");
export const wakeProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "ACTIVE", "wake", "새 signal에서 runtime wake");
export const killProject = (state: AppState, projectId: string) => setRuntimeStatus(state, projectId, "KILLED", "sleep", "Run 강제 종료 · lease revoked");

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
  const updatedExperiment: Experiment = {
    ...experiment,
    status: "passed",
    score: experiment.key === "H1" ? "78% recall" : experiment.key === "H3" ? "0.83 precision" : "0.91 utility",
    updatedAt,
  };
  let next = { ...state, experiments: replaceById(state.experiments, updatedExperiment) };
  next = appendEvent(next, { projectId: experiment.projectId, type: "EXPERIMENT_STARTED", actor: "human", summary: `${experiment.key} · ${experiment.title} experiment started`, detail: experiment.hypothesis, createdAt: updatedAt });
  return appendEvent(next, { projectId: experiment.projectId, type: "POLICY_CHANGED", actor: "agent", summary: `${experiment.key} completed · ${updatedExperiment.score}`, detail: "deterministic evidence and independent evaluator hooks recorded", createdAt: updatedAt });
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
  next = updateProject(next, { ...project, intentId: intent.id, status: "ACTIVE", updatedAt: createdAt });
  next = appendEvent(next, { projectId, type: "INTENT_CREATED", actor: "human", summary: `Intent v${intent.version} created`, detail: intent.rawText, createdAt });
  return { intent, state: next };
}

export function eventTone(type: EventType): string {
  if (type === "OBSERVE" || type === "CONTEXT_ASSEMBLED") return "blue";
  if (type === "ACTION_SELECTED" || type === "ACTION_EXECUTED") return "mint";
  if (type === "VERIFY" || type === "EVIDENCE_RECORDED") return "mint";
  if (type === "HUMAN_ITEM_CREATED" || type.startsWith("HUMAN_")) return "pink";
  if (type === "WORLD_CHANGED" || type === "OBSERVATION_REFRESHED") return "purple";
  if (type === "RUN_STATE_CHANGED") return "yellow";
  return "neutral";
}

export function eventLabel(type: EventType): string {
  const labels: Partial<Record<EventType, string>> = {
    WAKE_TRIGGERED: "WAKE",
    OBSERVE: "OBSERVE",
    CONTEXT_ASSEMBLED: "CONTEXT",
    MODEL_TURN: "DECIDE",
    ACTION_SELECTED: "ACT",
    ACTION_EXECUTED: "ACT",
    VERIFY: "VERIFY",
    EVIDENCE_RECORDED: "EVIDENCE",
    WORLD_CHANGED: "WORLD",
    OBSERVATION_REFRESHED: "WORLD",
    HUMAN_ITEM_CREATED: "HUMAN",
    HUMAN_ANSWERED: "HUMAN",
    HUMAN_APPROVED: "HUMAN",
    HUMAN_REJECTED: "HUMAN",
    RUN_STATE_CHANGED: "STATE",
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
  return { PROPOSED: "proposed", RUNNING: "running", VERIFIED: "verified", FAILED: "failed", BLOCKED: "blocked" }[status];
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
