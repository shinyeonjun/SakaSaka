import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface JsonResponse {
  response: Response;
  body: any;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
  if (!port) throw new Error("could not reserve an API port");
  return port;
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { response, body };
}

function post(baseUrl: string, path: string, body?: unknown): Promise<JsonResponse> {
  return request(baseUrl, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited before health check: ${logs.join("")}`);
    try {
      const { response } = await request(baseUrl, "/health");
      if (response.ok) return;
    } catch {
      // The server may still be binding its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`API health check timed out: ${logs.join("")}`);
}

async function waitForProject(baseUrl: string, projectId: string, predicate: (body: any) => boolean): Promise<any> {
  const deadline = Date.now() + 15_000;
  let lastBody: any;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}`);
    lastBody = result.body;
    if (result.response.ok && predicate(result.body)) return result.body;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`project state did not converge: ${JSON.stringify(lastBody)}`);
}

async function readSseReplay(baseUrl: string, projectId: string, cursor: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/stream`, { headers: { "Last-Event-ID": cursor } });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE replay timed out")), 3_000)),
  ]);
  await reader.cancel();
  return new TextDecoder().decode(result.value);
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const temporaryRoot = mkdtempSync(join(tmpdir(), "intent-world-api-"));
  const statePath = join(temporaryRoot, "state.json");
  const rawDirectory = join(temporaryRoot, "raw");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let provisionedWorkspace: string | undefined;
  const child = spawn(process.execPath, [resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), resolve(repoRoot, "server", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      API_PORT: String(port),
      INTENT_WORLD_STATE_FILE: statePath,
      INTENT_WORLD_RAW_DIR: rawDirectory,
      WORKSPACE_ROOT: repoRoot,
      OTEL_LOCAL_FILE: join(temporaryRoot, "observability.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  try {
    await waitForHealth(baseUrl, child, logs);
    const modelCatalog = await request(baseUrl, "/runtime/model-catalog");
    assert.equal(modelCatalog.response.status, 200);
    assert.ok(Array.isArray(modelCatalog.body.models));
    assert.ok(Array.isArray(modelCatalog.body.entries));
    assert.ok(modelCatalog.body.entries.some((entry: { id?: string; label?: string }) => entry.id === "gpt-5.6-luna" && entry.label === "GPT-5.6 Luna"));
    const modelStatus = await request(baseUrl, "/runtime/model-status?provider=deterministic&model=offline-model");
    assert.equal(modelStatus.response.status, 200, JSON.stringify(modelStatus.body));
    assert.equal(modelStatus.body.requested, "deterministic");
    assert.equal(modelStatus.body.effective, "deterministic");
    assert.equal(modelStatus.body.selectedModel, "offline-model");
    const projectId = `api-contract-${Date.now().toString(36)}`;
    const created = await post(baseUrl, "/projects", {
      projectId,
      rawIntent: "현재 workspace의 품질을 검증하고 안전한 상태를 확인해줘",
      settings: { workspacePath: repoRoot, budgetLimit: 5, maxHours: 1, allowedDomains: [], modelProvider: "deterministic", modelName: "offline-model" },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.id, projectId);
    assert.equal(created.body.project.status, "ACTIVE");
    assert.equal(created.body.intent.rawText, "현재 workspace의 품질을 검증하고 안전한 상태를 확인해줘");
    assert.equal(created.body.project.settings.modelName, "offline-model");
    const runtimeStatus = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}/runtime-status`);
    assert.equal(runtimeStatus.response.status, 200, JSON.stringify(runtimeStatus.body));
    assert.equal(runtimeStatus.body.model.effective, "deterministic");
    assert.equal(runtimeStatus.body.model.state, "connected");
    assert.equal(runtimeStatus.body.workspace.state, "bound");
    assert.equal(runtimeStatus.body.workspace.writable, true);

    const duplicate = await post(baseUrl, "/projects", { projectId, rawIntent: "duplicate", settings: { workspacePath: repoRoot } });
    assert.equal(duplicate.response.status, 409);
    const invalidPath = await post(baseUrl, "/projects", { projectId: `${projectId}-outside`, rawIntent: "outside", settings: { workspacePath: resolve(repoRoot, "..") } });
    assert.equal(invalidPath.response.status, 400);
    const invalidBody = await request(baseUrl, "/projects", { method: "POST", body: "[]" });
    assert.equal(invalidBody.response.status, 400);

    const greenfieldProjectId = `${projectId}-greenfield`;
    const greenfield = await post(baseUrl, "/projects", { projectId: greenfieldProjectId, rawIntent: "빈 workspace에서 작은 앱을 만들어줘", settings: { budgetLimit: 5, maxHours: 1, cycleDelayMs: 60_000 } });
    assert.equal(greenfield.response.status, 201, JSON.stringify(greenfield.body));
    provisionedWorkspace = greenfield.body.project.settings.workspacePath;
    assert.ok(typeof provisionedWorkspace === "string" && existsSync(provisionedWorkspace));
    assert.ok(provisionedWorkspace.startsWith(join(repoRoot, ".intent-world", "workspaces")));

    const run = await post(baseUrl, `/projects/${encodeURIComponent(projectId)}/run`);
    assert.equal(run.response.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.project.status, "ACTIVE");
    assert.ok(run.body.actions.some((action: any) => action.projectId === projectId && action.status === "VERIFIED"));
    const passEvidence = run.body.evidence.find((item: any) => item.projectId === projectId && item.verdict === "PASS");
    assert.ok(passEvidence);
    assert.equal(passEvidence.actionId, run.body.actions.at(-1).id);
    assert.ok(run.body.events.some((event: any) => event.type === "OBSERVE"));
    assert.ok(run.body.events.some((event: any) => event.type === "CONTEXT_ASSEMBLED"));
    assert.ok(run.body.events.some((event: any) => event.type === "EVIDENCE_RECORDED"));
    assert.ok(!run.body.events.some((event: any) => event.type === "EQUILIBRIUM_ENTERED"));
    const worldChanged = run.body.events.filter((event: any) => event.type === "WORLD_CHANGED").at(-1);
    assert.equal(run.body.world.cursorEventId, worldChanged.id);

    const firstEventId = run.body.events[0].id;
    const after = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}/events?after=${encodeURIComponent(firstEventId)}`);
    assert.equal(after.response.status, 200);
    assert.ok(after.body.events.every((event: any) => event.id !== firstEventId));
    const sse = await readSseReplay(baseUrl, projectId, firstEventId);
    assert.ok(sse.includes("event: event.created") || sse.includes("event: ready"));
    const raw = await request(baseUrl, `/evidence/${encodeURIComponent(passEvidence.id)}/raw`);
    assert.equal(raw.response.status, 200);
    for (const route of ["actions", "contexts", "relations", "retrieval-index"]) {
      const result = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}/${route}`);
      assert.equal(result.response.status, 200, route);
    }

    const workerProjectId = `${projectId}-worker`;
    const workerCreated = await post(baseUrl, "/projects", { projectId: workerProjectId, rawIntent: "worker가 quality gate를 실행해줘", settings: { workspacePath: repoRoot, budgetLimit: 5, maxHours: 1, cycleDelayMs: 0, modelProvider: "deterministic" } });
    assert.equal(workerCreated.response.status, 201);
    const oldStatePath = process.env.INTENT_WORLD_STATE_FILE;
    const oldRawDirectory = process.env.INTENT_WORLD_RAW_DIR;
    const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;
    process.env.INTENT_WORLD_STATE_FILE = statePath;
      process.env.INTENT_WORLD_RAW_DIR = rawDirectory;
      process.env.WORKSPACE_ROOT = repoRoot;
    try {
      const workerModule = await import("../server/worker");
      let processed = { processed: [] as string[] };
      for (let attempt = 0; attempt < 20 && !processed.processed.includes(workerProjectId); attempt += 1) {
        processed = await workerModule.runWorkerOnce();
        if (!processed.processed.includes(workerProjectId)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.ok(processed.processed.includes(workerProjectId));
    } finally {
      if (oldStatePath === undefined) delete process.env.INTENT_WORLD_STATE_FILE; else process.env.INTENT_WORLD_STATE_FILE = oldStatePath;
      if (oldRawDirectory === undefined) delete process.env.INTENT_WORLD_RAW_DIR; else process.env.INTENT_WORLD_RAW_DIR = oldRawDirectory;
      if (oldWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
    }
    const workerState = await waitForProject(baseUrl, workerProjectId, (body) => body.actions.some((action: any) => action.projectId === workerProjectId));
    const workerRunId = workerState.run.id;
    const paused = await post(baseUrl, `/runs/${encodeURIComponent(workerRunId)}/pause`);
    assert.equal(paused.body.project.status, "PAUSED");
    const resumed = await post(baseUrl, `/runs/${encodeURIComponent(workerRunId)}/resume`);
    assert.equal(resumed.body.project.status, "ACTIVE");
    const killed = await post(baseUrl, `/runs/${encodeURIComponent(workerRunId)}/kill`);
    assert.equal(killed.body.project.status, "KILLED");
    const greenfieldRunId = greenfield.body.project.activeRunId;
    const greenfieldKilled = await post(baseUrl, `/runs/${encodeURIComponent(greenfieldRunId)}/kill`);
    assert.equal(greenfieldKilled.body.project.status, "KILLED");

    const modelUpdated = await post(baseUrl, `/projects/${encodeURIComponent(projectId)}/model`, { modelProvider: "deterministic", modelName: "updated-offline-model" });
    assert.equal(modelUpdated.response.status, 200, JSON.stringify(modelUpdated.body));
    assert.equal(modelUpdated.body.project.settings.modelName, "updated-offline-model");
    assert.equal(modelUpdated.body.project.settings.modelProvider, "deterministic");
    const deleted = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.workspacePreserved, true);
    const deletedLookup = await request(baseUrl, `/projects/${encodeURIComponent(projectId)}`);
    assert.equal(deletedLookup.response.status, 404);

    console.log("API/worker acceptance passed");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      child.once("exit", () => resolvePromise());
      setTimeout(() => resolvePromise(), 2_000);
    });
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (provisionedWorkspace && provisionedWorkspace.startsWith(join(repoRoot, ".intent-world", "workspaces")) && existsSync(provisionedWorkspace)) rmSync(provisionedWorkspace, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
