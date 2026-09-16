import { strict as assert } from "node:assert";
import { createSeedState } from "../src/seed";
import { createProject, getProject, getProjectEvents, getToolSurface, getWorldSnapshot, recordNonToolAction, resolveHumanItem } from "../src/runtime";
import { validateActionBoundary } from "../src/security";
import { executeLocalCycle } from "../server/localRuntime";

async function main(): Promise<void> {
  const seed = createSeedState();
  const seededProject = getProject(seed, "project-trip-together");
  assert.equal(seededProject?.status, "ACTIVE");

  let asyncState = resolveHumanItem(seed, "Q-17", "answer", "B");
  asyncState = resolveHumanItem(asyncState, "APPROVAL-12", "approve");
  const asyncProject = getProject(asyncState, "project-trip-together")!;
  asyncState = recordNonToolAction(asyncState, asyncProject.id, {
    type: "WAIT",
    intentRef: asyncProject.intentId,
    worldCursor: getWorldSnapshot(asyncState, asyncProject.id)!.cursorEventId,
    rationaleSummary: "all required decisions are resolved and no useful action is available",
  });
  assert.equal(getProject(asyncState, "project-trip-together")?.status, "EQUILIBRIUM");

  const projectId = `acceptance-${Date.now().toString(36)}`;
  const local = createProject(seed, "현재 workspace의 품질을 검증하고 안전한 상태를 확인해줘", projectId, { workspacePath: process.cwd() });
  const executed = await executeLocalCycle(local, projectId);
  assert.equal(getProject(executed, projectId)?.status, "ACTIVE");
  assert.equal(executed.actions.find((action) => action.projectId === projectId)?.status, "VERIFIED");
  assert.ok(executed.evidence.find((evidence) => evidence.projectId === projectId && evidence.verdict === "PASS"));
  const eventTypes = new Set(getProjectEvents(executed, projectId).map((event) => event.type));
  for (const type of ["OBSERVE", "CONTEXT_ASSEMBLED", "TOOL_CALLED", "TOOL_RESULT", "VERIFY", "EVIDENCE_RECORDED"] as const) assert.ok(eventTypes.has(type), `missing event ${type}`);
  assert.ok(!eventTypes.has("EQUILIBRIUM_ENTERED"), "a successful ACT must leave the project active");

  const activeProject = getProject(executed, projectId)!;
  const waited = recordNonToolAction(executed, projectId, {
    type: "WAIT",
    intentRef: activeProject.intentId,
    worldCursor: getWorldSnapshot(executed, projectId)!.cursorEventId,
    rationaleSummary: "no useful next action is available right now",
  });
  assert.equal(getProject(waited, projectId)?.status, "EQUILIBRIUM");
  assert.ok(getProjectEvents(waited, projectId).some((event) => event.type === "EQUILIBRIUM_ENTERED"));

  const policyProject = getProject(seed, "project-trip-together")!;
  const blocked = validateActionBoundary(policyProject, { type: "ACT", intentRef: policyProject.intentId, worldCursor: "event-816", rationaleSummary: "production delete", tool: "deploy.production" }, getToolSurface(policyProject));
  assert.equal(blocked.status, "blocked");
  console.log("Acceptance A-D/G smoke passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
