import type { AppState, EventRecord, HumanItem, HumanItemKind, RuntimeStatus } from "./types";
import { getIntent, getOpenHumanItems, getProject, getRun, makeId } from "./runtime";
import { redactSecretLikeText } from "./security";
import type { InputSchema } from "./toolContracts";

/** A checkpoint reports a project state; it does not certify product quality. */
export interface MissionCheckpoint {
  disposition: "continue" | "waiting" | "equilibrium";
  summary: string;
  remainingWork: string[];
  /** Model-supplied references; these are not trusted Evidence IDs until resolved. */
  evidenceRefs: string[];
  wakeReasons: string[];
}

export const checkpointLimits = {
  summary: { minLength: 1, maxLength: 4_000 },
  remainingWork: { maxItems: 32, itemMinLength: 1, itemMaxLength: 1_000 },
  evidenceRefs: { maxItems: 64, itemMinLength: 1, itemMaxLength: 512 },
  wakeReasons: { maxItems: 16, itemMinLength: 1, itemMaxLength: 1_000 },
} as const;

const checkpointStringList = (limits: { maxItems: number; itemMinLength: number; itemMaxLength: number }): InputSchema => ({
  type: "array", maxItems: limits.maxItems,
  items: { type: "string", minLength: limits.itemMinLength, maxLength: limits.itemMaxLength },
});

export type CheckpointReferenceKind = "evidence" | "record" | "artifact" | "unresolved";
export type CheckpointReferenceStatus = "resolved" | "unverified" | "unresolved" | "rejected";
export interface CheckpointReference {
  input: string;
  kind: CheckpointReferenceKind;
  status: CheckpointReferenceStatus;
  normalized?: string;
  evidenceId?: string;
  recordRef?: string;
  relativePath?: string;
  relatedEvidenceIds?: string[];
  reason?: string;
}

export interface CheckpointParseResult {
  checkpoint?: MissionCheckpoint;
  reason?: string;
}

export interface NativeSession {
  protocolVersion: 1;
  threadId?: string;
  turnId?: string;
  turnsStarted: number;
  accountedTokens: number;
  accountedInputTokens: number;
  accountedCachedInputTokens: number;
  accountedOutputTokens: number;
  deliveredHumanSequence: number;
  checkpoint?: MissionCheckpoint;
  /** Resolved classification of checkpoint.evidenceRefs; artifact paths stay unverified. */
  checkpointReferences?: CheckpointReference[];
  lastMessage?: string;
  rawRef?: string;
  state: "starting" | "working" | "resting" | "interrupted" | "failed";
}

export const checkpointSchema: InputSchema = {
  type: "object", additionalProperties: false,
  required: ["disposition", "summary", "remainingWork", "evidenceRefs", "wakeReasons"],
  properties: {
    disposition: { type: "string", enum: ["continue", "waiting", "equilibrium"] },
    summary: { type: "string", ...checkpointLimits.summary },
    remainingWork: checkpointStringList(checkpointLimits.remainingWork),
    evidenceRefs: { ...checkpointStringList(checkpointLimits.evidenceRefs), description: "내부 Evidence ID, 알려진 원본 기록 참조, 또는 artifact:<작업공간 기준 상대 경로>. 경로는 Evidence ID가 아닙니다." },
    wakeReasons: checkpointStringList(checkpointLimits.wakeReasons),
  },
};

export function parseCheckpoint(raw: string): MissionCheckpoint | undefined {
  return inspectCheckpoint(raw).checkpoint;
}

