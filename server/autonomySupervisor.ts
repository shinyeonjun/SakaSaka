import { createHash } from "node:crypto";
import type { AppState, Observation } from "../src/types";
import type { ModelUsage } from "../src/ports";
import { redactSecretLikeText } from "../src/security";
import { accountModelUsage, getIntent, getProject, getProjectHumanItems, getRun, getWorldSnapshot, makeId, recordObservedWorldRefresh, wakeProject } from "../src/runtime";
import type { CycleStateStore } from "./cycleCoordinator";
import {
  activeMission, appendCoverageSnapshot, appendDecision, completeDiscoveryPass, coverageCategories, coverageCounts,
  createAutonomyProject, hasMaterialUnresolvedWork, mergeGapCandidates, selectableGaps, settleMission, startMissionForGap,
  type AutonomyProjectState, type DecisionTrace, type GapCandidate,
} from "./autonomyDomain";
import { autonomyStore, type FileAutonomyStore } from "./autonomyStore";
import { createDecisionGateway, decisionProviderStatus, type DecisionAnswer, type DecisionBatchResult, type DecisionGateway } from "./decisionGateway";
import { runCodexStructured, type CodexStructuredResult } from "./codexStructured";

const scoutLenses = [
  "Product, user value, requirements, UX, accessibility, privacy, hidden user assumptions and edge cases.",
  "Security, authorization, networking, infrastructure, reliability, operations, deployment, rollback, cost and abuse/failure modes.",
  "Architecture, application boundaries, data integrity, concurrency, testing, observability, performance, dependencies and maintainability.",
] as const;

interface ScoutOutput { gaps: GapCandidate[] }

export interface AutonomySupervisorOptions {
  decisionGateway?: DecisionGateway;
  store?: FileAutonomyStore;
  scoutRunner?: typeof runCodexStructured;
  now?: () => Date;
  discoveryParallelism?: number;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function discoveryIntervalMs(): number {
  return boundedNumber(process.env.SAKASAKA_COVERAGE_REVIEW_MINUTES, 60, 5, 10_080) * 60_000;
}

function defaultParallelism(): number {
  return Math.floor(boundedNumber(process.env.SAKASAKA_DISCOVERY_PARALLELISM, 3, 1, scoutLenses.length));
}

function candidateSchema(): Record<string, unknown> {
  const gapProperties = {
    category: { type: "string", enum: [...coverageCategories] },
    title: { type: "string", minLength: 1, maxLength: 240 },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
    impact: { type: "number", minimum: 0, maximum: 1 },
    uncertainty: { type: "number", minimum: 0, maximum: 1 },
    novelty: { type: "number", minimum: 0, maximum: 1 },
    urgency: { type: "number", minimum: 0, maximum: 1 },
    roleHint: { type: "string", maxLength: 160 },
    evidenceNeeded: { type: "array", maxItems: 8, items: { type: "string", maxLength: 500 } },
    sourceRefs: { type: "array", maxItems: 16, items: { type: "string", maxLength: 500 } },
  };
  return { type: "object", additionalProperties: false, required: ["gaps"], properties: { gaps: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["category", "title", "summary", "impact", "uncertainty", "novelty", "urgency", "roleHint", "evidenceNeeded", "sourceRefs"], properties: gapProperties } } } };
}

function compactState(state: AppState, projectId: string, autonomy: AutonomyProjectState): Record<string, unknown> | undefined {
  const project = getProject(state, projectId), intent = getIntent(state, projectId), run = getRun(state, projectId), world = getWorldSnapshot(state, projectId);
  if (!project || !intent || !run || !world) return undefined;
  const latestEvidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 16);
  const human = getProjectHumanItems(state, projectId).slice(0, 24);
  const currentMission = activeMission(autonomy);
  return {
    intent: { version: intent.version, text: redactSecretLikeText(intent.rawText).slice(0, 12_000), constraints: intent.constraints.map((item) => redactSecretLikeText(item)).slice(0, 64) },
    project: { status: project.status, budgetRemaining: Math.max(0, project.settings.budgetLimit - project.budgetSpent), productionBlocked: project.settings.productionBlocked, networkPolicy: project.settings.networkPolicy },
    runtime: { cycleCount: run.cycleCount, noProgressCycles: run.noProgressCycles, checkpoint: run.nativeSession?.checkpoint },
    world: { observedAt: world.observedAt, sources: Object.fromEntries(Object.entries(world.sources).map(([key, value]) => [key, { status: value.status, freshness: value.freshness, trust: value.trustLevel, summary: redactSecretLikeText(value.summary).slice(0, 2_000) }])) },
    human: human.map((item) => ({ kind: item.kind, status: item.status, title: redactSecretLikeText(item.title), answer: item.answerLabel ?? item.answer, blockingScope: item.blockingScope, continuingScope: item.continuingScope })),
    evidence: latestEvidence.map((item) => ({ verdict: item.verdict, kind: item.kind, summary: redactSecretLikeText(item.summary), source: redactSecretLikeText(item.source), createdAt: item.createdAt })),
    autonomy: {
      currentMission,
      knownGaps: autonomy.gaps.filter((gap) => gap.status !== "RESOLVED").sort((a, b) => b.priority - a.priority).slice(0, 24).map((gap) => ({ id: gap.id, category: gap.category, title: gap.title, summary: gap.summary, status: gap.status, priority: gap.priority })),
    },
  };
}

