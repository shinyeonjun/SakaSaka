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
export type ActionStatus = "PROPOSED" | "RUNNING" | "VERIFIED" | "FAILED" | "BLOCKED";
export type RiskClass = "P0" | "P1" | "P2" | "P3";

export type EventType =
  | "PROJECT_CREATED"
  | "INTENT_CREATED"
  | "WAKE_TRIGGERED"
  | "OBSERVE"
  | "CONTEXT_ASSEMBLED"
  | "MODEL_TURN"
  | "GAP_FOUND"
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
  | "OBSERVATION_REFRESHED";

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
  localActions: boolean;
  requireExternalApproval: boolean;
  productionBlocked: boolean;
  networkPolicy: "deny" | "allowlist";
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
  status: "healthy" | "warning" | "blocked";
  summary: string;
  observedAt: string;
  freshness: "fresh" | "aging" | "stale";
  trustLevel: "verified" | "observed" | "untrusted";
  relatedEntities: string[];
}

export interface WorldSnapshot {
  id: string;
  projectId: string;
  cursorEventId: string;
  observedAt: string;
  summary: string;
  sources: Record<WorldSourceKey, WorldSource>;
}

export type ObservationSource = WorldSourceKey | "shell";

export interface Observation {
  id: string;
  projectId: string;
  source: ObservationSource;
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
}

export interface ActionEnvelope {
  type: ActionType;
  intentRef: string;
  worldCursor: string;
  rationaleSummary: string;
  tool?: string;
  params?: Record<string, string | number | boolean>;
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
  candidateId?: string;
  status: ActionStatus;
  cost: number;
  modelVersion: string;
  toolVersion?: string;
  policyVersion: number;
  contextId?: string;
  createdAt: string;
  completedAt?: string;
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
  stopReason?: string;
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
  rationale: string;
  blockingScope: string[];
  continuingScope: string[];
  options: HumanOption[];
  answer?: string;
  answerLabel?: string;
  priority: "high" | "medium" | "low";
  createdAt: string;
  updatedAt: string;
  evidenceRefs: string[];
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
}

export interface AppState {
  schemaVersion: 1;
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
}
