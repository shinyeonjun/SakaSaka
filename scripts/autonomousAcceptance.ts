import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject, getProject, getRun } from "../src/runtime";
import { executeLocalCycle } from "../server/localRuntime";
import { stopManagedProcess } from "../server/processManager";
import type { ActionEnvelope, AppState, ContextPacket } from "../src/types";

function emptyState(): AppState {
  return { schemaVersion: 1, activeProjectId: "", projects: [], intents: [], runs: [], actions: [], worldSnapshots: [], observations: [], contexts: [], events: [], evidence: [], humanItems: [], artifacts: [], experiences: [], policies: [], resourceLedger: [], relations: [], retrievalIndex: [], experiments: [], approvalGrants: [], processes: [] };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => resolve()); });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  assert.ok(port > 0);
  return port;
}

function action(context: ContextPacket, type: ActionEnvelope["type"], tool?: string, params?: ActionEnvelope["params"], riskClass: ActionEnvelope["riskClass"] = tool?.startsWith("workspace.") ? "P1" : tool === "process.start" ? "P1" : tool === "browser.playwright" ? "P1" : tool === "shell.sandbox" ? "P1" : "P0"): ActionEnvelope {
  return { type, intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: `${type} selected from actual context`, tool, params, expectedValue: type === "WAIT" ? 0 : 0.8, riskClass, evidencePlan: type === "WAIT" ? ["world"] : ["world", "test"] };
}

type ActionFactory = (context: ContextPacket, index: number) => ActionEnvelope;

async function startMockModel(factory: ActionFactory, requestContexts: ContextPacket[]): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role?: string; content?: string }> };
    const userMessage = body.messages?.find((message) => message.role === "user")?.content;
    const context = JSON.parse(userMessage ?? "{}") as ContextPacket;
    requestContexts.push(context);
    const selected = factory(context, requestContexts.length - 1);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selected) } }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);
  return { server, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` };
}

function writeAction(context: ContextPacket, path: string, content: string): ActionEnvelope {
  return action(context, "ACT", "workspace.write", { path, content, overwrite: true });
}

function greenfieldAction(context: ContextPacket, _index: number): ActionEnvelope {
    const summaries = context.recentEvidenceViews?.map((item) => `${item.source} ${item.summary}`) ?? [];
  if (!summaries.some((item) => item.includes("workspace.list"))) return action(context, "ACT", "workspace.list", { depth: 3, maxEntries: 100 });
  if (!summaries.some((item) => item.includes("package.json"))) return writeAction(context, "package.json", JSON.stringify({ scripts: { build: "node --check app.js", test: "node test.js" } }));
  if (!context.recentEvidenceViews?.some((item) => item.summary.includes("index.html"))) return writeAction(context, "index.html", "<!doctype html><html><head><title>Counter</title></head><body><button id=\"increment\">Increment</button><span id=\"count\">0</span><script src=\"/app.js\"></script></body></html>");
  if (!context.recentEvidenceViews?.some((item) => item.summary.includes("app.js"))) return writeAction(context, "app.js", "const button = document.querySelector('#increment');\nlet count = 0;\nbutton.addEventListener('click', () => { count += 1; document.querySelector('#count').textContent = String(count); });\n");
  if (!context.recentEvidenceViews?.some((item) => item.summary.includes("test.js"))) return writeAction(context, "test.js", "const fs = require('node:fs');\nif (!fs.readFileSync('app.js', 'utf8').includes('count += 1')) process.exit(1);\nconsole.log('1 test passed');\n");
  if (!context.recentEvidenceViews?.some((item) => item.summary.includes("server.js"))) return writeAction(context, "server.js", "const http = require('node:http');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst root = __dirname;\nhttp.createServer((request, response) => { const name = request.url === '/' ? 'index.html' : request.url.slice(1); const file = path.join(root, name); if (!file.startsWith(root) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; } response.end(fs.readFileSync(file)); }).listen(Number(process.env.PORT || 3100), '127.0.0.1');\n");
  if (!context.recentEvidenceViews?.some((item) => item.source.includes("local-command:quality-build"))) return action(context, "ACT", "shell.sandbox", { commandId: "quality-build" }, "P1");
  if (!context.recentEvidenceViews?.some((item) => item.source.includes("local-command:quality-test"))) return action(context, "ACT", "shell.sandbox", { commandId: "quality-test" }, "P1");
  if (!context.recentEvidenceViews?.some((item) => item.source === "process.start")) {
    const port = Number(process.env.ACCEPTANCE_PREVIEW_PORT ?? "0");
    return action(context, "ACT", "process.start", port > 0 ? { argv: ["node", "server.js"], port } : { argv: ["node", "server.js"] }, "P1");
  }
  if (!context.recentEvidenceViews?.some((item) => item.source.includes("playwright:local"))) return action(context, "ACT", "browser.playwright", { url: `http://127.0.0.1:${process.env.ACCEPTANCE_PREVIEW_PORT}`, clickText: "Increment" }, "P1");
  return action(context, "WAIT", undefined, undefined, "P0");
}