function needsDiscovery(autonomy: AutonomyProjectState, intentVersion: number, nowMs: number): boolean {
  if (autonomy.intentVersion !== intentVersion) return true;
  if (!autonomy.lastDiscoveryAt) return true;
  if (nowMs - Date.parse(autonomy.lastDiscoveryAt) >= discoveryIntervalMs()) return true;
  const concreteOpen = autonomy.gaps.some((gap) => gap.source !== "taxonomy" && !["RESOLVED", "DEFERRED"].includes(gap.status));
  return !activeMission(autonomy) && !concreteOpen;
}

function traceFromDecision(projectId: string, runId: string | undefined, purpose: string, result: DecisionBatchResult, at: string): DecisionTrace {
  const confidenceValues = Object.values(result.answers).flatMap((answer) => answer.kind === "noul" ? [Math.abs(answer.probability - .5) * 2] : [answer.confidence]);
  const confidence = confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : undefined;
  return {
    id: makeId("decision"), projectId, runId, purpose, provider: result.provider, model: result.model,
    result: { answers: result.answers, fallbackUsed: result.fallbackUsed ?? false }, confidence, latencyMs: result.latencyMs,
    rawRef: result.usage.rawRef, createdAt: at,
  };
}

async function accountUsage(store: CycleStateStore, projectId: string, usage: ModelUsage | undefined): Promise<void> {
  if (!usage) return;
  await store.transact((state) => accountModelUsage(state, projectId, usage));
}

async function runScout(lens: string, stateView: Record<string, unknown>, runner: typeof runCodexStructured, signal?: AbortSignal): Promise<CodexStructuredResult<ScoutOutput>> {
  return runner<ScoutOutput>({
    purpose: `coverage-scout-${lens.slice(0, 24)}`,
    signal,
    instruction: [
      "You are one independent SakaSaka coverage scout. Your job is discovery, not implementation.",
      `Lens: ${lens}`,
      "Find material gaps, hidden assumptions, failure modes, missing requirements, or unverified claims that the current project may be overlooking.",
      "Do not treat hypotheses as observed facts. Do not repeat an existing known gap unless new evidence changes its risk. Prefer specific actionable gaps over generic advice.",
      "Return at most 12 candidates. Scores are 0..1: impact, uncertainty, novelty versus known gaps, and urgency. sourceRefs must only refer to identifiers or sources actually visible in STATE; otherwise return an empty list.",
    ].join("\n"),
    state: stateView,
    schema: candidateSchema(),
  });
}

async function discover(store: CycleStateStore, projectId: string, autonomy: AutonomyProjectState, options: Required<Pick<AutonomySupervisorOptions, "store" | "scoutRunner" | "now">> & AutonomySupervisorOptions): Promise<AutonomyProjectState> {
  const state = store.read(), intent = getIntent(state, projectId), view = compactState(state, projectId, autonomy);
  if (!intent || !view) return autonomy;
  const parallelism = Math.max(1, Math.min(scoutLenses.length, options.discoveryParallelism ?? defaultParallelism()));
  const results = await Promise.allSettled(scoutLenses.slice(0, parallelism).map((lens) => runScout(lens, view, options.scoutRunner, undefined)));
  const candidates: GapCandidate[] = [];
  let successful = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      successful += 1;
      candidates.push(...(Array.isArray(result.value.value.gaps) ? result.value.value.gaps : []));
      await accountUsage(store, projectId, result.value.usage);
    } else {
      const usage = (result.reason as { usage?: ModelUsage } | undefined)?.usage;
      if (usage) await accountUsage(store, projectId, usage);
    }
  }
  const at = options.now().toISOString();
  let next = mergeGapCandidates(autonomy, candidates, at, makeId);
  if (successful > 0) next = completeDiscoveryPass(next, intent.version, at);
  else next = { ...next, lastDiscoveryAt: at, updatedAt: at };
  return (await options.store.putProject(next));
}

