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
  return { QUESTION: "Questions", IDEA: "Ideas", CONCERN: "Concerns", APPROVAL: "Approvals" }[kind];
}

export function humanStatusLabel(status: HumanItemStatus): string {
  return {
    OPEN: "open",
    ANSWERED: "answered",
    APPROVED: "approved",
    REJECTED: "rejected",
    DEFERRED: "deferred",
    ACKNOWLEDGED: "acknowledged",
  }[status];
}

export function runtimeDescription(status: RuntimeStatus): string {
  return {
    ACTIVE: "AI가 직접 World를 바꾸고 있음",
    WAITING: "Human answer/approval이 필요한 범위가 있음",
    EQUILIBRIUM: "현재 비용 대비 가치 높은 행동이 없음",
    STALLED: "반복 실패 또는 진전 없음",
    PAUSED: "사용자가 실행을 일시 정지",
    KILLED: "Run 강제 종료 · lease revoked",
  }[status];
}

export function eventCategory(event: EventRecord): "runtime" | "human" | "world" | "evidence" {
  if (event.type.startsWith("HUMAN_") || event.type === "HUMAN_ITEM_CREATED") return "human";
  if (event.type.includes("EVIDENCE") || event.type === "VERIFY") return "evidence";
  if (event.type === "WORLD_CHANGED" || event.type === "OBSERVATION_REFRESHED" || event.type === "OBSERVE") return "world";
  return "runtime";
}