function maintenanceAction(context: ContextPacket, _index: number): ActionEnvelope {
  if (!context.recentEvidenceViews?.some((item) => item.summary.includes("app.js"))) return action(context, "ACT", "workspace.read", { path: "app.js", lineStart: 1, lineEnd: 10 });
  if (!context.recentEvidenceViews?.some((item) => item.source === "workspace.patch")) return action(context, "ACT", "workspace.patch", { patch: "--- a/app.js\n+++ b/app.js\n@@ -1,1 +1,1 @@\n-module.exports = () => 1;\n+module.exports = () => 2;\n" });
  if (!context.recentEvidenceViews?.some((item) => item.source.includes("local-command:quality-test"))) return action(context, "ACT", "shell.sandbox", { commandId: "quality-test" }, "P1");
  return action(context, "WAIT", undefined, undefined, "P0");
}

async function runCycles(state: AppState, projectId: string, expectedActCount: number): Promise<AppState> {
  let current = state;
  for (let index = 0; index < expectedActCount + 1; index += 1) {
    const before = current;
    current = await executeLocalCycle(current, projectId);
    const latestAction = current.actions.filter((candidate) => candidate.projectId === projectId).at(-1);
    assert.ok(latestAction, `cycle ${index} did not record an action`);
    if (latestAction.type === "ACT") assert.notEqual(getProject(current, projectId)?.status, "EQUILIBRIUM", "successful ACT must keep the project active");
    assert.notEqual(current, before);
    if (latestAction.type === "WAIT") break;
  }
  return current;
}