export function inspectCheckpoint(raw: string): CheckpointParseResult {
  try {
    const value: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "not-object" };
    const v = value as Record<string, unknown>;
    if (typeof v.disposition !== "string" || !["continue", "waiting", "equilibrium"].includes(v.disposition)) return { reason: "invalid-disposition" };
    if (typeof v.summary !== "string" || v.summary.length < checkpointLimits.summary.minLength || v.summary.length > checkpointLimits.summary.maxLength) return { reason: "invalid-summary" };
    for (const [name, limits] of Object.entries(checkpointLimits).filter(([name]) => name !== "summary") as Array<["remainingWork" | "evidenceRefs" | "wakeReasons", { maxItems: number; itemMinLength: number; itemMaxLength: number }]>) {
      const list = v[name];
      if (!Array.isArray(list) || list.length > limits.maxItems || list.some((item) => typeof item !== "string" || item.length < limits.itemMinLength || item.length > limits.itemMaxLength)) return { reason: `invalid-${name}` };
    }
    if (Object.keys(v).some((key) => !Object.hasOwn(checkpointSchema.properties!, key))) return { reason: "unknown-field" };
    const checkpoint = {
      disposition: v.disposition as MissionCheckpoint["disposition"],
      summary: redactSecretLikeText(v.summary),
      remainingWork: (v.remainingWork as string[]).map(redactSecretLikeText),
      evidenceRefs: (v.evidenceRefs as string[]).map(redactSecretLikeText),
      wakeReasons: (v.wakeReasons as string[]).map(redactSecretLikeText),
    };
    return { checkpoint };
  } catch { return { reason: "malformed-json" }; }
}

function referenceInput(value: string): string { return redactSecretLikeText(value.trim()).slice(0, checkpointLimits.evidenceRefs.itemMaxLength); }

function pathLike(value: string, explicitArtifact: boolean): boolean {
  return explicitArtifact || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.includes("/") || value.includes("\\") || /\.[^\\/]+$/.test(value);
}

interface LexicalPath {
  absolute: boolean;
  root: string;
  parts: string[];
  invalid: boolean;
  escapedRoot: boolean;
}

function lexicalPath(value: string): LexicalPath {
  const normalized = value.replaceAll("\\", "/");
  let rest = normalized;
  let root = "";
  let absolute = false;
  if (/^[A-Za-z]:\//.test(normalized)) {
    absolute = true;
    root = `${normalized.slice(0, 2).toLowerCase()}/`;
    rest = normalized.slice(3);
  } else if (normalized.startsWith("//")) {
    absolute = true;
    root = "//";
    rest = normalized.slice(2);
  } else if (normalized.startsWith("/")) {
    absolute = true;
    root = "/";
    rest = normalized.slice(1);
  }
  const parts: string[] = [];
  let invalid = value.includes("\0");
  let escapedRoot = false;
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) escapedRoot = true;
      else parts.pop();
      continue;
    }
    if (part.includes(":")) invalid = true;
    parts.push(part);
  }
  return { absolute, root, parts, invalid, escapedRoot };
}

function samePathPart(left: string, right: string): boolean {
  return (typeof process === "undefined" || process.platform === "win32" ? left.toLowerCase() : left) === (typeof process === "undefined" || process.platform === "win32" ? right.toLowerCase() : right);
}

function resolveArtifactPath(value: string, workspacePath: string | undefined): { relativePath?: string; reason?: string } {
  if (!workspacePath || !workspacePath.trim()) return { reason: "workspace-unavailable" };
  const workspace = lexicalPath(workspacePath);
  const candidate = lexicalPath(value);
  if (!workspace.absolute || workspace.invalid || workspace.escapedRoot || !value || candidate.invalid || candidate.escapedRoot) return { reason: "invalid-path" };
  if (candidate.absolute) {
    if (typeof process !== "undefined" && process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(value)) return { reason: "outside-workspace" };
    if (workspace.root !== candidate.root && !samePathPart(workspace.root, candidate.root)) return { reason: "outside-workspace" };
    if (candidate.parts.length <= workspace.parts.length || workspace.parts.some((part, index) => !samePathPart(part, candidate.parts[index]))) return { reason: "outside-workspace" };
    return { relativePath: candidate.parts.slice(workspace.parts.length).join("/") };
  }
  if (typeof process !== "undefined" && process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(value)) return { reason: "outside-workspace" };
  return { relativePath: candidate.parts.join("/") || undefined, reason: candidate.parts.length ? undefined : "invalid-path" };
}

