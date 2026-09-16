import { executableInvocation, stopProcessTree } from "./commandRunner";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDeveloperArgv, isManagedProcessArgv, redactSecretLikeText } from "../src/security";
import type { SandboxContext, ToolResult } from "../src/ports";
import type { ActionEnvelope, Evidence, ManagedProcess, Observation } from "../src/types";

const execFileAsync = promisify(execFile);
const maxLogBytes = 512 * 1024;
const defaultLifetimeMs = 30 * 60_000;
const children = new Map<string, ChildProcess>();
const records = new Map<string, ManagedProcess>();

export function hydrateManagedProcesses(persisted: ManagedProcess[]): void {
  for (const record of persisted) {
    if (!records.has(record.id)) records.set(record.id, { ...record, argv: [...record.argv] });
  }
}

function rawLogPath(key: string): { path: string; rawRef: string } {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const fileName = `${Date.now()}-${safeKey}.txt`;
  const directory = resolve(process.cwd(), process.env.INTENT_WORLD_RAW_DIR ?? ".data/raw");
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, fileName);
  writeFileSync(path, "", "utf8");
  return { path, rawRef: `local-raw://${fileName}` };
}

function appendLog(path: string, chunk: string): void {
  if (!existsSync(path)) return;
  const currentSize = requireStatSize(path);
  if (currentSize >= maxLogBytes) return;
  appendFileSync(path, redactSecretLikeText(chunk).slice(0, Math.max(0, maxLogBytes - currentSize)), "utf8");
}

function requireStatSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function childEnv(port: number | undefined): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|REDIS_URL)/i.test(key)));
  if (port) env.PORT = String(port);
  return env;
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

