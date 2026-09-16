import type {
  ActionEnvelope,
  AppState,
  ContextPacket,
  Evidence,
  EventRecord,
  Observation,
  ObservationSource,
  Project,
  ResourceLedger,
  Run,
  Verdict,
  WorldSnapshot,
  ManagedProcess,
} from "./types";

/** Runtime boundaries from the architecture spec. Implementations may be local, remote, or sandbox-backed. */
export interface ModelCapabilities {
  modelVersion: string;
  supportsStructuredActions: boolean;
  contextWindow: number;
  reasoningModes: string[];
}

export interface ModelUsage {
  modelVersion: string;
  tokens: number;
  cost: number;
  latencyMs: number;
}

export interface ModelGateway {
  decide(context: ContextPacket): Promise<ActionEnvelope>;
  capabilities(): Promise<ModelCapabilities>;
  usage(runId: string): Promise<ModelUsage>;
}

export interface SandboxContext {
  projectId: string;
  runId: string;
  permissionClass: "P0" | "P1" | "P2" | "P3";
  networkPolicy: "deny" | "allowlist";
  allowedDomains: string[];
  workspaceRef: string;
  sandboxId?: string;
  createdAt?: string;
  mode?: "process" | "docker";
  image?: string;
  processMaxLifetimeMs?: number;
  maxConcurrentProcesses?: number;
}

export interface ToolResult {
  tool: string;
  toolVersion: string;
  status: "succeeded" | "failed" | "blocked";
  outputRef: string;
  summary: string;
  evidence: Evidence[];
  cost: number;
  wallTimeMs: number;
  output?: string;
  blockedReason?: string;
  artifactRefs?: string[];
  progress?: "meaningful" | "none";
  changedPaths?: string[];
  process?: ManagedProcess;
  observations?: Observation[];
}

export interface ToolGateway {
  execute(action: ActionEnvelope, sandbox: SandboxContext): Promise<ToolResult>;
}

export interface EvaluatorResult {
  verdict: Verdict;
  summary: string;
  evidenceRefs: string[];
  evaluatorVersion: string;
}

export interface Evaluator {
  evaluate(claim: string, evidence: Evidence[], world: WorldSnapshot): Promise<EvaluatorResult>;
}

export interface WorldAdapterInput {
  project: Project;
  run: Run;
  previousWorld?: WorldSnapshot;
  state: AppState;
}

export interface WorldAdapter {
  source: ObservationSource;
  observe(input: WorldAdapterInput): Promise<Observation>;
}

export interface EventStore {
  append(event: EventRecord): Promise<EventRecord>;
  list(projectId: string, afterCursor?: string): Promise<EventRecord[]>;
}

export interface MemoryService {
  retrieve(context: ContextPacket): Promise<string[]>;
  consolidate(projectId: string): Promise<void>;
}

export interface ResourceLedgerStore {
  read(projectId: string, runId: string): Promise<ResourceLedger | undefined>;
  record(ledger: ResourceLedger): Promise<ResourceLedger>;
}

export interface SandboxManager {
  create(project: Project, run: Run): Promise<SandboxContext>;
  destroy(sandbox: SandboxContext): Promise<void>;
  kill(sandbox: SandboxContext): Promise<void>;
}

/** Raw secret values never cross this interface into model context or tool output. */
export interface SecretsBroker {
  issue(scope: { projectId: string; runId: string; names: string[]; ttlSeconds: number }): Promise<{ leaseId: string; expiresAt: string }>;
  revoke(leaseId: string): Promise<void>;
}

export interface ObservabilitySink {
  span(name: string, attributes: Record<string, string | number | boolean>): { end(attributes?: Record<string, string | number | boolean>): void };
  metric(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface RuntimePorts {
  model: ModelGateway;
  tools: ToolGateway;
  evaluator: Evaluator;
  world: WorldAdapter[];
  sandbox: SandboxManager;
  memory: MemoryService;
  ledger: ResourceLedgerStore;
}

export interface RuntimeJob {
  id: string;
  projectId: string;
  runId: string;
  trigger: "intent" | "human-answer" | "incident" | "scheduled-review" | "user-feedback" | "dependency-security" | "signal" | "manual";
  attempts: number;
  availableAt: string;
  leaseUntil?: string;
  leasedBy?: string;
}

export interface JobQueue {
  enqueue(job: Omit<RuntimeJob, "id" | "attempts" | "availableAt"> & Partial<Pick<RuntimeJob, "id" | "attempts" | "availableAt">>): Promise<RuntimeJob>;
  lease(workerId: string, leaseMs: number): Promise<RuntimeJob | undefined>;
  ack(jobId: string, workerId?: string): Promise<void>;
  retry(jobId: string, delayMs: number, workerId?: string): Promise<void>;
}

export interface ControlPlane {
  createProject(rawIntent: string): Promise<Project>;
  addIntent(projectId: string, rawText: string): Promise<void>;
  getProject(projectId: string): Promise<Project | undefined>;
  wake(projectId: string, trigger: string): Promise<void>;
  getRun(runId: string): Promise<Run | undefined>;
  stream(projectId: string, onEvent: (event: EventRecord) => void): () => void;
}
