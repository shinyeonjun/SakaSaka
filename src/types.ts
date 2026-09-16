import type { InputSchema } from "./toolContracts";
import type { ModelFailure } from "./modelFailure";
export type RuntimeStatus =
  | "ACTIVE"
  | "WAITING"
  | "EQUILIBRIUM"
  | "STALLED"
  | "PAUSED"
  | "KILLED";

export type RuntimePhase =
  | "idle"
  | "wake"
  | "observe"
  | "assemble"
  | "decide"
  | "dispatch"
  | "verify"
  | "govern"
  | "sleep";

export type HumanItemKind = "QUESTION" | "IDEA" | "CONCERN" | "APPROVAL";
export type HumanItemStatus =
  | "OPEN"
  | "ANSWERED"
  | "APPROVED"
  | "REJECTED"
  | "DEFERRED"
  | "ACKNOWLEDGED";

export type ActionType = "ACT" | "QUESTION" | "IDEA" | "CONCERN" | "WAIT";
export type ActionStatus = "PROPOSED" | "RUNNING" | "VERIFIED" | "UNCERTAIN" | "FAILED" | "BLOCKED";
export type RiskClass = "P0" | "P1" | "P2" | "P3";

export type EventType =
  | "PROJECT_CREATED"
  | "INTENT_CREATED"
  | "WAKE_TRIGGERED"
  | "OBSERVE"
  | "CONTEXT_ASSEMBLED"
  | "MODEL_TURN"
  | "MODEL_FAILED"
  | "CYCLE_PHASE"
  | "CYCLE_DISCARDED"
  | "RUNTIME_ERROR"
  | "GAP_FOUND"
  | "QUESTION_CREATED"
  | "TOOL_CALLED"
  | "TOOL_RESULT"
  | "ACTION_SELECTED"
  | "ACTION_EXECUTED"
  | "VERIFY"
  | "WORLD_CHANGED"
  | "EVIDENCE_RECORDED"
  | "RUN_STATE_CHANGED"
  | "HUMAN_ITEM_CREATED"
  | "HUMAN_ANSWERED"
  | "HUMAN_APPROVED"
  | "HUMAN_REJECTED"
  | "HUMAN_DEFERRED"
  | "HUMAN_ACKNOWLEDGED"
  | "ARTIFACT_CREATED"
  | "EXPERIMENT_CREATED"
  | "EXPERIMENT_STARTED"
  | "EQUILIBRIUM_ENTERED"
  | "POLICY_CHANGED"
  | "OBSERVATION_REFRESHED"
  | "WORKSPACE_CHANGED"
  | "PROCESS_STARTED"
  | "PROCESS_EXITED"
  | "APPROVAL_GRANT_ISSUED"
  | "APPROVAL_GRANT_CONSUMED"
  | "JOB_ENQUEUED";

export type EventActor = "human" | "agent" | "system";
export type EvidenceKind = "test" | "browser" | "screenshot" | "world" | "metric" | "human";
export type Verdict = "PASS" | "FAIL" | "UNCERTAIN";
export type ArtifactKind = "build" | "report" | "screenshot" | "release" | "docs";
export type ExperimentStatus = "ready" | "running" | "passed" | "needs-review";

export const worldSourceKeys = ["repo", "runtime", "browser", "db", "logs", "human"] as const;
export type WorldSourceKey = (typeof worldSourceKeys)[number];

export interface ProjectSettings {
  budgetLimit: number;
  maxHours: number;
  /** Hard cap even when CLI billing cannot be measured. */
  maxModelCalls?: number;
  localActions: boolean;
  requireExternalApproval: boolean;
  productionBlocked: boolean;
  networkPolicy: "deny" | "allowlist";
  /** API-created projects may bind a local workspace; browser-only projects leave this unset. */
  workspacePath?: string;
  previewUrl?: string;
  allowedDomains?: string[];
  sandboxMode?: "process" | "docker";
  modelProvider?: "auto" | "deterministic" | "openai-compatible" | "codex-cli";
  /** Optional provider-specific model id; an empty value delegates to provider defaults. */
  modelName?: string;
  reviewIntervalMinutes?: number;
  failureThreshold?: number;
  noProgressThreshold?: number;
  cycleDelayMs?: number;
  approvalTtlMinutes?: number;
  processMaxLifetimeMs?: number;
  maxConcurrentProcesses?: number;
}

