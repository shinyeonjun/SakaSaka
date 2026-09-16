import type { ActionEnvelope, ActionParamValue, ActionType, ApprovalGrant, Project, RiskClass, ToolCapability } from "./types";

const riskRank: Record<RiskClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const safeCommandIds = [
  "repo-status",
  "repo-diff",
  "repo-diff-check",
  "quality-test",
  "quality-build",
  "quality-build-api",
] as const;

export type SafeCommandId = (typeof safeCommandIds)[number];

const safeCommandCost: Record<SafeCommandId, number> = {
  "repo-status": 0.02,
  "repo-diff": 0.04,
  "repo-diff-check": 0.03,
  "quality-test": 0.18,
  "quality-build": 0.24,
  "quality-build-api": 0.12,
};

const maxActionPayloadBytes = 256 * 1024;
const maxActionArrayLength = 128;
const developerExecutables = new Set(["node", "node.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "git", "python", "python3", "pytest", "tsc", "vite", "playwright"]);
const managedProcessExecutables = new Set(["node", "node.exe", "vite"]);
const managedPackageScripts = new Set(["dev", "start", "preview", "serve"]);
const blockedDeveloperFlags = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--loader", "--import", "--experimental-loader"]);

export interface BoundaryDecision {
  status: "allowed" | "blocked" | "human-approval";
  reason: string;
  capability?: ToolCapability;
  normalizedTool?: string;
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/, "");
  if (normalizedPattern.startsWith("*.")) return normalizedHost.endsWith(normalizedPattern.slice(1)) && normalizedHost !== normalizedPattern.slice(2);
  return normalizedHost === normalizedPattern;
}

function isNetworkPattern(pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  const base = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (!base || normalized.includes("/") || normalized.includes(":")) return false;
  if (base === "localhost") return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(base)) return base.split(".").every((part) => Number(part) <= 255);
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(base);
}

export function isAllowedNetworkHost(rawUrl: string, networkPolicy: Project["settings"]["networkPolicy"], allowedDomains: string[]): boolean {
  if (networkPolicy === "deny") return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return allowedDomains.some((domain) => typeof domain === "string" && isNetworkPattern(domain) && hostMatches(url.hostname, domain));
  } catch {
    return false;
  }
}

/** Network access is deny-by-default unless a project explicitly names the host. */
export function isAllowedNetworkUrl(project: Project, rawUrl: string): boolean {
  return isAllowedNetworkHost(rawUrl, project.settings.networkPolicy, project.settings.allowedDomains ?? []);
}

function normalizeToolName(tool: string | undefined): string | undefined {
  if (!tool) return undefined;
  return {
    playwright: "browser.playwright",
    "browser-observation": "browser.playwright",
    "world-adapter": "repo.read",
    shell: "shell.sandbox",
  }[tool] ?? tool;
}

function isSafeCommand(value: unknown): value is SafeCommandId {
  return typeof value === "string" && (safeCommandIds as readonly string[]).includes(value);
}

export function estimateActionCost(action: ActionEnvelope): number {
  if (action.type !== "ACT") return 0;
  const tool = normalizeToolName(action.tool);
  if (tool === "browser.playwright") return 0.12;
  if (tool === "database.read") return 0.05;
  if (tool === "workspace.list" || tool === "workspace.read") return 0.01;
  if (tool === "workspace.write" || tool === "workspace.patch") return 0.08;
  if (tool === "workspace.delete") return 0.12;
  if (tool === "dependency.install") return 0.35;
  if (tool === "process.start") return 0.08;
  if (tool === "process.status" || tool === "process.stop") return 0.02;
  if (tool === "repo.read" && isSafeCommand(action.params?.commandId)) return safeCommandCost[action.params.commandId];
  if (tool === "shell.sandbox" && isSafeCommand(action.params?.commandId)) return safeCommandCost[action.params.commandId];
  return 0.2;
}