/** Resolve model references using current project records only; never reads the filesystem or performs I/O. */
export function resolveCheckpointReferences(state: AppState, projectId: string, checkpoint: MissionCheckpoint, workspacePath?: string): CheckpointReference[] {
  const ownEvidence = state.evidence.filter((item) => item.projectId === projectId);
  const otherEvidenceIds = new Set(state.evidence.filter((item) => item.projectId !== projectId).map((item) => item.id));
  const recordEvidenceIds = new Map<string, string[]>();
  const rememberRecord = (record: string, evidenceId?: string) => {
    const ids = recordEvidenceIds.get(record) ?? [];
    if (evidenceId && !ids.includes(evidenceId)) ids.push(evidenceId);
    recordEvidenceIds.set(record, ids);
  };
  for (const item of ownEvidence) if (item.rawRef) rememberRecord(item.rawRef, item.id);
  for (const observation of state.observations.filter((item) => item.projectId === projectId)) rememberRecord(observation.rawRef);
  for (const event of state.events.filter((item) => item.projectId === projectId)) {
    const rawRef = event.payload?.rawRef;
    if (typeof rawRef === "string") rememberRecord(rawRef);
  }
  const evidenceById = new Map(ownEvidence.map((item) => [item.id, item]));
  const resolveOne = (raw: string): CheckpointReference => {
    const input = referenceInput(raw);
    const evidenceKey = input.startsWith("evidence:") ? input.slice("evidence:".length) : input;
    const evidence = evidenceById.get(evidenceKey);
    if (evidence) return { input, kind: "evidence", status: "resolved", normalized: `evidence:${evidence.id}`, evidenceId: evidence.id };
    if (otherEvidenceIds.has(evidenceKey)) return { input, kind: "evidence", status: "rejected", reason: "other-project-evidence" };
    const recordKey = input.startsWith("record:") ? input.slice("record:".length) : input.startsWith("raw:") ? input.slice("raw:".length) : input;
    const record = recordEvidenceIds.get(recordKey);
    if (record) return { input, kind: "record", status: "resolved", normalized: recordKey, recordRef: recordKey, relatedEvidenceIds: record.length ? record : undefined };
    const explicitArtifact = input.startsWith("artifact:");
    const explicitRecord = input.startsWith("record:") || input.startsWith("raw:");
    if (!explicitArtifact && !explicitRecord && /^(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:/i.test(input)) return { input, kind: "unresolved", status: "rejected", reason: "external-uri" };
    const artifactValue = explicitArtifact ? input.slice("artifact:".length).trim() : input;
    if (pathLike(artifactValue, explicitArtifact)) {
      const artifact = resolveArtifactPath(artifactValue, workspacePath);
      if (!artifact.relativePath) return { input, kind: "unresolved", status: "rejected", reason: artifact.reason ?? "invalid-path" };
      const relatedEvidenceIds = ownEvidence.filter((item) => `${item.summary}\n${item.source}\n${item.rawRef ?? ""}`.includes(artifactValue) || `${item.summary}\n${item.source}\n${item.rawRef ?? ""}`.includes(artifact.relativePath!)).map((item) => item.id);
      return { input, kind: "artifact", status: "unverified", normalized: `artifact:${artifact.relativePath}`, relativePath: artifact.relativePath, relatedEvidenceIds: relatedEvidenceIds.length ? relatedEvidenceIds : undefined, reason: "artifact-path-is-not-evidence" };
    }
    return { input, kind: "unresolved", status: "unresolved", reason: "not-found" };
  };
  return checkpoint.evidenceRefs.map(resolveOne);
}

export function newNativeSession(): NativeSession {
  return { protocolVersion: 1, turnsStarted: 0, accountedTokens: 0, accountedInputTokens: 0, accountedCachedInputTokens: 0, accountedOutputTokens: 0, deliveredHumanSequence: -1, state: "starting" };
}

export function patchNativeSession(state: AppState, projectId: string, changes: Partial<NativeSession>): AppState {
  const run = getRun(state, projectId);
  if (!run) return state;
  return { ...state, runs: state.runs.map((item) => item.id === run.id ? { ...item, nativeSession: { ...(run.nativeSession ?? newNativeSession()), ...changes } } : item) };
}

export function missionEvent(state: AppState, projectId: string, type: EventRecord["type"], summary: string, detail?: string, extra: Partial<EventRecord> = {}): AppState {
  const run = getRun(state, projectId);
  const event: EventRecord = {
    ...extra, id: extra.id ?? makeId("event"), projectId, runId: run?.id, type,
    actor: extra.actor ?? "agent", schemaVersion: 1,
    summary: redactSecretLikeText(summary).slice(0, 1000), detail: detail === undefined ? undefined : redactSecretLikeText(detail).slice(0, 6000),
    createdAt: extra.createdAt ?? new Date().toISOString(),
    sequence: state.events.reduce((n, e) => Math.max(n, e.sequence ?? -1), -1) + 1,
    modelVersion: extra.modelVersion ?? `codex-app-server:${getProject(state, projectId)?.settings.modelName ?? "configured"}`,
  };
  return { ...state, events: [...state.events, event] };
}

export interface MissionHumanInput {
  key: string;
  title: string;
  rationale: string;
  blockingScope: string[];
  continuingScope: string[];
  options: string[];
}

const stringList = (max: number): InputSchema => ({ type: "array", items: { type: "string", maxLength: 500 }, maxItems: max });
export const missionHumanSchema: InputSchema = {
  type: "object", additionalProperties: false,
  required: ["key", "title", "rationale", "blockingScope", "continuingScope", "options"],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128, description: "동일 제품 결정을 다시 질문할 때 같은 키. 사람 답변을 대신 만들지 않습니다." },
    title: { type: "string", minLength: 1, maxLength: 1000 },
    rationale: { type: "string", minLength: 1, maxLength: 4000 },
    blockingScope: stringList(16), continuingScope: stringList(16), options: stringList(16),
  },
};

