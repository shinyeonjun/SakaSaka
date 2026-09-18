export const baselineCoverageCategories = [
  "Product", "UX", "Architecture", "Application", "Data", "Security", "Privacy", "Infrastructure",
  "Networking", "Reliability", "Observability", "Performance", "Testing", "Deployment", "Operations", "Cost", "Compliance",
] as const;

/** Compatibility alias for legacy UI/tests. Baseline categories are seeds, not a closed enum. */
export const coverageCategories = baselineCoverageCategories;
export type BaselineCoverageCategory = (typeof baselineCoverageCategories)[number];
export type CoverageCategory = string;

export type GapStatus = "UNEXPLORED" | "OPEN" | "INVESTIGATING" | "BLOCKED" | "RESOLVED" | "DEFERRED";
export type GapSource = "taxonomy" | "scout" | "world" | "human" | "verification";
export type MissionStatus = "PROPOSED" | "READY" | "RUNNING" | "VERIFYING" | "SUCCEEDED" | "BLOCKED" | "FAILED" | "SUPERSEDED" | "CANCELLED";
export type SurfaceOrigin = "baseline" | "discovered" | "human" | "standard";
export type SurfaceStatus = "UNEXPLORED" | "EXPLORED" | "RETIRED";
export type SpecialistOrigin = "baseline" | "discovered" | "human";
export type SpecialistStatus = "ACTIVE" | "RETIRED";

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

export interface SurfaceProposal {
  name: string;
  description: string;
  parentName?: string;
  rationale?: string;
  risk: number;
  sourceRefs?: string[];
}

export interface SpecialistProposal {
  name: string;
  focus: string;
  rationale?: string;
  surfaceNames?: string[];
}

export interface CoverageSurface {
  id: string;
  key: string;
  projectId: string;
  name: string;
  description: string;
  parentKey?: string;
  origin: SurfaceOrigin;
  status: SurfaceStatus;
  risk: number;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  lastExploredAt?: string;
}

export interface ScoutSpecialist {
  id: string;
  key: string;
  projectId: string;
  name: string;
  focus: string;
  rationale?: string;
  surfaceRefs: string[];
  origin: SpecialistOrigin;
  status: SpecialistStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
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
  /** Optional for backwards compatibility with pre-registry autonomy.json files. */
  surfaces?: CoverageSurface[];
  /** Optional for backwards compatibility with pre-registry autonomy.json files. */
  specialists?: ScoutSpecialist[];
  lastDiscoveryAt?: string;
  lastPublishedDigest?: string;
  updatedAt: string;
}

export interface AutonomyDatabase {
  schemaVersion: 1;
  projects: Record<string, AutonomyProjectState>;
}

export type IdFactory = (prefix: string) => string;

const baselineRisk: Record<BaselineCoverageCategory, number> = {
  Product: 0.62, UX: 0.5, Architecture: 0.7, Application: 0.72, Data: 0.82, Security: 0.95, Privacy: 0.92,
  Infrastructure: 0.78, Networking: 0.75, Reliability: 0.88, Observability: 0.68, Performance: 0.64, Testing: 0.76,
  Deployment: 0.8, Operations: 0.78, Cost: 0.58, Compliance: 0.82,
};

const baselineSpecialists = [
  {
    name: "General problem-space scout",
    focus: "Search beyond the current taxonomy. Find missing problem surfaces, domain-specific concerns, hidden assumptions, and specialist perspectives the project needs.",
    surfaces: [] as string[],
  },
  {
    name: "Product and human-systems scout",
    focus: "User value, requirements, UX, accessibility, privacy, hidden user assumptions, edge cases, localization, compatibility, and adoption friction.",
    surfaces: ["Product", "UX", "Privacy"],
  },
  {
    name: "Runtime and failure-mode scout",
    focus: "Security, authorization, networking, infrastructure, reliability, operations, deployment, rollback, abuse, cost, compliance, and failure modes.",
    surfaces: ["Security", "Infrastructure", "Networking", "Reliability", "Deployment", "Operations", "Cost", "Compliance"],
  },
  {
    name: "Architecture and evidence scout",
    focus: "Architecture, application boundaries, data integrity, concurrency, testing, observability, performance, dependencies, maintainability, and evidence quality.",
    surfaces: ["Architecture", "Application", "Data", "Observability", "Performance", "Testing"],
  },
] as const;

