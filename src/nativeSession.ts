import type { AppState, EventRecord, HumanItem, HumanItemKind, RuntimeStatus } from "./types";
import { getIntent, getProject, getRun, makeId } from "./runtime";
import { redactSecretLikeText } from "./security";
import type { InputSchema } from "./toolContracts";

/** A checkpoint reports a project state; it does not certify product quality. */
export interface MissionCheckpoint {
  disposition: "continue" | "waiting" | "equilibrium";
  summary: string;
  remainingWork: string[];
  evidenceRefs: string[];
  wakeReasons: string[];
}

export interface NativeSession {
  protocolVersion: 1;
  threadId?: string;
  turnId?: string;
  turnsStarted: number;
  accountedTokens: number;
  accountedInputTokens: number;
  accountedOutputTokens: number;
  deliveredHumanSequence: number;
  checkpoint?: MissionCheckpoint;
  lastMessage?: string;
  rawRef?: string;
  state: "starting" | "working" | "resting" | "interrupted" | "failed";
}

export const checkpointSchema: InputSchema = {
  type: "object", additionalProperties: false,
  required: ["disposition", "summary", "remainingWork", "evidenceRefs", "wakeReasons"],
  properties: {
    disposition: { type: "string", enum: ["continue", "waiting", "equilibrium"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    remainingWork: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 32 },
    evidenceRefs: { type: "array", items: { type: "string", maxLength: 512 }, maxItems: 64 },
    wakeReasons: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 16 },
  },
};

export function parseCheckpoint(raw: string): MissionCheckpoint | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>;
    if (!["continue", "waiting", "equilibrium"].includes(String(v.disposition)) || typeof v.summary !== "string" || !v.summary.trim() || v.summary.length > 4000) return undefined;
    for (const [name, max, length] of [["remainingWork", 32, 1000], ["evidenceRefs", 64, 512], ["wakeReasons", 16, 1000]] as const) {
      if (!Array.isArray(v[name]) || v[name].length > max || v[name].some((s: unknown) => typeof s !== "string" || s.length > length)) return undefined;
    }
    if (Object.keys(v).some((key) => !Object.hasOwn(checkpointSchema.properties!, key))) return undefined;
    return {
      disposition: v.disposition as MissionCheckpoint["disposition"],
      summary: redactSecretLikeText(v.summary),
      remainingWork: (v.remainingWork as string[]).map(redactSecretLikeText),
      evidenceRefs: v.evidenceRefs as string[], wakeReasons: (v.wakeReasons as string[]).map(redactSecretLikeText),
    };
  } catch { return undefined; }
}

export function newNativeSession(): NativeSession {
  return { protocolVersion: 1, turnsStarted: 0, accountedTokens: 0, accountedInputTokens: 0, accountedOutputTokens: 0, deliveredHumanSequence: -1, state: "starting" };
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
  const blocking = state.humanItems.filter((i) => i.projectId === projectId && (i.status === "OPEN" || i.status === "DEFERRED") && i.blockingScope.length);
  if (blocking.length) return "WAITING"; // Agent reported no independent work now; inbox remains actionable.
  if (checkpoint.remainingWork.length || checkpoint.disposition === "waiting") return "ACTIVE";
  return "EQUILIBRIUM";
}

/** Explicit engine migration; keep files/history and pause before changing executor authority. */
export function updateExecutionSettings(state: AppState, projectId: string, input: { executionMode: "native" | "atomic"; maxNativeTurns?: number; maxNativeTokens?: number }): AppState {
  const project = getProject(state, projectId), run = getRun(state, projectId);
  if (!project || !run || project.status === "KILLED") return state;
  if (input.executionMode !== "native" && input.executionMode !== "atomic") return state;
  for (const [value, max] of [[input.maxNativeTurns, 1000], [input.maxNativeTokens, 10000000]] as const) if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > max)) return state;
  const settings = { ...project.settings, executionMode: input.executionMode, maxNativeTurns: input.maxNativeTurns ?? project.settings.maxNativeTurns ?? 40, maxNativeTokens: input.maxNativeTokens ?? project.settings.maxNativeTokens ?? 250000 };
  const at = new Date().toISOString();
  const next: AppState = { ...state, projects: state.projects.map((p) => p.id === projectId ? { ...p, settings, status: "PAUSED", nextReviewAt: undefined, updatedAt: at } : p), runs: state.runs.map((r) => r.id === run.id ? { ...r, status: "PAUSED", phase: "sleep" } : r) };
  return missionEvent(next, projectId, "RUN_STATE_CHANGED", "PAUSED · 실행 방식 변경", `${input.executionMode} · 기존 파일과 질문·경험은 보존됩니다. 설정 확인 후 재개하십시오.`, { actor: "human" });
}
