import { updateExecutionSettings } from "../src/nativeSession";
import { mergeCycleResult } from "./cycleCoordinator";
import { checkHttpBoundary, isLoopbackHost } from "./httpBoundary";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, watch } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { createEmptyState } from "../src/emptyState";
import { JsonlEventStore } from "./jsonlEventStore";
import {
  addIntent,
  createArtifact,
  createExperiment,
  createProject,
  deleteProject,
  getProject,
  getProjectContexts,
  getProjectEvents,
  getProjectHumanItems,
  getProjectObservations,
  getProjectRelations,
  getProjectRetrievalEntries,
  getResourceLedger,
  getRun,
  getWorldSnapshot,
  isHumanActionAllowed,
  killProject,
  makeId,
  pauseProject,
  resolveHumanItem,
  resumeProject,
  refreshWorld,
  runCycle,
  runExperiment,
  stallProject,
  updateProjectModelSettings,
  wakeProject,
} from "../src/runtime";
import type { AppState, ArtifactKind, Experiment, ProjectMetrics, ProjectSettings } from "../src/types";
import type { RuntimeJob } from "../src/ports";
import type { ExperimentInput } from "../src/runtime";
import { evaluateProject } from "../src/evaluation";
import { executeLocalCycle, observeLocalWorld } from "./localRuntime";
import { normalizeWorkspacePath, setWorkspaceRootPath, workspaceRootConfigPath, workspaceRootPath } from "./pathPolicy";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";
import { withFileLock } from "./fileLock";
import { JsonJobQueue } from "./jobQueue";
import { provisionProjectWorkspace } from "./workspaceProvisioner";
import { hydrateManagedProcesses, stopProcessesForProject, stopProcessesForRun, stopAllManagedProcesses } from "./processManager";
import { inspectModelConnection, inspectRuntimeConnection, runtimeModelCatalog } from "./runtimeStatus";
import { autonomyStore } from "./autonomyStore";
import { projectAutonomyState } from "./autonomyProjection";

const configuredPort = Number(process.env.API_PORT ?? "8787");
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 8787;
const host = process.env.API_HOST?.trim() || "127.0.0.1";
const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const stateLockPath = `${statePath}.lock`;
const eventJournal = new JsonlEventStore(`${statePath}.events.jsonl`);
const queue = new JsonJobQueue(`${statePath}.queue.json`);
const subscribers = new Map<string, Set<ServerResponse>>();
const maxBodyBytes = 1_048_576;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function normalizeProjectSettings(raw: Partial<ProjectSettings> | undefined): ProjectSettings {
  return {
    budgetLimit: raw?.budgetLimit ?? 30,
    maxHours: raw?.maxHours ?? 12, maxModelCalls: raw?.maxModelCalls ?? 200,
    resourceLimitsDisabled: raw?.resourceLimitsDisabled ?? true,
    localActions: raw?.localActions ?? true,
    requireExternalApproval: raw?.requireExternalApproval ?? true,
    productionBlocked: raw?.productionBlocked ?? true,
    networkPolicy: raw?.networkPolicy ?? "allowlist",
    workspacePath: raw?.workspacePath,
    previewUrl: raw?.previewUrl,
    allowedDomains: raw?.allowedDomains,
    sandboxMode: raw?.sandboxMode ?? "process", executionMode: raw?.executionMode ?? "atomic", maxNativeTurns: raw?.maxNativeTurns, maxNativeTokens: raw?.maxNativeTokens, nativeTurnTimeoutMs: raw?.nativeTurnTimeoutMs,
    modelProvider: raw?.modelProvider ?? "auto",
    modelName: raw?.modelName,
    reviewIntervalMinutes: raw?.reviewIntervalMinutes ?? 360,
    failureThreshold: raw?.failureThreshold ?? 3,
    noProgressThreshold: raw?.noProgressThreshold ?? 5,
    cycleDelayMs: raw?.cycleDelayMs ?? 250,
    approvalTtlMinutes: raw?.approvalTtlMinutes ?? 60,
    processMaxLifetimeMs: raw?.processMaxLifetimeMs ?? 1_800_000,
    maxConcurrentProcesses: raw?.maxConcurrentProcesses ?? 4,
  };
}

function normalizeProjectMetrics(raw: Partial<ProjectMetrics> | undefined): ProjectMetrics {
  return { testsPassed: raw?.testsPassed ?? 0, testsTotal: raw?.testsTotal ?? 0, evidenceCoverage: raw?.evidenceCoverage ?? 0, humanOrchestrationCount: raw?.humanOrchestrationCount ?? 0, initiativeRecall: raw?.initiativeRecall ?? 0, initiativePrecision: raw?.initiativePrecision ?? 0 };
}

class BadRequestError extends Error {}

