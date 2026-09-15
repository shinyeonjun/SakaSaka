import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecretLikeText, safeCommandIds, type SafeCommandId } from "../src/security";
import { MODEL_VERSION, TOOL_VERSION } from "../src/runtime";
import type { Evaluator, EvaluatorResult, ModelCapabilities, ModelGateway, ModelUsage, SandboxContext, SandboxManager, ToolGateway, ToolResult, WorldAdapter, WorldAdapterInput } from "../src/ports";
import type { ActionEnvelope, Evidence, Observation, ObservationSource, WorldSnapshot } from "../src/types";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 120_000;
const maxOutputBytes = 256 * 1024;

function workspaceFor(input: WorldAdapterInput): string | undefined {
  const configured = input.project.settings.workspacePath;
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
): Observation {
  return {
    id: `${input.project.id}-${source}-${Date.now().toString(36)}`,
    projectId: input.project.id,
    source,
    observedAt: new Date().toISOString(),
    freshness: "fresh",
    rawRef,
    compactView: redactSecretLikeText(compactView),
    trustLevel,
    confidence,
    relatedEntities: [input.run.id],
  };
}

async function safeExec(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      timeout: commandTimeoutMs,
      windowsHide: true,
      maxBuffer: maxOutputBytes,
      shell: false,
    });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error: unknown) {
    const candidate = error as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
    return {
      code: typeof candidate.code === "number" ? candidate.code : 1,
      stdout: String(candidate.stdout ?? ""),
      stderr: String(candidate.stderr ?? (candidate.killed ? "command timed out" : "command failed")),
    };
  }
}

export class RepoWorldAdapter implements WorldAdapter {
  source = "repo" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const workspace = workspaceFor(input);
    if (!workspace) return observation(input, this.source, "workspace is not bound", "repo://unbound", "untrusted", 0.2);
    const result = await safeExec("git", ["status", "--short", "--branch"], workspace);
    const status = result.code === 0 ? result.stdout.trim() || "clean" : `git unavailable · ${result.stderr.trim()}`;
    return observation(input, this.source, status.split("\n").slice(0, 8).join(" · "), `repo://${workspace}/git-status`, result.code === 0 ? "verified" : "untrusted", result.code === 0 ? 0.99 : 0.25);
  }
}

export class RuntimeWorldAdapter implements WorldAdapter {
  source = "runtime" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const url = input.project.settings.previewUrl;
    if (!url) return observation(input, this.source, "preview URL is not configured", "runtime://unconfigured", "observed", 0.45);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return observation(input, this.source, `HTTP ${response.status} · ${response.ok ? "healthy" : "unhealthy"}`, "runtime://preview/health", response.ok ? "verified" : "observed", response.ok ? 0.96 : 0.6);
    } catch (error: unknown) {
      return observation(input, this.source, `preview unreachable · ${error instanceof Error ? error.message : "request failed"}`, "runtime://preview/unreachable", "untrusted", 0.25);
    }
  }
}

export class BrowserWorldAdapter implements WorldAdapter {
  source = "browser" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const url = input.project.settings.previewUrl;
    if (!url) return observation(input, this.source, "browser target is not configured", "browser://unconfigured", "untrusted", 0.2);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const contentType = response.headers.get("content-type") ?? "unknown content";
      return observation(input, this.source, `HTTP ${response.status} · ${contentType} · HTTP probe (DOM runner not configured)`, "browser://preview/http-probe", response.ok ? "observed" : "untrusted", response.ok ? 0.82 : 0.35);
    } catch (error: unknown) {
      return observation(input, this.source, `browser target unreachable · ${error instanceof Error ? error.message : "request failed"}`, "browser://preview/unreachable", "untrusted", 0.2);
    }
  }
}

export class DatabaseWorldAdapter implements WorldAdapter {
  source = "db" as const;