async function reviewMission(store: CycleStateStore, projectId: string, autonomy: AutonomyProjectState, gateway: DecisionGateway, now: () => Date): Promise<AutonomyProjectState> {
  const mission = activeMission(autonomy), state = store.read(), run = getRun(state, projectId);
  if (!mission || mission.status === "BLOCKED" || !run || run.cycleCount <= mission.startCycle) return autonomy;
  const view = compactState(state, projectId, autonomy);
  if (!view) return autonomy;
  let result: DecisionBatchResult;
  try {
    result = await gateway.decide({ purpose: "mission-review", state: { mission, project: view }, questions: {
      objectiveSatisfied: { type: "noul", instructions: "Has this mission objective actually been satisfied in the current world?", criteria: "True only when the current state supports the mission objective, not merely when the model says it is complete." },
      evidenceSufficient: { type: "noul", instructions: "Is the evidence sufficient to accept the mission as completed?", criteria: "True only when the evidence contract is supported by fresh test, world, browser, tool, or authoritative human evidence." },
      continueMission: { type: "noul", instructions: "Should the same mission remain the highest-value focus for the next work episode?", criteria: "True when material work remains in this mission and changing focus would be premature." },
    } });
    await accountUsage(store, projectId, result.usage);
  } catch { return autonomy; }
  const at = now().toISOString(), trace = traceFromDecision(projectId, run.id, "mission-review", result, at);
  let next = appendDecision(autonomy, trace);
  const satisfied = result.answers.objectiveSatisfied as DecisionAnswer | undefined;
  const evidence = result.answers.evidenceSufficient as DecisionAnswer | undefined;
  const keep = result.answers.continueMission as DecisionAnswer | undefined;
  if (satisfied?.kind === "noul" && evidence?.kind === "noul" && satisfied.probability >= .84 && evidence.probability >= .72) next = settleMission(next, mission.id, "SUCCEEDED", at, trace.id);
  else if (keep?.kind === "noul" && keep.probability < .22 && run.noProgressCycles > 0) next = settleMission(next, mission.id, "FAILED", at, trace.id);
  return autonomyStore.putProject(next);
}

async function prioritize(store: CycleStateStore, projectId: string, autonomy: AutonomyProjectState, gateway: DecisionGateway, now: () => Date): Promise<AutonomyProjectState> {
  if (activeMission(autonomy)) return autonomy;
  const state = store.read(), run = getRun(state, projectId), view = compactState(state, projectId, autonomy);
  if (!run || !view) return autonomy;
  const candidates = selectableGaps(autonomy).slice(0, 10);
  if (!candidates.length) {
    const at = now().toISOString();
    const next = appendCoverageSnapshot(autonomy, 0, 1, at, makeId);
    return autonomyStore.putProject(next);
  }
  const criteria = Object.fromEntries(candidates.map((gap) => [gap.id, `${gap.category}: ${gap.title}. impact=${gap.impact.toFixed(2)}, uncertainty=${gap.uncertainty.toFixed(2)}, urgency=${gap.urgency.toFixed(2)}, deterministicPriority=${gap.priority.toFixed(2)}. ${gap.summary}`]));
  let result: DecisionBatchResult | undefined;
  try {
    result = await gateway.decide({ purpose: "priority-frontier", state: view, questions: {
      nextGap: { type: "choice", instructions: "Which unresolved gap should the next specialist mission focus on now?", criteria },
      projectRisk: { type: "score", instructions: "How much material unresolved project risk is visible now?", criteria: ["negligible", "low", "moderate", "high", "critical"] },
      coverageConverged: { type: "noul", instructions: "Has discovery converged enough that there is no material high-value unresolved gap right now?", criteria: "True requires both broad coverage and no important unresolved gap; uncertainty itself is evidence against convergence." },
    } });
    await accountUsage(store, projectId, result.usage);
  } catch { /* deterministic priority remains a safe fallback for scheduling, never for policy */ }
  const at = now().toISOString();
  let next = autonomy;
  let chosen = candidates[0];
  let risk = Math.max(...candidates.map((gap) => gap.priority));
  let convergenceHint: number | undefined;
  if (result) {
    const selected = result.answers.nextGap;
    if (selected?.kind === "choice") chosen = candidates.find((gap) => gap.id === selected.choice) ?? chosen;
    const scored = result.answers.projectRisk;
    if (scored?.kind === "score") risk = Math.max(0, Math.min(1, scored.score / 4));
    const converged = result.answers.coverageConverged;
    if (converged?.kind === "noul") convergenceHint = converged.probability;
    next = appendDecision(next, traceFromDecision(projectId, run.id, "priority-frontier", result, at));
  }
  next = startMissionForGap(next, chosen.id, run.cycleCount, at, makeId);
  next = appendCoverageSnapshot(next, risk, convergenceHint, at, makeId);
  return autonomyStore.putProject(next);
}