function normalizeState(candidate: unknown): AppState {
  const value = candidate as Partial<AppState>;
  if (!Array.isArray(value.projects) || !Array.isArray(value.intents) || !Array.isArray(value.runs) || !Array.isArray(value.events)) throw new Error("state snapshot is missing required collections");
  const normalized: AppState = {
    ...(value as AppState),
    projects: value.projects.map((project) => ({
      ...project,
      settings: normalizeProjectSettings(project.settings),
      metrics: normalizeProjectMetrics(project.metrics),
    })),
    runs: value.runs.map((run) => ({
      ...run,
      consecutiveFailures: Number.isFinite(run.consecutiveFailures) ? run.consecutiveFailures : 0,
      noProgressCycles: Number.isFinite(run.noProgressCycles) ? run.noProgressCycles : 0,
      activeProcessIds: Array.isArray(run.activeProcessIds) ? run.activeProcessIds : [],
    })),
    actions: Array.isArray(value.actions) ? value.actions.map((action) => ({ ...action, schemaVersion: 1 as const })) : [],
    worldSnapshots: Array.isArray(value.worldSnapshots) ? value.worldSnapshots : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    humanItems: Array.isArray(value.humanItems) ? value.humanItems : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    experiences: Array.isArray(value.experiences) ? value.experiences : [],
    experiments: Array.isArray(value.experiments) ? value.experiments : [],
    observations: Array.isArray(value.observations) ? value.observations.map((observation) => ({
      ...observation,
      status: observation.status ?? (observation.trustLevel === "untrusted" || /unconfigured|unreachable|unanswered|awaiting|blocked|not connected/i.test(observation.compactView) ? "warning" : "healthy"),
    })) : [],
    contexts: Array.isArray(value.contexts) ? value.contexts.map((context) => ({ ...context, schemaVersion: 1 as const })) : [],
    policies: Array.isArray(value.policies) ? value.policies : [],
    resourceLedger: Array.isArray(value.resourceLedger) ? value.resourceLedger : [],
    relations: Array.isArray(value.relations) ? value.relations : [],
    retrievalIndex: Array.isArray(value.retrievalIndex) ? value.retrievalIndex : [],
    approvalGrants: Array.isArray(value.approvalGrants) ? value.approvalGrants : [],
    processes: Array.isArray(value.processes) ? value.processes : [],
  };
  const resourceLimitStop = /(?:토큰.*(?:상한|한도)|실행 예산|최대 모델 호출|OUTPUT_LIMIT)/i;
  const recoverableProjectIds = new Set(normalized.runs.filter((run) => run.status === "STALLED" && resourceLimitStop.test(`${run.stopReason ?? ""} ${run.lastModelFailure?.code ?? ""} ${run.lastModelFailure?.message ?? ""}`)).map((run) => run.projectId));
  if (!recoverableProjectIds.size) return normalized;
  return {
    ...normalized,
    projects: normalized.projects.map((project) => recoverableProjectIds.has(project.id) && project.status === "STALLED" ? { ...project, status: "ACTIVE", nextReviewAt: undefined } : project),
    runs: normalized.runs.map((run) => recoverableProjectIds.has(run.projectId) && run.status === "STALLED" ? { ...run, status: "ACTIVE", phase: "wake", stopReason: undefined, lastFailureSignature: undefined, lastModelFailure: undefined, retryAfter: undefined, execution: undefined } : run),
  };
}

function isRecoverableState(candidate: unknown): boolean {
  try {
    normalizeState(candidate);
    return true;
  } catch {
    return false;
  }
}

function loadState(): AppState {
  if (!existsSync(statePath)) return createEmptyState();
  const candidate = readJsonWithBackup<unknown>(statePath, isRecoverableState);
  if (candidate === undefined) throw new Error(`state snapshot is unreadable and no valid backup exists: ${statePath}`);
  return normalizeState(candidate);
}

let state = loadState();
hydrateManagedProcesses(state.processes);
mkdirSync(dirname(statePath), { recursive: true });

function persistState(next: AppState): void {
  next.revision = Math.max(next.revision ?? 0, loadState().revision ?? 0) + 1;
  writeJsonAtomically(statePath, next, isRecoverableState);
  for (const event of next.events) eventJournal.appendSync(event);
}

function publishEvents(previous: AppState, next: AppState): void {
  const known = new Set(previous.events.map((event) => event.id));
  const created = next.events.filter((event) => !known.has(event.id));
  for (const event of created) {
    const listeners = subscribers.get(event.projectId);
    if (!listeners) continue;
    for (const listener of listeners) {
      try { writeSseEvent(listener, event); } catch { listeners.delete(listener); }
    }
    if (!listeners.size) subscribers.delete(event.projectId);
  }
}

function eventNames(event: AppState["events"][number]): string[] {
  const names = ["event.created"];
  if (event.type === "RUN_STATE_CHANGED") names.push("run.state");
  if (event.type === "WORLD_CHANGED" || event.type === "OBSERVATION_REFRESHED") names.push("world.changed");
  if (event.type === "HUMAN_ITEM_CREATED" || event.type === "QUESTION_CREATED") names.push("human-item.created");
  if (event.type === "EVIDENCE_RECORDED") names.push("evidence.created");
  return names;
}

