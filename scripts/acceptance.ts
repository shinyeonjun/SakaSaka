import { strict as assert } from "node:assert";
import { createSeedState } from "../src/seed";
import { createProject, getProject, getProjectEvents, getToolSurface, resolveHumanItem, runCycle } from "../src/runtime";
import { validateActionBoundary } from "../src/security";
import { executeLocalCycle } from "../server/localRuntime";

async function main(): Promise<void> {
  const seed = createSeedState();
  const seededProject = getProject(seed, "project-trip-together");
  assert.equal(seededProject?.status, "ACTIVE");

  let asyncState = resolveHumanItem(seed, "Q-17", "answer", "B");
  asyncState = resolveHumanItem(asyncState, "APPROVAL-12", "approve");
  asyncState = runCycle(asyncState, "project-trip-together");
  assert.equal(getProject(asyncState, "project-trip-together")?.status, "EQUILIBRIUM");

  const projectId = `acceptance-${Date.now().toString(36)}`;
  const local = createProject(seed, "현재 workspace의 품질을 검증하고 안전한 상태를 확인해줘", projectId, { workspacePath: process.cwd() });
  const executed = await executeLocalCycle(local, projectId);
  assert.equal(getProject(executed, projectId)?.status, "EQUILIBRIUM");
  assert.equal(executed.actions.find((action) => action.projectId === projectId)?.status, "VERIFIED");
  assert.ok(executed.evidence.find((evidence) => evidence.projectId === projectId && evidence.verdict === "PASS"));
  const eventTypes = new Set(getProjectEvents(executed, projectId).map((event) => event.type));
  for (const type of ["OBSERVE", "CONTEXT_ASSEMBLED", "TOOL_CALLED", "TOOL_RESULT", "VERIFY", "EVIDENCE_RECORDED", "EQUILIBRIUM_ENTERED"]) assert.ok(eventTypes.has(type), `missing event ${type}`);

  const policyProject = getProject(seed, "project-trip-together")!;
  const blocked = validateActionBoundary(policyProject, { type: "ACT", intentRef: policyProject.intentId, worldCursor: "event-816", rationaleSummary: "production delete", tool: "deploy.production" }, getToolSurface(policyProject));
  assert.equal(blocked.status, "blocked");
  console.log("Acceptance A-D/G smoke passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