const MAX_SURFACES = 64;
const MAX_SPECIALISTS = 24;

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function boundedText(value: string | undefined, maximum: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "item";
}

export function surfaceKey(name: string): string {
  return `surface:${slug(name)}`;
}

export function specialistKey(name: string): string {
  return `specialist:${slug(name)}`;
}

export function gapKey(category: CoverageCategory, title: string): string {
  return `${slug(category)}:${slug(title)}`;
}

function seedSurfaces(projectId: string, at: string, id: IdFactory): CoverageSurface[] {
  return baselineCoverageCategories.map((name) => ({
    id: id("surface"),
    key: surfaceKey(name),
    projectId,
    name,
    description: `${name} is a baseline coverage seed. It is not a closed taxonomy; scouts may add better project-specific surfaces.`,
    origin: "baseline" as const,
    status: "UNEXPLORED" as const,
    risk: baselineRisk[name],
    sourceRefs: [],
    createdAt: at,
    updatedAt: at,
  }));
}

function seedSpecialists(projectId: string, at: string, id: IdFactory): ScoutSpecialist[] {
  return baselineSpecialists.map((seed) => ({
    id: id("specialist"),
    key: specialistKey(seed.name),
    projectId,
    name: seed.name,
    focus: seed.focus,
    surfaceRefs: seed.surfaces.map(surfaceKey),
    origin: "baseline" as const,
    status: "ACTIVE" as const,
    createdAt: at,
    updatedAt: at,
  }));
}

export function ensureAutonomyRegistries(project: AutonomyProjectState, at: string, id: IdFactory): AutonomyProjectState {
  const seededSurfaces = seedSurfaces(project.projectId, at, id);
  const seededSpecialists = seedSpecialists(project.projectId, at, id);
  const legacySurfaceNames = [...new Set(project.gaps.map((gap) => boundedText(gap.category, 120)).filter(Boolean))];
  const surfaces = [...(project.surfaces?.length ? project.surfaces : seededSurfaces)];

  for (const name of legacySurfaceNames) {
    const key = surfaceKey(name);
    if (surfaces.some((surface) => surface.key === key)) continue;
    if (surfaces.length >= MAX_SURFACES) break;
    const gapRisk = Math.max(0.5, ...project.gaps.filter((gap) => surfaceKey(gap.category) === key).map((gap) => gap.impact));
    surfaces.push({
      id: id("surface"), key, projectId: project.projectId, name,
      description: `Migrated from an existing gap category: ${name}.`,
      origin: "discovered", status: "EXPLORED", risk: clamp01(gapRisk), sourceRefs: [],
      createdAt: at, updatedAt: at, lastExploredAt: at,
    });
  }

  // Pre-registry releases created one synthetic taxonomy gap per baseline category.
  // They are coverage placeholders, not observed project defects, so retire them
  // from the real Gap Graph when loading into the dynamic-registry model.
  let retiredLegacyGap = false;
  const gaps = project.gaps.map((gap) => {
    if (gap.source !== "taxonomy" || gap.status === "DEFERRED" || gap.status === "RESOLVED") return gap;
    retiredLegacyGap = true;
    return { ...gap, status: "DEFERRED" as const, priority: 0, resolvedAt: undefined, updatedAt: at };
  });

  const specialists = project.specialists?.length ? project.specialists : seededSpecialists;
  if (project.surfaces?.length && project.specialists?.length && !retiredLegacyGap) return project;
  return { ...project, gaps, surfaces, specialists, updatedAt: at };
}

