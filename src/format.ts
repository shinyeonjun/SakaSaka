import type { EventRecord, HumanItemKind, HumanItemStatus, RuntimeStatus } from "./types";

export function formatClock(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function humanKindLabel(kind: HumanItemKind): string {
  return { QUESTION: "질문", IDEA: "아이디어", CONCERN: "우려", APPROVAL: "승인" }[kind];
}

export function humanStatusLabel(status: HumanItemStatus): string {
  return {
    OPEN: "열림",
    ANSWERED: "답변 완료",
    APPROVED: "승인됨",
    REJECTED: "거절됨",
    DEFERRED: "나중에 답변",
    ACKNOWLEDGED: "확인됨",
  }[status];
}

export function runtimeDescription(status: RuntimeStatus): string {
  return {
    ACTIVE: "다음 인지 주기를 실행할 수 있는 상태",
    WAITING: "사람의 답변 또는 승인이 필요한 범위가 있음",
    EQUILIBRIUM: "현재 비용 대비 가치 높은 행동이 없음",
    STALLED: "반복 실패 또는 진전 없음",
    PAUSED: "사용자가 실행을 일시 정지",
    KILLED: "실행 강제 종료 · lease 폐기",
  }[status];
}

export function worldStatusLabel(status: "healthy" | "warning" | "blocked"): string {
  return { healthy: "정상", warning: "주의", blocked: "차단됨" }[status];
}

export function freshnessLabel(freshness: "fresh" | "aging" | "stale"): string {
  return { fresh: "최신", aging: "오래됨", stale: "낡음" }[freshness];
}

export function trustLevelLabel(trustLevel: "verified" | "observed" | "untrusted"): string {
  return { verified: "검증됨", observed: "관찰됨", untrusted: "신뢰하지 않음" }[trustLevel];
}

export function artifactKindLabel(kind: "build" | "report" | "screenshot" | "release" | "docs"): string {
  return { build: "빌드", report: "리포트", screenshot: "스크린샷", release: "릴리스", docs: "문서" }[kind];
}

export function eventCategory(event: EventRecord): "runtime" | "human" | "world" | "evidence" {
  if (event.type.startsWith("HUMAN_") || event.type === "HUMAN_ITEM_CREATED") return "human";
  if (event.type.includes("EVIDENCE") || event.type === "VERIFY") return "evidence";
  if (event.type === "WORLD_CHANGED" || event.type === "OBSERVATION_REFRESHED" || event.type === "OBSERVE") return "world";
  return "runtime";
}
