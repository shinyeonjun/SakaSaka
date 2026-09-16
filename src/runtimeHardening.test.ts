import { describe, expect, it } from "vitest";
import { createEmptyState } from "./emptyState";
import { createProject, assembleContext, getProject, getRun, getWorldSnapshot, recordModelFailure, recordNonToolAction, resolveHumanItem, runCycle } from "./runtime";
import { createDecisionSchema, unwrapDecision, validateActionInput, type InputSchema } from "./toolContracts";
import { parseActionEnvelope, validateActionBoundary } from "./security";
import { modelFailure, ModelGatewayError } from "./modelFailure";
import { runtimeDiagnostics } from "./runtimeDiagnostics";

const projectId = "regression";
const initial = () => createProject(createEmptyState(), "내가 쓸 수 있는 작은 앱", projectId);
function strictErrors(schema: InputSchema): string[] {
  const own = schema.type === "object" && (schema.additionalProperties !== false || Object.keys(schema.properties ?? {}).some((key) => !schema.required?.includes(key))) ? ["open object"] : [];
  return [...own, ...Object.values(schema.properties ?? {}).flatMap(strictErrors), ...(schema.anyOf ?? []).flatMap(strictErrors), ...(schema.items ? strictErrors(schema.items) : [])];
}

describe("dogfood runtime regressions", () => {
  it("uses a closed, tool-discriminated strict schema at every object depth", () => {
    const context = assembleContext(initial(), projectId)!;
    const schema = createDecisionSchema(context);
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(strictErrors(schema)).toEqual([]);
    const branches = schema.properties!.action.anyOf!;
    expect(branches.find((branch) => branch.properties?.tool.enum?.[0] === "workspace.write")?.properties?.params.required).toContain("content");
    expect(context.toolSurface.filter((tool) => tool.enabled).every((tool) => Boolean(tool.inputSchema))).toBe(true);
    expect(context.toolSurface.find((tool) => tool.name === "deploy.production")?.enabled).toBe(false);
  });

  it("normalizes optional nulls without changing code or allowing missing required params", () => {
    const action = parseActionEnvelope(unwrapDecision({ action: { type: "ACT", intentRef: "i", worldCursor: "w", rationaleSummary: "write", tool: "workspace.write", params: { path: "app.js", content: "const x = null;", overwrite: null }, riskClass: null, evidencePlan: null, expectedValue: null } }));
    expect(action?.params).toEqual({ path: "app.js", content: "const x = null;" });
    expect(validateActionInput(action!)).toBeUndefined();
    expect(validateActionInput({ ...action!, params: { file: "app.js", text: "x" } })).toContain("path");
    expect(parseActionEnvelope(unwrapDecision({ ...action, params: { path: null, content: "x" } }))).toBeUndefined();
  });

  it("provider failure after a successful list retains the real cause, usage and last success separately", () => {
    let state = initial();
    const intentRef = getProject(state, projectId)!.intentId;
    state = runCycle(state, projectId, { action: { type: "ACT", intentRef, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "폴더 조회", tool: "workspace.list" }, toolResult: { tool: "workspace.list", toolVersion: "test", status: "succeeded", outputRef: "test://list", output: "[]", summary: "폴더가 비어 있습니다.", cost: 0.01, wallTimeMs: 1, evidence: [{ id: "list-success", projectId, kind: "world", verdict: "PASS", source: "workspace.list", summary: "0 entries", createdAt: new Date().toISOString() }] } });
    const successfulId = state.actions.at(-1)!.id;
    state = recordModelFailure(state, projectId, new ModelGatewayError(modelFailure("SCHEMA_REJECTED", "중첩 params schema 거절", false, { rawRef: "local-raw://failure.json" }), { modelVersion: "codex-test", tokens: 23, cost: 0.0045, usageKnown: true, latencyMs: 100 }));
    expect(getProject(state, projectId)?.status).toBe("STALLED");
    expect(state.actions).toHaveLength(1); // no manufactured WAIT
    expect(getRun(state, projectId)?.lastModelFailure?.code).toBe("SCHEMA_REJECTED");
    expect(runtimeDiagnostics(state, projectId)?.reason).toContain("schema");
    expect(runtimeDiagnostics(state, projectId)?.lastSuccess?.id).toBe(successfulId);
    expect(getProject(state, projectId)?.budgetSpent).toBeCloseTo(0.0145);
    expect(state.resourceLedger[0].tokens).toBe(23);
  });

  it("a late human answer remains in the next model context after leaving the inbox", () => {
    let state = initial();
    state = recordNonToolAction(state, projectId, { type: "QUESTION", intentRef: getProject(state, projectId)!.intentId, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "팀원도 삭제할 수 있나요?" });
    const item = state.humanItems[0];
    state = resolveHumanItem(state, item.id, "defer");
    state = resolveHumanItem(state, item.id, "answer", "작성자만 삭제할 수 있어야 합니다.");
    expect(assembleContext(state, projectId)?.humanDecisionViews).toContainEqual(expect.objectContaining({ id: item.id, answer: "작성자만 삭제할 수 있어야 합니다." }));
    expect(assembleContext(state, projectId)?.openHumanItemRefs).not.toContain(item.id);
  });

  it("same read-only observation cannot renew progress forever", () => {
    let state = createProject(createEmptyState(), "앱을 만들어줘", projectId, { noProgressThreshold: 2 });
    for (let n = 0; n < 3; n++) {
      state = runCycle(state, projectId, { action: { type: "ACT", intentRef: getProject(state, projectId)!.intentId, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "조회", tool: "workspace.list" }, toolResult: { tool: "workspace.list", toolVersion: "test", status: "succeeded", outputRef: `raw://${n}`, output: "[]", summary: "0 entries", cost: 0, wallTimeMs: 1, progress: "meaningful", evidence: [{ id: `e-${n}`, projectId, kind: "world", verdict: "PASS", summary: "0 entries", source: "workspace.list", createdAt: new Date().toISOString() }], observations: [{ id: `o-${n}`, projectId, source: "workspace", status: "healthy", observedAt: new Date().toISOString(), freshness: "fresh", rawRef: `raw://${n}`, compactView: "0 entries", trustLevel: "observed", confidence: 1, relatedEntities: [] }] } });
    }
    expect(getRun(state, projectId)?.noProgressCycles).toBe(2);
    expect(getProject(state, projectId)?.status).toBe("STALLED");
  });
  it("does not infer transport failure from an ordinary model WAIT sentence", () => {
    const state = initial();
    const next = recordNonToolAction(state, projectId, { type: "WAIT", intentRef: getProject(state, projectId)!.intentId, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "이전 model gateway unavailable 기록과 무관하게 현재 가치 있는 행동이 없습니다." });
    expect(getProject(next, projectId)?.status).toBe("EQUILIBRIUM");
    expect(getRun(next, projectId)?.lastModelFailure).toBeUndefined();
    expect(next.events.some((event) => event.type === "MODEL_FAILED")).toBe(false);
  });

});
