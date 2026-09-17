import { runCommand } from "./commandRunner";
import { OpenAICompatibleModelGateway } from "./openaiGateway";
export { OpenAICompatibleModelGateway } from "./openaiGateway";
import { ModelGatewayError, modelFailure } from "../src/modelFailure";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAllowedNetworkHost, isAllowedNetworkUrl, isDeveloperArgv, parseActionEnvelope, redactSecretLikeText, safeCommandIds, type SafeCommandId } from "../src/security";
import { MODEL_VERSION, TOOL_VERSION } from "../src/runtime";
import type { Evaluator, EvaluatorResult, ModelCapabilities, ModelGateway, ModelUsage, SandboxContext, SandboxManager, ToolGateway, ToolResult, WorldAdapter, WorldAdapterInput } from "../src/ports";
import type { ActionEnvelope, ContextPacket, Evidence, ModelCatalog, ModelCatalogEntry, ModelProviderStatus, Observation, ObservationSource, Project, ProjectSettings, ResolvedModelProvider, WorldSnapshot } from "../src/types";
import { normalizeWorkspacePath } from "./pathPolicy";
import { executeProcessTool } from "./processManager";
import { executeWorkspaceTool } from "./workspaceTools";
import { getRecommendedCodexModels } from "../src/modelCatalog";
import { CodexCliModelGateway, configuredCodexModel, inspectCodexCli } from "./codexCliGateway";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 120_000;
const maxOutputBytes = 256 * 1024;

function childProcessEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|REDIS_URL)/i.test(key)));
}

function modelCost(tokens: number): number {
  const safeTokens = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  const pricePerMillion = Number(process.env.MODEL_COST_PER_MILLION ?? "0");
  if (!Number.isFinite(pricePerMillion) || pricePerMillion < 0) return 0;
  return Number(((safeTokens / 1_000_000) * pricePerMillion).toFixed(4));
}

async function fetchAllowedNetwork(rawUrl: string, networkPolicy: Project["settings"]["networkPolicy"], allowedDomains: string[], init: RequestInit = {}): Promise<Response> {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!isAllowedNetworkHost(currentUrl, networkPolicy, allowedDomains)) throw new Error("network URL is outside the project allowlist");
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error("network redirect limit exceeded");
}

interface DatabaseTarget {
  host: string;
  port: number;
}

function databaseTarget(rawUrl: string | undefined): DatabaseTarget | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    const port = parsed.port ? Number(parsed.port) : 5432;
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return undefined;
  }
}

async function probeDatabaseEndpoint(target: DatabaseTarget): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe(reachable);
    };
    try {
      const socket = createConnection({ host: target.host, port: target.port });
      socket.setTimeout(3_000, () => { socket.destroy(); finish(false); });
      socket.once("connect", () => { socket.destroy(); finish(true); });
      socket.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function rawOutputPath(key: string, extension: "txt" | "html" | "png" = "txt"): { path: string; rawRef: string } {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const fileName = `${Date.now()}-${safeKey}.${extension}`;
  const directory = resolve(process.cwd(), process.env.INTENT_WORLD_RAW_DIR ?? ".data/raw");
  mkdirSync(directory, { recursive: true });
  return { path: resolve(directory, fileName), rawRef: `local-raw://${fileName}` };
}

function persistRawOutput(key: string, output: string, extension: "txt" | "html" = "txt"): string {
  const target = rawOutputPath(key, extension);
  writeFileSync(target.path, redactSecretLikeText(output).slice(0, maxOutputBytes), "utf8");
  return target.rawRef;
}

class BrowserAssertionError extends Error {}
class BrowserUnavailableError extends Error {}

interface BrowserProbe {
  output: string;
  title: string;
  screenshotRef?: string;
}

async function playwrightProbe(url: string, projectId: string, runId: string, networkPolicy: Project["settings"]["networkPolicy"], allowedDomains: string[], viewport = { width: 1280, height: 800 }, clickText?: string, expectedText?: string): Promise<BrowserProbe> {
  const { chromium } = await import("playwright");
  const configuredExecutable = process.env.SAKASAKA_BROWSER_EXECUTABLE?.trim();
  let executablePath: string | undefined;
  if (configuredExecutable && existsSync(configuredExecutable)) {
    executablePath = configuredExecutable;
  } else {
    try {
      const bundledExecutable = chromium.executablePath();
      if (bundledExecutable && existsSync(bundledExecutable)) executablePath = bundledExecutable;
    } catch {
      // A packaged sidecar may not have Playwright's downloaded browser.
    }
  }
  const launchOptions = { headless: true, ...(executablePath ? { executablePath } : {}) };
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error: unknown) {
    if (process.platform !== "win32" || process.env.SAKASAKA_BROWSER_EXECUTABLE?.trim()) throw new BrowserUnavailableError(error instanceof Error ? error.message : "브라우저 실행 실패");
    // Windows installations usually include Edge even when the hermetic
    // Playwright browser cannot be spawned by a packaged sidecar.
    try { browser = await chromium.launch({ headless: true, channel: "msedge" }); } catch (edgeError) { throw new BrowserUnavailableError(edgeError instanceof Error ? edgeError.message : "브라우저 실행 실패"); }
  }
  let browserContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    browserContext = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await browserContext.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (/^(?:about|data|blob):/i.test(requestUrl) || isAllowedNetworkHost(requestUrl, networkPolicy, allowedDomains)) return route.continue();
      return route.abort("blockedbyclient");
    });
    const page = await browserContext.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!isAllowedNetworkHost(page.url(), networkPolicy, allowedDomains)) throw new Error("browser redirect is outside the project allowlist");
    if (clickText) {
      await page.getByRole("button", { name: clickText }).click({ timeout: 10_000 });
      await page.waitForTimeout(50);
    }
    if (expectedText) {
      try { await page.getByText(expectedText, { exact: false }).first().waitFor({ state: "visible", timeout: 5_000 }); }
      catch { throw new BrowserAssertionError(`브라우저 단언 실패: ${expectedText}`); }
    }
    const title = await page.title();
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 4000);
    const screenshot = rawOutputPath(`${projectId}-${runId}-browser`, "png");
    await page.screenshot({ path: screenshot.path, fullPage: true });
    return { output: `Playwright ${viewport.width}x${viewport.height} · title=${title || "(untitled)"} · ${body} · screenshot=${screenshot.rawRef}`, title, screenshotRef: screenshot.rawRef };
  } finally {
    await browserContext?.close();
    await browser.close();
  }
}

