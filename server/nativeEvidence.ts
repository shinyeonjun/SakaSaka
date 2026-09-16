import { createHash } from "node:crypto";
import type { AppState, Evidence, AgentAction } from "../src/types";
import { getProject, getRun, getWorldSnapshot, makeId } from "../src/runtime";
import { missionEvent } from "../src/nativeSession";
import { redactSecretLikeText } from "../src/security";
import { rebuildRetrievalIndex } from "../src/memory";
import { asRecord, type RpcRecord } from "./codexAppServer";

/** Provider item IDs are namespaced, never interpreted as SakaSaka process IDs. */
export function nativeActionId(projectId: string, threadId: string, turnId: string, itemId: string): string {
  return `native-${createHash("sha256").update(JSON.stringify([projectId, threadId, turnId, itemId])).digest("hex")}`;
}

export function recordNativeItem(state: AppState, projectId: string, threadId: string, turnId: string, item: RpcRecord, complete: boolean, rawRef: string): AppState {
  if (typeof item.id !== "string" || !["commandExecution", "fileChange", "webSearch", "mcpToolCall"].includes(String(item.type))) return state;
  const project = getProject(state, projectId), run = getRun(state, projectId), world = getWorldSnapshot(state, projectId);
  if (!project || !run || !world) return state;
  const id = nativeActionId(projectId, threadId, turnId, item.id);
  const previous = state.actions.find((a) => a.id === id);
  if (complete && previous?.completedAt && previous.tool === `codex.${String(item.type)}`) return state;
  const tool = `codex.${String(item.type)}`;
  const summary = item.type === "commandExecution" ? `명령 · ${String(item.command ?? "").slice(0, 1000)}`
    : item.type === "fileChange" ? `파일 변경 · ${(Array.isArray(item.changes) ? item.changes : []).map((change) => String(asRecord(change).path ?? "")).join(", ").slice(0, 1000)}`
    : `외부 도구 관찰 · ${String(item.type)}`;
  const now = new Date().toISOString();
  const succeeded = item.type === "commandExecution" ? item.exitCode === 0 && item.status === "completed" : item.type === "fileChange" && item.status === "completed";
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
  const action: AgentAction = {
    ...previous, id, projectId, runId: run.id, schemaVersion: 1, type: "ACT", tool,
    intentRef: project.intentId, worldCursor: world.cursorEventId, rationaleSummary: redactSecretLikeText(summary),
    status: !complete ? "RUNNING" : succeeded ? "VERIFIED" : failed ? "FAILED" : "UNCERTAIN",
    params: { providerItemId: item.id, threadId, turnId }, riskClass: "P1", cost: 0,
    modelVersion: `codex-app-server:${project.settings.modelName ?? "configured"}`, toolVersion: "codex-app-server-v2",
    policyVersion: 1, createdAt: previous?.createdAt ?? now, completedAt: complete ? now : undefined, toolResultRef: complete ? rawRef : undefined,
  };
  let next: AppState = { ...state, actions: previous ? state.actions.map((a) => a.id === id ? action : a) : [...state.actions, action],
    projects: state.projects.map((p) => p.id === projectId ? { ...p, currentActionId: id } : p) };
  next = missionEvent(next, projectId, complete ? "TOOL_RESULT" : "TOOL_CALLED", summary, complete ? `원본 ${rawRef} · native 실행 상태=${String(item.status)}` : "Codex의 같은 세션 안에서 도구를 실행 중입니다.", { actionId: id, payload: { threadId, turnId, providerItemId: item.id, rawRef } });
  if (!complete) return next;
  const output = redactSecretLikeText(String(item.aggregatedOutput ?? "")).slice(0, 5000);
  const ev: Evidence = { id: makeId("evidence"), projectId, actionId: id, kind: "world", verdict: succeeded ? "PASS" : failed ? "FAIL" : "UNCERTAIN",
    summary: `${summary} · ${succeeded ? "실행 성공" : failed ? "실행 실패 — 에이전트가 결과를 읽고 복구 가능" : "결과 미확인"}. 제품 목표 전체의 검증이 아닙니다.`,
    source: tool, createdAt: now, rawRef, evaluator: "native-execution-status", evaluatorVersion: "1",
    metadata: { threadId, turnId, providerItemId: item.id, status: String(item.status), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) } };
  next = { ...next, evidence: [...next.evidence, ev], observations: [...next.observations, {
    id: makeId("observation"), projectId, source: item.type === "fileChange" ? "workspace" : "shell", status: failed ? "warning" : "healthy",
    observedAt: now, freshness: "fresh", trustLevel: "untrusted", confidence: 0.8, rawRef, compactView: `${ev.summary}\n${output}`, relatedEntities: [id, run.id],
  }] };
  next = missionEvent(next, projectId, "EVIDENCE_RECORDED", ev.summary, output, { actionId: id, evidenceIds: [ev.id] });
  const experience = {
    id: makeId("experience"), projectId, situation: `native thread ${threadId} · turn ${turnId}`, decision: action.rationaleSummary,
    action: tool, outcome: ev.summary, evidenceIds: [ev.id], cost: 0, risk: "P1" as const, humanIntervention: false, createdAt: now,
    worldBeforeRef: world.id, intentRef: project.intentId, actionType: "ACT" as const, actionPayloadRef: id, modelVersion: action.modelVersion, toolVersion: action.toolVersion, policyVersion: 1,
  };
  next = { ...next, experiences: [...next.experiences, experience], relations: [...next.relations,
    { id: makeId("relation"), projectId, fromId: experience.id, relationType: "derived-from", toId: id, createdAt: now },
    { id: makeId("relation"), projectId, fromId: id, relationType: "verified-by", toId: ev.id, createdAt: now },
  ] };
  return { ...next, retrievalIndex: rebuildRetrievalIndex(next, projectId) };
}