export function parseMissionHuman(value: unknown): MissionHumanInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  for (const [name, max] of [["key",128], ["title",1000], ["rationale",4000]] as const) if (typeof v[name] !== "string" || !v[name].trim() || v[name].length > max) return undefined;
  for (const name of ["blockingScope", "continuingScope", "options"] as const) if (!Array.isArray(v[name]) || v[name].length > 16 || v[name].some((s: unknown) => typeof s !== "string" || s.length > 500)) return undefined;
  if (Object.keys(v).some((key) => !Object.hasOwn(missionHumanSchema.properties!, key))) return undefined;
  return v as unknown as MissionHumanInput;
}

/** Idempotent inbox registration. Resolved items are returned, not asked again. */
export function registerMissionHuman(state: AppState, projectId: string, kind: Exclude<HumanItemKind, "APPROVAL">, input: MissionHumanInput): { state: AppState; item: HumanItem } {
  const intent = getIntent(state, projectId);
  if (!intent) throw new Error("프로젝트 의도가 없습니다.");
  const key = `${intent.id}:${kind}:${input.key}`;
  const previous = state.humanItems.find((item) => item.projectId === projectId && item.missionKey === key);
  if (previous) return { state, item: previous };
  const now = new Date().toISOString();
  const item: HumanItem = {
    id: makeId(kind), projectId, kind, missionKey: key, status: "OPEN",
    title: redactSecretLikeText(input.title), summary: redactSecretLikeText(input.rationale), rationale: redactSecretLikeText(input.rationale),
    blockingScope: kind === "QUESTION" ? input.blockingScope.map(redactSecretLikeText) : [],
    continuingScope: input.continuingScope.map(redactSecretLikeText),
    options: input.options.map((title, i) => ({ id: `option-${i + 1}`, title: redactSecretLikeText(title), description: "선택하거나 별도 의견을 남길 수 있습니다." })),
    responseMode: input.options.length ? "choice-and-text" : "free-text",
    priority: kind === "QUESTION" ? "high" : "medium", createdAt: now, updatedAt: now, evidenceRefs: [],
  };
  let next = { ...state, humanItems: [...state.humanItems, item] };
  next = missionEvent(next, projectId, "HUMAN_ITEM_CREATED", `${kind} · ${item.title}`, item.rationale, { payload: { itemId: item.id } });
  if (kind === "QUESTION") next = missionEvent(next, projectId, "QUESTION_CREATED", `질문함에 보관 · ${item.title}`, "미응답은 답변이 아닙니다. 독립적인 작업은 계속할 수 있습니다.", { payload: { itemId: item.id } });
  return { state: next, item };
}