function workspaceFor(input: WorldAdapterInput): string | undefined {
  const configured = normalizeWorkspacePath(input.project.settings.workspacePath);
  if (!configured) return undefined;
  try {
    return statSync(configured).isDirectory() ? resolve(configured) : undefined;
  } catch {
    return undefined;
  }
}

function observation(
  input: WorldAdapterInput,
  source: ObservationSource,
  compactView: string,
  rawRef: string,
  trustLevel: Observation["trustLevel"] = "observed",
  confidence = trustLevel === "verified" ? 0.98 : 0.78,
  status: Observation["status"] = trustLevel === "untrusted" ? "warning" : "healthy",
): Observation {
  return {
    id: `${input.project.id}-${source}-${Date.now().toString(36)}`,
    projectId: input.project.id,
    source,
    status,
    observedAt: new Date().toISOString(),
    freshness: "fresh",
    rawRef,
    compactView: redactSecretLikeText(compactView),
    trustLevel,
    confidence,
    relatedEntities: [input.run.id],
  };
}

async function safeExec(file: string, args: string[], cwd: string, signal?: AbortSignal) {
  return runCommand(file, args, { cwd, signal, timeoutMs: commandTimeoutMs, maxBytes: maxOutputBytes, env: childProcessEnv() });
}

export class RepoWorldAdapter implements WorldAdapter {
  source = "repo" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const workspace = workspaceFor(input);
    if (!workspace) return observation(input, this.source, "workspace is not bound", "repo://unbound", "untrusted", 0.2, "warning");
    // A child folder must not accidentally report its parent's repository.
    if (!existsSync(resolve(workspace, ".git"))) return observation(input, this.source, "작업 폴더는 존재하며 Git 저장소는 아직 초기화되지 않았습니다. 파일 생성이 가능한 정상 초기 상태입니다.", `repo://${workspace}/not-initialized`, "observed", 0.99, "absent");
    const result = await safeExec("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--short", "--branch"], workspace);
    const status = result.code === 0 ? result.stdout.trim() || "clean" : `${result.errorCode === "ENOENT" ? "GIT_BINARY_UNAVAILABLE" : "GIT_STATUS_FAILED"} · ${result.stderr.trim()}`;
    return observation(input, this.source, status.split("\n").slice(0, 8).join(" · "), `repo://${workspace}/git-status`, result.code === 0 ? "verified" : "untrusted", result.code === 0 ? 0.99 : 0.25, result.code === 0 ? "healthy" : "warning");
  }
}

export class RuntimeWorldAdapter implements WorldAdapter {
  source = "runtime" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const url = input.project.settings.previewUrl;
    if (!url) return observation(input, this.source, "미리보기 서버를 아직 시작하지 않았습니다.", "runtime://unconfigured", "observed", 1, "not-configured");
    if (!isAllowedNetworkUrl(input.project, url)) return observation(input, this.source, "preview URL blocked by the project network allowlist", "runtime://blocked-by-policy", "untrusted", 0.2, "warning");
    try {
      const response = await fetchAllowedNetwork(url, input.project.settings.networkPolicy, input.project.settings.allowedDomains ?? [], { signal: AbortSignal.timeout(10_000) });
      const body = (await response.text()).slice(0, 4000);
      return observation(input, this.source, `HTTP ${response.status} · ${response.ok ? "healthy" : "unhealthy"}`, persistRawOutput(`${input.project.id}-${input.run.id}-runtime`, body, "html"), response.ok ? "verified" : "observed", response.ok ? 0.96 : 0.6, response.ok ? "healthy" : "warning");
    } catch (error: unknown) {
      return observation(input, this.source, `preview unreachable · ${error instanceof Error ? error.message : "request failed"}`, "runtime://preview/unreachable", "untrusted", 0.25, "warning");
    }
  }
}

