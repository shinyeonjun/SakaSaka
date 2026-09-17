import type { AppState, Evidence, HumanItem } from "./types";

export const coverageCategories = [
  "Product", "UX", "Architecture", "Application", "Data", "Security", "Privacy", "Infrastructure",
  "Networking", "Reliability", "Observability", "Performance", "Testing", "Deployment", "Operations", "Cost", "Compliance",
] as const;

export type CoverageCategory = (typeof coverageCategories)[number];

export interface ControlPlaneGapView {
  id: string;
  category: string;
  title: string;
  priority: number;
  evidenceId: string;
  observedAt: string;
  status?: string;
  source?: string;
  summary?: string;
  evidenceNeeded?: string[];
  sourceRefs?: string[];
  impact?: number;
  uncertainty?: number;
  novelty?: number;
  urgency?: number;
}

export interface ControlPlaneMissionView {
  id: string;
  role: string;
  objective: string;
  evidenceContract: string[];
  observedAt: string;
  evidenceId: string;
  status?: string;
  priority?: number;
  gapId?: string;
  attempt?: number;
}

export interface ControlPlaneSnapshotView {
  decisionProvider?: string;
  counts: {
    open: number;
    investigating: number;
    blocked: number;
    unexplored: number;
    highPriority: number;
  };
  mission?: ControlPlaneMissionView;
  gaps: ControlPlaneGapView[];
  evidenceId: string;
  observedAt: string;
}

const emptyCounts = { open: 0, investigating: 0, blocked: 0, unexplored: 0, highPriority: 0 };

function asNumber(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseGap(raw: string, evidence: Evidence): ControlPlaneGapView | undefined {
  const match = raw.trim().match(/^(\S+)\s+([^/]+)\/(.+)\(([0-9.]+)\)$/);
  if (!match) return undefined;
  return {
    id: match[1],
    category: match[2].trim(),
    title: match[3].trim(),
    priority: Math.max(0, Math.min(1, asNumber(match[4]))),
    evidenceId: evidence.id,
    observedAt: evidence.createdAt,
  };
}

export function parseControlPlaneEvidence(evidence: Evidence): ControlPlaneSnapshotView | undefined {
  if (evidence.source !== "sakasaka-autonomy") return undefined;
  const summary = evidence.summary;
  const head = summary.match(/decision=([^;]+);\s*open=(\d+),\s*investigating=(\d+),\s*blocked=(\d+),\s*unexplored=(\d+),\s*highPriority=(\d+)/i);
  const counts = head ? {
    open: asNumber(head[2]),
    investigating: asNumber(head[3]),
    blocked: asNumber(head[4]),
    unexplored: asNumber(head[5]),
    highPriority: asNumber(head[6]),
  } : { ...emptyCounts };

  let mission: ControlPlaneMissionView | undefined;
  const missionMatch = summary.match(/Active mission \[([^\]]+)]\s+([\s\S]+?)\.\s+Evidence contract:\s+([\s\S]+?)\.\s+(?:Priority gaps:|No unresolved priority gaps\.)/);
  if (missionMatch) {
    mission = {
      id: `mission-${evidence.id}`,
      role: missionMatch[1].trim(),
      objective: missionMatch[2].trim(),
      evidenceContract: missionMatch[3].split(" | ").map((item) => item.trim()).filter(Boolean),
      observedAt: evidence.createdAt,
      evidenceId: evidence.id,
    };
  }

  const gaps: ControlPlaneGapView[] = [];
  const gapsMatch = summary.match(/Priority gaps:\s+([\s\S]+?)\.\s+This is control-plane state/);
  if (gapsMatch) {
    for (const raw of gapsMatch[1].split(";")) {
      const gap = parseGap(raw, evidence);
      if (gap) gaps.push(gap);
    }
  }

  return {
    decisionProvider: head?.[1]?.trim(),
    counts,
    mission,
    gaps,
    evidenceId: evidence.id,
    observedAt: evidence.createdAt,
  };
}

export function controlPlaneHistory(state: AppState, projectId: string): ControlPlaneSnapshotView[] {
  return state.evidence
    .filter((item) => item.projectId === projectId && item.source === "sakasaka-autonomy")
    .map(parseControlPlaneEvidence)
    .filter((item): item is ControlPlaneSnapshotView => Boolean(item))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

export function latestControlPlane(state: AppState, projectId: string): ControlPlaneSnapshotView | undefined {
  return controlPlaneHistory(state, projectId).at(-1);
}

export function missionHistory(state: AppState, projectId: string): ControlPlaneMissionView[] {
  const seen = new Set<string>();
  const missions: ControlPlaneMissionView[] = [];
  for (const snapshot of controlPlaneHistory(state, projectId).reverse()) {
    if (!snapshot.mission) continue;
    const key = `${snapshot.mission.role}\u0000${snapshot.mission.objective}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missions.push(snapshot.mission);
  }
  return missions;
}

export function gapHistory(state: AppState, projectId: string): ControlPlaneGapView[] {
  const byId = new Map<string, ControlPlaneGapView>();
  for (const snapshot of controlPlaneHistory(state, projectId)) {
    for (const gap of snapshot.gaps) byId.set(gap.id, gap);
  }
  return [...byId.values()].sort((a, b) => b.priority - a.priority || b.observedAt.localeCompare(a.observedAt));
}

export function openHumanItems(state: AppState, projectId: string): HumanItem[] {
  return state.humanItems
    .filter((item) => item.projectId === projectId && item.status === "OPEN")
    .sort((a, b) => (a.priority === b.priority ? b.createdAt.localeCompare(a.createdAt) : ({ high: 3, medium: 2, low: 1 }[b.priority] - { high: 3, medium: 2, low: 1 }[a.priority])));
}

export function relativeAge(iso: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  if (!Number.isFinite(delta)) return "-";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function priorityBand(priority: number): "P0" | "P1" | "P2" | "P3" {
  if (priority >= 0.85) return "P0";
  if (priority >= 0.65) return "P1";
  if (priority >= 0.45) return "P2";
  return "P3";
}

export function categoryLabel(category: string): string {
  return ({
    Product: "제품", UX: "UX", Architecture: "아키텍처", Application: "애플리케이션", Data: "데이터", Security: "보안",
    Privacy: "개인정보", Infrastructure: "인프라", Networking: "네트워크", Reliability: "안정성", Observability: "관측성",
    Performance: "성능", Testing: "테스트", Deployment: "배포", Operations: "운영", Cost: "비용", Compliance: "규정 준수",
  } as Record<string, string>)[category] ?? category;
}

export function categorySignal(state: AppState, projectId: string, category: string): { gaps: number; risk: number; state: "open" | "seen" | "quiet" } {
  const gaps = gapHistory(state, projectId).filter((gap) => gap.category === category);
  const current = latestControlPlane(state, projectId)?.gaps.filter((gap) => gap.category === category) ?? [];
  if (current.length) return { gaps: current.length, risk: Math.max(...current.map((gap) => gap.priority)), state: "open" };
  if (gaps.length) return { gaps: gaps.length, risk: Math.max(...gaps.map((gap) => gap.priority)), state: "seen" };
  return { gaps: 0, risk: 0, state: "quiet" };
}