export type ModelProvider = NonNullable<ProjectSettings["modelProvider"]>;
export type ResolvedModelProvider = "deterministic" | "openai-compatible" | "codex-cli" | "unavailable";
export type ProviderConnectionState = "connected" | "configured" | "unknown" | "needs-setup" | "unavailable";

export interface ModelProviderStatus {
  requested: ModelProvider;
  effective: ResolvedModelProvider;
  state: ProviderConnectionState;
  displayName: string;
  detail: string;
  selectedModel?: string;
  availableModels: string[];
  binary?: string;
  version?: string;
  authentication: "not-applicable" | "configured" | "verified" | "unverified" | "missing";
  checkedAt: string;
}

export interface ModelCatalog {
  models: string[];
  defaultModel?: string;
  entries?: ModelCatalogEntry[];
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  group?: "recommended" | "configured";
}

export type WorkspaceBindingState = "bound" | "missing" | "inaccessible" | "unbound" | "rejected";

export interface WorkspaceBindingStatus {
  state: WorkspaceBindingState;
  root: string;
  configuredPath?: string;
  resolvedPath?: string;
  exists: boolean;
  writable: boolean;
  detail: string;
}

export interface RuntimeConnectionStatus {
  model: ModelProviderStatus;
  workspace: WorkspaceBindingStatus;
}

export interface ProjectMetrics {
  testsPassed: number;
  testsTotal: number;
  evidenceCoverage: number;
  humanOrchestrationCount: number;
  initiativeRecall: number;
  initiativePrecision: number;
}

export interface Project {
  id: string;
  name: string;
  subtitle: string;
  status: RuntimeStatus;
  intentId: string;
  activeRunId: string;
  currentActionId?: string;
  createdAt: string;
  updatedAt: string;
  budgetSpent: number;
  settings: ProjectSettings;
  metrics: ProjectMetrics;
  nextReviewAt?: string;
}

export interface Intent {
  id: string;
  projectId: string;
  rawText: string;
  constraints: string[];
  version: number;
  createdAt: string;
}

export interface WorldSource {
  key: WorldSourceKey;
  label: string;
  status: "healthy" | "warning" | "blocked" | "absent" | "not-configured";
  summary: string;
  observedAt: string;
  freshness: "fresh" | "aging" | "stale";
  trustLevel: "verified" | "observed" | "untrusted";
  relatedEntities: string[];
}

export interface WorldSnapshot {
  /** Evidence-only snapshot from work superseded by a newer human decision. */
  superseded?: boolean;
  id: string;
  projectId: string;
  cursorEventId: string;
  observedAt: string;
  summary: string;
  sources: Record<WorldSourceKey, WorldSource>;
}

export type ObservationSource = WorldSourceKey | "shell" | "workspace" | "process";

export interface Observation {
  id: string;
  projectId: string;
  source: ObservationSource;
  status: WorldSource["status"];
  observedAt: string;
  freshness: WorldSource["freshness"];
  rawRef: string;
  compactView: string;
  trustLevel: WorldSource["trustLevel"];
  confidence: number;
  relatedEntities: string[];
}

