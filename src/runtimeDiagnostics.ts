import type { AppState } from "./types";

/** Prefer actual failure records to a stale action rationale. Safe for pure UI tests. */
export function runtimeDiagnostics(state: AppState, projectId: string) {
  const project = state.projects.find((item) => item.id === projectId);
  const run = state.runs.find((item) => item.id === project?.activeRunId);
  const failures = state.events.filter((item) => item.projectId === projectId && item.runId === run?.id && ["MODEL_FAILED", "RUNTIME_ERROR"].includes(item.type));
  const latestFailure = failures.at(-1);
  const lastAction = state.actions.filter((item) => item.projectId === projectId && item.runId === run?.id).at(-1);
  const lastSuccess = state.actions.filter((item) => item.projectId === projectId && item.runId === run?.id && item.status === "VERIFIED").at(-1);
  const stopped = project?.status === "STALLED";
  return {
    stopped,
    reason: stopped ? run?.stopReason ?? run?.lastModelFailure?.message ?? latestFailure?.detail ?? latestFailure?.summary ?? "중단 이유가 기록되지 않았습니다. 활동 원본을 확인하십시오." : undefined,
    code: run?.lastModelFailure?.code,
    retryable: run?.lastModelFailure?.retryable,
    rawRef: run?.lastModelFailure?.rawRef ?? (typeof latestFailure?.payload?.rawRef === "string" ? latestFailure.payload.rawRef : undefined),
    failureCount: run?.consecutiveFailures ?? 0,
    noProgressCount: run?.noProgressCycles ?? 0,
    retryAfter: run?.retryAfter,
    lastAction, lastSuccess,
  };
}