export class BrowserWorldAdapter implements WorldAdapter {
  source = "browser" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const url = input.project.settings.previewUrl;
    if (!url) return observation(input, this.source, "브라우저로 확인할 미리보기 주소가 아직 없습니다.", "browser://unconfigured", "observed", 1, "not-configured");
    if (!isAllowedNetworkUrl(input.project, url)) return observation(input, this.source, "browser target blocked by the project network allowlist", "browser://blocked-by-policy", "untrusted", 0.2, "warning");
    try {
      const probe = await playwrightProbe(url, input.project.id, input.run.id, input.project.settings.networkPolicy, input.project.settings.allowedDomains ?? []);
      const rawRef = persistRawOutput(`${input.project.id}-${input.run.id}-browser`, probe.output);
      return observation(input, this.source, `${probe.title ? `title=${probe.title} · ` : ""}${probe.output.slice(0, 260)}`, rawRef, "verified", 0.96, "healthy");
    } catch (error: unknown) {
      try {
        const response = await fetchAllowedNetwork(url, input.project.settings.networkPolicy, input.project.settings.allowedDomains ?? [], { signal: AbortSignal.timeout(10_000) });
        const contentType = response.headers.get("content-type") ?? "unknown content";
        const body = (await response.text()).slice(0, 4000);
        return observation(input, this.source, `HTTP ${response.status} · ${contentType} · Playwright unavailable, HTTP fallback`, persistRawOutput(`${input.project.id}-${input.run.id}-browser-fallback`, body, "html"), response.ok ? "observed" : "untrusted", response.ok ? 0.82 : 0.35, "warning");
      } catch (fallbackError: unknown) {
        return observation(input, this.source, `browser target unreachable · ${error instanceof Error ? error.message : fallbackError instanceof Error ? fallbackError.message : "request failed"}`, "browser://preview/unreachable", "untrusted", 0.2, "warning");
      }
    }
  }
}

export class DatabaseWorldAdapter implements WorldAdapter {
  source = "db" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const target = databaseTarget(process.env.DATABASE_URL);
    if (!target) return observation(input, this.source, process.env.DATABASE_URL ? "데이터베이스 주소 형식이 올바르지 않습니다." : "데이터베이스를 아직 연결하지 않았습니다. 제품에 필요한지는 별도 판단 대상입니다.", "db://unconfigured", "observed", 1, process.env.DATABASE_URL ? "warning" : "not-configured");
    const reachable = await probeDatabaseEndpoint(target);
    return observation(
      input,
      this.source,
      reachable ? `Postgres endpoint reachable · ${target.host}:${target.port} TCP health verified` : `Postgres endpoint unreachable · ${target.host}:${target.port}`,
      `db://${target.host}:${target.port}/tcp-health`,
      reachable ? "observed" : "untrusted",
      reachable ? 0.72 : 0.25,
      reachable ? "healthy" : "warning",
    );
  }
}

export class LogsWorldAdapter implements WorldAdapter {
  source = "logs" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const recent = input.state.events
      .filter((event) => event.projectId === input.project.id)
      .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))
      .slice(0, 4)
      .map((event) => event.type)
      .join(" · ");
    return observation(input, this.source, recent || "no events yet", `logs://${input.project.id}/recent`, "verified", 0.9);
  }
}

export class HumanWorldAdapter implements WorldAdapter {
  source = "human" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const open = input.state.humanItems.filter((item) => item.projectId === input.project.id && (item.status === "OPEN" || item.status === "DEFERRED"));
    const summary = open.length ? `${open.length} open item${open.length === 1 ? "" : "s"} · ${open.map((item) => item.id).join(" · ")}` : "all decisions resolved";
    return observation(input, this.source, summary, `human://${input.project.id}/open-items`, "verified", 0.99, open.length ? "warning" : "healthy");
  }
}

export function createLocalWorldAdapters(): WorldAdapter[] {
  return [new RepoWorldAdapter(), new RuntimeWorldAdapter(), new BrowserWorldAdapter(), new DatabaseWorldAdapter(), new LogsWorldAdapter(), new HumanWorldAdapter()];
}

function npmInvocation(args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file: "npm", args };
  const cli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? { file: process.execPath, args: [cli, ...args] } : { file: "npm.cmd", args };
}

export function commandSpec(commandId: SafeCommandId): { file: string; args: string[]; kind: Evidence["kind"]; label: string; cost: number } {
  switch (commandId) {
    case "repo-status": return { file: "git", args: ["status", "--short", "--branch"], kind: "world", label: "git status", cost: 0.02 };
    case "repo-diff": return { file: "git", args: ["diff", "--no-ext-diff", "--no-color", "--"], kind: "world", label: "git diff", cost: 0.04 };
    case "repo-diff-check": return { file: "git", args: ["diff", "--check"], kind: "test", label: "git diff --check", cost: 0.03 };
    case "quality-test": return { ...npmInvocation(["test", "--", "--run"]), kind: "test", label: "npm test", cost: 0.18 };
    case "quality-build": return { ...npmInvocation(["run", "build"]), kind: "test", label: "npm run build", cost: 0.24 };
    case "quality-build-api": return { ...npmInvocation(["run", "build:api"]), kind: "test", label: "npm run build:api", cost: 0.12 };
  }
}