export function validateActionBoundary(
  project: Project,
  action: ActionEnvelope,
  capabilities: ToolCapability[],
  estimatedCost = 0,
  approvalGrant?: ApprovalGrant,
  now = Date.now(),
): BoundaryDecision {
  if (action.type !== "ACT") return { status: "allowed", reason: "human-facing action does not dispatch a side effect" };

  if (action.intentRef !== project.intentId) {
    return { status: "blocked", reason: "action intentRef does not match the active project intent" };
  }

  const normalizedTool = normalizeToolName(action.tool);
  const capability = capabilities.find((candidate) => candidate.name === normalizedTool);
  if (!capability) return { status: "blocked", reason: `tool is not exposed by the current capability surface: ${action.tool ?? "missing"}`, normalizedTool };
  if (!capability.enabled) return { status: "blocked", reason: `tool capability is disabled: ${capability.name}`, capability, normalizedTool };
  if (estimatedCost > Math.max(0, project.settings.budgetLimit - project.budgetSpent)) {
    return { status: "blocked", reason: "resource budget would be exceeded", capability, normalizedTool };
  }
  if (capability.requiresNetwork && project.settings.networkPolicy === "deny") {
    return { status: "blocked", reason: "network policy denies this capability", capability, normalizedTool };
  }
  if (capability.name === "browser.playwright" && (typeof action.params?.url !== "string" || !isAllowedNetworkUrl(project, action.params.url))) {
    return { status: "blocked", reason: "network URL is outside the project allowlist", capability, normalizedTool };
  }
  if (capability.name === "repo.read" && !["repo-status", "repo-diff", "repo-diff-check"].includes(String(action.params?.commandId))) {
    return { status: "blocked", reason: "repo.read only exposes status, diff, and diff-check commands", capability, normalizedTool };
  }
  if (capability.name === "shell.sandbox" && !isSafeCommand(action.params?.commandId)) {
    if (project.settings.sandboxMode !== "docker" || !isDeveloperArgv(action.params?.argv)) {
      return { status: "blocked", reason: "command is outside the fixed local allowlist or Docker argv contract", capability, normalizedTool };
    }
  }
  if (capability.name === "workspace.read" && !isWorkspacePathParam(action.params?.path)) return { status: "blocked", reason: "workspace.read requires a relative path", capability, normalizedTool };
  if (capability.name === "workspace.write" && (!isWorkspacePathParam(action.params?.path) || typeof action.params?.content !== "string")) return { status: "blocked", reason: "workspace.write requires a relative path and text content", capability, normalizedTool };
  if (capability.name === "workspace.patch" && typeof action.params?.patch !== "string") return { status: "blocked", reason: "workspace.patch requires a unified patch string", capability, normalizedTool };
  if (capability.name === "workspace.delete" && !isWorkspacePathParam(action.params?.path)) return { status: "blocked", reason: "workspace.delete requires a relative path", capability, normalizedTool };
  if (capability.name === "dependency.install" && !isPackageList(action.params?.packages)) return { status: "blocked", reason: "dependency.install requires validated package names", capability, normalizedTool };
  if (capability.name === "process.start" && !(project.settings.sandboxMode === "docker" ? isDeveloperArgv(action.params?.argv) : isManagedProcessArgv(action.params?.argv))) return { status: "blocked", reason: project.settings.sandboxMode === "docker" ? "process.start requires a valid Docker argv array" : "process.start only permits a managed dev-server argv in process mode", capability, normalizedTool };
  if ((capability.name === "process.status" || capability.name === "process.stop") && !isBoundedString(action.params?.processId, 256)) return { status: "blocked", reason: `${capability.name} requires a processId`, capability, normalizedTool };
  if (riskRank[capability.riskClass] >= riskRank.P3 && project.settings.productionBlocked) {
    return { status: "blocked", reason: "P3 production/destructive side effects are hard-blocked by project policy", capability, normalizedTool };
  }
  if (riskRank[capability.riskClass] >= riskRank.P2 && project.settings.requireExternalApproval) {
    if (approvalGrant && approvalGrant.singleUse && !approvalGrant.consumedAt && Date.parse(approvalGrant.expiresAt) > now && approvalGrant.projectId === project.id && approvalGrant.tool === action.tool && approvalGrant.actionFingerprint === actionFingerprint(action) && approvalGrant.paramsFingerprint === paramsFingerprint(action) && approvalGrant.paramsCanonical === canonicalActionParams(action) && approvalGrant.intentRef === action.intentRef) {
      return { status: "allowed", reason: "matching single-use human approval grant is active", capability, normalizedTool };
    }
    return { status: "human-approval", reason: "external or difficult-to-reverse side effect requires an approval item", capability, normalizedTool };
  }
  if (capability.riskClass === "P1" && !project.settings.localActions) {
    return { status: "blocked", reason: "local sandbox actions are disabled by project policy", capability, normalizedTool };
  }
  return { status: "allowed", reason: "capability, permission, network, and resource checks passed", capability, normalizedTool };
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isWorkspacePathParam(value: unknown): value is string {
  if (!isBoundedString(value, 2_000)) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized) && !normalized.split("/").some((part) => part === "..");
}

export function isDeveloperArgv(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2_000)) return false;
  const executable = String(value[0]).toLowerCase();
  if (!developerExecutables.has(executable)) return false;
  return !value.slice(1).some((item) => {
    const option = item.toLowerCase().split("=", 1)[0];
    return item.includes("\0")
      || blockedDeveloperFlags.has(option)
      || item.startsWith("/")
      || /^[a-zA-Z]:[\\/]/.test(item)
      || /(?:^|[=:\\/]\s*)\.\.(?:[\\/]|$)/.test(item);
  });
}