function writeSseEvent(response: ServerResponse, event: AppState["events"][number]): void {
  response.write(eventNames(event).map((name) => `id: ${event.id}\nevent: ${name}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

async function commitMutation(mutator: (current: AppState) => AppState | Promise<AppState>): Promise<AppState> {
  return withFileLock(stateLockPath, async () => {
    const previous = loadState();
    let next = await mutator(previous);
    for (const project of next.projects) {
      if ((project.status === "PAUSED" || project.status === "KILLED") && getProject(previous, project.id)?.status !== project.status) {
        const run = getRun(next, project.id);
        if (run) {
          await stopProcessesForRun(next.processes, run.id);
          next = { ...next, runs: next.runs.map((candidate) => candidate.id === run.id ? { ...candidate, activeProcessIds: [] } : candidate) };
        }
      }
    }
    state = next;
    if (next !== previous) {
      persistState(next);
      publishEvents(previous, next);
      await scheduleJobs(previous, next);
    }
    return state;
  });
}

function headers(contentType = "application/json"): Record<string, string> {
  return {
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, Authorization",
    "Access-Control-Allow-Methods": "DELETE, GET, POST, OPTIONS",
    "Content-Type": contentType,
  };
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, headers());
  response.end(JSON.stringify(data));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) throw new BadRequestError("request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequestError("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function projectPayload(projectId: string): Record<string, unknown> | undefined {
  const project = getProject(state, projectId);
  if (!project) return undefined;
  return {
    project,
    intent: state.intents.find((intent) => intent.id === project.intentId),
    run: getRun(state, projectId),
    world: getWorldSnapshot(state, projectId),
    needsYou: getProjectHumanItems(state, projectId),
    actions: state.actions.filter((item) => item.projectId === projectId),
    evidence: state.evidence.filter((item) => item.projectId === projectId),
    artifacts: state.artifacts.filter((item) => item.projectId === projectId),
    events: getProjectEvents(state, projectId),
    observations: getProjectObservations(state, projectId),
    contexts: getProjectContexts(state, projectId),
    experiences: state.experiences.filter((item) => item.projectId === projectId),
    ledger: getResourceLedger(state, projectId),
    relations: getProjectRelations(state, projectId),
    retrievalIndex: getProjectRetrievalEntries(state, projectId),
    approvalGrants: state.approvalGrants.filter((grant) => grant.projectId === projectId),
    processes: state.processes.filter((process) => process.projectId === projectId),
  };
}

const queueTriggers = new Map<string, RuntimeJob["trigger"]>([
  ["PROJECT_CREATED", "intent"],
  ["INTENT_CREATED", "intent"],
  ["WAKE_TRIGGERED", "signal"],
  ["HUMAN_ANSWERED", "human-answer"],
  ["HUMAN_APPROVED", "human-answer"],
  ["HUMAN_REJECTED", "human-answer"],
  ["HUMAN_DEFERRED", "human-answer"],
  ["HUMAN_ITEM_CREATED", "signal"],
  ["QUESTION_CREATED", "signal"],
  ["ACTION_EXECUTED", "signal"],
  ["TOOL_RESULT", "signal"],
  ["POLICY_CHANGED", "signal"],
]);

async function scheduleJobs(previous: AppState, next: AppState): Promise<void> {
  const previousIds = new Set(previous.events.map((event) => event.id));
  const created = next.events.filter((event) => !previousIds.has(event.id));
  const byProject = new Map<string, RuntimeJob["trigger"]>();
  for (const event of created) {
    const trigger = queueTriggers.get(event.type);
    if (trigger) byProject.set(event.projectId, trigger);
  }
  for (const [projectId, trigger] of byProject) {
    const project = getProject(next, projectId);
    if (!project || project.status !== "ACTIVE" || !project.settings.workspacePath) continue;
    const delay = Math.max(0, Number(project.settings.cycleDelayMs ?? 250));
    await queue.enqueue({ projectId, runId: project.activeRunId, trigger, availableAt: new Date(Date.now() + delay).toISOString() });
  }
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function refreshStateFromDisk(): void {
  if (!existsSync(statePath)) return;
  let next: AppState;
  try {
    next = loadState();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "state snapshot reload failed");
    return;
  }
  if (next.revision === state.revision && next.events.length === state.events.length && next.events.at(-1)?.id === state.events.at(-1)?.id) return;
  const previous = state;
  state = next;
  publishEvents(previous, next);
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
watch(dirname(statePath), (_event, filename) => {
  if (filename && filename.toString() !== basename(statePath)) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshStateFromDisk();
  }, 25);
});

function afterCursor(events: AppState["events"], cursor: string | null): AppState["events"] {
  if (!cursor) return events;
  const index = events.findIndex((event) => event.id === cursor);
  return index < 0 ? events : events.slice(index + 1);
}

function parseExperimentInput(body: Record<string, unknown>): ExperimentInput {
  const list = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  const variantConfig = body.variantConfig && typeof body.variantConfig === "object" ? Object.fromEntries(Object.entries(body.variantConfig).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean> : undefined;
  return {
    key: typeof body.key === "string" ? body.key : "H-custom",
    title: typeof body.title === "string" ? body.title : "Custom experiment",
    hypothesis: typeof body.hypothesis === "string" ? body.hypothesis : "Custom hypothesis",
    description: typeof body.description === "string" ? body.description : "Created by the control plane",
    variant: typeof body.variant === "string" ? body.variant : "local",
    benchmark: typeof body.benchmark === "string" ? body.benchmark : undefined,
    budgetLimit: typeof body.budgetLimit === "number" && body.budgetLimit > 0 ? body.budgetLimit : undefined,
    hiddenCriteria: list(body.hiddenCriteria),
    evaluatorRefs: list(body.evaluatorRefs),
    variantConfig,
  };
}

function parseProjectSettings(raw: unknown): { settings?: Partial<ProjectSettings>; error?: string } {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return { error: "settings must be a JSON object" };
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const positiveNumber = (key: string, fallback: number, maximum: number): number | string => {
    const value = body[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) return `${key} must be a finite number between 0 and ${maximum}`;
    return value;
  };
  const configuredBudget = Number(process.env.DEFAULT_RUN_BUDGET ?? "30");
  const defaultBudget = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : 30;
  const budgetLimit = positiveNumber("budgetLimit", defaultBudget, 1_000_000);
  const maxHours = positiveNumber("maxHours", 12, 168);
  const maxModelCalls = positiveNumber("maxModelCalls", 200, 10_000);
  const reviewIntervalMinutes = positiveNumber("reviewIntervalMinutes", 360, 10_080);
  if (typeof budgetLimit === "string") return { error: budgetLimit };
  if (typeof maxHours === "string") return { error: maxHours };
  if (typeof maxModelCalls === "string" || !Number.isInteger(maxModelCalls)) return { error: "maxModelCalls must be a positive integer" };
  if (typeof reviewIntervalMinutes === "string") return { error: reviewIntervalMinutes };
  const optionalPositive = (key: string, fallback: number, maximum: number): number | string => {
    const value = body[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) return `${key} must be a finite number between 0 and ${maximum}`;
    return value;
  };
  const optionalNonNegative = (key: string, fallback: number, maximum: number): number | string => {
    const value = body[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) return `${key} must be a finite number between 0 and ${maximum}`;
    return value;
  };
  const failureThreshold = optionalPositive("failureThreshold", 3, 32);
  const noProgressThreshold = optionalPositive("noProgressThreshold", 5, 128);
  const cycleDelayMs = optionalNonNegative("cycleDelayMs", 250, 60_000);
  const approvalTtlMinutes = optionalPositive("approvalTtlMinutes", 60, 10_080);
  const processMaxLifetimeMs = optionalPositive("processMaxLifetimeMs", 1_800_000, 86_400_000);
  const maxConcurrentProcesses = optionalPositive("maxConcurrentProcesses", 4, 32);
  for (const value of [failureThreshold, noProgressThreshold, cycleDelayMs, approvalTtlMinutes, processMaxLifetimeMs, maxConcurrentProcesses]) if (typeof value === "string") return { error: value };
  const booleanSetting = (key: string, fallback: boolean): boolean | string => {
    const value = body[key];
    if (value === undefined) return fallback;
    return typeof value === "boolean" ? value : `${key} must be boolean`;
  };
  const localActions = booleanSetting("localActions", true);
  const requireExternalApproval = booleanSetting("requireExternalApproval", true);
  const productionBlocked = booleanSetting("productionBlocked", true);
  const resourceLimitsDisabled = booleanSetting("resourceLimitsDisabled", true);
  if (typeof localActions === "string") return { error: localActions };
  if (typeof requireExternalApproval === "string") return { error: requireExternalApproval };
  if (typeof productionBlocked === "string") return { error: productionBlocked };
  if (typeof resourceLimitsDisabled === "string") return { error: resourceLimitsDisabled };
  const networkPolicy = body.networkPolicy === undefined ? "allowlist" : body.networkPolicy;
  if (networkPolicy !== "deny" && networkPolicy !== "allowlist") return { error: "networkPolicy must be deny or allowlist" };
  const executionMode = body.executionMode ?? "atomic";
  if (executionMode !== "atomic" && executionMode !== "native") return { error: "executionMode must be atomic or native" };
  const maxNativeTurns = optionalPositive("maxNativeTurns", 40, 1000);
  const maxNativeTokens = optionalPositive("maxNativeTokens", 250000, 10000000);
  const nativeTurnTimeoutMs = optionalPositive("nativeTurnTimeoutMs", 300000, 540000);
  for (const limit of [maxNativeTurns, maxNativeTokens, nativeTurnTimeoutMs]) if (typeof limit === "string") return { error: limit };
  const sandboxMode = body.sandboxMode === undefined ? "process" : body.sandboxMode;
  if (sandboxMode !== "process" && sandboxMode !== "docker") return { error: "sandboxMode must be process or docker" };
  const modelProvider = body.modelProvider === undefined ? "auto" : body.modelProvider;
  if (modelProvider !== "auto" && modelProvider !== "deterministic" && modelProvider !== "openai-compatible" && modelProvider !== "codex-cli") return { error: "modelProvider is not supported" };
  const modelName = body.modelName === undefined ? undefined : body.modelName;
  if (modelName !== undefined && (typeof modelName !== "string" || (modelName.trim() && !modelIdPattern.test(modelName.trim())))) return { error: "modelName must be a model id with at most 128 safe characters" };
  const previewUrl = body.previewUrl === undefined ? undefined : body.previewUrl;
  let previewHost: string | undefined;
  if (previewUrl !== undefined) {
    if (typeof previewUrl !== "string") return { error: "previewUrl must be a URL" };
    try {
      const parsed = new URL(previewUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "previewUrl must use http or https" };
      if (parsed.username || parsed.password) return { error: "previewUrl must not contain credentials" };
      previewHost = parsed.hostname;
    } catch {
      return { error: "previewUrl must be a valid URL" };
    }
  }
  const domains = body.allowedDomains === undefined ? [] : body.allowedDomains;
  const isValidDomain = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    const domain = value.trim().toLowerCase();
    const base = domain.startsWith("*.") ? domain.slice(2) : domain;
    if (!base || domain.startsWith(".") || domain.endsWith(".")) return false;
    if (base === "localhost") return true;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(base)) return base.split(".").every((part) => Number(part) <= 255);
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(base);
  };
  if (!Array.isArray(domains) || domains.length > 64 || domains.some((domain) => !isValidDomain(domain))) return { error: "allowedDomains contains an invalid host pattern" };
  const allowedDomains = [...new Set((domains as string[]).map((domain) => domain.trim().toLowerCase()))];
  for (const localHost of ["registry.npmjs.org", "localhost", "127.0.0.1"]) if (!allowedDomains.includes(localHost)) allowedDomains.push(localHost);
  if (previewHost && !allowedDomains.some((domain) => domain === previewHost || domain === `*.${previewHost}`)) allowedDomains.push(previewHost);
  const workspacePath = body.workspacePath === undefined ? undefined : normalizeWorkspacePath(body.workspacePath);
  if (body.workspacePath !== undefined && !workspacePath) return { error: "workspacePath must be an existing directory or a future path inside WORKSPACE_ROOT" };
  return { settings: { budgetLimit, maxHours, maxModelCalls, resourceLimitsDisabled, reviewIntervalMinutes, failureThreshold: failureThreshold as number, noProgressThreshold: noProgressThreshold as number, cycleDelayMs: cycleDelayMs as number, approvalTtlMinutes: approvalTtlMinutes as number, processMaxLifetimeMs: processMaxLifetimeMs as number, maxConcurrentProcesses: maxConcurrentProcesses as number, localActions, requireExternalApproval, productionBlocked, networkPolicy, sandboxMode, executionMode, maxNativeTurns: maxNativeTurns as number, maxNativeTokens: maxNativeTokens as number, nativeTurnTimeoutMs: nativeTurnTimeoutMs as number, modelProvider, modelName: modelName === undefined ? undefined : (modelName as string).trim(), workspacePath, previewUrl, allowedDomains } };
}

function parseModelSettings(body: Record<string, unknown>): { settings?: Pick<ProjectSettings, "modelProvider" | "modelName">; error?: string } {
  const modelProvider = body.modelProvider;
  if (modelProvider !== "auto" && modelProvider !== "deterministic" && modelProvider !== "openai-compatible" && modelProvider !== "codex-cli") return { error: "modelProvider is not supported" };
  const rawModelName = body.modelName;
  if (rawModelName !== undefined && typeof rawModelName !== "string") return { error: "modelName must be a string" };
  const modelName = typeof rawModelName === "string" ? rawModelName.trim() || undefined : undefined;
  if (modelName && !modelIdPattern.test(modelName)) return { error: "modelName must be a model id with at most 128 safe characters" };
  return { settings: { modelProvider, modelName } };
}

function isSafeProjectId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function isExperimentInputValid(input: ExperimentInput): boolean {
  return [input.key, input.title, input.hypothesis, input.description, input.variant].every((value) => value.trim().length > 0 && value.length <= 4000);
}

function findProjectIdByRun(runId: string): string | undefined {
  return state.runs.find((run) => run.id === runId)?.projectId;
}

function parseWakeTrigger(value: unknown): string {
  const allowed = new Set(["intent", "human-answer", "incident", "scheduled-review", "user-feedback", "dependency-security", "manual", "signal"]);
  return typeof value === "string" && allowed.has(value) ? value : "manual";
}

function rawOutputFile(fileName: string): { path: string; contentType: string } | undefined {
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) return undefined;
  const directory = resolve(process.cwd(), process.env.INTENT_WORLD_RAW_DIR ?? ".data/raw");
  const candidate = resolve(directory, fileName);
  const distance = relative(directory, candidate);
  if (distance.startsWith(`..${sep}`) || distance === ".." || !existsSync(candidate)) return undefined;
  try {
    if (!isInsideRawDirectory(directory, realpathSync.native(candidate))) return undefined;
    const contentType = fileName.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    return { path: candidate, contentType };
  } catch {
    return undefined;
  }
}

function isInsideRawDirectory(directory: string, candidate: string): boolean {
  const distance = relative(directory, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!checkHttpBoundary(request, response, host)) return;
  refreshStateFromDisk();
  const parsedUrl = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "localhost"));
  let parts: string[];
  try {
    parts = routeParts(parsedUrl.pathname);
  } catch {
    sendError(response, 400, "path contains an invalid escape sequence");
    return;
  }
  const method = request.method ?? "GET";

  if (method === "OPTIONS") {
    response.writeHead(204, headers());
    response.end();
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "intent-world-control-plane", statePath, persistence: "json-snapshot+jsonl-event-journal", queue: "json-durable-queue", worker: "separate-process" });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/state") {
    sendJson(response, 200, state);
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/projects") {
    sendJson(response, 200, { projects: state.projects });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/runtime/model-catalog") {
    sendJson(response, 200, runtimeModelCatalog());
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/runtime/model-status") {
    const rawProvider = parsedUrl.searchParams.get("provider") ?? "auto";
    const supportedProviders = ["auto", "deterministic", "openai-compatible", "codex-cli"] as const;
    if (!(supportedProviders as readonly string[]).includes(rawProvider)) {
      sendError(response, 400, "provider is not supported");
      return;
    }
    const rawModelName = parsedUrl.searchParams.get("model")?.trim() || undefined;
    if (rawModelName && !modelIdPattern.test(rawModelName)) {
      sendError(response, 400, "model must be a model id with at most 128 safe characters");
      return;
    }
    sendJson(response, 200, await inspectModelConnection(rawProvider as (typeof supportedProviders)[number], rawModelName));
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/runtime/workspace-root") {
    sendJson(response, 200, { root: workspaceRootPath(), configPath: workspaceRootConfigPath() });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/runtime/workspace-root") {
    if (process.env.DESKTOP_MODE?.trim().toLowerCase() !== "true") {
      sendError(response, 403, "workspace root selection is available only in desktop mode");
      return;
    }
    const body = await readJson(request);
    const root = setWorkspaceRootPath(body.path);
    if (!root) {
      sendError(response, 400, "path must be an existing directory");
      return;
    }
    sendJson(response, 200, { root, configPath: workspaceRootConfigPath() });
    return;
  }

  if (method === "GET" && parts[0] === "raw" && parts[1] && parts.length === 2) {
    const raw = rawOutputFile(parts[1]);
    if (!raw) {
      sendError(response, 404, "raw output not found");
      return;
    }
    response.writeHead(200, { ...headers(raw.contentType), "Cache-Control": "private, max-age=60" });
    response.end(readFileSync(raw.path));
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "projects") {
    const body = await readJson(request);
    const rawIntent = typeof body.rawIntent === "string" ? body.rawIntent.trim() : "";
    if (!rawIntent) {
      sendError(response, 400, "rawIntent is required");
      return;
    }
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : makeId("project");
    if (!isSafeProjectId(projectId)) {
      sendError(response, 400, "projectId must contain only letters, numbers, dot, underscore, or hyphen");
      return;
    }
    const parsedSettings = parseProjectSettings(body.settings);
    if (parsedSettings.error || !parsedSettings.settings) {
      sendError(response, 400, parsedSettings.error ?? "invalid project settings");
      return;
    }
    if (state.projects.some((candidate) => candidate.id === projectId)) {
      sendError(response, 409, "projectId already exists");
      return;
    }
    let workspacePath = parsedSettings.settings.workspacePath;
    try {
      workspacePath = workspacePath ?? provisionProjectWorkspace(projectId);
      mkdirSync(workspacePath, { recursive: true });
    } catch (error: unknown) {
      sendError(response, 400, error instanceof Error ? error.message : "workspace could not be provisioned");
      return;
    }
    const projectSettings = { ...parsedSettings.settings, workspacePath };
    const committed = await commitMutation((current) => createProject(current, rawIntent, projectId, projectSettings));
    if (!committed.projects.some((candidate) => candidate.id === projectId)) {
      sendError(response, 409, "projectId already exists");
      return;
    }
    sendJson(response, 201, projectPayload(projectId));
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "experiments") {
    const body = await readJson(request);
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId || !getProject(state, projectId)) {
      sendError(response, 400, "projectId is required and must reference an existing project");
      return;
    }
    const input = parseExperimentInput(body);
    if (!isExperimentInputValid(input)) {
      sendError(response, 400, "experiment fields must be non-empty and at most 4000 characters");
      return;
    }
    const committed = await commitMutation((current) => createExperiment(current, projectId, input));
    const experiment = committed.experiments.filter((candidate) => candidate.projectId === projectId).at(-1);
    sendJson(response, 201, { experiment, project: getProject(committed, projectId) });
    return;
  }

  if (parts[0] === "projects" && parts[1]) {
    const projectId = parts[1];
    const project = getProject(state, projectId);
    if (!project) {
      sendError(response, 404, "project not found");
      return;
    }

    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "autonomy" && parts.length === 3) {
      sendJson(response, 200, projectAutonomyState(projectId, autonomyStore.readProject(projectId)));
      return;
    }

    if (method === "DELETE" && parts.length === 2) {
      let deleted = false;
      await commitMutation(async (current) => {
        const currentProject = getProject(current, projectId);
        if (!currentProject) return current;
        await stopProcessesForProject(current.processes, projectId);
        await queue.removeProject(projectId);
        deleted = true;
        return deleteProject(current, projectId);
      });
      if (!deleted) {
        sendError(response, 404, "project not found");
        return;
      }
      for (const listener of subscribers.get(projectId) ?? []) {
        try { listener.end(); } catch { /* the client may already be gone */ }
      }
      subscribers.delete(projectId);
      sendJson(response, 200, { deleted: true, projectId, workspacePreserved: true });
      return;
    }

    if (method === "GET" && parts[2] === "runtime-status" && parts.length === 3) {
      sendJson(response, 200, await inspectRuntimeConnection(project));
      return;
    }

    if (method === "POST" && parts[2] === "execution" && parts.length === 3) {
      const body = await readJson(request);
      if (body.executionMode !== "atomic" && body.executionMode !== "native") { sendError(response, 400, "executionMode must be atomic or native"); return; }
      for (const [key, maximum] of [["maxNativeTurns", 1000], ["maxNativeTokens", 10000000]] as const) {
        const value = body[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum)) { sendError(response, 400, `${key} is out of range`); return; }
      }
      if (project.status === "KILLED") { sendError(response, 409, "killed project cannot change execution mode"); return; }
      const executionMode = body.executionMode;
      await commitMutation((current) => updateExecutionSettings(current, projectId, { executionMode, maxNativeTurns: body.maxNativeTurns as number | undefined, maxNativeTokens: body.maxNativeTokens as number | undefined }));
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && parts[2] === "model" && parts.length === 3) {
      const body = await readJson(request);
      const parsedModel = parseModelSettings(body);
      if (parsedModel.error || !parsedModel.settings) {
        sendError(response, 400, parsedModel.error ?? "invalid model settings");
        return;
      }
      let changed = false;
      const committed = await commitMutation((current) => {
        const next = updateProjectModelSettings(current, projectId, parsedModel.settings!);
        changed = next !== current;
        return next;
      });
      if (!getProject(committed, projectId)) {
        sendError(response, 404, "project not found");
        return;
      }
      sendJson(response, 200, { ...projectPayload(projectId), changed });
      return;
    }

    if (method === "POST" && parts[2] === "intents" && parts.length === 3) {
      const body = await readJson(request);
      const rawText = typeof body.rawText === "string" ? body.rawText : typeof body.rawIntent === "string" ? body.rawIntent : "";
      if (!rawText.trim()) {
        sendError(response, 400, "rawText is required");
        return;
      }
      await commitMutation((current) => addIntent(current, projectId, rawText).state);
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && (parts[2] === "wake" || parts[2] === "run") && parts.length === 3) {
      const body = await readJson(request);
      let rejected: string | undefined;
      await commitMutation((current) => {
        const currentProject = getProject(current, projectId);
        if (!currentProject || currentProject.status === "KILLED" || (parts[2] === "run" && !["ACTIVE", "WAITING"].includes(currentProject.status))) {
          rejected = currentProject?.status ?? "missing";
          return current;
        }
        return wakeProject(current, projectId, parseWakeTrigger(body.trigger));
      });
      if (rejected) { sendError(response, 409, `project is ${rejected}`); return; }
      sendJson(response, 202, { ...projectPayload(projectId), queued: true });
      return;
    }

    if (method === "POST" && parts[2] === "stall" && parts.length === 3) {
      const body = await readJson(request);
      const reason = typeof body.reason === "string" ? body.reason : "manual stall review";
      await commitMutation((current) => stallProject(current, projectId, reason));
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "human-items" && parts.length === 3) {
      sendJson(response, 200, { items: getProjectHumanItems(state, projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "world" && parts.length === 3) {
      sendJson(response, 200, { world: getWorldSnapshot(state, projectId), observations: getProjectObservations(state, projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "evidence" && parts.length === 3) {
      sendJson(response, 200, { evidence: state.evidence.filter((item) => item.projectId === projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "actions" && parts.length === 3) {
      sendJson(response, 200, { actions: state.actions.filter((item) => item.projectId === projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "contexts" && parts.length === 3) {
      sendJson(response, 200, { contexts: getProjectContexts(state, projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "relations" && parts.length === 3) {
      sendJson(response, 200, { relations: getProjectRelations(state, projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "retrieval-index" && parts.length === 3) {
      sendJson(response, 200, { entries: getProjectRetrievalEntries(state, projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "world" && parts[3] === "refresh" && parts.length === 4) {
      const before = loadState();
      const priorProject = getProject(before, projectId);
      const observed = priorProject?.settings.workspacePath ? await observeLocalWorld(before, projectId) : refreshWorld(before, projectId);
      // Observation may be slow; never hold the global state lock while probing.
      await commitMutation((current) => {
        if (JSON.stringify(getProject(current, projectId)) !== JSON.stringify(priorProject) || getWorldSnapshot(current, projectId)?.cursorEventId !== getWorldSnapshot(before, projectId)?.cursorEventId) return current;
        return mergeCycleResult(current, before, observed, projectId, true, false);
      });
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "events" && parts.length === 3) {
      const cursor = parsedUrl.searchParams.get("after");
      const allEvents = state.events.filter((event) => event.projectId === projectId);
      sendJson(response, 200, { events: afterCursor(allEvents, cursor) });
      return;
    }

    if (method === "GET" && parts[2] === "evaluation" && parts.length === 3) {
      sendJson(response, 200, evaluateProject(state, projectId));
      return;
    }

    if (method === "GET" && parts[2] === "stream" && parts.length === 3) {
      response.writeHead(200, {
        ...headers("text/event-stream"),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const lastEventIdHeader = request.headers["last-event-id"];
      const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
      const chronological = state.events.filter((event) => event.projectId === projectId);
      for (const event of afterCursor(chronological, lastEventId ?? null)) writeSseEvent(response, event);
      response.write("event: ready\ndata: " + JSON.stringify({ projectId, cursor: chronological.at(-1)?.id ?? null }) + "\n\n");
      const listeners = subscribers.get(projectId) ?? new Set<ServerResponse>();
      listeners.add(response);
      subscribers.set(projectId, listeners);
      const heartbeat = setInterval(() => {
        try { response.write(": keep-alive\n\n"); } catch { clearInterval(heartbeat); listeners.delete(response); }
      }, 25_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        listeners.delete(response);
        if (!listeners.size) subscribers.delete(projectId);
      });
      response.on("error", () => {
        clearInterval(heartbeat);
        listeners.delete(response);
        if (!listeners.size) subscribers.delete(projectId);
      });
      return;
    }

    if (method === "GET" && parts[2] === "artifacts" && parts.length === 3) {
      sendJson(response, 200, { artifacts: state.artifacts.filter((artifact) => artifact.projectId === projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "artifacts" && parts.length === 3) {
      const body = await readJson(request);
      const allowedKinds: ArtifactKind[] = ["build", "report", "screenshot", "release", "docs"];
      const kind = body.kind === undefined ? "report" : body.kind;
      if (typeof kind !== "string" || !allowedKinds.includes(kind as ArtifactKind)) {
        sendError(response, 400, "artifact kind is not supported");
        return;
      }
      const name = typeof body.name === "string" && body.name ? body.name : "Runtime artifact";
      const description = typeof body.description === "string" ? body.description : "Created by the control plane";
      await commitMutation((current) => createArtifact(current, projectId, kind as ArtifactKind, name, description));
      sendJson(response, 201, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "experiments" && parts.length === 3) {
      sendJson(response, 200, { experiments: state.experiments.filter((experiment) => experiment.projectId === projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "experiments" && parts.length === 3) {
      const body = await readJson(request);
      const input = parseExperimentInput(body);
      if (!isExperimentInputValid(input)) {
        sendError(response, 400, "experiment fields must be non-empty and at most 4000 characters");
        return;
      }
      await commitMutation((current) => createExperiment(current, projectId, input));
      sendJson(response, 201, projectPayload(projectId));
      return;
    }
  }

  if (parts[0] === "runs" && parts[1]) {
    const runId = parts[1];
    const projectId = findProjectIdByRun(runId);
    if (!projectId) {
      sendError(response, 404, "run not found");
      return;
    }
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, { run: getRun(state, projectId), project: getProject(state, projectId) });
      return;
    }
    if (method === "POST" && parts.length === 3) {
      const runAction = parts[2];
      if (!["pause", "resume", "kill"].includes(runAction)) {
        sendError(response, 400, "unsupported run action");
        return;
      }
      await commitMutation((current) => runAction === "pause" ? pauseProject(current, projectId) : runAction === "resume" ? resumeProject(current, projectId) : killProject(current, projectId));
      sendJson(response, 200, { run: getRun(state, projectId), project: getProject(state, projectId) });
      return;
    }
  }

  if (parts[0] === "human-items" && parts[1] && parts[2] && method === "POST") {
    const item = state.humanItems.find((candidate) => candidate.id === parts[1]);
    if (!item) {
      sendError(response, 404, "human item not found");
      return;
    }
    const body = await readJson(request);
    const action = parts[2] as "answer" | "approve" | "reject" | "defer" | "acknowledge";
    const answer = typeof body.answer === "string" ? body.answer : undefined;
    if (!["answer", "approve", "reject", "defer", "acknowledge"].includes(action)) {
      sendError(response, 400, "unsupported human item action");
      return;
    }
    let resolved = false;
    let resolvedProjectId = item.projectId;
    await commitMutation((current) => {
      const currentItem = current.humanItems.find((candidate) => candidate.id === item.id);
      if (!currentItem || !isHumanActionAllowed(currentItem, action, answer)) return current;
      resolved = true;
      resolvedProjectId = currentItem.projectId;
      return resolveHumanItem(current, currentItem.id, action, answer);
    });
    if (!resolved) {
      sendError(response, 409, "human item is already resolved or the action does not match its kind");
      return;
    }
    sendJson(response, 200, projectPayload(resolvedProjectId));
    return;
  }

  if (parts[0] === "evidence" && parts[1] && method === "GET") {
    const evidence = state.evidence.find((item) => item.id === parts[1]);
    if (!evidence) {
      sendError(response, 404, "evidence not found");
    } else if (parts[2] === "raw" && parts.length === 3 && evidence.rawRef?.startsWith("local-raw://")) {
      const raw = rawOutputFile(evidence.rawRef.slice("local-raw://".length));
      if (!raw) sendError(response, 404, "raw output not found");
      else {
        response.writeHead(200, { ...headers(raw.contentType), "Cache-Control": "private, max-age=60" });
        response.end(readFileSync(raw.path));
      }
    } else if (parts.length === 2) sendJson(response, 200, { evidence });
    else sendError(response, 404, "route not found");
    return;
  }

  if (parts[0] === "artifacts" && parts[1] && method === "GET") {
    const artifact = state.artifacts.find((item) => item.id === parts[1]);
    if (!artifact) sendError(response, 404, "artifact not found");
    else sendJson(response, 200, { artifact });
    return;
  }

  if (parts[0] === "experiments" && parts[1]) {
    const experiment = state.experiments.find((item) => item.id === parts[1]);
    if (!experiment) {
      sendError(response, 404, "experiment not found");
      return;
    }
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, { experiment });
      return;
    }
    if (method === "POST" && parts[2] === "run") {
      await commitMutation((current) => runExperiment(current, experiment.id));
      sendJson(response, 200, { experiment: state.experiments.find((item) => item.id === experiment.id) });
      return;
    }
  }

  if (method === "GET" && parts[0] === "events") {
    const projectId = parsedUrl.searchParams.get("projectId");
    const cursor = parsedUrl.searchParams.get("after");
    const events = projectId ? state.events.filter((event) => event.projectId === projectId) : state.events;
    sendJson(response, 200, { events: afterCursor(events, cursor) });
    return;
  }

  sendError(response, 404, "route not found");
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "internal server error";
    if (!response.headersSent) sendError(response, error instanceof BadRequestError ? 400 : 500, message);
    else response.end();
  });
});

if (!isLoopbackHost(host) && !process.env.SAKASAKA_API_TOKEN) throw new Error("외부 API 바인딩에는 SAKASAKA_API_TOKEN이 필요합니다. 기본값은 127.0.0.1입니다.");
server.listen(port, host, () => {
  console.log("Intent World control plane listening on http://" + host + ":" + port);
});

const shutdown = async () => {
  await withFileLock(stateLockPath, async () => {
    const current = loadState();
    hydrateManagedProcesses(current.processes);
    const stoppedRuns = new Set<string>();
    for (const run of current.runs) {
      if (!stoppedRuns.has(run.id)) {
        await stopProcessesForRun(current.processes, run.id);
        stoppedRuns.add(run.id);
      }
    }
    const next: AppState = { ...current, runs: current.runs.map((run) => ({ ...run, activeProcessIds: [] })) };
    state = next;
    persistState(next);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "managed process shutdown persistence failed");
    return stopAllManagedProcesses();
  });
  server.close(() => process.exit(0));
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