  async observe(input: WorldAdapterInput): Promise<Observation> {
    const configured = Boolean(process.env.DATABASE_URL);
    return observation(input, this.source, configured ? "DATABASE_URL configured · connectivity requires DB adapter" : "database is not configured", configured ? "db://configured/redacted" : "db://unconfigured", configured ? "observed" : "untrusted", configured ? 0.65 : 0.25);
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
    const open = input.state.humanItems.filter((item) => item.projectId === input.project.id && item.status === "OPEN");
    const summary = open.length ? `${open.length} open item${open.length === 1 ? "" : "s"} · ${open.map((item) => item.id).join(" · ")}` : "all decisions resolved";
    return observation(input, this.source, summary, `human://${input.project.id}/open-items`, "verified", 0.99);
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

function commandSpec(commandId: SafeCommandId): { file: string; args: string[]; kind: Evidence["kind"]; label: string; cost: number } {
  switch (commandId) {
    case "repo-status": return { file: "git", args: ["status", "--short", "--branch"], kind: "world", label: "git status", cost: 0.02 };
    case "repo-diff-check": return { file: "git", args: ["diff", "--check"], kind: "test", label: "git diff --check", cost: 0.03 };
    case "quality-test": return { ...npmInvocation(["test", "--", "--run"]), kind: "test", label: "npm test", cost: 0.18 };
    case "quality-build": return { ...npmInvocation(["run", "build"]), kind: "test", label: "npm run build", cost: 0.24 };
    case "quality-build-api": return { ...npmInvocation(["run", "build:api"]), kind: "test", label: "npm run build:api", cost: 0.12 };
  }
}

function outputSummary(output: string, label: string, success: boolean): string {
  const normalized = output.trim().replace(/\s+/g, " ");
  if (!normalized) return `${label} · ${success ? "PASS" : "FAIL"}`;
  return `${label} · ${success ? "PASS" : "FAIL"} · ${normalized.slice(-180)}`;
}

export class LocalToolGateway implements ToolGateway {
  async execute(action: ActionEnvelope, sandbox: SandboxContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = action.tool;
    if (action.type !== "ACT") {
      return { tool: tool ?? "none", toolVersion: TOOL_VERSION, status: "succeeded", outputRef: `tool://${sandbox.projectId}/noop`, summary: "no side effect for human-facing action", evidence: [], cost: 0, wallTimeMs: 0, output: "" };
    }
    if (tool === "browser.playwright") {
      const url = typeof action.params?.url === "string" ? action.params.url : undefined;
      if (!url) return this.blocked(sandbox, tool, "browser URL is required for a real browser probe", startedAt);
      let parsed: URL;
      try { parsed = new URL(url); } catch { return this.blocked(sandbox, tool, "browser URL is invalid", startedAt); }
      if (sandbox.allowedDomains.length && !sandbox.allowedDomains.includes(parsed.hostname)) return this.blocked(sandbox, tool, "browser host is outside the project allowlist", startedAt);
      try {
        const response = await fetch(parsed, { signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        const output = `HTTP ${response.status} · ${body.slice(0, 4000)}`;
        const evidence: Evidence = { id: `evidence-tool-${Date.now().toString(36)}`, projectId: sandbox.projectId, kind: "browser", verdict: response.ok ? "PASS" : "FAIL", summary: `HTTP browser probe ${response.status}`, source: "local-http-browser-probe", createdAt: new Date().toISOString(), rawRef: `tool://${sandbox.projectId}/browser`, evaluator: "local-deterministic-evaluator", evaluatorVersion: "local-evaluator-0.1" };
        return { tool, toolVersion: TOOL_VERSION, status: response.ok ? "succeeded" : "failed", outputRef: `tool://${sandbox.projectId}/browser/${Date.now()}`, summary: outputSummary(output, "browser probe", response.ok), evidence: [evidence], cost: 0.08, wallTimeMs: Date.now() - startedAt, output: redactSecretLikeText(output) };
      } catch (error: unknown) {
        return { tool, toolVersion: TOOL_VERSION, status: "failed", outputRef: `tool://${sandbox.projectId}/browser/${Date.now()}`, summary: `browser probe failed · ${error instanceof Error ? error.message : "request failed"}`, evidence: [], cost: 0.08, wallTimeMs: Date.now() - startedAt, output: "" };
      }
    }

    const commandId = action.params?.commandId;
    if (typeof commandId !== "string" || !(safeCommandIds as readonly string[]).includes(commandId)) return this.blocked(sandbox, tool ?? "missing", "commandId is not in the fixed local allowlist", startedAt);
    const spec = commandSpec(commandId as SafeCommandId);
    const result = await safeExec(spec.file, spec.args, sandbox.workspaceRef);
    const output = redactSecretLikeText([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, maxOutputBytes);
    const success = result.code === 0;
    const evidence: Evidence = {
      id: `evidence-tool-${Date.now().toString(36)}`,
      projectId: sandbox.projectId,
      kind: spec.kind,
      verdict: success ? "PASS" : "FAIL",
      summary: outputSummary(output, spec.label, success),
      source: `local-command:${commandId}`,
      createdAt: new Date().toISOString(),
      rawRef: `tool://${sandbox.projectId}/${sandbox.runId}/${commandId}`,
      evaluator: "local-deterministic-evaluator",
      evaluatorVersion: "local-evaluator-0.1",
      metadata: { exitCode: result.code, allowlisted: true },
    };
    return {
      tool: tool ?? "shell.sandbox",
      toolVersion: TOOL_VERSION,
      status: success ? "succeeded" : "failed",
      outputRef: `tool://${sandbox.projectId}/${sandbox.runId}/${commandId}/${Date.now()}`,
      summary: outputSummary(output, spec.label, success),
      evidence: [evidence],
      cost: spec.cost,
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

  async decide(context: import("../src/types").ContextPacket): Promise<ActionEnvelope> {
    const shell = context.toolSurface.find((tool) => tool.name === "shell.sandbox" && tool.enabled);
    const repo = context.toolSurface.find((tool) => tool.name === "repo.read" && tool.enabled);
    if (context.boundary.remainingBudget <= 0 || (!shell && !repo)) {
      return { type: "WAIT", intentRef: context.intentRef, worldCursor: context.worldCursor, rationaleSummary: "사용 가능한 local capability 또는 budget이 없어 대기", expectedValue: 0, riskClass: "P0", evidencePlan: ["world"] };
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
    this.usageByRun.set(context.id, { modelVersion: MODEL_VERSION, tokens: 480, cost: 0.04, latencyMs: 1 });
    return action;
  }

  async capabilities(): Promise<ModelCapabilities> {
    return { modelVersion: MODEL_VERSION, supportsStructuredActions: true, contextWindow: 16_000, reasoningModes: ["deterministic-ranking"] };
  }

  async usage(runId: string): Promise<ModelUsage> {
    return this.usageByRun.get(runId) ?? { modelVersion: MODEL_VERSION, tokens: 0, cost: 0, latencyMs: 0 };
  }
}

export class DeterministicEvaluator implements Evaluator {
  async evaluate(claim: string, evidence: Evidence[], _world: WorldSnapshot): Promise<EvaluatorResult> {
    if (!evidence.length) return { verdict: "UNCERTAIN", summary: `evaluator could not verify: ${claim}`, evidenceRefs: [], evaluatorVersion: "local-evaluator-0.1" };
    if (evidence.some((item) => item.verdict === "FAIL")) return { verdict: "FAIL", summary: `evidence reports failure: ${claim}`, evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "local-evaluator-0.1" };
    if (evidence.some((item) => item.verdict === "UNCERTAIN")) return { verdict: "UNCERTAIN", summary: `evidence is incomplete: ${claim}`, evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "local-evaluator-0.1" };
    return { verdict: "PASS", summary: `deterministic evidence passed: ${claim}`, evidenceRefs: evidence.map((item) => item.id), evaluatorVersion: "local-evaluator-0.1" };
  }
}

export class LocalSandboxManager implements SandboxManager {
  async create(project: import("../src/types").Project, run: import("../src/types").Run): Promise<SandboxContext> {
    return {
      projectId: project.id,
      runId: run.id,
      permissionClass: "P1",
      networkPolicy: project.settings.networkPolicy,
      allowedDomains: project.settings.allowedDomains ?? [],
      workspaceRef: project.settings.workspacePath ?? process.cwd(),
      sandboxId: `process-sandbox-${project.id}-${run.id}`,
      createdAt: new Date().toISOString(),
    };
  }

  async destroy(_sandbox: SandboxContext): Promise<void> {}
  async kill(_sandbox: SandboxContext): Promise<void> {}
}

export class InMemoryMemoryService {
  async retrieve(context: import("../src/types").ContextPacket): Promise<string[]> { return context.experienceRefs.slice(0, 5); }
  async consolidate(_projectId: string): Promise<void> {}
}

export function localWorkspaceExists(project: import("../src/types").Project): boolean {
  return Boolean(project.settings.workspacePath && existsSync(project.settings.workspacePath));
}