export interface Evidence {
  id: string;
  projectId: string;
  kind: EvidenceKind;
  verdict: Verdict;
  summary: string;
  source: string;
  createdAt: string;
  actionId?: string;
  evaluator?: string;
  evaluatorVersion?: string;
  rawRef?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type ActionParamValue = string | number | boolean | string[];

export interface ActionEnvelope {
  type: ActionType;
  intentRef: string;
  worldCursor: string;
  rationaleSummary: string;
  tool?: string;
  params?: Record<string, ActionParamValue>;
  expectedValue?: number;
  riskClass?: RiskClass;
  evidencePlan?: string[];
}

export type ActionForce = "closure" | "discovery" | "boundary" | "wait";

export interface ActionScore {
  goalGap: number;
  informationGain: number;
  evidenceGain: number;
  cost: number;
  risk: number;
  total: number;
}

export interface ActionCandidate extends ActionEnvelope {
  id: string;
  projectId: string;
  force: ActionForce;
  score: ActionScore;
  sourceRefs: string[];
}

export interface AgentAction extends ActionEnvelope {
  id: string;
  projectId: string;
  runId: string;
  schemaVersion: 1;
  candidateId?: string;
  status: ActionStatus;
  cost: number;
  modelVersion: string;
  toolVersion?: string;
  policyVersion: number;
  contextId?: string;
  createdAt: string;
  completedAt?: string;
  toolResultRef?: string;
  boundaryDecision?: "allowed" | "blocked" | "human-approval";
  approvalGrantId?: string;
}

export interface Run {
  id: string;
  projectId: string;
  status: RuntimeStatus;
  phase: RuntimePhase;
  cycleCount: number;
  startedAt: string;
  lastCycleAt: string;
  leaseExpiresAt: string;
  consecutiveFailures: number;
  noProgressCycles: number;
  lastMeaningfulProgressAt?: string;
  lastFailureSignature?: string;
  activeProcessIds: string[];
  stopReason?: string;
  lastModelFailure?: ModelFailure;
  retryAfter?: string;
  execution?: { id: string; owner: string; expiresAt: string; stage: RuntimePhase; dispatchStarted?: boolean; action?: ActionEnvelope };
}

export interface EventRecord {
  id: string;
  sequence?: number;
  projectId: string;
  type: EventType;
  actor: EventActor;
  summary: string;
  detail?: string;
  createdAt: string;
  runId?: string;
  actionId?: string;
  evidenceIds?: string[];
  payload?: Record<string, string | number | boolean | string[]>;
  modelVersion?: string;
  toolVersion?: string;
  policyVersion?: number;
  schemaVersion: 1;
}

export interface ContextPacket {
  id: string;
  projectId: string;
  intentRef: string;
  worldCursor: string;
  rawIntent: string;
  constraints: string[];
  observationRefs: string[];
  openHumanItemRefs: string[];
  experienceRefs: string[];
  boundary: {
    remainingBudget: number;
    remainingModelCalls?: number;
    maxHours: number;
    networkPolicy: ProjectSettings["networkPolicy"];
    productionBlocked: boolean;
    openApprovalRefs: string[];
  };
  toolSurface: ToolCapability[];
  assembledAt: string;
  schemaVersion: 1;
  modelVersion: string;
  policyVersion: number;
  humanDecisionViews?: Array<{ id: string; kind: HumanItemKind; status: HumanItemStatus; title: string; answer?: string; updatedAt: string; blockingScope: string[] }>;
  lastModelFailure?: ModelFailure;
  /** The active run is part of provenance, but is optional for legacy snapshots. */
  runId?: string;
  /** Compact, source-linked views are safe to pass to a model; raw output stays behind rawRef. */
  observationViews?: Array<{
    id: string;
    source: ObservationSource;
    status: Observation["status"];
    observedAt: string;
    freshness: Observation["freshness"];
    rawRef: string;
    compactView: string;
    trustLevel: Observation["trustLevel"];
    confidence: number;
    relatedEntities: string[];
  }>;
  openHumanItemViews?: Array<{
    id: string;
    kind: HumanItemKind;
    status: HumanItemStatus;
    title: string;
    summary: string;
    blockingScope: string[];
    continuingScope: string[];
  }>;
  relevantExperienceViews?: Array<{
    id: string;
    situation: string;
    decision: string;
    action: string;
    outcome: string;
    evidenceIds: string[];
    risk: RiskClass;
    createdAt: string;
  }>;
  recentActionViews?: Array<{
    id: string;
    type: ActionType;
    status: ActionStatus;
    tool?: string;
    params?: Record<string, ActionParamValue>;
    rationaleSummary: string;
    intentRef: string;
    worldCursor: string;
    approvalGrantId?: string;
    createdAt: string;
  }>;
  recentEvidenceViews?: Array<{
    id: string;
    kind: EvidenceKind;
    verdict: Verdict;
    summary: string;
    source: string;
    actionId?: string;
    rawRef?: string;
    createdAt: string;
  }>;
  activeApprovalGrantViews?: Array<{
    id: string;
    actionFingerprint: string;
    tool?: string;
    expiresAt: string;
  }>;
  activeProcessViews?: Array<{
    id: string;
    argv: string[];
    status: ManagedProcess["status"];
    pid?: number;
    port?: number;
    previewUrl?: string;
    stdoutRawRef?: string;
    stderrRawRef?: string;
  }>;
  /** Runtime errors remain visible until a later verified cycle closes the gap. */
  activeIncidentRefs?: string[];
  untrustedObservationRefs?: string[];
}

export interface ToolCapability {
  name: string;
  description: string;
  riskClass: RiskClass;
  reversible: boolean;
  requiresNetwork: boolean;
  sideEffect: boolean;
  enabled: boolean;
  toolVersion: string;
  inputSchema?: InputSchema;
}

export interface Policy {
  id: string;
  projectId: string;
  version: number;
  representation: string;
  status: "active" | "candidate" | "retired";
  parentPolicyId?: string;
  evalRefs: string[];
  createdAt: string;
}

export interface ResourceLedger {
  id: string;
  projectId: string;
  runId: string;
  tokens: number;
  modelCost: number;
  wallTimeMs: number;
  toolCalls: number;
  sandboxSeconds: number;
  budgetLimit: number;
  updatedAt: string;
}

export type RelationType = "supports" | "derived-from" | "verified-by" | "blocked-by" | "caused" | "contradicts" | "improves";

export interface Relation {
  id: string;
  projectId: string;
  fromId: string;
  relationType: RelationType;
  toId: string;
  createdAt: string;
}

export interface RetrievalIndexEntry {
  id: string;
  projectId: string;
  entityId: string;
  sourceRef: string;
  /** Optional generated vector; the index is always rebuildable from sourceRef. */
  embedding?: number[];
  metadata: Record<string, string | number | boolean>;
  recency: number;
  outcomeQuality: number;
  createdAt: string;
}

export interface HumanOption {
  id: string;
  title: string;
  description: string;
}

export interface HumanItem {
  id: string;
  projectId: string;
  kind: HumanItemKind;
  status: HumanItemStatus;
  title: string;
  summary: string;
  /** Optional detail-page copy. Inbox summaries stay concise and source-specific. */
  detailSummary?: string;
  /** The side effect that caused an approval item, when a boundary blocked it. */
  actionRef?: string;
  rationale: string;
  blockingScope: string[];
  continuingScope: string[];
  options: HumanOption[];
  responseMode?: "choice" | "free-text" | "choice-and-text";
  answer?: string;
  answerLabel?: string;
  priority: "high" | "medium" | "low";
  createdAt: string;
  updatedAt: string;
  evidenceRefs: string[];
}

export interface ApprovalGrant {
  id: string;
  projectId: string;
  approvalItemId: string;
  originalActionRef: string;
  /** Legacy grants without the exact Intent binding must be reapproved. */
  intentRef?: string;
  actionFingerprint: string;
  tool?: string;
  paramsFingerprint: string;
  paramsCanonical: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  singleUse: true;
}

export interface ManagedProcess {
  id: string;
  projectId: string;
  runId: string;
  argv: string[];
  cwd: string;
  pid?: number;
  containerId?: string;
  port?: number;
  previewUrl?: string;
  status: "starting" | "running" | "exited" | "stopped" | "failed";
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  stdoutRawRef?: string;
  stderrRawRef?: string;
  error?: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  name: string;
  status: "ready" | "in-review" | "archived";
  description: string;
  updatedAt: string;
  sourceRef: string;
  sizeLabel: string;
}

export interface Experience {
  id: string;
  projectId: string;
  situation: string;
  decision: string;
  action: string;
  outcome: string;
  evidenceIds: string[];
  cost: number;
  risk: RiskClass;
  humanIntervention: boolean;
  createdAt: string;
  worldBeforeRef?: string;
  worldAfterRef?: string;
  intentRef?: string;
  actionType?: ActionType;
  actionPayloadRef?: string;
  modelVersion?: string;
  toolVersion?: string;
  policyVersion?: number;
}

export interface Experiment {
  id: string;
  projectId: string;
  key: string;
  title: string;
  hypothesis: string;
  description: string;
  variant: string;
  status: ExperimentStatus;
  score: string;
  updatedAt: string;
  benchmark?: string;
  budgetLimit?: number;
  hiddenCriteria?: string[];
  evaluatorRefs?: string[];
  variantConfig?: Record<string, string | number | boolean>;
  runIds?: string[];
  evaluationEvidenceRefs?: string[];
}

export interface AppState {
  schemaVersion: 1;
  revision?: number;
  activeProjectId: string;
  projects: Project[];
  intents: Intent[];
  runs: Run[];
  actions: AgentAction[];
  worldSnapshots: WorldSnapshot[];
  observations: Observation[];
  contexts: ContextPacket[];
  events: EventRecord[];
  evidence: Evidence[];
  humanItems: HumanItem[];
  artifacts: Artifact[];
  experiences: Experience[];
  policies: Policy[];
  resourceLedger: ResourceLedger[];
  relations: Relation[];
  retrievalIndex: RetrievalIndexEntry[];
  experiments: Experiment[];
  approvalGrants: ApprovalGrant[];
  processes: ManagedProcess[];
}
