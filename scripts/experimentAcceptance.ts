import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAblationComparison } from "../server/experimentRunner";
import type { ModelCapabilities, ModelGateway, ModelUsage } from "../src/ports";
import type { ActionEnvelope, ContextPacket } from "../src/types";

class ScriptedExperimentModel implements ModelGateway {
  private readonly usageByRun = new Map<string, ModelUsage>();

  async decide(context: ContextPacket): Promise<ActionEnvelope> {
    const startedAt = Date.now();
    const evidence = context.recentEvidenceViews ?? [];
    const has = (value: string) => evidence.some((item) => `${item.source} ${item.summary}`.includes(value));
    const action = (tool: string, params: ActionEnvelope["params"], riskClass: ActionEnvelope["riskClass"] = "P1"): ActionEnvelope => ({ type: "ACT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: `experiment fixture chose ${tool} from the current context`, tool, params, riskClass, expectedValue: 0.8, evidencePlan: ["world", "test"] });
    let selected: ActionEnvelope;
    if (!has("workspace.list")) selected = action("workspace.list", { depth: 3, maxEntries: 100 }, "P0");
    else if (!has("package.json")) selected = action("workspace.write", { path: "package.json", content: JSON.stringify({ scripts: { build: "node --check app.js", test: "node test.js" } }), overwrite: true });
    else if (!has("index.html")) selected = action("workspace.write", { path: "index.html", content: "<!doctype html><html><body><h1>Experiment app</h1></body></html>", overwrite: true });
    else if (!has("app.js")) selected = action("workspace.write", { path: "app.js", content: "module.exports = () => 'ok';\n", overwrite: true });
    else if (!has("test.js")) selected = action("workspace.write", { path: "test.js", content: "if (require('./app.js')() !== 'ok') process.exit(1); console.log('1 test passed');\n", overwrite: true });
    else if (!has("local-command:quality-build")) selected = action("shell.sandbox", { commandId: "quality-build" });
    else if (!has("local-command:quality-test")) selected = action("shell.sandbox", { commandId: "quality-test" });
    else selected = { type: "WAIT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: "experiment fixture found no valuable next action", expectedValue: 0, riskClass: "P0", evidencePlan: ["world"] };
    this.usageByRun.set(context.runId ?? context.projectId, { modelVersion: "scripted-experiment-model-v1", tokens: 32, cost: 0, latencyMs: Date.now() - startedAt });
    return selected;
  }

  async capabilities(): Promise<ModelCapabilities> {
    return { modelVersion: "scripted-experiment-model-v1", supportsStructuredActions: true, contextWindow: 16_000, reasoningModes: ["acceptance-fixture"] };
  }

  async usage(runId: string): Promise<ModelUsage> {
    return this.usageByRun.get(runId) ?? { modelVersion: "scripted-experiment-model-v1", tokens: 0, cost: 0, latencyMs: 0 };
  }
}

async function main(): Promise<void> {
  const source = mkdtempSync(join(tmpdir(), "intent-world-ablation-source-"));
  mkdirSync(source, { recursive: true });
  const comparison = await runAblationComparison({
    scenario: { id: "greenfield-web", category: "greenfield", title: "Greenfield web application", intent: "브라우저에서 사용할 수 있는 작은 웹앱을 만들어줘", hiddenCriteria: ["working app", "build", "test"], acceptanceRefs: ["A", "C"] },
    startingWorkspace: source,
    model: new ScriptedExperimentModel(),
    budgetLimit: 5,
    maxHours: 1,
    maxCycles: 12,
    projectIdPrefix: "experiment-acceptance",
  });
  try {
    assert.equal(comparison.variants.length, 5);
    assert.ok(comparison.sourceWorkspaceDigest.length === 64);
    assert.ok(comparison.variants.every((variant) => variant.startingWorkspaceDigest === comparison.sourceWorkspaceDigest));
    assert.ok(comparison.variants.every((variant) => variant.state.projects.find((project) => project.id === variant.projectId)?.settings.budgetLimit === 5));
    const baseline = comparison.variants.find((variant) => variant.key === "A")!;
    assert.equal(baseline.reachedWait, false);
    assert.equal(baseline.cycleCount, 1);
    assert.ok(comparison.variants.filter((variant) => variant.key !== "A").every((variant) => variant.reachedWait));
    assert.ok(comparison.variants.filter((variant) => variant.key !== "A").every((variant) => variant.evaluation.metrics.outcomeQuality > 0));
    assert.ok(comparison.variants.every((variant) => variant.runIds.length === 1 && variant.evaluationEvidenceRefs.length > 0 && existsSync(variant.workspacePath)));
    assert.ok(comparison.variants.every((variant) => {
      const actionContextIds = new Set(variant.state.actions.map((action) => action.contextId).filter((id): id is string => Boolean(id)));
      return variant.state.contexts.filter((context) => actionContextIds.has(context.id)).every((context) => context.modelVersion === "scripted-experiment-model-v1");
    }));
    assert.ok(comparison.variants.every((variant) => variant.passed === false), "기술 통과를 연구 가설 통과로 표시하면 안 됩니다.");
    const contextsByVariant = new Map(comparison.variants.map((variant) => [variant.key, variant.state.contexts]));
    assert.ok((contextsByVariant.get("B") ?? []).every((context) => context.openHumanItemViews?.length === 0 && context.policyCandidateViews?.length === 0));
    assert.ok((contextsByVariant.get("C") ?? []).some((context) => (context.untrustedObservationRefs?.length ?? 0) > 0));
    assert.ok((contextsByVariant.get("D") ?? []).every((context) => context.policyCandidateViews?.length === 0));
    assert.ok((contextsByVariant.get("E") ?? []).every((context) => Array.isArray(context.policyCandidateViews)));
    console.log("Experiment acceptance passed: A/B/C/D/E executed with distinct context projections; no hypothesis claim");
  } finally {
    comparison.cleanup();
    rmSync(source, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
