import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, copyFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { evaluateProject, type ProjectEvaluation } from "../src/evaluation";
import { scoreExperiment, type BenchmarkScenario } from "../src/experimentHarness";
import { createProject, getProject, getRun } from "../src/runtime";
import type { ModelGateway } from "../src/ports";
import type { ActionEnvelope, AppState, ContextPacket, Experiment } from "../src/types";
import { executeLocalCycle } from "./localRuntime";
import { stopProcessesForRun } from "./processManager";

export type AblationVariantKey = "A" | "B" | "C" | "D" | "E";

export interface AblationVariantResult {
  key: AblationVariantKey;
  title: string;
  projectId: string;
  workspacePath: string;
  startingWorkspaceDigest: string;
  state: AppState;
  evaluation: ProjectEvaluation;
  runIds: string[];
  evaluationEvidenceRefs: string[];
  actionCount: number;
  cycleCount: number;
  reachedWait: boolean;
  score: string;
  passed: boolean;
  evaluatorRefs: string[];
}

export interface AblationComparison {
  sourceWorkspace: string;
  sourceWorkspaceDigest: string;
  rootPath: string;
  variants: AblationVariantResult[];
  cleanup(): void;
}

export interface AblationRunnerOptions {
  scenario: BenchmarkScenario;
  startingWorkspace: string;
  model: ModelGateway;
  budgetLimit: number;
  maxHours?: number;
  maxCycles?: number;
  projectIdPrefix?: string;
  variants?: readonly AblationVariantKey[];
  outputRoot?: string;
}

const variantTitles: Record<AblationVariantKey, string> = {
  A: "single-call control (not a commercial coding-agent baseline)",
  B: "persistent closed loop without discovery signals",
  C: "persistent loop with discovery context",
  D: "persistent loop with experience retrieval",
  E: "persistent loop with evidence-gated policy candidates",
};

function emptyState(): AppState {
  return {
    schemaVersion: 1,
    activeProjectId: "",
    projects: [],
    intents: [],
    runs: [],
    actions: [],
    worldSnapshots: [],
    observations: [],
    contexts: [],
    events: [],
    evidence: [],
    humanItems: [],
    artifacts: [],
    experiences: [],
    policies: [],
    resourceLedger: [],
    relations: [],
    retrievalIndex: [],
    experiments: [],
    approvalGrants: [],
    processes: [],
  };
}

function assertDirectory(path: string, label: string): string {
  const candidate = resolve(path);
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) throw new Error(`${label} must be an existing directory`);
  return realpathSync.native(candidate);
}

function assertInside(root: string, candidate: string): void {
  const distance = relative(root, candidate);
  if (distance === ".." || distance.startsWith(`..${sep}`) || /^[a-zA-Z]:/.test(distance)) throw new Error("ablation path escapes its output root");
}

function copyWorkspace(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`starting workspace contains unsupported symlink: ${entry.name}`);
    if (entry.isDirectory()) copyWorkspace(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error(`starting workspace contains unsupported filesystem entry: ${entry.name}`);
  }
}

function workspaceDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const name = relative(root, absolute).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) throw new Error(`workspace digest encountered a symlink: ${name}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

/**
 * Applies only the explicit experiment ablation. Production runtime context
 * assembly remains complete; the reduced packets make the baseline boundary
 * visible and reproducible without introducing a fixed developer workflow.
 */
export function ablationContextProjection(variant: AblationVariantKey): (context: ContextPacket) => ContextPacket {
  return (context) => {
    if (variant === "A") return {
      ...context,
      observationRefs: [],
      observationViews: [],
      openHumanItemRefs: [],
      openHumanItemViews: [],
      experienceRefs: [],
      relevantExperienceViews: [],
      recentActionViews: [],
      recentEvidenceViews: [],
      activeApprovalGrantViews: [],
      activeProcessViews: [],
      activeIncidentRefs: [],
      untrustedObservationRefs: [],
      policyCandidateViews: [],
    };
    if (variant === "B") return {
      ...context,
      openHumanItemRefs: [],
      openHumanItemViews: [],
      activeIncidentRefs: [],
      untrustedObservationRefs: [],
      experienceRefs: [],
      relevantExperienceViews: [],
      policyCandidateViews: [],
    };
    if (variant === "C") return {
      ...context,
      experienceRefs: [],
      relevantExperienceViews: [],
      policyCandidateViews: [],
    };
    if (variant === "D") return {
      ...context,
      policyCandidateViews: [],
    };
    return context;
  };
}

function safeVariantList(variants: readonly AblationVariantKey[] | undefined): AblationVariantKey[] {
  const selected: AblationVariantKey[] = variants?.length ? [...variants] : ["A", "B", "C", "D", "E"];
  const allowed = new Set<AblationVariantKey>(["A", "B", "C", "D", "E"]);
  if (selected.some((variant) => !allowed.has(variant))) throw new Error("ablation variants must be one of A, B, C, D, or E");
  return [...new Set(selected)];
}

function experimentForVariant(state: AppState, projectId: string, scenario: BenchmarkScenario, variant: AblationVariantKey, runIds: string[], evidenceRefs: string[]): Experiment {
  return {
    id: `experiment-${projectId}`,
    projectId,
    key: "H2",
    title: `${scenario.title} · ${variant}`,
    hypothesis: "동일 Intent·model·budget에서 runtime variant의 실제 outcome을 비교",
    description: "isolated workspace, actual tool results, evaluator evidence, and run provenance",
    variant,
    status: "ready",
    score: "—",
    updatedAt: new Date().toISOString(),
    benchmark: scenario.id,
    budgetLimit: state.projects.find((project) => project.id === projectId)?.settings.budgetLimit,
    hiddenCriteria: scenario.hiddenCriteria,
    evaluatorRefs: [],
    runIds,
    evaluationEvidenceRefs: evidenceRefs,
  };
}

async function runVariant(options: AblationRunnerOptions, variant: AblationVariantKey, rootPath: string, sourceDigest: string, model: ModelGateway): Promise<AblationVariantResult> {
  const projectId = `${options.projectIdPrefix ?? "ablation"}-${variant.toLowerCase()}`;
  const workspacePath = join(rootPath, variant);
  assertInside(rootPath, workspacePath);
  copyWorkspace(options.startingWorkspace, workspacePath);
  const settings = {
    workspacePath,
    budgetLimit: options.budgetLimit,
    maxHours: options.maxHours ?? 1,
    localActions: true,
    requireExternalApproval: true,
    productionBlocked: true,
    networkPolicy: "allowlist" as const,
    allowedDomains: ["registry.npmjs.org", "localhost", "127.0.0.1"],
    sandboxMode: "process" as const,
    modelProvider: "openai-compatible" as const,
    cycleDelayMs: 0,
    failureThreshold: 3,
    noProgressThreshold: 5,
  };
  let state = createProject(emptyState(), options.scenario.intent, projectId, settings);
  const maxCycles = Math.max(1, Math.min(512, Math.floor(options.maxCycles ?? 24)));
  let reachedWait = false;
  for (let cycle = 0; cycle < (variant === "A" ? 1 : maxCycles); cycle += 1) {
    state = await executeLocalCycle(state, projectId, { modelGateway: model, contextProjection: ablationContextProjection(variant) });
    const latest = state.actions.filter((action) => action.projectId === projectId).at(-1);
    if (!latest) break;
    if (latest.type === "WAIT") { reachedWait = true; break; }
    const status = getProject(state, projectId)?.status;
    if (status === "STALLED" || status === "WAITING" || status === "KILLED" || status === "PAUSED") break;
  }
  const run = getRun(state, projectId);
  if (run) {
    await stopProcessesForRun(state.processes, run.id);
    state = { ...state, runs: state.runs.map((candidate) => candidate.id === run.id ? { ...candidate, activeProcessIds: [] } : candidate) };
  }
  const evaluation = evaluateProject(state, projectId, options.scenario.hiddenCriteria);
  const runIds = run ? [run.id] : [];
  const evidenceRefs = state.evidence.filter((evidence) => evidence.projectId === projectId).map((evidence) => evidence.id);
  const score = scoreExperiment(state, experimentForVariant(state, projectId, options.scenario, variant, runIds, evidenceRefs));
  return {
    key: variant,
    title: variantTitles[variant],
    projectId,
    workspacePath,
    startingWorkspaceDigest: sourceDigest,
    state,
    evaluation,
    runIds,
    evaluationEvidenceRefs: evidenceRefs,
    actionCount: state.actions.filter((action) => action.projectId === projectId).length,
    cycleCount: run?.cycleCount ?? 0,
    reachedWait,
    score: score.score,
    passed: score.passed,
    evaluatorRefs: score.evaluatorRefs,
  };
}

/** Runs comparable A–E variants against real local tools in isolated workspaces. */
export async function runAblationComparison(options: AblationRunnerOptions): Promise<AblationComparison> {
  const sourceWorkspace = assertDirectory(options.startingWorkspace, "startingWorkspace");
  if (!Number.isFinite(options.budgetLimit) || options.budgetLimit <= 0) throw new Error("budgetLimit must be positive");
  if (!options.scenario.intent.trim()) throw new Error("scenario intent must be non-empty");
  const variants = safeVariantList(options.variants);
  const ownsRoot = !options.outputRoot;
  const rootPath = options.outputRoot ? resolve(options.outputRoot) : mkdtempSync(join(process.cwd(), ".intent-world-ablation-"));
  mkdirSync(rootPath, { recursive: true });
  const sourceDigest = workspaceDigest(sourceWorkspace);
  const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const previousRawDirectory = process.env.INTENT_WORLD_RAW_DIR;
  process.env.WORKSPACE_ROOT = rootPath;
  process.env.INTENT_WORLD_RAW_DIR = join(rootPath, "raw");
  mkdirSync(process.env.INTENT_WORLD_RAW_DIR, { recursive: true });
  try {
    const results: AblationVariantResult[] = [];
    for (const variant of variants) results.push(await runVariant(options, variant, rootPath, sourceDigest, options.model));
    return {
      sourceWorkspace,
      sourceWorkspaceDigest: sourceDigest,
      rootPath,
      variants: results,
      cleanup: () => {
        if (ownsRoot) rmSync(rootPath, { recursive: true, force: true });
      },
    };
  } finally {
    if (previousWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousRawDirectory === undefined) delete process.env.INTENT_WORLD_RAW_DIR; else process.env.INTENT_WORLD_RAW_DIR = previousRawDirectory;
  }
}
