import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { stopProcessTree } from "./commandRunner";
import { redactSecretLikeText } from "../src/security";

export type RpcRecord = Record<string, unknown>;
export interface AppServerClient {
  start(): Promise<void>;
  request(method: string, params: RpcRecord): Promise<unknown>;
  onNotification(listener: (method: string, params: RpcRecord) => void): void;
  onRequest(listener: (method: string, params: RpcRecord) => Promise<unknown>): void;
  closed: Promise<Error>;
  close(): Promise<void>;
}

export interface AppServerOptions {
  binary?: string;
  /** Explicit launcher arguments, also used by contract tests. Never passed by the model. */
  prefix?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

/** Protocol pinned/tested against Codex 0.154.0; dynamicTools are experimental. */
export class CodexAppServer implements AppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private notify: (method: string, params: RpcRecord) => void = () => undefined;
  private serverRequest: (method: string, params: RpcRecord) => Promise<unknown> = async () => { throw new Error("Unsupported server request"); };
  private writeQueue = Promise.resolve();
  private exitError?: Error;
  private stderr = "";
  private resolveClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>((resolve) => { this.resolveClosed = resolve; });

  constructor(private readonly options: AppServerOptions) {}
  onNotification(listener: (method: string, params: RpcRecord) => void): void { this.notify = listener; }
  onRequest(listener: (method: string, params: RpcRecord) => Promise<unknown>): void { this.serverRequest = listener; }

  async start(): Promise<void> {
    if (this.child || this.exitError) throw new Error("App Server client is not reusable");
    const binary = this.options.binary ?? process.env.CODEX_CLI_BIN?.trim() ?? (process.platform === "win32" ? "codex.exe" : "codex");
    const env = this.options.env ?? nativeCliEnvironment();
    this.child = spawn(binary, [...(this.options.prefix ?? []), "app-server", "--listen", "stdio://", "-c", 'web_search="disabled"', "-c", "shell_environment_policy.inherit=none",
      "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.hooks=false",
      "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "features.in_app_browser=false"], {
      cwd: this.options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let partial = "", bytes = 0;
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024 * 1024) { this.fail(new Error("App Server 이벤트 출력 한도를 초과했습니다.")); void this.close(); return; }
      partial += decoder.write(chunk);
      let newline: number;
      while ((newline = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
        if (Buffer.byteLength(line) > (this.options.maxLineBytes ?? 2 * 1024 * 1024)) { this.fail(new Error("App Server 메시지 크기 초과")); void this.close(); return; }
        if (line.trim()) this.receive(line);
      }
      if (Buffer.byteLength(partial) > (this.options.maxLineBytes ?? 2 * 1024 * 1024)) { this.fail(new Error("App Server 메시지 크기 초과")); void this.close(); }
    });
    const stderrDecoder = new StringDecoder("utf8");
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + stderrDecoder.write(chunk)).slice(-16_384); });
    this.child.once("error", (error) => this.fail(new Error(`Codex App Server 실행 실패: ${error.message}`)));
    this.child.once("close", (code) => this.fail(new Error(`Codex App Server 종료 (${code ?? "signal"}): ${redactSecretLikeText(this.stderr).slice(-2000)}`)));
    this.child.stdin.on("error", (error) => this.fail(error));
    await this.request("initialize", { clientInfo: { name: "sakasaka", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    await this.send({ method: "initialized", params: {} });
  }

  request(method: string, params: RpcRecord): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (!this.child) return Promise.reject(new Error("App Server가 시작되지 않았습니다."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App Server ${method} 응답 시간 초과`)); }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private receive(line: string): void {
    try {
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid object");
      const value = message as RpcRecord;
      if (typeof value.method === "string") {
        const params = asRecord(value.params);
        if (typeof value.id === "string" || typeof value.id === "number") {
          // Do not await here: server calls and responses are bidirectional and interleaved.
          void this.serverRequest(value.method, params).then(
            (result) => this.send({ id: value.id, result }),
            (error: unknown) => this.send({ id: value.id, error: { code: -32602, message: redactSecretLikeText(error instanceof Error ? error.message : "요청 처리 실패").slice(0, 2000) } }),
          ).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
        } else this.notify(value.method, params);
      } else if (typeof value.id === "number") {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.error) pending.reject(new Error(redactSecretLikeText(String(asRecord(value.error).message ?? "RPC 오류"))));
        else pending.resolve(value.result);
      }
    } catch (error: unknown) {
      this.fail(new Error(`Codex JSON-RPC 형식 오류: ${error instanceof Error ? error.message : "invalid JSON"}`));
      void this.close();
    }
  }

  private send(value: RpcRecord): Promise<void> {
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) return Promise.reject(new Error("App Server 요청 크기 초과"));
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.exitError || !this.child || this.child.stdin.destroyed) throw this.exitError ?? new Error("App Server 연결 종료");
      if (!this.child.stdin.write(line, "utf8")) await once(this.child.stdin, "drain");
    });
    return this.writeQueue;
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.resolveClosed(error);
  }

  async close(): Promise<void> {
    // Reject outstanding work before ending stdin. Otherwise an already queued
    // request races stdin.end() and leaks a misleading write-after-end error.
    this.fail(new Error("App Server 연결을 닫았습니다."));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let timer: NodeJS.Timeout | undefined;
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    child.once("close", finish);
    child.stdin.end();
    if (child.pid) stopProcessTree(child.pid);
    timer = setTimeout(() => {
      if (child.pid && child.exitCode === null && child.signalCode === null) stopProcessTree(child.pid, true);
      finish();
    }, 1500);
    try { await stopped; } finally { clearTimeout(timer); child.off("close", finish); }
  }
}

export function asRecord(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

export function nativeCliEnvironment(): NodeJS.ProcessEnv {
  // Provider authentication belongs to the CLI, never to model messages or child shell env.
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|REDIS_URL)/i.test(key)));
  if (process.env.SAKASAKA_CODEX_HOME?.trim()) safe.CODEX_HOME = process.env.SAKASAKA_CODEX_HOME.trim();
  if (process.env.CODEX_API_KEY) safe.CODEX_API_KEY = process.env.CODEX_API_KEY;
  return safe;
}

/** Fail closed instead of silently inheriting external tool authority. */
export function checkNativeConfig(config: RpcRecord): string | undefined {
  const servers = asRecord(config.mcp_servers);
  if (Object.values(servers).some((value) => asRecord(value).enabled !== false)) return "Native 모드에서는 외부 MCP가 활성화된 Codex 설정을 상속하지 않습니다. 외부 MCP를 끈 전용 Codex 설정을 사용하십시오.";
  for (const key of ["hooks", "notify"]) {
    const value = config[key];
    if (value && (Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : true)) return `Native 모드 전용 Codex 설정에서 ${key} 외부 실행을 제거하십시오.`;
  }
  return undefined;
}