async function main(): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "intent-world-autonomous-"));
  const workspace = join(temporaryRoot, "greenfield");
  const maintenanceWorkspace = join(temporaryRoot, "maintenance");
  const rawDirectory = join(temporaryRoot, "raw");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(maintenanceWorkspace, { recursive: true });
  mkdirSync(rawDirectory, { recursive: true });
  const previousEnv = { root: process.env.WORKSPACE_ROOT, raw: process.env.INTENT_WORLD_RAW_DIR, modelUrl: process.env.MODEL_API_URL, modelKey: process.env.MODEL_API_KEY, preview: process.env.ACCEPTANCE_PREVIEW_PORT };
  const greenfieldContexts: ContextPacket[] = [];
  const maintenanceContexts: ContextPacket[] = [];
  let modelServer: Server | undefined;
  const startedProcesses: string[] = [];
  try {
    process.env.WORKSPACE_ROOT = temporaryRoot;
    process.env.INTENT_WORLD_RAW_DIR = rawDirectory;
    process.env.MODEL_API_KEY = "mock-key";
    const previewPort = await freePort();
    process.env.ACCEPTANCE_PREVIEW_PORT = String(previewPort);
    const greenfieldModel = await startMockModel(greenfieldAction, greenfieldContexts);
    modelServer = greenfieldModel.server;
    process.env.MODEL_API_URL = greenfieldModel.endpoint;
    let greenfieldState = createProject(emptyState(), "브라우저에서 버튼을 누르면 숫자가 증가하는 작은 웹앱을 만들어줘.", "greenfield-acceptance", { workspacePath: workspace, modelProvider: "openai-compatible", sandboxMode: "process", networkPolicy: "allowlist", allowedDomains: ["127.0.0.1", "localhost"], cycleDelayMs: 0, processMaxLifetimeMs: 120_000 });
    greenfieldState = await runCycles(greenfieldState, "greenfield-acceptance", 10);
    const greenfieldProject = getProject(greenfieldState, "greenfield-acceptance");
    assert.equal(greenfieldProject?.status, "EQUILIBRIUM");
    assert.ok(greenfieldContexts.length >= 10, "mock gateway did not receive multiple cognition cycles");
    assert.ok(greenfieldContexts.every((context) => context.rawIntent.includes("숫자") && context.toolSurface.length > 0 && context.modelVersion.startsWith("openai-compatible:")));
    assert.ok(greenfieldState.actions.filter((action) => action.projectId === "greenfield-acceptance").every((action) => action.modelVersion.startsWith("openai-compatible:") && action.contextId && greenfieldState.contexts.some((context) => context.id === action.contextId)));
    assert.ok((greenfieldState.resourceLedger.find((ledger) => ledger.projectId === "greenfield-acceptance")?.tokens ?? 0) > 0, "provider usage was not recorded");
    assert.ok(greenfieldState.events.some((event) => event.projectId === "greenfield-acceptance" && event.type === "MODEL_TURN" && typeof event.payload?.rawRef === "string" && event.payload.rawRef.startsWith("local-raw://")), "model raw response provenance was not persisted");
    assert.match(readFileSync(join(workspace, "index.html"), "utf8"), /Increment/);
    assert.match(readFileSync(join(workspace, "app.js"), "utf8"), /count \+= 1/);
    assert.ok(greenfieldState.evidence.some((item) => item.source.includes("local-command:quality-build") && item.verdict === "PASS"));
    assert.ok(greenfieldState.evidence.some((item) => item.source.includes("local-command:quality-test") && item.verdict === "PASS"));
    const browserEvidence = greenfieldState.evidence.find((item) => item.source.includes("playwright:local") && item.verdict === "PASS");
    assert.ok(browserEvidence?.rawRef);
    const browserRaw = browserEvidence?.rawRef?.replace("local-raw://", "");
    assert.ok(browserRaw && existsSync(join(rawDirectory, browserRaw)));
    assert.match(readFileSync(join(rawDirectory, browserRaw), "utf8"), /Count: 1|Increment/);
    const greenfieldRun = getRun(greenfieldState, "greenfield-acceptance");
    assert.ok(greenfieldRun && greenfieldRun.cycleCount >= 10 && greenfieldRun.activeProcessIds.length === 1);
    startedProcesses.push(...(greenfieldRun?.activeProcessIds ?? []));
    assert.ok(greenfieldState.experiences.some((experience) => experience.actionType === "ACT" && experience.evidenceIds.length > 0));
    assert.ok(greenfieldState.events.some((event) => event.type === "WORKSPACE_CHANGED"));
    const firstEquilibrium = greenfieldState.events.findIndex((event) => event.type === "EQUILIBRIUM_ENTERED");
    const lastAct = greenfieldState.actions.filter((action) => action.projectId === "greenfield-acceptance" && action.type === "ACT").at(-1);
    const lastActEvent = lastAct ? greenfieldState.events.findIndex((event) => event.actionId === lastAct.id && event.type === "RUN_STATE_CHANGED") : -1;
    assert.ok(firstEquilibrium > lastActEvent, "an ACT must not enter equilibrium in the same cycle");

    writeFileSync(join(maintenanceWorkspace, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
    writeFileSync(join(maintenanceWorkspace, "app.js"), "module.exports = () => 1;\n", "utf8");
    writeFileSync(join(maintenanceWorkspace, "test.js"), "if (require('./app.js')() !== 2) process.exit(1); console.log('1 test passed');\n", "utf8");
    const maintenanceModel = await startMockModel(maintenanceAction, maintenanceContexts);
    modelServer.close();
    modelServer = maintenanceModel.server;
    process.env.MODEL_API_URL = maintenanceModel.endpoint;
    let maintenanceState = createProject(emptyState(), "기존 작은 앱의 버그를 찾아 고치고 실제 테스트로 검증해줘.", "maintenance-acceptance", { workspacePath: maintenanceWorkspace, modelProvider: "openai-compatible", sandboxMode: "process", networkPolicy: "allowlist", allowedDomains: ["127.0.0.1", "localhost"], cycleDelayMs: 0 });
    maintenanceState = await runCycles(maintenanceState, "maintenance-acceptance", 3);
    assert.equal(readFileSync(join(maintenanceWorkspace, "app.js"), "utf8").trim(), "module.exports = () => 2;");
    assert.equal(getProject(maintenanceState, "maintenance-acceptance")?.status, "EQUILIBRIUM");
    assert.ok(maintenanceState.evidence.some((item) => item.source === "workspace.patch" && item.verdict === "PASS"));
    assert.ok(maintenanceState.evidence.some((item) => item.source.includes("local-command:quality-test") && item.verdict === "PASS"));
    assert.ok(maintenanceContexts.length >= 4);
    console.log("Autonomous acceptance passed: real HTTP model, multi-cycle greenfield build/browser verification, and maintenance patch/test flow");
  } finally {
    await Promise.all(startedProcesses.map((processId) => stopManagedProcess(processId)));
    await new Promise<void>((resolve) => modelServer?.close(() => resolve()) ?? resolve());
    if (previousEnv.root === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = previousEnv.root;
    if (previousEnv.raw === undefined) delete process.env.INTENT_WORLD_RAW_DIR; else process.env.INTENT_WORLD_RAW_DIR = previousEnv.raw;
    if (previousEnv.modelUrl === undefined) delete process.env.MODEL_API_URL; else process.env.MODEL_API_URL = previousEnv.modelUrl;
    if (previousEnv.modelKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousEnv.modelKey;
    if (previousEnv.preview === undefined) delete process.env.ACCEPTANCE_PREVIEW_PORT; else process.env.ACCEPTANCE_PREVIEW_PORT = previousEnv.preview;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
