export const coverageCategories = [
  "Product", "UX", "Architecture", "Application", "Data", "Security", "Privacy", "Infrastructure",
  "Networking", "Reliability", "Observability", "Performance", "Testing", "Deployment", "Operations", "Cost", "Compliance",
] as const;

export type CoverageCategory = (typeof coverageCategories)[number];
export type GapStatus = "UNEXPLORED" | "OPEN" | "INVESTIGATING" | "BLOCKED" | "RESOLVED" | "DEFERRED";
export type GapSource = "taxonomy" | "scout" | "world" | "human" | "verification";
export type MissionStatus = "PROPOSED" | "READY" | "RUNNING" | "VERIFYING" | "SUCCEEDED" | "BLOCKED" | "FAILED" | "SUPERSEDED" | "CANCELLED";

export interface GapCandidate {
  category: CoverageCategory;
  title: string;
  summary: string;
  impact: number;
  uncertainty: number;
  novelty: number;
  urgency: number;
  roleHint?: string;
  evidenceNeeded?: string[];
  sourceRefs?: string[];
}

export interface CoverageGap extends GapCandidate {
  id: string;
  key: string;
  projectId: string;
  status: GapStatus;
  source: GapSource;
  priority: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface AutonomyMission {
  id: string;
  projectId: string;
  gapId: string;
  role: string;
  objective: string;
  evidenceContract: string[];
  status: MissionStatus;
  priority: number;
  attempt: number;
  startCycle: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastDecisionId?: string;
}

export interface DecisionTrace {
  id: string;
  projectId: string;
  runId?: string;
  purpose: string;
  provider: string;
  model: string;
  result: Record<string, unknown>;
  confidence?: number;
  latencyMs: number;
  rawRef?: string;
  createdAt: string;
}

export interface CoverageSnapshot {
  id: string;
  projectId: string;
  open: number;
  unexplored: number;
  investigating: number;
  blocked: number;
  resolved: number;
  highPriorityOpen: number;
  risk: number;
  convergence: number;
  createdAt: string;
}

export interface AutonomyProjectState {
  version: 1;
  projectId: string;
  intentVersion: number;
  gaps: CoverageGap[];
  missions: AutonomyMission[];
  decisions: DecisionTrace[];
  coverageSnapshots: CoverageSnapshot[];
  lastDiscoveryAt?: string;
  lastPublishedDigest?: string;
  updatedAt: string;
}

export interface AutonomyDatabase {
  schemaVersion: 1;
  projects: Record<string, AutonomyProjectState>;
}

export type IdFactory = (prefix: string) => string;

const categoryRisk: Record<CoverageCategory, number> = {
  Product: 0.62, UX: 0.5, Architecture: 0.7, Application: 0.72, Data: 0.82, Security: 0.95, Privacy: 0.92,
  Infrastructure: 0.78, Networking: 0.75, Reliability: 0.88, Observability: 0.68, Performance: 0.64, Testing: 0.76,
  Deployment: 0.8, Operations: 0.78, Cost: 0.58, Compliance: 0.82,
};

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function boundedText(value: string | undefined, maximum: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "gap";
}

export function gapKey(category: CoverageCategory, title: string): string {
  return `${category.toLowerCase()}:${slug(title)}`;
}

export function priorityForGap(input: Pick<GapCandidate, "impact" | "uncertainty" | "novelty" | "urgency">, status: GapStatus = "OPEN"): number {
  const explorationBonus = status === "UNEXPLORED" ? 0.08 : status === "BLOCKED" ? -0.08 : 0;
  return clamp01(
    clamp01(input.impact) * 0.38 +
    clamp01(input.uncertainty) * 0.22 +
    clamp01(input.novelty) * 0.14 +
    clamp01(input.urgency) * 0.26 + explorationBonus,
  );
}

export function createAutonomyProject(projectId: string, intentVersion: number, at: string, id: IdFactory): AutonomyProjectState {
  const gaps = coverageCategories.map<CoverageGap>((category) => {
    const risk = categoryRisk[category];
    const candidate: GapCandidate = {
      category,
      title: `${category} surface review`,
      summary: `${category} 관점에서 현재 의도와 구현이 놓친 요구·가정·실패 모드가 있는지 독립적으로 탐색합니다.`,
      impact: risk,
      uncertainty: 0.9,
      novelty: 0.45,
      urgency: Math.max(0.35, risk - 0.15),
      roleHint: `${category} specialist`,
      evidenceNeeded: [`${category} 관점의 현재 상태와 미검증 가정`],
      sourceRefs: [],
    };
    return {
      ...candidate,
      id: id("gap"),
      key: `surface:${category.toLowerCase()}`,
      projectId,
      status: "UNEXPLORED",
      source: "taxonomy",
      priority: priorityForGap(candidate, "UNEXPLORED"),
      createdAt: at,
      updatedAt: at,
    };
  });
  return { version: 1, projectId, intentVersion, gaps, missions: [], decisions: [], coverageSnapshots: [], updatedAt: at };
}

function normalizeCandidate(candidate: GapCandidate): GapCandidate | undefined {
  const category = coverageCategories.includes(candidate.category) ? candidate.category : undefined;
  const title = boundedText(candidate.title, 240);
  const summary = boundedText(candidate.summary, 2_000);
  if (!category || !title || !summary) return undefined;
  return {
    category,
    title,
    summary,
    impact: clamp01(candidate.impact),
    uncertainty: clamp01(candidate.uncertainty),
    novelty: clamp01(candidate.novelty),
    urgency: clamp01(candidate.urgency),
    roleHint: boundedText(candidate.roleHint, 160) || undefined,
    evidenceNeeded: (candidate.evidenceNeeded ?? []).map((item) => boundedText(item, 500)).filter(Boolean).slice(0, 8),
    sourceRefs: (candidate.sourceRefs ?? []).map((item) => boundedText(item, 500)).filter(Boolean).slice(0, 16),
  };
}

export function mergeGapCandidates(project: AutonomyProjectState, candidates: GapCandidate[], at: string, id: IdFactory): AutonomyProjectState {
  const gaps = [...project.gaps];
  for (const raw of candidates) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const key = gapKey(candidate.category, candidate.title);
    const index = gaps.findIndex((gap) => gap.key === key);
    if (index >= 0) {
      const previous = gaps[index];
      if (previous.status === "RESOLVED" || previous.status === "DEFERRED") continue;
      const merged: CoverageGap = {
        ...previous,
        ...candidate,
        impact: Math.max(previous.impact, candidate.impact),
        uncertainty: Math.max(previous.uncertainty, candidate.uncertainty),
        novelty: Math.max(previous.novelty, candidate.novelty),
        urgency: Math.max(previous.urgency, candidate.urgency),
        evidenceNeeded: [...new Set([...(previous.evidenceNeeded ?? []), ...(candidate.evidenceNeeded ?? [])])].slice(0, 8),
        sourceRefs: [...new Set([...(previous.sourceRefs ?? []), ...(candidate.sourceRefs ?? [])])].slice(0, 16),
        status: previous.status === "UNEXPLORED" ? "OPEN" : previous.status,
        source: previous.source === "taxonomy" ? "scout" : previous.source,
        updatedAt: at,
        priority: priorityForGap(candidate, previous.status === "UNEXPLORED" ? "OPEN" : previous.status),
      };
      gaps[index] = merged;
      continue;
    }
    gaps.push({
      ...candidate,
      id: id("gap"),
      key,
      projectId: project.projectId,
      status: "OPEN",
      source: "scout",
      priority: priorityForGap(candidate),
      createdAt: at,
      updatedAt: at,
    });
  }
  return { ...project, gaps, updatedAt: at };
}

