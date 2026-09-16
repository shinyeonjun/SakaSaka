import type { ActionEnvelope, ActionType, Project, RiskClass, ToolCapability } from "./types";

const riskRank: Record<RiskClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const safeCommandIds = [
  "repo-status",
  "repo-diff-check",
  "quality-test",
  "quality-build",
  "quality-build-api",
] as const;

export type SafeCommandId = (typeof safeCommandIds)[number];

const safeCommandCost: Record<SafeCommandId, number> = {
  "repo-status": 0.02,
  "repo-diff-check": 0.03,
  "quality-test": 0.18,
  "quality-build": 0.24,
  "quality-build-api": 0.12,
};

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
  if (tool === "repo.read" && action.params?.commandId === "repo-status") return safeCommandCost["repo-status"];
  if (tool === "shell.sandbox" && isSafeCommand(action.params?.commandId)) return safeCommandCost[action.params.commandId];
  return 0.2;
}

export function validateActionBoundary(
  project: Project,
  action: ActionEnvelope,
  capabilities: ToolCapability[],
  estimatedCost = 0,
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
  if (capability.name === "repo.read" && action.params?.commandId !== "repo-status") {
    return { status: "blocked", reason: "repo.read only exposes the repo-status command", capability, normalizedTool };
  }
  if (capability.name === "shell.sandbox" && !isSafeCommand(action.params?.commandId)) {
    return { status: "blocked", reason: "command is outside the fixed local allowlist", capability, normalizedTool };
  }
  if (riskRank[capability.riskClass] >= riskRank.P3 && project.settings.productionBlocked) {
    return { status: "blocked", reason: "P3 production/destructive side effects are hard-blocked by project policy", capability, normalizedTool };
  }
  if (riskRank[capability.riskClass] >= riskRank.P2 && project.settings.requireExternalApproval) {
    return { status: "human-approval", reason: "external or difficult-to-reverse side effect requires an approval item", capability, normalizedTool };
  }
  if (capability.riskClass === "P1" && !project.settings.localActions) {
    return { status: "blocked", reason: "local sandbox actions are disabled by project policy", capability, normalizedTool };
  }
  return { status: "allowed", reason: "capability, permission, network, and resource checks passed", capability, normalizedTool };
}

export function redactSecretLikeText(value: string): string {
  return value
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
  const params = candidate.params;
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 64 || Object.values(params).some((item) => !["string", "number", "boolean"].includes(typeof item)))) return undefined;
  const riskClass = candidate.riskClass;
  if (riskClass !== undefined && !["P0", "P1", "P2", "P3"].includes(String(riskClass))) return undefined;
  const evidencePlan = candidate.evidencePlan;
  if (evidencePlan !== undefined && (!Array.isArray(evidencePlan) || evidencePlan.length > 32 || evidencePlan.some((item) => typeof item !== "string" || item.length > 256))) return undefined;
  const expectedValue = candidate.expectedValue;
  if (expectedValue !== undefined && (typeof expectedValue !== "number" || !Number.isFinite(expectedValue) || expectedValue < 0 || expectedValue > 1)) return undefined;
  return {
    type: type as ActionType,
    intentRef,
    worldCursor,
    rationaleSummary,
    tool: typeof candidate.tool === "string" && candidate.tool.length <= 256 ? candidate.tool : undefined,
    params: params as ActionEnvelope["params"],
    expectedValue,
    riskClass: riskClass as ActionEnvelope["riskClass"],
    evidencePlan: evidencePlan as string[] | undefined,
  };
}
