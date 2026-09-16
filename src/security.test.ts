import { describe, expect, it } from "vitest";
import { createEmptyState } from "./emptyState";
import { createProject, getProject, getToolSurface, getWorldSnapshot } from "./runtime";
import { actionFingerprint, estimateActionCost, isActiveProcessReference, isAllowedNetworkHost, isDeveloperArgv, isManagedProcessArgv, parseActionEnvelope, redactSecretLikeText, validateActionBoundary } from "./security";
import type { ActionEnvelope, Project } from "./types";

function project(settings: Parameters<typeof createProject>[3] = {}): Project {
  const state = createProject(createEmptyState(), "보안 경계를 실제로 검증해줘", "security-project", settings);
  return getProject(state, "security-project")!;
}

function action(candidate: Project, overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  const state = createProject(createEmptyState(), "보안 경계를 실제로 검증해줘", "security-project");
  const worldCursor = getWorldSnapshot(state, "security-project")!.cursorEventId;
  return { type: "ACT", intentRef: candidate.intentId, worldCursor, rationaleSummary: "경계를 검증할 실제 행동", tool: "repo.read", params: { commandId: "repo-status" }, ...overrides };
}

describe("action boundary enforcement", () => {
  it("프로젝트 capability surface에 노출되지 않은 도구를 거부한다", () => {
    const candidate = project();
    const decision = validateActionBoundary(candidate, action(candidate, { tool: "shell.exec", params: undefined }), getToolSurface(candidate));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("not exposed");
  });

  it("허용 목록 밖의 명령은 프로세스 시작 전에 차단한다", () => {
    const candidate = project();
    const decision = validateActionBoundary(candidate, action(candidate, { tool: "shell.sandbox", params: { commandId: "rm-rf" } }), getToolSurface(candidate));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("fixed local allowlist");
  });

  it("임의 개발자 argv는 Docker 경계 안에서만 허용한다", () => {
    const processProject = project();
    const developerAction = action(processProject, { tool: "shell.sandbox", params: { argv: ["node", "server.js"] } });
    expect(validateActionBoundary(processProject, developerAction, getToolSurface(processProject)).status).toBe("blocked");
    const dockerProject = project({ sandboxMode: "docker" });
    expect(validateActionBoundary(dockerProject, action(dockerProject, { tool: "shell.sandbox", params: { argv: ["node", "server.js"] } }), getToolSurface(dockerProject)).status).toBe("allowed");
    expect(validateActionBoundary(dockerProject, action(dockerProject, { tool: "shell.sandbox", params: { argv: ["node", "-e", "process.exit(0)"] } }), getToolSurface(dockerProject)).status).toBe("blocked");
    expect(isDeveloperArgv(["node", "--eval=process.exit(0)"])).toBe(false);
    expect(isDeveloperArgv(["node", "-p", "process.env.SECRET"])).toBe(false);
    expect(isDeveloperArgv(["npm", "--prefix=..", "test"])).toBe(false);
    expect(isManagedProcessArgv(["node", "server.js"])).toBe(true);
    expect(isManagedProcessArgv(["npm", "run", "dev"])).toBe(true);
    expect(isManagedProcessArgv(["npm", "run", "clean"])).toBe(false);
  });

  it("process lifecycle은 현재 context가 공개한 ID만 참조한다", () => {
    const candidate = project();
    expect(isActiveProcessReference(action(candidate, { tool: "process.status", params: { processId: "process-current" } }), ["process-current"])).toBe(true);
    expect(isActiveProcessReference(action(candidate, { tool: "process.stop", params: { processId: "process-other" } }), ["process-current"])).toBe(false);
  });

  it("읽기 전용 repo capability로 품질 명령을 우회하지 못한다", () => {
    const candidate = project();
    const decision = validateActionBoundary(candidate, action(candidate, { tool: "repo.read", params: { commandId: "quality-test" } }), getToolSurface(candidate));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("status");
    expect(estimateActionCost(action(candidate, { tool: "shell.sandbox", params: { commandId: "quality-test" } }))).toBe(0.18);
  });

  it("읽기 전용 repo capability에서 실제 git diff를 노출한다", () => {
    const candidate = project();
    expect(validateActionBoundary(candidate, action(candidate, { params: { commandId: "repo-diff" } }), getToolSurface(candidate)).status).toBe("allowed");
  });

  it("네트워크 정책이 deny이면 네트워크 도구를 허용하지 않는다", () => {
    const candidate = project({ networkPolicy: "deny" });
    const decision = validateActionBoundary(candidate, action(candidate, { tool: "browser.playwright", params: { url: "https://example.com" } }), getToolSurface(candidate));
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toContain("network policy");
  });

  it("명시된 host만 허용하고 인증 정보가 있는 URL은 거부한다", () => {
    expect(isAllowedNetworkHost("https://preview.example.com/app", "allowlist", ["*.example.com"])).toBe(true);
    expect(isAllowedNetworkHost("https://example.com/app", "allowlist", ["*.example.com"])).toBe(false);
    expect(isAllowedNetworkHost("https://preview.example.com.evil.test", "allowlist", ["*.example.com"])).toBe(false);
    expect(isAllowedNetworkHost("https://user:password@preview.example.com", "allowlist", ["*.example.com"])).toBe(false);
  });

  it("행동을 현재 Intent에 묶고 P3 외부 작업은 human approval로 전환한다", () => {
    const candidate = project();
    const staleIntent = validateActionBoundary(candidate, action(candidate, { intentRef: "intent-stale" }), getToolSurface(candidate));
    expect(staleIntent.status).toBe("blocked");
    expect(staleIntent.reason).toContain("intentRef");
    const approvalProject = project({ productionBlocked: false });
    const approval = validateActionBoundary(approvalProject, action(approvalProject, { tool: "deploy.production", params: { url: "https://deploy.example.com" }, riskClass: "P3" }), getToolSurface(approvalProject));
    expect(approval.status).toBe("human-approval");
  });

  it("secret-shaped 값은 도구 출력에 저장되기 전에 가린다", () => {
    expect(redactSecretLikeText("api_key=sk-test-1234567890 password=hunter2")).toBe("api_key=[REDACTED] password=[REDACTED]");
    expect(redactSecretLikeText("https://user:password@example.com/private")).toBe("https://[REDACTED]@example.com/private");
  });

  it("구조화된 모델 출력을 도구 게이트웨이에 전달하기 전에 검증한다", () => {
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "테스트 실행", tool: "shell.sandbox", params: { commandId: "quality-test" } })?.type).toBe("ACT");
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "잘못된 값", params: { command: { injected: true } } })).toBeUndefined();
    expect(parseActionEnvelope({ type: "ACT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "도구 누락" })).toBeUndefined();
    expect(parseActionEnvelope({ type: "WAIT", intentRef: "intent-1", worldCursor: "world-1", rationaleSummary: "대기", tool: null, params: null, expectedValue: null, riskClass: null, evidencePlan: null })).toMatchObject({ type: "WAIT", tool: undefined, params: undefined, expectedValue: undefined, riskClass: undefined, evidencePlan: undefined });
    const first = action(project());
    expect(actionFingerprint(first)).toBe(actionFingerprint(first));
    expect(actionFingerprint(first)).not.toBe(actionFingerprint({ ...first, params: { commandId: "repo-diff" } }));
  });
});