export function createAutonomyProject(projectId: string, intentVersion: number, at: string, id: IdFactory): AutonomyProjectState {
  return {
    version: 1,
    projectId,
    intentVersion,
    gaps: [],
    missions: [],
    decisions: [],
    coverageSnapshots: [],
    surfaces: seedSurfaces(projectId, at, id),
    specialists: seedSpecialists(projectId, at, id),
    updatedAt: at,
  };
}

function normalizeSurfaceProposal(proposal: SurfaceProposal): SurfaceProposal | undefined {
  const name = boundedText(proposal.name, 120);
  const description = boundedText(proposal.description, 2_000);
  if (!name || !description) return undefined;
  return {
    name,
    description,
    parentName: boundedText(proposal.parentName, 120) || undefined,
    rationale: boundedText(proposal.rationale, 1_000) || undefined,
    risk: clamp01(proposal.risk),
    sourceRefs: (proposal.sourceRefs ?? []).map((item) => boundedText(item, 500)).filter(Boolean).slice(0, 16),
  };
}

export function mergeSurfaceProposals(project: AutonomyProjectState, proposals: SurfaceProposal[], at: string, id: IdFactory): AutonomyProjectState {
  const normalizedProject = ensureAutonomyRegistries(project, at, id);
  const surfaces = [...(normalizedProject.surfaces ?? [])];
  for (const raw of proposals) {
    const proposal = normalizeSurfaceProposal(raw);
    if (!proposal) continue;
    const key = surfaceKey(proposal.name);
    const index = surfaces.findIndex((surface) => surface.key === key);
    if (index >= 0) {
      const previous = surfaces[index];
      surfaces[index] = {
        ...previous,
        description: proposal.description || previous.description,
        parentKey: proposal.parentName ? surfaceKey(proposal.parentName) : previous.parentKey,
        risk: Math.max(previous.risk, proposal.risk),
        sourceRefs: [...new Set([...previous.sourceRefs, ...(proposal.sourceRefs ?? [])])].slice(0, 16),
        updatedAt: at,
      };
      continue;
    }
    if (surfaces.length >= MAX_SURFACES) break;
    surfaces.push({
      id: id("surface"), key, projectId: project.projectId, name: proposal.name, description: proposal.description,
      parentKey: proposal.parentName ? surfaceKey(proposal.parentName) : undefined,
      origin: "discovered", status: "UNEXPLORED", risk: proposal.risk,
      sourceRefs: proposal.sourceRefs ?? [], createdAt: at, updatedAt: at,
    });
  }
  return { ...normalizedProject, surfaces, updatedAt: at };
}

function normalizeSpecialistProposal(proposal: SpecialistProposal): SpecialistProposal | undefined {
  const name = boundedText(proposal.name, 160);
  const focus = boundedText(proposal.focus, 2_000);
  if (!name || !focus) return undefined;
  return {
    name,
    focus,
    rationale: boundedText(proposal.rationale, 1_000) || undefined,
    surfaceNames: (proposal.surfaceNames ?? []).map((item) => boundedText(item, 120)).filter(Boolean).slice(0, 12),
  };
}

export function mergeSpecialistProposals(project: AutonomyProjectState, proposals: SpecialistProposal[], at: string, id: IdFactory): AutonomyProjectState {
  let next = ensureAutonomyRegistries(project, at, id);
  for (const raw of proposals) {
    const proposal = normalizeSpecialistProposal(raw);
    if (!proposal) continue;
    const missingSurfaces = (proposal.surfaceNames ?? []).filter((name) => !(next.surfaces ?? []).some((surface) => surface.key === surfaceKey(name)));
    if (missingSurfaces.length) {
      next = mergeSurfaceProposals(next, missingSurfaces.map((name) => ({
        name, description: `Specialist ${proposal.name} identified this as a distinct project problem surface.`, risk: 0.65, sourceRefs: [],
      })), at, id);
    }
    const specialists = [...(next.specialists ?? [])];
    const key = specialistKey(proposal.name);
    const index = specialists.findIndex((specialist) => specialist.key === key);
    const surfaceRefs = [...new Set((proposal.surfaceNames ?? []).map(surfaceKey))];
    if (index >= 0) {
      const previous = specialists[index];
      specialists[index] = {
        ...previous,
        focus: proposal.focus,
        rationale: proposal.rationale ?? previous.rationale,
        surfaceRefs: [...new Set([...previous.surfaceRefs, ...surfaceRefs])].slice(0, 16),
        updatedAt: at,
      };
    } else if (specialists.length < MAX_SPECIALISTS) {
      specialists.push({
        id: id("specialist"), key, projectId: project.projectId, name: proposal.name, focus: proposal.focus,
        rationale: proposal.rationale, surfaceRefs, origin: "discovered", status: "ACTIVE", createdAt: at, updatedAt: at,
      });
    }
    next = { ...next, specialists, updatedAt: at };
  }
  return next;
}