function observationSummary(autonomy: AutonomyProjectState): string {
  const mission = activeMission(autonomy), counts = coverageCounts(autonomy), top = autonomy.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status)).sort((a, b) => b.priority - a.priority).slice(0, 5);
  const provider = decisionProviderStatus();
  return [
    `SakaSaka autonomy: decision=${provider.effective}; open=${counts.open}, investigating=${counts.investigating}, blocked=${counts.blocked}, unexplored=${counts.unexplored}, highPriority=${counts.highPriorityOpen}.`,
    mission ? `Active mission [${mission.role}] ${mission.objective}. Evidence contract: ${mission.evidenceContract.join(" | ")}.` : "No active specialist mission.",
    top.length ? `Priority gaps: ${top.map((gap) => `${gap.id} ${gap.category}/${gap.title}(${gap.priority.toFixed(2)})`).join("; ")}.` : "No unresolved priority gaps.",
    "This is verified control-plane state, not permission to bypass policy or proof that a gap is solved.",
  ].join(" ").slice(0, 4_000);
}

async function publishObservation(store: CycleStateStore, projectId: string, autonomy: AutonomyProjectState, fileStore: FileAutonomyStore, now: () => Date): Promise<AutonomyProjectState> {
  const summary = observationSummary(autonomy), digest = createHash("sha256").update(summary).digest("hex");
  if (digest === autonomy.lastPublishedDigest) return autonomy;
  const at = now().toISOString();
  const next = { ...autonomy, lastPublishedDigest: digest, updatedAt: at };
  await fileStore.putProject(next);
  const counts = coverageCounts(next), mission = activeMission(next);
  const observation: Observation = {
    id: makeId("observation"), projectId, source: "runtime", status: counts.highPriorityOpen || mission ? "warning" : "healthy", observedAt: at, freshness: "fresh",
    rawRef: `autonomy://${projectId}/${digest.slice(0, 16)}`, compactView: summary, trustLevel: "verified", confidence: .99,
    relatedEntities: [mission?.id, ...next.gaps.filter((gap) => !["RESOLVED", "DEFERRED"].includes(gap.status)).slice(0, 8).map((gap) => gap.id)].filter((value): value is string => Boolean(value)),
  };
  await store.transact((state) => recordObservedWorldRefresh(state, projectId, [observation]));
  return next;
}

export async function runAutonomyPrelude(store: CycleStateStore, projectId: string, options: AutonomySupervisorOptions = {}): Promise<AutonomyProjectState | undefined> {
  const state = store.read(), project = getProject(state, projectId), intent = getIntent(state, projectId);
  if (!project || !intent) return undefined;
  const fileStore = options.store ?? autonomyStore, now = options.now ?? (() => new Date()), scoutRunner = options.scoutRunner ?? runCodexStructured, gateway = options.decisionGateway ?? createDecisionGateway();
  let autonomy = fileStore.readProject(projectId) ?? createAutonomyProject(projectId, intent.version, now().toISOString(), makeId);
  if (!fileStore.readProject(projectId)) await fileStore.putProject(autonomy);
  autonomy = await reviewMission(store, projectId, autonomy, gateway, now);
  if (needsDiscovery(autonomy, intent.version, now().getTime())) autonomy = await discover(store, projectId, autonomy, { ...options, store: fileStore, scoutRunner, now });
  autonomy = await prioritize(store, projectId, autonomy, gateway, now);
  return publishObservation(store, projectId, autonomy, fileStore, now);
}

export async function runAutonomyPostlude(store: CycleStateStore, projectId: string, options: AutonomySupervisorOptions = {}): Promise<void> {
  const fileStore = options.store ?? autonomyStore, autonomy = fileStore.readProject(projectId), project = getProject(store.read(), projectId);
  if (!autonomy || !project) return;
  if (project.status === "EQUILIBRIUM" && hasMaterialUnresolvedWork(autonomy)) {
    await store.transact((state) => wakeProject(state, projectId, "coverage-gap"));
  }
}
