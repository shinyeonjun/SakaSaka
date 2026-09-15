import type { ActionEnvelope, Project, RiskClass, ToolCapability } from "./types";

const riskRank: Record<RiskClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const safeCommandIds = [
  "repo-status",
  "repo-diff-check",
  "quality-test",
  "quality-build",
  "quality-build-api",
] as const;

export type SafeCommandId = (typeof safeCommandIds)[number];

export interface BoundaryDecision {
  status: "allowed" | "blocked" | "human-approval";
  reason: string;
  capability?: ToolCapability;
  normalizedTool?: string;
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

export function validateActionBoundary(
  project: Project,
  action: ActionEnvelope,
  capabilities: ToolCapability[],
  estimatedCost = 0,
): BoundaryDecision {
  if (action.type !== "ACT") return { status: "allowed", reason: "human-facing action does not dispatch a side effect" };

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
  if (capability.name === "shell.sandbox" && action.params?.commandId !== undefined && !isSafeCommand(action.params.commandId)) {
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
    .replace(/\b(sk|ghp|xoxb|AKIA)[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED]");
}

export function isUntrustedExternalSource(source: string): boolean {
  return source === "browser" || source === "shell" || source === "logs";
}
