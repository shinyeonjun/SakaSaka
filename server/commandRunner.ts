import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export interface CommandResult { code: number; stdout: string; stderr: string; errorCode?: string; cancelled?: boolean; timedOut?: boolean }

/** Windows .cmd files are not executables. Invoke npm's JS entry without a shell. */
export function executableInvocation(file: string, args: readonly string[]): { file: string; args: string[] } {
  if (process.platform !== "win32" || !["npm", "npm.cmd"].includes(file.toLowerCase())) return { file, args: [...args] };
  const configured = process.env.npm_execpath;
  const candidates = [
    ...(configured?.endsWith("npm-cli.js") ? [configured] : []),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) throw new Error("npm-cli.js를 찾지 못했습니다. Node.js/npm 설치와 PATH를 확인하십시오.");
  return { file: process.env.SAKASAKA_NODE_BIN || ("pkg" in process ? "node" : process.execPath), args: [resolve(cli), ...args] };
}

/** Best-effort process-tree stop. A PID is accepted only from our process registry. */
export function stopProcessTree(pid: number, force = false): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, shell: false, timeout: 5_000 }, () => undefined);
  } else {
    try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ } }
  }
}

/** Bounded one-shot command. No string-shell parsing; cancellation reaches children. */
export async function runCommand(file: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }): Promise<CommandResult> {
  if (options.signal?.aborted) return { code: 1, stdout: "", stderr: "명령 실행 전에 취소되었습니다.", cancelled: true };
  const dockerName = file === "docker" && args[0] === "run" && !args.includes("--name") ? `sakasaka-command-${randomUUID()}` : undefined;
  const commandArgs = dockerName ? ["run", "--name", dockerName, ...args.slice(1)] : args;
  const invocation = executableInvocation(file, commandArgs);
  return new Promise((resolveResult) => {
    const child = spawn(invocation.file, invocation.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    let stdout = "", stderr = "", bytes = 0, settled = false, cancelled = false, timedOut = false;
    let errorCode: string | undefined, escalation: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      const result = { code, stdout: stdout + out.end(), stderr: stderr + err.end(), errorCode, cancelled, timedOut };
      if (dockerName && code !== 0) execFile("docker", ["rm", "-f", dockerName], { shell: false, windowsHide: true, timeout: 5_000 }, () => resolveResult(result));
      else resolveResult(result);
    };
    const stop = (reason: string) => {
      if (settled || escalation) return;
      stderr += `\n${reason}`;
      if (child.pid) stopProcessTree(child.pid);
      escalation = setTimeout(() => { if (child.pid) stopProcessTree(child.pid, true); finish(1); }, 1_000);
    };
    const abort = () => { cancelled = true; stop("명령 실행이 취소되었습니다."); };
    const timeout = setTimeout(() => { timedOut = true; stop("명령 실행 시간이 초과되었습니다."); }, options.timeoutMs ?? 120_000);
    const append = (chunk: Buffer, stdoutStream: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > (options.maxBytes ?? 262_144)) { errorCode = "OUTPUT_LIMIT"; stop("명령 출력 한도를 초과했습니다."); return; }
      if (stdoutStream) stdout += out.write(chunk); else stderr += err.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, false));
    child.once("error", (error: NodeJS.ErrnoException) => { errorCode = error.code; stderr += error.message; finish(1); });
    child.once("close", (code) => finish(cancelled || timedOut || errorCode ? 1 : code ?? 1));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