export function estimateLocalActionCost(action: ActionEnvelope): number {
  if (action.type !== "ACT") return 0;
  if (action.tool === "browser.playwright" || action.tool === "playwright" || action.tool === "browser-observation") return 0.12;
  if (action.tool === "database.read") return 0.05;
  const commandId = action.params?.commandId;
  if (typeof commandId === "string" && (safeCommandIds as readonly string[]).includes(commandId)) return commandSpec(commandId as SafeCommandId).cost;
  return 0.2;
}

function dockerCommand(commandId: SafeCommandId): string[] {
  switch (commandId) {
    case "repo-status": return ["git", "status", "--short", "--branch"];
    case "repo-diff": return ["git", "diff", "--no-ext-diff", "--no-color", "--"];
    case "repo-diff-check": return ["git", "diff", "--check"];
    case "quality-test": return ["npm", "test", "--", "--run"];
    case "quality-build": return ["npm", "run", "build"];
    case "quality-build-api": return ["npm", "run", "build:api"];
  }
}

function outputSummary(output: string, label: string, success: boolean): string {
  const normalized = output.trim().replace(/\s+/g, " ");
  if (!normalized) return `${label} · ${success ? "PASS" : "FAIL"}`;
  const bounded = normalized.length <= 6_000 ? normalized : `${normalized.slice(0, 2_900)} … ${normalized.slice(-2_900)}`;
  return `${label} · ${success ? "PASS" : "FAIL"} · ${bounded}`;
}