/**
 * Codex 0.154 can return an exec failure without a commandExecution notification.
 * Preserve the actual raw tool output rather than dropping it or inventing exit metadata.
 * Only function/custom-tool items are accepted; reasoning/encrypted content is never retained.
 */
export function recordNativeRawTool(state: AppState, projectId: string, threadId: string, turnId: string, item: RpcRecord, rawRef: string): AppState {
  const call = item.type === "function_call" || item.type === "custom_tool_call";
  const output = item.type === "function_call_output" || item.type === "custom_tool_call_output";
  if ((!call && !output) || typeof item.call_id !== "string") return state;
  const project = getProject(state, projectId), run = getRun(state, projectId), world = getWorldSnapshot(state, projectId);
  if (!project || !run || !world) return state;
  const id = nativeActionId(projectId, threadId, turnId, item.call_id);
  const previous = state.actions.find((a) => a.id === id);
  if (previous?.completedAt || (call && previous)) return state;
  const now = new Date().toISOString();
  const name = typeof item.name === "string" ? item.name : previous?.tool?.replace(/^codex\./, "") ?? "tool";
  // Dynamic bridge outputs are already source-linked by SakaSaka itself.
  if (name.startsWith("sakasaka_")) return state;
  const action: AgentAction = {
    ...previous, id, projectId, runId: run.id, type: "ACT", tool: previous?.tool ?? `codex.${name}`,
    schemaVersion: 1, intentRef: project.intentId, worldCursor: world.cursorEventId,
    rationaleSummary: previous?.rationaleSummary ?? `Native 도구 · ${name}`,
    status: output ? "UNCERTAIN" : "RUNNING", cost: 0,
    params: { providerItemId: item.call_id, threadId, turnId }, riskClass: "P1", policyVersion: 1,
    modelVersion: `codex-app-server:${project.settings.modelName ?? "configured"}`,
    createdAt: previous?.createdAt ?? now, completedAt: output ? now : undefined, toolResultRef: rawRef,
  };
  let next: AppState = { ...state, actions: previous ? state.actions.map((a) => a.id === id ? action : a) : [...state.actions, action] };
  if (!output) return next;
  const text = redactSecretLikeText(typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")).slice(0, 6000);
  const evidence: Evidence = { id: makeId("evidence"), projectId, actionId: id, kind: "world", verdict: "UNCERTAIN", summary: `Native 도구 결과 · 구조화 실행 상태 미제공 · ${text.slice(0, 1000)}`, source: "codex.rawToolOutput", createdAt: now, rawRef, metadata: { threadId, turnId, providerItemId: item.call_id } };
  next = { ...next, evidence: [...next.evidence, evidence], observations: [...next.observations, { id: makeId("observation"), projectId, source: "shell", status: "warning", observedAt: now, freshness: "fresh", trustLevel: "untrusted", confidence: 0.5, rawRef, compactView: text, relatedEntities: [id, run.id] }] };
  next = missionEvent(next, projectId, "EVIDENCE_RECORDED", evidence.summary, text, { actionId: id, evidenceIds: [evidence.id], payload: { rawRef } });
  const experience = {
    id: makeId("experience"), projectId, situation: `native thread ${threadId} · turn ${turnId}`, decision: action.rationaleSummary,
    action: action.tool ?? "codex.rawToolOutput", outcome: evidence.summary, evidenceIds: [evidence.id], cost: 0,
    risk: "P1" as const, humanIntervention: false, createdAt: now, worldBeforeRef: world.id,
    intentRef: project.intentId, actionType: "ACT" as const, actionPayloadRef: id, modelVersion: action.modelVersion, policyVersion: 1,
  };
  next = { ...next, experiences: [...next.experiences, experience], relations: [...next.relations,
    { id: makeId("relation"), projectId, fromId: experience.id, relationType: "derived-from", toId: id, createdAt: now },
    { id: makeId("relation"), projectId, fromId: id, relationType: "verified-by", toId: evidence.id, createdAt: now },
  ] };
  return { ...next, retrievalIndex: rebuildRetrievalIndex(next, projectId) };
}