/**
 * Process mode may keep a real dev server alive, but it must not dispatch an
 * arbitrary package script. Full developer argv remains a Docker-only path.
 */
export function isManagedProcessArgv(value: unknown): value is string[] {
  if (!isDeveloperArgv(value)) return false;
  const executable = value[0]!.toLowerCase();
  if (managedProcessExecutables.has(executable)) return value.length >= 2;
  if (!["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(executable)) return false;
  if (value.length === 2 && value[1] === "start") return true;
  return value.length === 3 && value[1] === "run" && managedPackageScripts.has(value[2]!.toLowerCase());
}

/** Process lifecycle IDs must come from the current source-linked context. */
export function isActiveProcessReference(action: ActionEnvelope, activeProcessIds: readonly string[]): boolean {
  if (action.type !== "ACT" || (action.tool !== "process.status" && action.tool !== "process.stop")) return true;
  return typeof action.params?.processId === "string" && activeProcessIds.includes(action.params.processId);
}

function isPackageList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((item) => typeof item === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._-]+)?$/i.test(item) && item.length <= 214);
}

export function redactSecretLikeText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi, "[REDACTED_PEM]")
    .replace(/(authorization\s*[:=]\s*bearer\s+|\bbearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(cookie|set-cookie|session[_-]?cookie)\s*[:=]\s*[^\r\n,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password|session[_-]?cookie)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(sk|ghp|xoxb|AKIA)[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED]");
}

export function isUntrustedExternalSource(source: string): boolean {
  return source === "browser" || source === "shell" || source === "logs";
}

export function parseActionEnvelope(value: unknown): ActionEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const actionTypes: ActionType[] = ["ACT", "QUESTION", "IDEA", "CONCERN", "WAIT"];
  const type = candidate.type;
  const intentRef = candidate.intentRef;
  const worldCursor = candidate.worldCursor;
  const rationaleSummary = candidate.rationaleSummary;
  if (!actionTypes.includes(type as ActionType) || typeof intentRef !== "string" || intentRef.length > 512 || typeof worldCursor !== "string" || worldCursor.length > 512 || typeof rationaleSummary !== "string" || !rationaleSummary.trim() || rationaleSummary.length > 4_000) return undefined;
  const tool = candidate.tool === null ? undefined : candidate.tool;
  if (type === "ACT" && (typeof tool !== "string" || !tool.trim())) return undefined;
  if (type !== "ACT" && tool !== undefined) return undefined;
  const params = candidate.params === null ? undefined : candidate.params;
  if (params !== undefined && (!isBoundedParams(params) || JSON.stringify(params).length > maxActionPayloadBytes)) return undefined;
  const riskClass = candidate.riskClass === null ? undefined : candidate.riskClass;
  if (riskClass !== undefined && !["P0", "P1", "P2", "P3"].includes(String(riskClass))) return undefined;
  const evidencePlan = candidate.evidencePlan === null ? undefined : candidate.evidencePlan;
  if (evidencePlan !== undefined && (!Array.isArray(evidencePlan) || evidencePlan.length > 32 || evidencePlan.some((item) => typeof item !== "string" || item.length > 256))) return undefined;
  const expectedValue = candidate.expectedValue === null ? undefined : candidate.expectedValue;
  if (expectedValue !== undefined && (typeof expectedValue !== "number" || !Number.isFinite(expectedValue) || expectedValue < 0 || expectedValue > 1)) return undefined;
  return {
    type: type as ActionType,
    intentRef,
    worldCursor,
    rationaleSummary,
    tool: typeof tool === "string" && tool.length <= 256 ? tool : undefined,
    params: params as ActionEnvelope["params"],
    expectedValue,
    riskClass: riskClass as ActionEnvelope["riskClass"],
    evidencePlan: evidencePlan as string[] | undefined,
  };
}

function isBoundedParams(value: unknown): value is Record<string, ActionParamValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 64) return false;
  return entries.every(([key, item]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(key)) return false;
    if (typeof item === "string") return item.length <= 256_000;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "boolean") return true;
    if (Array.isArray(item)) return item.length <= maxActionArrayLength && item.every((entry) => typeof entry === "string" && entry.length <= 2_000);
    return false;
  });
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function fingerprintCanonical(canonical: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Stable lookup checksum only. Authorization additionally compares canonical params and Intent. */
export function actionFingerprint(action: ActionEnvelope): string {
  return fingerprintCanonical(stableValue({ type: action.type, intentRef: action.intentRef, tool: action.tool ?? "", params: action.params ?? {} }));
}

export function canonicalActionParams(action: ActionEnvelope): string {
  return stableValue(action.params ?? {});
}

export function paramsFingerprint(action: ActionEnvelope): string {
  return fingerprintCanonical(canonicalActionParams(action));
}