export class LocalToolGateway implements ToolGateway {
  async execute(action: ActionEnvelope, sandbox: SandboxContext, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const tool = action.tool;
    if (action.type !== "ACT") {
      return { tool: tool ?? "none", toolVersion: TOOL_VERSION, status: "succeeded", outputRef: `tool://${sandbox.projectId}/noop`, summary: "no side effect for human-facing action", evidence: [], cost: 0, wallTimeMs: 0, output: "" };
    }
    const workspaceResult = await executeWorkspaceTool(action, sandbox, options);
    if (workspaceResult) return workspaceResult;
    const processResult = await executeProcessTool(action, sandbox, sandbox.processMaxLifetimeMs ?? Number(process.env.PROCESS_MAX_LIFETIME_MS ?? "1800000"), options);
    if (processResult) return processResult;
    if (tool === "browser.playwright") {
      const url = typeof action.params?.url === "string" ? action.params.url : undefined;
      if (!url) return this.blocked(sandbox, tool, "browser URL is required for a real browser probe", startedAt);
      if (!isAllowedNetworkHost(url, sandbox.networkPolicy, sandbox.allowedDomains)) return this.blocked(sandbox, tool, "browser host is outside the project allowlist", startedAt);
      try {
        const viewportWidth = typeof action.params?.viewportWidth === "number" && Number.isInteger(action.params.viewportWidth) ? Math.max(320, Math.min(4_000, action.params.viewportWidth)) : 1280;
        const viewportHeight = typeof action.params?.viewportHeight === "number" && Number.isInteger(action.params.viewportHeight) ? Math.max(240, Math.min(4_000, action.params.viewportHeight)) : 800;
        const clickText = typeof action.params?.clickText === "string" ? action.params.clickText.slice(0, 256) : undefined;
        const probe = await playwrightProbe(url, sandbox.projectId, sandbox.runId, sandbox.networkPolicy, sandbox.allowedDomains, { width: viewportWidth, height: viewportHeight }, clickText, typeof action.params?.expectedText === "string" ? action.params.expectedText : undefined);
        const rawRef = persistRawOutput(`${sandbox.projectId}-${sandbox.runId}-browser-result`, probe.output);
        const evidence: Evidence = { id: `evidence-tool-${Date.now().toString(36)}`, projectId: sandbox.projectId, kind: "browser", verdict: "PASS", summary: `브라우저 관찰 성공 · ${probe.title || "제목 없음"}${action.params?.expectedText ? " · 지정한 문자열 확인" : " · 제품 요구사항 전체를 검증한 결과는 아닙니다."}`, source: "playwright:local", createdAt: new Date().toISOString(), rawRef, evaluator: "local-deterministic-evaluator", evaluatorVersion: "local-evaluator-0.1" };
        const screenshotEvidence: Evidence | undefined = probe.screenshotRef ? { id: `evidence-tool-screenshot-${Date.now().toString(36)}`, projectId: sandbox.projectId, kind: "screenshot", verdict: "PASS", summary: "Playwright screenshot captured", source: "playwright:local", createdAt: new Date().toISOString(), rawRef: probe.screenshotRef, evaluator: "local-deterministic-evaluator", evaluatorVersion: "local-evaluator-0.1" } : undefined;
        return { tool, toolVersion: TOOL_VERSION, status: "succeeded", outputRef: `tool://${sandbox.projectId}/browser/${Date.now()}`, summary: outputSummary(probe.output, "Playwright browser probe", true), evidence: screenshotEvidence ? [evidence, screenshotEvidence] : [evidence], cost: 0.12, wallTimeMs: Date.now() - startedAt, output: redactSecretLikeText(probe.output) };
      } catch (error: unknown) {
        if (!(error instanceof BrowserUnavailableError)) {
          const detail = redactSecretLikeText(error instanceof Error ? error.message : "브라우저 관찰 실패");
          const rawRef = persistRawOutput(`${sandbox.projectId}-${sandbox.runId}-browser-assertion`, detail);
          return { tool, toolVersion: TOOL_VERSION, status: "failed", outputRef: rawRef, summary: detail, output: detail, cost: 0.12, wallTimeMs: Date.now() - startedAt, evidence: [{ id: `evidence-${crypto.randomUUID()}`, projectId: sandbox.projectId, kind: "browser", verdict: "FAIL", summary: detail, source: "playwright:assertion", rawRef, createdAt: new Date().toISOString() }] };
        }
        try {
          const response = await fetchAllowedNetwork(url, sandbox.networkPolicy, sandbox.allowedDomains, { signal: AbortSignal.timeout(10_000) });
          const body = await response.text();
          const output = `HTTP ${response.status} · ${body.slice(0, 4000)} · Playwright unavailable: ${redactSecretLikeText(error.message).slice(0, 2000)} · HTTP fallback`;
          const rawRef = persistRawOutput(`${sandbox.projectId}-${sandbox.runId}-browser-fallback`, output, "html");
          const evidence: Evidence = { id: `evidence-tool-${Date.now().toString(36)}`, projectId: sandbox.projectId, kind: "browser", verdict: response.ok ? "UNCERTAIN" : "FAIL", summary: `HTTP browser fallback ${response.status} · browser engine unavailable`, source: "local-http-browser-probe", createdAt: new Date().toISOString(), rawRef, evaluator: "local-deterministic-evaluator", evaluatorVersion: "local-evaluator-0.1", metadata: { browserEngine: "unavailable", httpTransport: true } };
          return { tool, toolVersion: TOOL_VERSION, status: response.ok ? "succeeded" : "failed", outputRef: `tool://${sandbox.projectId}/browser/${Date.now()}`, summary: outputSummary(output, "HTTP browser fallback · UNCERTAIN", response.ok), evidence: [evidence], cost: 0.08, wallTimeMs: Date.now() - startedAt, output: redactSecretLikeText(output) };
        } catch (fallbackError: unknown) {
          return { tool, toolVersion: TOOL_VERSION, status: "failed", outputRef: `tool://${sandbox.projectId}/browser/${Date.now()}`, summary: `browser probe failed · ${error instanceof Error ? error.message : fallbackError instanceof Error ? fallbackError.message : "request failed"}`, evidence: [], cost: 0.08, wallTimeMs: Date.now() - startedAt, output: "" };
        }
      }
    }

    if (tool === "database.read") {
      const operation = action.params?.operation;
      if (operation !== undefined && operation !== "health") return this.blocked(sandbox, tool, "database.read only exposes the health operation", startedAt);
      const target = databaseTarget(process.env.DATABASE_URL);
      const reachable = target ? await probeDatabaseEndpoint(target) : false;
      const targetLabel = target ? `${target.host}:${target.port}` : "unconfigured";
      const verdict = reachable ? "PASS" : "UNCERTAIN";
      const summary = reachable ? `Postgres endpoint reachable · ${targetLabel}` : `Postgres endpoint could not be verified · ${targetLabel}`;
      const evidence: Evidence = {
        id: `evidence-db-${Date.now().toString(36)}`,
        projectId: sandbox.projectId,
        kind: "world",
        verdict,
        summary,
        source: "database:tcp-health",
        createdAt: new Date().toISOString(),
        evaluator: "local-deterministic-evaluator",
        evaluatorVersion: "local-evaluator-0.1",
        metadata: { tcpReachable: reachable },
      };
      return { tool, toolVersion: TOOL_VERSION, status: "succeeded", outputRef: `tool://${sandbox.projectId}/database/${Date.now()}`, summary, evidence: [evidence], cost: 0.05, wallTimeMs: Date.now() - startedAt, output: redactSecretLikeText(summary) };
    }

    const commandId = action.params?.commandId;
    const safeCommand = typeof commandId === "string" && (safeCommandIds as readonly string[]).includes(commandId) ? commandId as SafeCommandId : undefined;
    const developerArgv = sandbox.mode === "docker" && isDeveloperArgv(action.params?.argv) ? action.params.argv : undefined;
    if (!safeCommand && !developerArgv) return this.blocked(sandbox, tool ?? "missing", "commandId is not in the fixed local allowlist or Docker argv is invalid", startedAt);
    if (tool === "repo.read" && safeCommand !== "repo-status" && safeCommand !== "repo-diff" && safeCommand !== "repo-diff-check") return this.blocked(sandbox, tool, "repo.read only exposes status, diff, and diff-check commands", startedAt);
    if (tool !== "shell.sandbox" && tool !== "repo.read") return this.blocked(sandbox, tool ?? "missing", "command execution is not exposed by this tool", startedAt);
    if (tool === "repo.read" && !existsSync(resolve(sandbox.workspaceRef, ".git"))) {
      const summary = "Git 저장소가 아직 초기화되지 않았습니다. 작업 폴더의 파일 읽기·쓰기는 가능합니다.";
      const rawRef = persistRawOutput(`${sandbox.projectId}-git-absent`, summary);
      const ev: Evidence = { id: `evidence-${crypto.randomUUID()}`, projectId: sandbox.projectId, kind: "world", verdict: "PASS", summary, source: "repo:not-initialized", rawRef, createdAt: new Date().toISOString() };
      return { tool, toolVersion: TOOL_VERSION, status: "succeeded", outputRef: rawRef, summary, evidence: [ev], output: summary, cost: 0.02, wallTimeMs: Date.now() - startedAt, observations: [{ id: `observation-${crypto.randomUUID()}`, projectId: sandbox.projectId, source: "repo", status: "absent", observedAt: new Date().toISOString(), freshness: "fresh", rawRef, compactView: summary, trustLevel: "observed", confidence: 1, relatedEntities: [sandbox.runId] }] };
    }
    const spec = safeCommand ? commandSpec(safeCommand) : undefined;
    const commandArgv = developerArgv ?? dockerCommand(safeCommand!);
    const command = sandbox.mode === "docker" ? ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--cpus", "1", "--pids-limit", "128", "--memory", "1g", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-v", `${sandbox.workspaceRef}:/workspace:rw`, "-w", "/workspace", sandbox.image ?? process.env.SANDBOX_IMAGE ?? "node:22-alpine", ...commandArgv] : undefined;
    const result = command ? await safeExec("docker", command, sandbox.workspaceRef, options.signal) : await safeExec(spec!.file, spec!.args, sandbox.workspaceRef, options.signal);
    const output = redactSecretLikeText([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, maxOutputBytes);
    const commandLabel = safeCommand ? commandSpec(safeCommand).label : `Docker ${developerArgv?.join(" ") ?? "developer command"}`;
    const rawRef = persistRawOutput(`${sandbox.projectId}-${sandbox.runId}-${safeCommand ?? "docker-developer"}`, output);
    const success = result.code === 0;
    const evidence: Evidence = {
      id: `evidence-tool-${Date.now().toString(36)}`,
      projectId: sandbox.projectId,
      kind: spec?.kind ?? "test",
      verdict: success ? "PASS" : "FAIL",
      summary: outputSummary(output, commandLabel, success),
      source: safeCommand ? `local-command:${safeCommand}` : "docker:developer-argv",
      createdAt: new Date().toISOString(),
      rawRef,
      evaluator: "local-deterministic-evaluator",
      evaluatorVersion: "local-evaluator-0.1",
      metadata: { exitCode: result.code, allowlisted: Boolean(safeCommand), sandbox: sandbox.mode ?? "process" },
    };
    return {
      tool: tool ?? "shell.sandbox",
      toolVersion: TOOL_VERSION,
      status: success ? "succeeded" : "failed",
      outputRef: `tool://${sandbox.projectId}/${sandbox.runId}/${safeCommand ?? "docker-developer"}/${Date.now()}`,
      summary: outputSummary(output, commandLabel, success),
      evidence: [evidence],
      cost: spec?.cost ?? 0.2,
      wallTimeMs: Date.now() - startedAt,
      output,
    };
  }

