/** Real Codex App Server + local scripted Responses endpoint. No paid model or login. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServer } from "../server/codexAppServer";
import { runNativeEpisode } from "../server/nativeRuntime";
import { createProject, getProject, getRun, resolveHumanItem, wakeProject } from "../src/runtime";
import { createEmptyState } from "../src/emptyState";
import { stopProcessesForRun } from "../server/processManager";
import type { AppState } from "../src/types";

// Keep the fixture workspace outside /tmp: Native turn/start deliberately
// excludes /tmp, so putting the writable root there would test the wrong
// boundary on Linux runners.
const acceptanceParent = process.env.RUNNER_TEMP?.trim() || process.env.GITHUB_WORKSPACE?.trim() || process.cwd();
const root = mkdtempSync(join(acceptanceParent, ".sakasaka-native-acceptance-"));
const workspace = join(root, "workspace"), home = join(root, "codex-home");
mkdirSync(workspace); mkdirSync(home);
process.env.WORKSPACE_ROOT = root;
process.env.INTENT_WORLD_RAW_DIR = join(root, "raw");
const binary = process.env.SAKASAKA_TEST_CODEX_BIN;
if (!binary) { rmSync(root, { recursive: true, force: true }); throw new Error("SAKASAKA_TEST_CODEX_BIN에 검증할 실제 Codex 바이너리를 지정하십시오. 테스트를 건너뛰어 성공으로 표시하지 않습니다."); }
const previewPort = await freePort();
let state = createProject(createEmptyState(), "버튼을 누르면 숫자가 올라가는 작은 웹앱이 있었으면 좋겠어", "native-acceptance", { workspacePath: workspace, modelProvider: "codex-cli", modelName: "test-native-model", executionMode: "native", sandboxMode: "process", maxNativeTurns: 5, maxNativeTokens: 100000, nativeTurnTimeoutMs: 90000 });
let serial = Promise.resolve();
const store = { read: () => state, transact(update: (s: AppState) => AppState): Promise<AppState> { const p = serial.then(() => { state = update(state); return state; }); serial = p.then(() => undefined); return p; } };
const coreOnly = process.argv.includes("--core");
let requestIndex = 0, maintenance = false;
const inputs: string[] = [];
const question = { key: "caption", title: "버튼 이름을 무엇으로 할까요?", rationale: "사람이 원하는 표시 문구입니다. 동작 구현은 계속할 수 있습니다.", blockingScope: ["최종 표시 문구"], continuingScope: ["카운터 동작", "검증"], options: [] };
const files = {
  "index.html": '<!doctype html><html lang="ko"><meta charset="utf-8"><title>카운터</title><body><button id="add">더하기</button><output id="count">0</output><script>let n=0;document.querySelector("#add").onclick=()=>document.querySelector("#count").textContent=String(++n);</script></body></html>',
  "logic.mjs": 'export const increment = n => n + 2;\n',
  "test.mjs": 'import assert from "node:assert/strict";import {test} from "node:test";import {increment} from "./logic.mjs";test("increments exactly one",()=>assert.equal(increment(0),1));\n',
  "server.mjs": 'import http from "node:http";import fs from "node:fs";http.createServer((q,s)=>{s.setHeader("Content-Type","text/html; charset=utf-8");s.end(fs.readFileSync("index.html"));}).listen(Number(process.env.PORT),"127.0.0.1");\n',
};
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const shellWrite = (values: Record<string, string>) => Object.entries(values)
  .map(([path, content]) => `printf %s ${shellQuote(content)} > ${shellQuote(path)}`)
  .join(" && ");
const fixtureWrite = (mode: string, target?: string) => mode === "initial"
  ? shellWrite(files)
  : mode === "fix"
    ? shellWrite({ "logic.mjs": "export const increment = n => n + 1;\n" })
    : mode === "readme"
      ? shellWrite({ "README.md": "사용자 선택: 하나 더\n" })
      : shellWrite({ [target ?? "../outside-native.txt"]: "must-not-exist" });
const server = createServer(async (req, res) => {
  if (!req.url?.endsWith("/responses")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [] })); return; }
  try {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4000000) throw new Error("request too large"); }
    const payload = JSON.parse(raw);
    inputs.push(JSON.stringify(payload.input));
    if (process.env.NATIVE_ACCEPTANCE_DEBUG_DIR) writeFileSync(join(process.env.NATIVE_ACCEPTANCE_DEBUG_DIR, `request-${maintenance}-${requestIndex}.json`), JSON.stringify(payload, null, 2));
    const names = (payload.tools ?? []).flatMap((tool: {type:string;name?:string;tools?:Array<{name:string}>}) => tool.type === "namespace" ? tool.tools?.map((t) => `${tool.name}.${t.name}`) ?? [] : [tool.name ?? ""]);
    if (requestIndex === 0 && !maintenance) console.log("Native tools:", names.join(","));
    const named = (suffix: string) => { const name = names.find((n: string) => n === suffix || n.endsWith(`.${suffix}`)); assert(name, `provider did not receive tool ${suffix}`); return name; };
    const exec = (command: string) => ({ name: named("exec_command"), arguments: JSON.stringify({ cmd: command, yield_time_ms: 1000, max_output_tokens: 2000 }) });
    let call: {name:string;arguments:string} | undefined;
    const i = requestIndex++;
    if (!maintenance) {
      if (i === 0) call = { name: named("sakasaka_question"), arguments: JSON.stringify(question) };
      else if (i === 1) { assert.equal(state.humanItems[0]?.status, "OPEN", "question must be registered before native work"); call = exec(fixtureWrite("initial")); }
      else if (i === 2) call = exec("node --test test.mjs");
      else if (i === 3) call = exec(fixtureWrite("fix") + " && node --test test.mjs");
      else if (i === 4) call = { name: named("sakasaka_preview_start"), arguments: JSON.stringify({ argv: ["node", "server.mjs"], port: previewPort }) };
      else if (i === 5) call = coreOnly ? exec("node --test test.mjs") : { name: named("sakasaka_browser"), arguments: JSON.stringify({ url: `http://127.0.0.1:${previewPort}`, clickText: "더하기", expectedText: "1" }) };
      else if (i === 6) {
        const item = state.humanItems[0]; assert(item && item.status === "OPEN");
        await store.transact((s) => resolveHumanItem(s, item.id, "defer"));
        await store.transact((s) => resolveHumanItem(s, item.id, "answer", "하나 더"));
        // The next tool reads the actual durable answer even if steer raced this request.
        call = { name: named("sakasaka_context"), arguments: "{}" };
      } else if (i === 7) {
        assert(inputs.at(-1)?.includes("하나 더"), "actual human answer must reach the same agent thread");
        call = exec(fixtureWrite("readme"));
      } else if (i === 8) call = exec(fixtureWrite("outside", "../outside-native.txt"));
    } else {
      if (i === 0) call = exec("node --test test.mjs");
      else if (i === 1) call = exec(fixtureWrite("fix") + " && node --test test.mjs");
    }
    const item = call ? { type: "function_call", id: `fc-${maintenance}-${i}`, call_id: `call-${maintenance}-${i}`, status: "completed", ...call }
      : { type: "message", id: `msg-${maintenance}-${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ disposition: "equilibrium", summary: "테스트 fixture가 작업 결과를 보고합니다. 실제 모델 지능 검증이 아닙니다.", remainingWork: [], evidenceRefs: state.evidence.map((e) => e.id).slice(-32), wakeReasons: ["사용자 의견 또는 장애"] }), annotations: [] }] };
    const responseId = `resp-${maintenance}-${i}`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });
    event({ type: "response.output_item.added", output_index: 0, item });
    event({ type: "response.output_item.done", output_index: 0, item });
    event({ type: "response.completed", response: { id: responseId, object: "response", status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 } } });
    res.end();
  } catch (error) { console.error(error); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: String(error) } })); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = (server.address() as {port:number}).port;
writeFileSync(join(home, "config.toml"), `model="test-native-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local scripted test only"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\n# GitHub-hosted Ubuntu runners may deny the vendored Bubblewrap user namespace.\n# Landlock remains a real filesystem sandbox and is enabled only for this fixture.\nuse_legacy_landlock=true\n${process.env.NATIVE_ACCEPTANCE_SANDBOX_NETWORK === "1" ? "\n# The fixture model is loopback-only; avoid a runner network namespace setup.\n[sandbox_workspace_write]\nnetwork_access=true\n" : ""}`);
const makeClient = (cwd: string) => new CodexAppServer({ binary, cwd, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, RUST_LOG: "error" }, requestTimeoutMs: 10000 });
try {
  await runNativeEpisode(store, "native-acceptance", { clientFactory: makeClient, pollMs: 100, sandboxNetworkAccess: process.env.NATIVE_ACCEPTANCE_SANDBOX_NETWORK === "1" });
  console.log("Native first result", getProject(state, "native-acceptance")?.status, getRun(state, "native-acceptance")?.stopReason);
  assert.equal(getProject(state, "native-acceptance")?.status, "EQUILIBRIUM");
  assert.equal(readFileSync(join(workspace, "logic.mjs"), "utf8"), "export const increment = n => n + 1;\n");
  assert(state.evidence.some((e) => e.metadata?.exitCode === 1 || (e.source === "codex.rawToolOutput" && e.summary.includes("Process exited with code 1"))), "real failing test output must be retained even when provider omits structured execution status");
  if (!coreOnly) assert(state.evidence.some((e) => e.kind === "browser" && e.verdict === "PASS"), "real Chromium evidence required; never fallback to mock PASS");
  assert(state.evidence.some((e) => e.rawRef && e.verdict === "PASS"));
  assert.equal(state.humanItems[0].status, "ANSWERED");
  assert.equal(existsSync(join(root, "outside-native.txt")), false, "Codex native sandbox must reject writes outside the workspace");
  const initialTokens = getRun(state, "native-acceptance")?.nativeSession?.accountedTokens ?? 0;
  const thread = getRun(state, "native-acceptance")?.nativeSession?.threadId;
  assert(thread); assert(readFileSync(join(workspace, "README.md"), "utf8").includes("하나 더"));
  writeFileSync(join(workspace, "logic.mjs"), "export const increment = n => n + 3;\n");
  maintenance = true; requestIndex = 0;
  await store.transact((s) => wakeProject(s, "native-acceptance", "incident"));
  await runNativeEpisode(store, "native-acceptance", { clientFactory: makeClient, pollMs: 100, sandboxNetworkAccess: process.env.NATIVE_ACCEPTANCE_SANDBOX_NETWORK === "1" });
  assert.equal(getProject(state, "native-acceptance")?.status, "EQUILIBRIUM");
  assert.equal(getRun(state, "native-acceptance")?.nativeSession?.threadId, thread);
  assert((getRun(state, "native-acceptance")?.nativeSession?.accountedTokens ?? 0) > initialTokens, "resumed thread usage must continue accounting, not reset or disappear");
  assert.equal(readFileSync(join(workspace, "logic.mjs"), "utf8"), "export const increment = n => n + 1;\n");
  console.log(coreOnly
    ? "Native CORE acceptance passed: actual Codex App Server, native command/write/failure recovery, async human answer, workspace write boundary, persistent-thread maintenance. Browser integration NOT EXECUTED; this does not satisfy the full CI gate. Model responses were scripted."
    : "Native acceptance passed: actual Codex App Server, native command/write/failure recovery, async human answer, real Chromium, workspace write boundary, persistent-thread maintenance. Model responses were scripted; no live-model ability claim.");
} catch (error) {
  console.error("Native events", state.events.slice(-8));
  console.error("Native evidence", state.evidence);
  const target = process.env.NATIVE_ACCEPTANCE_DEBUG_DIR;
  if (target) { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "state.json"), JSON.stringify(state, null, 2)); console.error("Debug root:", root); }
  throw error;
} finally {
  await stopProcessesForRun(state.processes, getRun(state, "native-acceptance")!.id);
  server.closeAllConnections(); server.close();
  if (!process.env.NATIVE_ACCEPTANCE_DEBUG_DIR) rmSync(root, { recursive: true, force: true });
}

async function freePort(): Promise<number> { const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening"); const p = (s.address() as {port:number}).port; await new Promise<void>((resolve) => s.close(() => resolve())); return p; }