export function completeDiscoveryPass(project: AutonomyProjectState, intentVersion: number, at: string): AutonomyProjectState {
  const gaps = project.gaps.map((gap) => gap.source === "taxonomy" && gap.status === "UNEXPLORED"
    ? { ...gap, status: "RESOLVED" as const, uncertainty: 0.45, priority: 0, updatedAt: at, resolvedAt: at }
    : gap);
  return { ...project, intentVersion, gaps, lastDiscoveryAt: at, updatedAt: at };
}

export function activeMission(project: AutonomyProjectState): AutonomyMission | undefined {
  const active = new Set<MissionStatus>(["PROPOSED", "READY", "RUNNING", "VERIFYING", "BLOCKED"]);
  return project.missions.filter((mission) => active.has(mission.status)).sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function selectableGaps(project: AutonomyProjectState): CoverageGap[] {
  const activeGap = activeMission(project)?.gapId;
  return project.gaps
    .filter((gap) => ["OPEN", "UNEXPLORED", "INVESTIGATING"].includes(gap.status) && gap.id !== activeGap)
    .sort((a, b) => b.priority - a.priority || b.impact - a.impact || a.createdAt.localeCompare(b.createdAt));
}

export function startMissionForGap(project: AutonomyProjectState, gapId: string, runCycle: number, at: string, id: IdFactory): AutonomyProjectState {
  if (activeMission(project)) return project;
  const gap = project.gaps.find((item) => item.id === gapId);
  if (!gap || !["OPEN", "UNEXPLORED", "INVESTIGATING"].includes(gap.status)) return project;
  const mission: AutonomyMission = {
    id: id("mission"),
    projectId: project.projectId,
    gapId: gap.id,
    role: gap.roleHint || `${gap.category} specialist`,
    objective: `${gap.title}: ${gap.summary}`,
    evidenceContract: gap.evidenceNeeded?.length ? gap.evidenceNeeded : ["현실 상태를 직접 관찰하거나 실행 결과로 검증할 것", "완료 주장은 재현 가능한 증거와 연결할 것"],
    status: "RUNNING",
    priority: gap.priority,
    attempt: 1,
    startCycle: runCycle,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
  };
  return {
    ...project,
    gaps: project.gaps.map((item) => item.id === gap.id ? { ...item, status: "INVESTIGATING", updatedAt: at } : item),
    missions: [...project.missions, mission],
    updatedAt: at,
  };
}

export function settleMission(project: AutonomyProjectState, missionId: string, status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "SUPERSEDED" | "CANCELLED", at: string, decisionId?: string): AutonomyProjectState {
  const mission = project.missions.find((item) => item.id === missionId);
  if (!mission) return project;
  const gapStatus: GapStatus = status === "SUCCEEDED" ? "RESOLVED" : status === "BLOCKED" ? "BLOCKED" : status === "FAILED" ? "OPEN" : "DEFERRED";
  return {
    ...project,
    missions: project.missions.map((item) => item.id === missionId ? { ...item, status, updatedAt: at, completedAt: status === "BLOCKED" ? undefined : at, lastDecisionId: decisionId ?? item.lastDecisionId } : item),
    gaps: project.gaps.map((gap) => gap.id === mission.gapId ? {
      ...gap,
      status: gapStatus,
      uncertainty: status === "FAILED" ? clamp01(gap.uncertainty + 0.08) : gap.uncertainty,
      priority: status === "SUCCEEDED" ? 0 : priorityForGap(gap, gapStatus),
      updatedAt: at,
      resolvedAt: status === "SUCCEEDED" ? at : undefined,
    } : gap),
    updatedAt: at,
  };
}

export function appendDecision(project: AutonomyProjectState, trace: DecisionTrace, maximum = 256): AutonomyProjectState {
  return { ...project, decisions: [...project.decisions, trace].slice(-maximum), updatedAt: trace.createdAt };
}

export function coverageCounts(project: AutonomyProjectState) {
  const count = (status: GapStatus) => project.gaps.filter((gap) => gap.status === status).length;
  return {
    open: count("OPEN"), unexplored: count("UNEXPLORED"), investigating: count("INVESTIGATING"), blocked: count("BLOCKED"), resolved: count("RESOLVED"), deferred: count("DEFERRED"),
    highPriorityOpen: project.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status) && gap.priority >= 0.62).length,
  };
}