  private blocked(sandbox: SandboxContext, tool: string, reason: string, startedAt: number): ToolResult {
    return { tool, toolVersion: TOOL_VERSION, status: "blocked", outputRef: `tool://${sandbox.projectId}/blocked/${Date.now()}`, summary: `BLOCKED · ${reason}`, evidence: [], cost: 0, wallTimeMs: Date.now() - startedAt, blockedReason: reason, output: "" };
  }
}

export class DeterministicLocalModelGateway implements ModelGateway {
  private readonly usageByRun = new Map<string, ModelUsage>();

  async decide(context: ContextPacket): Promise<ActionEnvelope> {
    const startedAt = Date.now();
    const rememberUsage = () => this.usageByRun.set(context.runId ?? context.projectId, { modelVersion: MODEL_VERSION, tokens: 0, cost: 0, latencyMs: Date.now() - startedAt });
    const shell = context.toolSurface.find((tool) => tool.name === "shell.sandbox" && tool.enabled);
    const repo = context.toolSurface.find((tool) => tool.name === "repo.read" && tool.enabled);
    const hasBlockingHumanScope = context.openHumanItemViews?.some((item) => item.blockingScope.length > 0) ?? false;
    const hasCleanPriorVerification = context.relevantExperienceViews?.some((experience) => /pass|healthy|verified/i.test(experience.outcome) && !/fail|uncertain/i.test(experience.outcome)) ?? false;
    if (hasBlockingHumanScope && hasCleanPriorVerification) {
      rememberUsage();
      return { type: "WAIT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: "독립 범위의 현재 evidence는 충분하고 human-owned scope의 결정을 기다림", expectedValue: 0.02, riskClass: "P0", evidencePlan: ["human", "world"] };
    }
    const budgetExhausted = context.boundary.resourceLimits !== "unlimited" && (context.boundary.remainingBudget ?? 0) <= 0;
    if (budgetExhausted || (!shell && !repo)) {
      rememberUsage();
      return { type: "WAIT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: budgetExhausted ? "bounded budget이 소진되어 대기" : "사용 가능한 local capability가 없어 대기", expectedValue: 0, riskClass: "P0", evidencePlan: ["world"] };
    }
    const action: ActionEnvelope = {
      type: "ACT",
      intentRef: context.intentRef,
      worldCursor: context.worldCursor,
      rationaleSummary: "실제 workspace의 quality gate를 실행하고 결과를 evidence로 확인",
      tool: shell ? "shell.sandbox" : "repo.read",
      params: { commandId: shell ? "quality-test" : "repo-status" },
      expectedValue: 0.72,
      riskClass: shell ? "P1" : "P0",
      evidencePlan: ["test", "world"],
    };
    rememberUsage();
    return action;
  }

  async capabilities(): Promise<ModelCapabilities> {
    return { modelVersion: MODEL_VERSION, supportsStructuredActions: true, contextWindow: 16_000, reasoningModes: ["deterministic-ranking"] };
  }

  async usage(runId: string): Promise<ModelUsage> {
    return this.usageByRun.get(runId) ?? { modelVersion: MODEL_VERSION, tokens: 0, cost: 0, latencyMs: 0 };
  }
}

export class UnavailableModelGateway implements ModelGateway {
  constructor(private readonly reason: string) {}

  async decide(context: ContextPacket): Promise<ActionEnvelope> {
    throw new ModelGatewayError(modelFailure("PROVIDER_UNAVAILABLE", this.reason, false));
  }

  async capabilities(): Promise<ModelCapabilities> {
    return { modelVersion: "unavailable", supportsStructuredActions: false, contextWindow: 0, reasoningModes: [] };
  }

  async usage(_runId: string): Promise<ModelUsage> {
    return { modelVersion: "unavailable", tokens: 0, cost: 0, latencyMs: 0, usageKnown: false };
  }
}

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function getCodexModelCatalog(): ModelCatalog {
  const configured = (process.env.CODEX_CLI_MODELS ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => modelIdPattern.test(value));
  const configuredDefault = configuredCodexModel();
  const defaultModel = configuredDefault && modelIdPattern.test(configuredDefault) ? configuredDefault : undefined;
  const recommended = getRecommendedCodexModels();
  const configuredEntries: ModelCatalogEntry[] = configured.map((id) => ({ id, label: recommended.find((model) => model.id === id)?.label ?? id, group: recommended.some((model) => model.id === id) ? "recommended" : "configured" }));
  const baseEntries = configured.length > 0 ? configuredEntries : recommended;
  const models = [...new Set([...baseEntries.map((entry) => entry.id), ...(defaultModel && !baseEntries.some((entry) => entry.id === defaultModel) ? [defaultModel] : [])])].slice(0, 64);
  const entries = models.map((id) => baseEntries.find((entry) => entry.id === id) ?? recommended.find((entry) => entry.id === id) ?? { id, label: id, group: "configured" as const });
  return { models, defaultModel, entries };
}

type ModelSettingsSource = { settings: Pick<ProjectSettings, "modelProvider" | "modelName"> };

function projectModelName(project: ModelSettingsSource | undefined): string | undefined {
  const value = project?.settings.modelName?.trim();
  return value && modelIdPattern.test(value) ? value : undefined;
}

export function resolveModelProvider(project: ModelSettingsSource): ResolvedModelProvider {
  const requested = project.settings.modelProvider ?? "auto";
  const configuredEndpoint = process.env.MODEL_API_URL?.trim();
  const endpoint = configuredEndpoint && isSafeModelEndpoint(configuredEndpoint) ? configuredEndpoint : undefined;
  const apiKey = process.env.MODEL_API_KEY?.trim();
  if (requested === "deterministic") return "deterministic";
  if (requested === "codex-cli") return "codex-cli";
  if (requested === "openai-compatible") return endpoint && apiKey ? "openai-compatible" : "unavailable";
  if (endpoint && apiKey) return "openai-compatible";
  if (codexCliEnabled()) return "codex-cli";
  return "unavailable";
}

export async function inspectModelProvider(project?: ModelSettingsSource): Promise<ModelProviderStatus> {
  const requested = project?.settings.modelProvider ?? "auto";
  const effective = resolveModelProvider(project ?? { settings: { modelProvider: requested } });
  const checkedAt = new Date().toISOString();
  const projectModel = projectModelName(project);
  if (effective === "deterministic") {
    return { requested, effective, state: "connected", displayName: "결정론적 연구 기준선", detail: "외부 AI가 아닌 로컬 결정론적 게이트웨이입니다. 실제 AI 연결로 표시하지 않습니다.", selectedModel: projectModel, availableModels: [], authentication: "not-applicable", checkedAt };
  }
  if (effective === "openai-compatible") {
    const endpoint = process.env.MODEL_API_URL?.trim() ?? "";
    return { requested, effective, state: "configured", displayName: requested === "auto" ? "OpenAI 호환 API · 자동 선택" : "OpenAI 호환 API", detail: `엔드포인트와 API 키 설정을 확인했습니다. 실제 인증·응답은 첫 인지 주기에서 검증됩니다. (${endpoint})`, selectedModel: projectModel ?? (process.env.MODEL_NAME?.trim() || undefined), availableModels: [], authentication: "configured", checkedAt };
  }
  if (effective === "codex-cli") {
    const diagnostics = await inspectCodexCli();
    const catalog = getCodexModelCatalog();
    const selectedModel = projectModel ?? catalog.defaultModel;
    const availableModels = selectedModel && !catalog.models.includes(selectedModel) ? [selectedModel, ...catalog.models] : catalog.models;
    return {
      requested,
      effective,
      state: !diagnostics.installed ? "unavailable" : diagnostics.authentication === "verified" ? "configured" : "unknown",
      displayName: requested === "auto" ? "Codex CLI · 자동 선택" : "Codex CLI",
      detail: diagnostics.detail,
      selectedModel,
      availableModels,
      binary: diagnostics.binary,
      version: diagnostics.version,
      authentication: diagnostics.authentication,
      checkedAt,
    };
  }
  const configuredEndpoint = process.env.MODEL_API_URL?.trim();
  const detail = requested === "openai-compatible" && configuredEndpoint && !isSafeModelEndpoint(configuredEndpoint)
    ? "MODEL_API_URL은 사용자명·비밀번호가 없는 http/https URL이어야 합니다."
    : "실제 모델 provider가 설정되지 않았습니다. OpenAI 호환 API 또는 Codex CLI를 설정하세요.";
  return { requested, effective, state: "needs-setup", displayName: "사용 가능한 모델 없음", detail, selectedModel: projectModel, availableModels: [], authentication: "missing", checkedAt };
}

export function createModelGateway(project: Project): ModelGateway {
  const configuredEndpoint = process.env.MODEL_API_URL?.trim();
  const endpoint = configuredEndpoint && isSafeModelEndpoint(configuredEndpoint) ? configuredEndpoint : undefined;
  const apiKey = process.env.MODEL_API_KEY?.trim();
  switch (resolveModelProvider(project)) {
    case "deterministic":
      return new DeterministicLocalModelGateway();
    case "codex-cli":
      return new CodexCliModelGateway({ model: projectModelName(project) });
    case "openai-compatible":
      return new OpenAICompatibleModelGateway(endpoint as string, apiKey as string, projectModelName(project));
    case "unavailable":
    default:
      return new UnavailableModelGateway(configuredEndpoint && !endpoint ? "MODEL_API_URL은 http/https URL이며 사용자명·비밀번호를 포함하지 않아야 합니다." : "MODEL_API_URL과 MODEL_API_KEY가 설정되지 않았습니다.");
  }
}

function codexCliEnabled(): boolean {
  const flag = process.env.CODEX_CLI_ENABLED?.trim().toLowerCase();
  if (flag === "false") return false;
  return flag === "true" || Boolean(process.env.CODEX_CLI_BIN?.trim());
}

function isSafeModelEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export class DeterministicEvaluator implements Evaluator {
  async evaluate(claim: string, evidence: Evidence[], _world: WorldSnapshot): Promise<EvaluatorResult> {
    if (!evidence.length) return { verdict: "UNCERTAIN", summary: `evaluator could not verify: ${claim}`, evidenceRefs: [], evaluatorVersion: "local-evaluator-0.1" };
    if (evidence.some((item) => item.verdict === "FAIL")) return { verdict: "FAIL", summary: `evidence reports failure: ${claim}`, evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "local-evaluator-0.1" };
    if (evidence.some((item) => item.verdict === "UNCERTAIN")) return { verdict: "UNCERTAIN", summary: `evidence is incomplete: ${claim}`, evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "local-evaluator-0.1" };
    return { verdict: "PASS", summary: "도구 실행 증거가 성공했습니다. 제품 목표·모델의 설명 자체를 검증한 결과는 아닙니다.", evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "tool-evidence-0.2" };
  }
}

export class LocalSandboxManager implements SandboxManager {
  async create(project: import("../src/types").Project, run: import("../src/types").Run): Promise<SandboxContext> {
    const workspaceRef = normalizeWorkspacePath(project.settings.workspacePath);
    if (!workspaceRef || !existsSync(workspaceRef)) throw new Error("project workspace is not provisioned");
    return {
      projectId: project.id,
      runId: run.id,
      permissionClass: "P1",
      networkPolicy: project.settings.networkPolicy,
      allowedDomains: project.settings.allowedDomains ?? [],
      workspaceRef,
      sandboxId: `process-sandbox-${project.id}-${run.id}`,
      createdAt: new Date().toISOString(),
      mode: "process",
      processMaxLifetimeMs: project.settings.processMaxLifetimeMs,
      maxConcurrentProcesses: project.settings.maxConcurrentProcesses,
    };
  }

  async destroy(_sandbox: SandboxContext): Promise<void> {}
  async kill(_sandbox: SandboxContext): Promise<void> {}
}

export class DockerSandboxManager extends LocalSandboxManager {
  async create(project: Project, run: import("../src/types").Run): Promise<SandboxContext> {
    const sandbox = await super.create(project, run);
    return { ...sandbox, mode: "docker", image: process.env.SANDBOX_IMAGE ?? "node:22-alpine", sandboxId: `docker-sandbox-${project.id}-${run.id}` };
  }
}

export class InMemoryMemoryService {
  async retrieve(context: import("../src/types").ContextPacket): Promise<string[]> { return [...context.experienceRefs]; }
  async consolidate(_projectId: string): Promise<void> {}
}

export function localWorkspaceExists(project: import("../src/types").Project): boolean {
  const workspace = normalizeWorkspacePath(project.settings.workspacePath);
  return Boolean(workspace && existsSync(workspace));
}
