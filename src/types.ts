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
  | "ARTIFACT_CREATED"
  | "EXPERIMENT_STARTED"
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

export interface AgentAction extends ActionEnvelope {
  id: string;
  projectId: string;
  runId: string;
  status: ActionStatus;
  cost: number;
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
  schemaVersion: 1;
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
  events: EventRecord[];
  evidence: Evidence[];
  humanItems: HumanItem[];
  artifacts: Artifact[];
  experiences: Experience[];
  experiments: Experiment[];
}
