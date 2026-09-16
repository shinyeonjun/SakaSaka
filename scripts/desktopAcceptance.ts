import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
  assert.ok(port > 0);
  return port;
}

function currentTarget(): { api: string; worker: string } {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    return { api: `sakasaka-api-${triple}.exe`, worker: `sakasaka-worker-${triple}.exe` };
  }
  if (platform === "darwin") {
    const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    return { api: `sakasaka-api-${triple}`, worker: `sakasaka-worker-${triple}` };
  }
  if (platform === "linux") {
    const triple = arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    return { api: `sakasaka-api-${triple}`, worker: `sakasaka-worker-${triple}` };
  }
  throw new Error(`지원하지 않는 데스크톱 플랫폼입니다: ${platform}/${arch}`);
}

function childEnvironment(root: string, port: number): NodeJS.ProcessEnv {
  const data = join(root, "data");
  mkdirSync(join(data, "raw"), { recursive: true });
  mkdirSync(join(data, "workspaces"), { recursive: true });
  return {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    DESKTOP_MODE: "true",
    CODEX_CLI_ENABLED: "false",
    INTENT_WORLD_STATE_FILE: join(data, "state.json"),
    INTENT_WORLD_RAW_DIR: join(data, "raw"),
    INTENT_WORLD_WORKSPACE_ROOT_FILE: join(data, "workspace-root.txt"),
    WORKSPACE_ROOT: join(data, "workspaces"),
  };
}

function start(binary: string, cwd: string, environment: NodeJS.ProcessEnv): { child: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const child = spawn(binary, [], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitForHealth(port: number, child: ChildProcess, logs: string[]): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The packaged process may still be starting.
    }
    if (child.exitCode !== null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`패키지 API health 확인 실패: ${logs.join("").slice(-2_000)}`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    setTimeout(resolvePromise, 5_000).unref();
  });
}

async function main(): Promise<void> {
  const repository = resolve(process.cwd());
  const binaries = currentTarget();
  const apiBinary = resolve(repository, "src-tauri", "binaries", binaries.api);
  const workerBinary = resolve(repository, "src-tauri", "binaries", binaries.worker);
  assert.ok(existsSync(apiBinary), `API sidecar가 없습니다: ${apiBinary}`);
  assert.ok(existsSync(workerBinary), `worker sidecar가 없습니다: ${workerBinary}`);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "sakasaka-desktop-acceptance-"));
  const workspace = join(temporaryRoot, "selected-workspace");
  mkdirSync(workspace, { recursive: true });
  const port = await freePort();
  const environment = childEnvironment(temporaryRoot, port);
  const api = start(apiBinary, temporaryRoot, environment);
  let worker: ReturnType<typeof start> | undefined;
  try {
    await waitForHealth(port, api.child, api.logs);
    const rootResponse = await fetch(`http://127.0.0.1:${port}/runtime/workspace-root`);
    assert.equal(rootResponse.status, 200);
    const selectedResponse = await fetch(`http://127.0.0.1:${port}/runtime/workspace-root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json() as { root?: string };
    assert.equal(selected.root, resolve(workspace));

    worker = start(workerBinary, temporaryRoot, environment);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    assert.equal(worker.child.exitCode, null, worker.logs.join(""));
    console.log("Desktop acceptance passed: packaged API/worker sidecars, health, workspace boundary, and lifecycle");
  } finally {
    await stop(worker?.child);
    await stop(api.child);
    await fsPromises.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