export function coverageConvergence(project: AutonomyProjectState): number {
  const unresolved = project.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status));
  if (!unresolved.length) return 1;
  const weighted = unresolved.reduce((sum, gap) => sum + gap.priority * Math.max(0.35, gap.impact), 0) / unresolved.length;
  return clamp01(1 - weighted);
}

export function appendCoverageSnapshot(project: AutonomyProjectState, risk: number, convergenceHint: number | undefined, at: string, id: IdFactory): AutonomyProjectState {
  const counts = coverageCounts(project);
  const snapshot: CoverageSnapshot = {
    id: id("coverage"), projectId: project.projectId,
    open: counts.open, unexplored: counts.unexplored, investigating: counts.investigating, blocked: counts.blocked, resolved: counts.resolved,
    highPriorityOpen: counts.highPriorityOpen,
    risk: clamp01(risk),
    convergence: clamp01(convergenceHint === undefined ? coverageConvergence(project) : Math.min(convergenceHint, coverageConvergence(project) + 0.2)),
    createdAt: at,
  };
  return { ...project, coverageSnapshots: [...project.coverageSnapshots, snapshot].slice(-128), updatedAt: at };
}

export function hasMaterialUnresolvedWork(project: AutonomyProjectState): boolean {
  return Boolean(activeMission(project)) || project.gaps.some((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status) && gap.priority >= 0.55);
}
