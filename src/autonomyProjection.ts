import type { ControlPlaneGapView, ControlPlaneMissionView } from "./controlPlaneView";

export type AutonomyGapStatus = "UNEXPLORED" | "OPEN" | "INVESTIGATING" | "BLOCKED" | "RESOLVED" | "DEFERRED";
export type AutonomyMissionStatus = "PROPOSED" | "READY" | "RUNNING" | "VERIFYING" | "SUCCEEDED" | "BLOCKED" | "FAILED" | "SUPERSEDED" | "CANCELLED";

export interface AutonomySurfaceProjection {
  id: string;
  key: string;
  name: string;
  description: string;
  parentKey?: string;
  origin: "baseline" | "discovered" | "human" | "standard";
  status: "UNEXPLORED" | "EXPLORED" | "RETIRED";
  risk: number;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  lastExploredAt?: string;
}

export interface AutonomySpecialistProjection {
  id: string;
  key: string;
  name: string;
  focus: string;
  rationale?: string;
  surfaceRefs: string[];
  origin: "baseline" | "discovered" | "human";
  status: "ACTIVE" | "RETIRED";
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface AutonomyGapProjection {
  id: string;
  category: string;
  title: string;
  summary: string;
  status: AutonomyGapStatus;
  source: string;
  priority: number;
  impact: number;
  uncertainty: number;
  novelty: number;
  urgency: number;
  evidenceNeeded: string[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface AutonomyMissionProjection {
  id: string;
  gapId: string;
  role: string;
  objective: string;
  evidenceContract: string[];
  status: AutonomyMissionStatus;
  priority: number;
  attempt: number;
  startCycle: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastDecisionId?: string;
}

export interface AutonomyDecisionProjection {
  id: string;
  purpose: string;
  provider: string;
  model: string;
  confidence?: number;
  latencyMs: number;
  createdAt: string;
}

export interface AutonomyCoverageProjection {
  id: string;
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

export interface AutonomyProjectProjection {
  available: boolean;
  projectId: string;
  intentVersion?: number;
  updatedAt?: string;
  lastDiscoveryAt?: string;
  surfaces: AutonomySurfaceProjection[];
  specialists: AutonomySpecialistProjection[];
  gaps: AutonomyGapProjection[];
  missions: AutonomyMissionProjection[];
  decisions: AutonomyDecisionProjection[];
  coverageSnapshots: AutonomyCoverageProjection[];
}

export function autonomySurfaces(projection: AutonomyProjectProjection | undefined): AutonomySurfaceProjection[] {
  return projection?.available ? projection.surfaces.filter((surface) => surface.status !== "RETIRED") : [];
}

export function activeAutonomySpecialists(projection: AutonomyProjectProjection | undefined): AutonomySpecialistProjection[] {
  return projection?.available ? projection.specialists.filter((specialist) => specialist.status === "ACTIVE") : [];
}

const terminalMission = new Set<AutonomyMissionStatus>(["SUCCEEDED", "SUPERSEDED", "CANCELLED"]);
const closedGap = new Set<AutonomyGapStatus>(["RESOLVED", "DEFERRED"]);

export function activeAutonomyMissions(projection: AutonomyProjectProjection | undefined): AutonomyMissionProjection[] {
  if (!projection?.available) return [];
  return projection.missions
    .filter((mission) => !terminalMission.has(mission.status))
    .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
}

export function autonomyMissionHistory(projection: AutonomyProjectProjection | undefined): ControlPlaneMissionView[] {
  if (!projection?.available) return [];
  const statusRank: Record<AutonomyMissionStatus, number> = {
    RUNNING: 9, VERIFYING: 8, READY: 7, BLOCKED: 6, PROPOSED: 5, FAILED: 4, SUCCEEDED: 3, SUPERSEDED: 2, CANCELLED: 1,
  };
  return [...projection.missions]
    .sort((a, b) => statusRank[b.status] - statusRank[a.status] || b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))
    .map((mission) => ({
      id: mission.id,
      role: mission.role,
      objective: mission.objective,
      evidenceContract: mission.evidenceContract,
      observedAt: mission.updatedAt,
      evidenceId: `autonomy:${mission.id}`,
      status: mission.status,
      priority: mission.priority,
      gapId: mission.gapId,
      attempt: mission.attempt,
    }));
}

export function autonomyGapHistory(projection: AutonomyProjectProjection | undefined): ControlPlaneGapView[] {
  if (!projection?.available) return [];
  return [...projection.gaps]
    .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))
    .map((gap) => ({
      id: gap.id,
      category: gap.category,
      title: gap.title,
      priority: gap.priority,
      evidenceId: `autonomy:${gap.id}`,
      observedAt: gap.updatedAt,
      status: gap.status,
      source: gap.source,
      summary: gap.summary,
      evidenceNeeded: gap.evidenceNeeded,
      sourceRefs: gap.sourceRefs,
      impact: gap.impact,
      uncertainty: gap.uncertainty,
      novelty: gap.novelty,
      urgency: gap.urgency,
    }));
}

export function unresolvedAutonomyGaps(projection: AutonomyProjectProjection | undefined): ControlPlaneGapView[] {
  return autonomyGapHistory(projection).filter((gap) => !closedGap.has((gap.status ?? "OPEN") as AutonomyGapStatus));
}

export function autonomyCounts(projection: AutonomyProjectProjection | undefined) {
  if (!projection?.available) return undefined;
  const latest = projection.coverageSnapshots.at(-1);
  if (latest) return {
    open: latest.open,
    investigating: latest.investigating,
    blocked: latest.blocked,
    unexplored: latest.unexplored,
    resolved: latest.resolved,
    highPriority: latest.highPriorityOpen,
    convergence: latest.convergence,
    risk: latest.risk,
    observedAt: latest.createdAt,
  };
  const counts = { open: 0, investigating: 0, blocked: 0, unexplored: projection.surfaces.filter((surface) => surface.status === "UNEXPLORED").length, resolved: 0, highPriority: 0, convergence: 0, risk: 0, observedAt: projection.updatedAt ?? "" };
  for (const gap of projection.gaps) {
    if (gap.status === "OPEN") counts.open += 1;
    else if (gap.status === "INVESTIGATING") counts.investigating += 1;
    else if (gap.status === "BLOCKED") counts.blocked += 1;
    else if (gap.status === "RESOLVED") counts.resolved += 1;
    if (!closedGap.has(gap.status) && gap.priority >= .75) counts.highPriority += 1;
    if (!closedGap.has(gap.status)) counts.risk = Math.max(counts.risk, gap.priority);
  }
  const activeSurfaces = projection.surfaces.filter((surface) => surface.status !== "RETIRED");
  const surfaceCoverage = activeSurfaces.length ? activeSurfaces.filter((surface) => surface.status === "EXPLORED").length / activeSurfaces.length : 1;
  const materialGaps = projection.gaps.filter((gap) => gap.status !== "DEFERRED");
  const gapClosure = materialGaps.length ? materialGaps.filter((gap) => gap.status === "RESOLVED").length / materialGaps.length : 1;
  counts.convergence = Math.max(0, Math.min(1, surfaceCoverage * .4 + gapClosure * .6));
  return counts;
}

export function latestAutonomyDecision(projection: AutonomyProjectProjection | undefined): AutonomyDecisionProjection | undefined {
  return projection?.available ? [...projection.decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
}