function normalizeCandidate(candidate: GapCandidate): GapCandidate | undefined {
  const category = boundedText(candidate.category, 120);
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
  let next = ensureAutonomyRegistries(project, at, id);
  const gaps = [...next.gaps];
  let surfaces = [...(next.surfaces ?? [])];
  for (const raw of candidates) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const categoryKey = surfaceKey(candidate.category);
    if (!surfaces.some((surface) => surface.key === categoryKey) && surfaces.length < MAX_SURFACES) {
      surfaces.push({
        id: id("surface"), key: categoryKey, projectId: project.projectId, name: candidate.category,
        description: `A scout discovered a project-specific problem surface while reporting: ${candidate.summary}`,
        origin: "discovered", status: "EXPLORED", risk: candidate.impact,
        sourceRefs: candidate.sourceRefs ?? [], createdAt: at, updatedAt: at, lastExploredAt: at,
      });
    }
    const key = gapKey(candidate.category, candidate.title);
    const index = gaps.findIndex((gap) => gap.key === key);
    if (index >= 0) {
      const previous = gaps[index];
      if (previous.status === "RESOLVED" || previous.status === "DEFERRED") continue;
      gaps[index] = {
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
      continue;
    }
    gaps.push({
      ...candidate, id: id("gap"), key, projectId: project.projectId, status: "OPEN", source: "scout",
      priority: priorityForGap(candidate), createdAt: at, updatedAt: at,
    });
  }
  next = { ...next, gaps, surfaces, updatedAt: at };
  return next;
}

export function completeDiscoveryPass(
  project: AutonomyProjectState,
  intentVersion: number,
  at: string,
  exploredSurfaceRefs: string[] = [],
  ranSpecialistKeys: string[] = [],
): AutonomyProjectState {
  const explored = new Set(exploredSurfaceRefs);
  const ran = new Set(ranSpecialistKeys);
  return {
    ...project,
    intentVersion,
    surfaces: (project.surfaces ?? []).map((surface) => explored.has(surface.key)
      ? { ...surface, status: "EXPLORED" as const, lastExploredAt: at, updatedAt: at }
      : surface),
    specialists: (project.specialists ?? []).map((specialist) => ran.has(specialist.key)
      ? { ...specialist, lastRunAt: at, updatedAt: at }
      : specialist),
    lastDiscoveryAt: at,
    updatedAt: at,
  };
}

export function activeScoutSpecialists(project: AutonomyProjectState): ScoutSpecialist[] {
  return (project.specialists ?? []).filter((specialist) => specialist.status === "ACTIVE");
}