export function missionInbox(state: AppState, projectId: string) {
  return state.humanItems.filter((item) => item.projectId === projectId).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id)).slice(-64).map((item) => ({
    id: item.id, kind: item.kind, title: item.title, status: item.status,
    answer: ["ANSWERED", "APPROVED", "ACKNOWLEDGED", "REJECTED"].includes(item.status) ? item.answerLabel ?? item.answer ?? item.status : null,
    blockingScope: item.blockingScope, continuingScope: item.continuingScope, updatedAt: item.updatedAt,
  }));
}

export function humanSignals(state: AppState, projectId: string, after: number): EventRecord[] {
  return state.events.filter((event) => event.projectId === projectId && (event.sequence ?? -1) > after &&
    ["HUMAN_ANSWERED", "HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_ACKNOWLEDGED", "HUMAN_DEFERRED"].includes(event.type));
}

/** Never turn a successful native turn into an unqualified product-complete flag. */
export function checkpointStatus(state: AppState, projectId: string, checkpoint: MissionCheckpoint): RuntimeStatus {
  if (checkpoint.disposition === "continue") return "ACTIVE";
  const blocking = getOpenHumanItems(state, projectId).filter((i) => i.blockingScope.length > 0);
  if (blocking.length) return blocking.every((item) => item.continuingScope.length === 0) ? "WAITING" : "ACTIVE";
  // A waiting checkpoint without a registered human gate is a protocol
  // inconsistency. Do not turn it into an unbounded ACTIVE retry loop.
  if (checkpoint.disposition === "waiting") return "STALLED";
  if (checkpoint.remainingWork.length) return "ACTIVE";
  return "EQUILIBRIUM";
}

/** Explicit engine migration; keep files/history and pause before changing executor authority. */
export function updateExecutionSettings(state: AppState, projectId: string, input: { executionMode: "native" | "atomic"; maxNativeTurns?: number; maxNativeTokens?: number }): AppState {
  const project = getProject(state, projectId), run = getRun(state, projectId);
  if (!project || !run || project.status === "KILLED") return state;
  if (input.executionMode !== "native" && input.executionMode !== "atomic") return state;
  if (input.maxNativeTurns !== undefined && (!Number.isInteger(input.maxNativeTurns) || input.maxNativeTurns <= 0 || input.maxNativeTurns > 1000)) return state;
  if (input.maxNativeTokens !== undefined && (!Number.isInteger(input.maxNativeTokens) || input.maxNativeTokens < 0 || input.maxNativeTokens > 10000000)) return state;
  const settings = { ...project.settings, executionMode: input.executionMode, maxNativeTurns: input.maxNativeTurns ?? project.settings.maxNativeTurns ?? 40, maxNativeTokens: 0 };
  const at = new Date().toISOString();
  const next: AppState = { ...state, projects: state.projects.map((p) => p.id === projectId ? { ...p, settings, status: "PAUSED", nextReviewAt: undefined, updatedAt: at } : p), runs: state.runs.map((r) => r.id === run.id ? { ...r, status: "PAUSED", phase: "sleep" } : r) };
  return missionEvent(next, projectId, "RUN_STATE_CHANGED", "PAUSED · 실행 방식 변경", `${input.executionMode} · 기존 파일과 질문·경험은 보존됩니다. 설정 확인 후 재개하십시오.`, { actor: "human" });
}