function observation(projectId: string, runId: string, record: ManagedProcess, status: Observation["status"] = "healthy"): Observation {
  return { id: `observation-process-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, projectId, source: "process", status, observedAt: new Date().toISOString(), freshness: "fresh", rawRef: record.stdoutRawRef ?? `process://${record.id}`, compactView: redactSecretLikeText(`process ${record.id} · ${record.status}${record.port ? ` · port ${record.port}` : ""}`), trustLevel: "observed", confidence: status === "healthy" ? 0.9 : 0.35, relatedEntities: [runId, record.id] };
}

function evidence(projectId: string, verdict: Evidence["verdict"], summary: string, source: string, record: ManagedProcess): Evidence {
  return { id: `evidence-process-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, projectId, kind: "world", verdict, summary: redactSecretLikeText(summary).slice(0, 4_000), source, createdAt: new Date().toISOString(), rawRef: record.stdoutRawRef, evaluator: "local-process-manager", evaluatorVersion: "process-manager-0.1", metadata: { processId: record.id, status: record.status, pid: record.pid ?? 0, port: record.port ?? 0 } };
}

function output(sandbox: SandboxContext, record: ManagedProcess, ev: Evidence, progress: "meaningful" | "none"): ToolResult {
  return { tool: "process", toolVersion: "process-manager-0.1", status: ev.verdict === "FAIL" ? "failed" : "succeeded", outputRef: `tool://${sandbox.projectId}/${sandbox.runId}/process/${record.id}`, summary: ev.summary, evidence: [ev], cost: 0.08, wallTimeMs: 0, output: JSON.stringify(record), process: { ...record }, observations: [observation(sandbox.projectId, sandbox.runId, record, ev.verdict === "FAIL" ? "warning" : "healthy")], progress };
}

function actionArgv(action: ActionEnvelope): string[] {
  const argv = action.params?.argv;
  if (!Array.isArray(argv) || !argv.every((item) => typeof item === "string")) throw new Error("process action requires argv");
  return argv;
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  stopProcessTree(pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  stopProcessTree(pid, true);
}

export async function executeProcessTool(action: ActionEnvelope, sandbox: SandboxContext, maxLifetimeMs = defaultLifetimeMs, options: { signal?: AbortSignal } = {}): Promise<ToolResult | undefined> {
  if (action.type !== "ACT" || !action.tool?.startsWith("process.")) return undefined;
  const startedAt = Date.now();
  try {
    options.signal?.throwIfAborted();
    if (action.tool === "process.start") {
      const argv = actionArgv(action);
      const validArgv = sandbox.mode === "docker" ? isDeveloperArgv(argv) : isManagedProcessArgv(argv);
      if (!validArgv) throw new Error(sandbox.mode === "docker" ? "process.start argv is outside the Docker developer command allowlist" : "process.start argv is outside the process-mode dev-server allowlist");
      const requestedPort = typeof action.params?.port === "number" && Number.isInteger(action.params.port) && action.params.port >= 1 && action.params.port <= 65_535 ? action.params.port : undefined;
      const active = [...records.values()].filter((candidate) => candidate.projectId === sandbox.projectId && candidate.runId === sandbox.runId && (candidate.status === "starting" || candidate.status === "running"));
      const duplicate = active.find((candidate) => candidate.argv.length === argv.length && candidate.argv.every((value, index) => value === argv[index]) && candidate.port === requestedPort);
      if (duplicate) {
        const ev = evidence(sandbox.projectId, "PASS", `process.start reused managed process · ${duplicate.id}`, "process.start", duplicate);
        return { ...output(sandbox, duplicate, ev, "none"), tool: action.tool, cost: 0.02, wallTimeMs: Date.now() - startedAt };
      }
      if (active.length >= (sandbox.maxConcurrentProcesses ?? 4)) {
        const record: ManagedProcess = { id: `process-${Date.now().toString(36)}`, projectId: sandbox.projectId, runId: sandbox.runId, argv, cwd: sandbox.workspaceRef, port: requestedPort, status: "failed", startedAt: new Date().toISOString(), error: "maximum concurrent managed process limit reached" };
        records.set(record.id, record);
        const ev = evidence(sandbox.projectId, "FAIL", `process.start failed · maximum ${sandbox.maxConcurrentProcesses ?? 4} processes reached`, "process.start", record);
        return { ...output(sandbox, record, ev, "none"), tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
      }
      if (requestedPort && !(await portAvailable(requestedPort))) {
        const record: ManagedProcess = { id: `process-${Date.now().toString(36)}`, projectId: sandbox.projectId, runId: sandbox.runId, argv, cwd: sandbox.workspaceRef, port: requestedPort, status: "failed", startedAt: new Date().toISOString(), error: "requested port is already in use" };
        records.set(record.id, record);
        const ev = evidence(sandbox.projectId, "FAIL", `process.start failed · port ${requestedPort} is already in use`, "process.start", record);
        return { ...output(sandbox, record, ev, "none"), tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
      }
      const stdout = rawLogPath(`${sandbox.projectId}-${sandbox.runId}-process-stdout`);
      const stderr = rawLogPath(`${sandbox.projectId}-${sandbox.runId}-process-stderr`);
      const record: ManagedProcess = { id: `process-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, projectId: sandbox.projectId, runId: sandbox.runId, argv: [...argv], cwd: sandbox.workspaceRef, port: requestedPort, previewUrl: requestedPort ? `http://127.0.0.1:${requestedPort}` : undefined, status: "starting", startedAt: new Date().toISOString(), stdoutRawRef: stdout.rawRef, stderrRawRef: stderr.rawRef };
      try {
        const dockerArgs = sandbox.mode === "docker" ? [
          "run", "--rm", "--init", "--name", record.id, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--cpus", "1", "--pids-limit", "128", "--memory", "1g", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
          ...(requestedPort ? ["-e", `PORT=${requestedPort}`] : []),
          ...(requestedPort ? ["--network", "bridge", "-p", `127.0.0.1:${requestedPort}:${requestedPort}`] : ["--network", "none"]),
          "-v", `${resolve(sandbox.workspaceRef)}:/workspace:rw`, "-w", "/workspace", sandbox.image ?? process.env.SANDBOX_IMAGE ?? "node:22-alpine", ...argv,
        ] : undefined;
        options.signal?.throwIfAborted();
        if (sandbox.mode === "docker") record.containerId = record.id;
        const invocation = executableInvocation(sandbox.mode === "docker" ? "docker" : argv[0], dockerArgs ?? argv.slice(1));
        const child = spawn(invocation.file, invocation.args, { cwd: resolve(sandbox.workspaceRef), shell: false, windowsHide: true, detached: process.platform !== "win32", env: childEnv(requestedPort), stdio: ["ignore", "pipe", "pipe"] });
        record.pid = child.pid;
        record.status = "running";
        children.set(record.id, child);
        records.set(record.id, record);
        child.stdout?.on("data", (chunk: Buffer) => appendLog(stdout.path, chunk.toString()));
        child.stderr?.on("data", (chunk: Buffer) => appendLog(stderr.path, chunk.toString()));
        child.once("error", (error) => { record.status = "failed"; record.error = redactSecretLikeText(error.message); record.endedAt = new Date().toISOString(); });
        child.once("close", (code) => { record.exitCode = code ?? undefined; record.status = record.status === "stopped" ? "stopped" : code === 0 ? "exited" : "failed"; record.endedAt = new Date().toISOString(); children.delete(record.id); });
        await new Promise<void>((resolveSpawn, rejectSpawn) => { child.once("spawn", resolveSpawn); child.once("error", rejectSpawn); });
        if (options.signal?.aborted) { await stopManagedProcess(record.id); throw new Error("프로세스 시작이 취소되었습니다."); }
        const timer = setTimeout(() => { void stopManagedProcess(record.id); }, Math.max(1_000, maxLifetimeMs));
        timer.unref?.();
        const ev = evidence(sandbox.projectId, "PASS", `process.start · ${argv.join(" ")} · pid ${record.pid ?? "unknown"}`, "process.start", record);
        return { ...output(sandbox, record, ev, "meaningful"), tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
      } catch (error: unknown) {
        record.status = "failed";
        record.error = redactSecretLikeText(error instanceof Error ? error.message : "process spawn failed");
        records.set(record.id, record);
        const ev = evidence(sandbox.projectId, "FAIL", `process.start failed · ${record.error}`, "process.start", record);
        return { ...output(sandbox, record, ev, "none"), tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
      }
    }

    const processId = typeof action.params?.processId === "string" ? action.params.processId : "";
    const record = records.get(processId);
    if (!record) {
      const missing: ManagedProcess = { id: processId || `unknown-${Date.now().toString(36)}`, projectId: sandbox.projectId, runId: sandbox.runId, argv: [], cwd: sandbox.workspaceRef, status: "failed", startedAt: new Date().toISOString(), error: "managed process not found" };
      const ev = evidence(sandbox.projectId, "FAIL", "managed process not found", action.tool, missing);
      return { ...output(sandbox, missing, ev, "none"), tool: action.tool, status: "failed", cost: 0.02, wallTimeMs: Date.now() - startedAt };
    }
    if (record.projectId !== sandbox.projectId || record.runId !== sandbox.runId) {
      const ev = evidence(sandbox.projectId, "FAIL", "managed process belongs to another project or run", action.tool, record);
      return { ...output(sandbox, record, ev, "none"), tool: action.tool, status: "failed", cost: 0.02, wallTimeMs: Date.now() - startedAt };
    }
    if (action.tool === "process.status" && (record.status === "running" || record.status === "starting") && record.pid) {
      try { process.kill(record.pid, 0); } catch { record.status = "exited"; record.endedAt = new Date().toISOString(); }
    }
    if (action.tool === "process.stop") {
      record.status = "stopped";
      if (record.containerId) await stopContainer(record.containerId);
      await terminatePid(record.pid ?? 0);
      children.get(record.id)?.kill();
      children.delete(record.id);
      record.endedAt = new Date().toISOString();
      const ev = evidence(sandbox.projectId, "PASS", `process.stop · ${record.id}`, "process.stop", record);
      return { ...output(sandbox, record, ev, "meaningful"), tool: action.tool, cost: 0.02, wallTimeMs: Date.now() - startedAt };
    }
    const ev = evidence(sandbox.projectId, record.status === "failed" ? "FAIL" : "PASS", `process.status · ${record.id} · ${record.status}`, "process.status", record);
    return { ...output(sandbox, record, ev, "meaningful"), tool: action.tool, cost: 0.02, wallTimeMs: Date.now() - startedAt };
  } catch (error: unknown) {
    const record: ManagedProcess = { id: `process-error-${Date.now().toString(36)}`, projectId: sandbox.projectId, runId: sandbox.runId, argv: [], cwd: sandbox.workspaceRef, status: "failed", startedAt: new Date().toISOString(), error: redactSecretLikeText(error instanceof Error ? error.message : "process manager failed") };
    const ev = evidence(sandbox.projectId, "FAIL", record.error ?? "process manager failed", action.tool, record);
    return { ...output(sandbox, record, ev, "none"), tool: action.tool, status: "failed", cost: 0.02, wallTimeMs: Date.now() - startedAt };
  }
}

export async function stopManagedProcess(processId: string): Promise<void> {
  const record = records.get(processId);
  if (!record || record.status === "exited" || record.status === "stopped" || record.status === "failed") return;
  record.status = "stopped";
  if (record.containerId) await stopContainer(record.containerId);
  await terminatePid(record.pid ?? 0);
  children.get(processId)?.kill();
  children.delete(processId);
  record.endedAt = new Date().toISOString();
}

export async function stopProcessesForRun(processes: ManagedProcess[], runId: string): Promise<void> {
  hydrateManagedProcesses(processes);
  await Promise.all(processes.filter((record) => record.runId === runId && (record.status === "starting" || record.status === "running")).map(async (record) => {
    if (records.has(record.id)) {
      await stopManagedProcess(record.id);
      const stopped = records.get(record.id);
      if (stopped) Object.assign(record, stopped);
    }
    else {
      await terminatePid(record.pid ?? 0);
      record.status = "stopped";
      record.endedAt = new Date().toISOString();
    }
  }));
}

export async function stopProcessesForProject(processes: ManagedProcess[], projectId: string): Promise<void> {
  hydrateManagedProcesses(processes);
  await Promise.all(processes.filter((record) => record.projectId === projectId && (record.status === "starting" || record.status === "running")).map(async (record) => {
    if (records.has(record.id)) {
      await stopManagedProcess(record.id);
      const stopped = records.get(record.id);
      if (stopped) Object.assign(record, stopped);
    } else {
      await terminatePid(record.pid ?? 0);
      record.status = "stopped";
      record.endedAt = new Date().toISOString();
    }
  }));
}

export async function stopAllManagedProcesses(): Promise<void> {
  await Promise.all([...records.values()].filter((record) => record.status === "starting" || record.status === "running").map((record) => stopManagedProcess(record.id)));
}

export function getManagedProcess(processId: string): ManagedProcess | undefined {
  const record = records.get(processId);
  return record ? { ...record, argv: [...record.argv] } : undefined;
}

async function stopContainer(name: string): Promise<void> {
  if (!/^process-[a-zA-Z0-9-]+$/.test(name)) return;
  try { await execFileAsync("docker", ["rm", "-f", name], { shell: false, windowsHide: true, timeout: 5_000 }); } catch { /* may already have exited */ }
}