export function priorityForGap(input: Pick<GapCandidate, "impact" | "uncertainty" | "novelty" | "urgency">, status: GapStatus = "OPEN"): number {
  const explorationBonus = status === "UNEXPLORED" ? 0.08 : status === "BLOCKED" ? -0.08 : 0;
  return clamp01(clamp01(input.impact) * 0.38 + clamp01(input.uncertainty) * 0.22 + clamp01(input.novelty) * 0.14 + clamp01(input.urgency) * 0.26 + explorationBonus);
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
    id: id("mission"), projectId: project.projectId, gapId: gap.id, role: gap.roleHint || `${gap.category} specialist`,
    objective: `${gap.title}: ${gap.summary}`,
    evidenceContract: gap.evidenceNeeded?.length ? gap.evidenceNeeded : ["현실 상태를 직접 관찰하거나 실행 결과로 검증할 것", "완료 주장은 재현 가능한 증거와 연결할 것"],
    status: "RUNNING", priority: gap.priority, attempt: 1, startCycle: runCycle, createdAt: at, updatedAt: at, startedAt: at,
  };
  return {
    ...project,
    gaps: project.gaps.map((item) => item.id === gap.id ? { ...item, status: "INVESTIGATING", updatedAt: at } : item),
    missions: [...project.missions, mission], updatedAt: at,
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
      ...gap, status: gapStatus, uncertainty: status === "FAILED" ? clamp01(gap.uncertainty + 0.08) : gap.uncertainty,
      priority: status === "SUCCEEDED" ? 0 : priorityForGap(gap, gapStatus), updatedAt: at, resolvedAt: status === "SUCCEEDED" ? at : undefined,
    } : gap),
    updatedAt: at,
  };
}

export function appendDecision(project: AutonomyProjectState, trace: DecisionTrace, maximum = 256): AutonomyProjectState {
  return { ...project, decisions: [...project.decisions, trace].slice(-maximum), updatedAt: trace.createdAt };
}

export function coverageCounts(project: AutonomyProjectState) {
  const count = (status: GapStatus) => project.gaps.filter((gap) => gap.status === status).length;
  const unexploredSurfaces = (project.surfaces ?? []).filter((surface) => surface.status === "UNEXPLORED").length;
  return {
    open: count("OPEN"), unexplored: unexploredSurfaces, investigating: count("INVESTIGATING"), blocked: count("BLOCKED"), resolved: count("RESOLVED"), deferred: count("DEFERRED"),
    highPriorityOpen: project.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status) && gap.priority >= 0.62).length,
  };
}

export function coverageConvergence(project: AutonomyProjectState): number {
  const unresolved = project.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status));
  const gapDebt = unresolved.length
    ? unresolved.reduce((sum, gap) => sum + gap.priority * Math.max(0.35, gap.impact), 0) / unresolved.length
    : 0;
  const activeSurfaces = (project.surfaces ?? []).filter((surface) => surface.status !== "RETIRED");
  const unexplored = activeSurfaces.filter((surface) => surface.status === "UNEXPLORED");
  const surfaceDebt = activeSurfaces.length
    ? unexplored.reduce((sum, surface) => sum + Math.max(0.35, surface.risk), 0) / activeSurfaces.length
    : 0;
  return clamp01(1 - Math.min(1, gapDebt * 0.78 + surfaceDebt * 0.35));
}

export function appendCoverageSnapshot(project: AutonomyProjectState, risk: number, convergenceHint: number | undefined, at: string, id: IdFactory): AutonomyProjectState {
  const counts = coverageCounts(project);
  const convergence = coverageConvergence(project);
  const snapshot: CoverageSnapshot = {
    id: id("coverage"), projectId: project.projectId, open: counts.open, unexplored: counts.unexplored, investigating: counts.investigating,
    blocked: counts.blocked, resolved: counts.resolved, highPriorityOpen: counts.highPriorityOpen, risk: clamp01(risk),
    convergence: clamp01(convergenceHint === undefined ? convergence : Math.min(convergenceHint, convergence + 0.2)), createdAt: at,
  };
  return { ...project, coverageSnapshots: [...project.coverageSnapshots, snapshot].slice(-128), updatedAt: at };
}

export function hasMaterialUnresolvedWork(project: AutonomyProjectState): boolean {
  if (activeMission(project)) return true;
  if (project.gaps.some((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status) && gap.priority >= 0.55)) return true;
  const specialists = activeScoutSpecialists(project);
  return (project.surfaces ?? []).some((surface) =>
    surface.status === "UNEXPLORED"
    && surface.risk >= 0.7
    && specialists.some((specialist) => specialist.surfaceRefs.includes(surface.key))
  );
}
