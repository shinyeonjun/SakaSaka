import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient, RpcRecord } from "./codexAppServer";
import { checkNativeConfig } from "./codexAppServer";
import { runNativeEpisode } from "./nativeRuntime";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject, getRun, pauseProject, resolveHumanItem, resumeProject, wakeProject } from "../src/runtime";
import type { AppState } from "../src/types";
import { checkpointSchema, inspectCheckpoint, parseCheckpoint, registerMissionHuman, resolveCheckpointReferences } from "../src/nativeSession";

const directories: string[] = [];
const saved = { raw: process.env.INTENT_WORLD_RAW_DIR, root: process.env.WORKSPACE_ROOT };
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  if (saved.raw === undefined) delete process.env.INTENT_WORLD_RAW_DIR; else process.env.INTENT_WORLD_RAW_DIR = saved.raw;
  if (saved.root === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = saved.root;
});
const report = (disposition = "equilibrium", remainingWork: string[] = []) => JSON.stringify({ disposition, summary: "실제 확인한 결과만 보고합니다.", remainingWork, evidenceRefs: [], wakeReasons: ["새 사용자 의견"] });

class FakeClient implements AppServerClient {
  calls: Array<{ method: string; params: RpcRecord }> = [];
  notify: (method: string, params: RpcRecord) => void = () => undefined;
  serverRequest: (method: string, params: RpcRecord) => Promise<unknown> = async () => ({});
  private resolveClosed!: (e: Error) => void;
  closed = new Promise<Error>((resolve) => { this.resolveClosed = resolve; });
  constructor(readonly script: (client: FakeClient) => Promise<void>) {}
  async start() {}
  onNotification(fn: (method: string, params: RpcRecord) => void) { this.notify = fn; }
  onRequest(fn: (method: string, params: RpcRecord) => Promise<unknown>) { this.serverRequest = fn; }
  async close() { this.resolveClosed(new Error("closed")); }
  async request(method: string, params: RpcRecord): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "config/read") return { config: {} };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-test" } };
    if (method === "turn/start") { setTimeout(() => { void this.script(this).catch(() => this.close()); }, 0); return { turn: { id: "turn-test" } }; }
    if (method === "turn/interrupt") await this.close();
    return {};
  }
  item(item: RpcRecord, complete = true) { this.notify(complete ? "item/completed" : "item/started", { threadId: "thread-test", turnId: "turn-test", item }); }
  finish(text = report()) { this.item({ id: "report", type: "agentMessage", text, phase: "final_answer" }); this.notify("turn/completed", { threadId: "thread-test", turn: { id: "turn-test", status: "completed" } }); }
  tool(name: string, args: RpcRecord) { return this.serverRequest("item/tool/call", { threadId: "thread-test", turnId: "turn-test", tool: name, callId: `call-${name}`, arguments: args }); }
}

function fixture(settings: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "sakasaka-native-test-")); directories.push(root);
  process.env.WORKSPACE_ROOT = root; process.env.INTENT_WORLD_RAW_DIR = join(root, "raw");
  let state = createProject(createEmptyState(), "친구와 사용할 작은 앱이 있었으면 좋겠어", "native-test", { workspacePath: root, modelProvider: "codex-cli", executionMode: "native", ...settings });
  let queue = Promise.resolve();
  return {
    root, read: () => state,
    transact(update: (s: AppState) => AppState): Promise<AppState> {
      const result = queue.then(() => { state = update(state); return state; }); queue = result.then(() => undefined); return result;
    },
  };
}
const question = { key: "sharing", title: "공개 범위를 어떻게 할까요?", rationale: "사용자의 공개 범위 선호가 필요합니다.", blockingScope: ["공개 공유"], continuingScope: ["로컬 편집"], options: [] };
const blockingQuestion = { ...question, continuingScope: [] };
const waitFor = async (condition: () => boolean) => { const deadline = Date.now() + 3000; while (!condition()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((r) => setTimeout(r, 10)); } };

describe("mission native runtime", () => {
  it("원문 의도는 보존하고 실제 모델 입력의 중복 필드에서도 비밀 값을 제거한다", async () => {
    const store = fixture();
    await store.transact((s) => ({ ...s, intents: s.intents.map((i) => ({ ...i, rawText: "작은 앱 password=do-not-forward-123" })) }));
    const client = new FakeClient(async (c) => c.finish());
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    const prompt = JSON.stringify(client.calls.find((c) => c.method === "turn/start")?.params);
    expect(prompt).not.toContain("do-not-forward-123");
    expect(store.read().intents[0].rawText).toContain("do-not-forward-123");
    expect(store.read().events.some((e) => e.type === "CONTEXT_ASSEMBLED" && e.payload?.rawRef)).toBe(true);
  });

  it("Native sandbox 네트워크는 기본 차단이고 acceptance에서만 명시적으로 열 수 있다", async () => {
    const lockedStore = fixture();
    const locked = new FakeClient(async (c) => c.finish());
    await runNativeEpisode(lockedStore, "native-test", { clientFactory: () => locked });
    expect((locked.calls.find((c) => c.method === "turn/start")?.params.sandboxPolicy as RpcRecord).networkAccess).toBe(false);

    const acceptanceStore = fixture();
    const acceptance = new FakeClient(async (c) => c.finish());
    await runNativeEpisode(acceptanceStore, "native-test", { clientFactory: () => acceptance, sandboxNetworkAccess: true });
    expect((acceptance.calls.find((c) => c.method === "turn/start")?.params.sandboxPolicy as RpcRecord).networkAccess).toBe(true);
  });

  it("여러 native 행동과 오류 복구는 같은 turn에서 이어지고 명령 실패 1회로 중단하지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      c.item({ id: "cmd1", type: "commandExecution", command: "node test.js", status: "failed", exitCode: 1, aggregatedOutput: "test failed" });
      c.item({ id: "change", type: "fileChange", status: "completed", changes: [{ path: "app.js" }] });
      c.item({ id: "cmd2", type: "commandExecution", command: "node test.js", status: "completed", exitCode: 0, aggregatedOutput: "test passed" });
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(client.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    expect(store.read().actions).toHaveLength(3);
    expect(store.read().evidence.map((e) => e.verdict)).toEqual(["FAIL", "PASS", "PASS"]);
    expect(getProject(store.read(), "native-test")?.status).toBe("EQUILIBRIUM");
    expect(store.read().experiences).toHaveLength(3);
    expect(getRun(store.read(), "native-test")?.execution).toBeUndefined();
  });

  it("질문 접수는 미응답을 반환하며 계속 작업하고, 미룬 뒤의 실제 답변은 같은 thread에 steer된다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      const response = await c.tool("sakasaka_question", question) as { contentItems: Array<{ text: string }> };
      expect(JSON.parse(response.contentItems[0].text).item.answer).toBeNull();
      c.item({ id: "independent", type: "fileChange", status: "completed", changes: [{ path: "editor.js" }] });
      const id = store.read().humanItems[0].id;
      await store.transact((s) => resolveHumanItem(s, id, "defer"));
      await store.transact((s) => resolveHumanItem(s, id, "answer", "초대된 친구에게만 공개"));
      await waitFor(() => c.calls.some((call) => call.method === "turn/steer" && JSON.stringify(call.params).includes("초대된 친구에게만 공개")));
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client, pollMs: 20 });
    expect(store.read().humanItems[0].status).toBe("ANSWERED");
    expect(client.calls.some((c) => c.method === "turn/steer")).toBe(true);
    expect(getProject(store.read(), "native-test")?.status).toBe("EQUILIBRIUM");
  });

  it("명시된 미응답 때문에 기다린 뒤 답변 wake에서 기존 thread를 resume한다", async () => {
    const store = fixture();
    await runNativeEpisode(store, "native-test", { clientFactory: () => new FakeClient(async (c) => { await c.tool("sakasaka_question", blockingQuestion); c.finish(report("waiting", ["공개 범위 답변"])); }) });
    expect(getProject(store.read(), "native-test")?.status).toBe("WAITING");
    await store.transact((s) => resolveHumanItem(s, s.humanItems[0].id, "answer", "비공개"));
    const resumed = new FakeClient(async (c) => c.finish());
    await runNativeEpisode(store, "native-test", { clientFactory: () => resumed });
    expect(resumed.calls.find((c) => c.method === "thread/resume")?.params.threadId).toBe("thread-test");
    expect(JSON.stringify(resumed.calls.find((c) => c.method === "turn/start")?.params)).toContain("비공개");
  });

  it("질문의 continuingScope가 있으면 영향받지 않는 작업을 전체 대기로 만들지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      await c.tool("sakasaka_question", question);
      c.finish(report("waiting", ["공개 범위 답변"]));
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(getProject(store.read(), "native-test")?.status).toBe("ACTIVE");
  });

  it("질문함 없이 waiting을 보고하면 무한 ACTIVE 재시도를 하지 않는다", async () => {
    const store = fixture();
    await runNativeEpisode(store, "native-test", { clientFactory: () => new FakeClient(async (c) => c.finish(report("waiting", ["등록되지 않은 외부 조건"]))) });
    expect(getProject(store.read(), "native-test")?.status).toBe("STALLED");
    expect(getRun(store.read(), "native-test")?.stopReason).toContain("waiting");
  });

  it("일시 정지 뒤 도착한 stale Native 결과는 상태에 커밋하지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      await store.transact((s) => pauseProject(s, "native-test"));
      c.item({ id: "stale-change", type: "fileChange", status: "completed", changes: [{ path: "stale.js" }] });
      await c.closed.catch(() => undefined);
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client, pollMs: 20 });
    expect(store.read().actions).toHaveLength(0);
    expect(getProject(store.read(), "native-test")?.status).toBe("PAUSED");
    expect(getRun(store.read(), "native-test")?.execution).toBeUndefined();
  });

  it("빠른 일시 정지와 재개 뒤 이전 episode lease의 결과는 상태에 커밋하지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      await store.transact((s) => pauseProject(s, "native-test"));
      await store.transact((s) => resumeProject(s, "native-test"));
      c.item({ id: "stale-after-resume", type: "fileChange", status: "completed", changes: [{ path: "stale-after-resume.js" }] });
      await c.closed.catch(() => undefined);
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client, pollMs: 20 });
    expect(store.read().actions).toHaveLength(0);
    expect(getProject(store.read(), "native-test")?.status).toBe("ACTIVE");
    expect(getRun(store.read(), "native-test")?.execution).toBeUndefined();
  });

  it("검색 이벤트가 도착하면 Native turn을 중단하고 성공으로 처리하지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      c.item({ id: "forbidden-search", type: "webSearch", status: "completed" });
      await c.closed.catch(() => undefined);
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client, pollMs: 20 });
    expect(getProject(store.read(), "native-test")?.status).toBe("STALLED");
    expect(store.read().actions.some((action) => action.tool === "codex.webSearch" && action.status === "FAILED")).toBe(true);
    expect(store.read().evidence.some((evidence) => evidence.verdict === "UNCERTAIN" && evidence.summary.includes("프로토콜 위반"))).toBe(true);
  });

  it("잘못된 managed process ID는 복구 피드백이고 전체 프로젝트를 STALLED로 만들지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      const reply = await c.tool("sakasaka_preview_status", { processId: "made-up" });
      expect(JSON.stringify(reply)).toContain("미리보기 ID가 없습니다");
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(getProject(store.read(), "native-test")?.status).toBe("EQUILIBRIUM");
  });

  it("모델 응답 중 pause는 즉시 저장되고 native 작업을 interrupt한다", async () => {
    const store = fixture();
    const client = new FakeClient(async () => { await store.transact((s) => pauseProject(s, "native-test")); });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client, pollMs: 20 });
    expect(getProject(store.read(), "native-test")?.status).toBe("PAUSED");
    expect(client.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
    expect(getRun(store.read(), "native-test")?.execution).toBeUndefined();
  });

  it("누적 토큰 알림은 중복 과금하지 않고 상한 없이 계속 계측한다", async () => {
    const store = fixture({ maxNativeTokens: 100 });
    const client = new FakeClient(async (c) => {
      const params = { threadId: "thread-test", turnId: "turn-test", tokenUsage: { total: { totalTokens: 80, inputTokens: 60, cachedInputTokens: 10, outputTokens: 20 } } };
      c.notify("thread/tokenUsage/updated", params); c.notify("thread/tokenUsage/updated", params);
      c.notify("thread/tokenUsage/updated", { ...params, tokenUsage: { total: { totalTokens: 101, inputTokens: 75, cachedInputTokens: 30, outputTokens: 26 } } });
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(store.read().resourceLedger.reduce((n, l) => n + l.tokens, 0)).toBe(101);
    expect(getRun(store.read(), "native-test")?.nativeSession?.accountedCachedInputTokens).toBe(30);
    expect(getRun(store.read(), "native-test")?.stopReason).toBeUndefined();
    expect(getProject(store.read(), "native-test")?.status).not.toBe("STALLED");
  });

  it("자동 permission escalation을 거절해도 에이전트는 안전한 대안을 계속 선택한다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => {
      const response = await c.serverRequest("item/commandExecution/requestApproval", { threadId: "thread-test", turnId: "turn-test", itemId: "approval", reason: "외부 권한" });
      expect(response).toEqual({ decision: "decline" });
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(getProject(store.read(), "native-test")?.status).toBe("EQUILIBRIUM");
  });

  it("turn continue는 ACTIVE를 유지하고 새 시그널에서 같은 프로젝트가 깨어난다", async () => {
    const store = fixture();
    await runNativeEpisode(store, "native-test", { clientFactory: () => new FakeClient(async (c) => c.finish(report("continue", ["다음 가치 있는 변경"]))) });
    expect(getProject(store.read(), "native-test")?.status).toBe("ACTIVE");
    await runNativeEpisode(store, "native-test", { clientFactory: () => new FakeClient(async (c) => c.finish()) });
    expect(getProject(store.read(), "native-test")?.nextReviewAt).toBeTruthy();
    await store.transact((s) => wakeProject(s, "native-test", "user-feedback"));
    expect(getRun(store.read(), "native-test")?.nativeSession?.threadId).toBe("thread-test");
  });

  it("정확한 외부 패키지 요청을 승인한 후 한 번만 소비하고 실행한다", async () => {
    const store = fixture(); let executions = 0;
    const client = new FakeClient(async (c) => {
      const args = { packages: ["react"], packageManager: "npm" };
      const first = await c.tool("sakasaka_dependency_install", args);
      expect(JSON.stringify(first)).toContain("pendingApproval");
      const item = store.read().humanItems[0]; expect(item.kind).toBe("APPROVAL");
      await store.transact((s) => resolveHumanItem(s, item.id, "approve"));
      const approved = await c.tool("sakasaka_dependency_install", args);
      expect(JSON.stringify(approved)).toContain('"ok":true');
      await c.tool("sakasaka_dependency_install", args);
      expect(executions).toBe(1);
      c.finish();
    });
    await runNativeEpisode(store, "native-test", { clientFactory: () => client,
      executeTool: async (a) => { executions++; return { tool: a.tool!, toolVersion: "test", status: "succeeded", outputRef: "test://dependency", summary: "test adapter only", evidence: [], cost: 0, wallTimeMs: 0 }; } });
    expect(store.read().approvalGrants[0].consumedAt).toBeTruthy();
    expect(store.read().events.filter((e) => e.type === "APPROVAL_GRANT_CONSUMED")).toHaveLength(1);
  });

  it("엄격한 체크포인트와 외부 설정 경계, 해결된 질문 dedupe를 보존한다", () => {
    expect(parseCheckpoint('{"disposition":"equilibrium"}')).toBeUndefined();
    expect(parseCheckpoint(JSON.stringify({ disposition: "equilibrium", summary: "확인", remainingWork: [], evidenceRefs: ["Authorization: Bearer leaked"], wakeReasons: [] }))).toBeDefined();
    expect(checkNativeConfig({ mcp_servers: { remote: {} } })).toContain("MCP");
    expect(checkNativeConfig({ mcp_servers: { remote: { enabled: false } } })).toBeUndefined();
    const store = fixture();
    const first = registerMissionHuman(store.read(), "native-test", "QUESTION", question);
    const answered = resolveHumanItem(first.state, first.item.id, "answer", "답변");
    expect(registerMissionHuman(answered, "native-test", "QUESTION", question).state.humanItems).toHaveLength(1);
  });

  it("실제 Windows smoke checkpoint의 작업공간 경로를 정상적으로 읽는다", () => {
    const evidencePath = String.raw`C:\Users\plosind\AppData\Local\Temp\sakasaka-native-smoke-2nHjyj\workspace\native-smoke.txt`;
    const parsed = parseCheckpoint(JSON.stringify({
      disposition: "equilibrium",
      summary: "native-smoke.txt를 생성하고 다시 읽어 내용이 정확히 일치함을 확인했습니다.",
      remainingWork: [], evidenceRefs: [evidencePath], wakeReasons: [],
    }));
    expect(parsed).toMatchObject({ disposition: "equilibrium", evidenceRefs: [evidencePath] });
  });

  it("checkpoint 스키마와 파서는 공백·한글·Windows 경로를 같은 문자열로 취급한다", () => {
    const evidenceItems = checkpointSchema.properties?.evidenceRefs?.items;
    expect(evidenceItems).toMatchObject({ type: "string", minLength: 1, maxLength: 512 });
    const parsed = parseCheckpoint(JSON.stringify({
      disposition: "equilibrium", summary: "확인", remainingWork: [],
      evidenceRefs: ["한글 파일.txt", String.raw`C:\작업 폴더\결과 파일.txt`, "record with spaces"], wakeReasons: [],
    }));
    expect(parsed?.evidenceRefs).toEqual(["한글 파일.txt", String.raw`C:\작업 폴더\결과 파일.txt`, "record with spaces"]);
  });

  it("checkpoint의 malformed JSON·잘못된 disposition·누락 필드는 계속 거절한다", () => {
    expect(inspectCheckpoint("{malformed")).toMatchObject({ reason: "malformed-json" });
    expect(inspectCheckpoint(JSON.stringify({ disposition: "done", summary: "확인", remainingWork: [], evidenceRefs: [], wakeReasons: [] }))).toMatchObject({ reason: "invalid-disposition" });
    expect(inspectCheckpoint(JSON.stringify({ disposition: "equilibrium", summary: "확인", remainingWork: [], evidenceRefs: [] }))).toMatchObject({ reason: "invalid-wakeReasons" });
  });

  it("checkpoint 형식 오류는 작업 기록을 보존하고 성공한 작업을 자동 재실행하지 않는다", async () => {
    const store = fixture();
    const client = new FakeClient(async (c) => c.finish(JSON.stringify({ disposition: "equilibrium", summary: "파일 작업은 끝났지만", remainingWork: [], evidenceRefs: [] })));
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(getProject(store.read(), "native-test")?.status).toBe("STALLED");
    expect(getRun(store.read(), "native-test")).toMatchObject({ status: "STALLED", retryAfter: undefined, lastModelFailure: { code: "INVALID_OUTPUT", retryable: false, message: expect.stringContaining("invalid-wakeReasons") } });
    expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("checkpoint 참조는 프로젝트 근거·원본 기록·산출물·거절·미해결을 구분한다", async () => {
    const store = fixture();
    await store.transact((s) => ({ ...s, evidence: [...s.evidence,
      { id: "evidence-own", projectId: "native-test", kind: "world", verdict: "PASS", summary: "작업 결과", source: "test", createdAt: new Date().toISOString(), rawRef: "local-raw://own.jsonl" },
      { id: "evidence-other", projectId: "other-project", kind: "world", verdict: "PASS", summary: "다른 프로젝트", source: "test", createdAt: new Date().toISOString() },
    ] }));
    const inside = join(store.root, "한글 폴더", "결과 파일.txt");
    const outside = join(store.root, "..", "outside-result.txt");
    const checkpoint = { disposition: "equilibrium" as const, summary: "확인", remainingWork: [], evidenceRefs: ["evidence-own", "local-raw://own.jsonl", inside, outside, String.raw`artifact:..\탈출.txt`, "https://example.com/result", "git://example.com/result", "evidence-other", "unseen-reference"], wakeReasons: [] };
    const refs = resolveCheckpointReferences(store.read(), "native-test", checkpoint, store.root);
    expect(refs.find((ref) => ref.input === "evidence-own")).toMatchObject({ kind: "evidence", status: "resolved", evidenceId: "evidence-own" });
    expect(refs.find((ref) => ref.input === "local-raw://own.jsonl")).toMatchObject({ kind: "record", status: "resolved", recordRef: "local-raw://own.jsonl" });
    expect(refs.find((ref) => ref.input === inside)).toMatchObject({ kind: "artifact", status: "unverified", relativePath: "한글 폴더/결과 파일.txt" });
    expect(refs.find((ref) => ref.input === outside)).toMatchObject({ status: "rejected", reason: "outside-workspace" });
    expect(refs.find((ref) => ref.input === String.raw`artifact:..\탈출.txt`)).toMatchObject({ status: "rejected", reason: "invalid-path" });
    expect(refs.find((ref) => ref.input === "https://example.com/result")).toMatchObject({ status: "rejected", reason: "external-uri" });
    expect(refs.find((ref) => ref.input === "git://example.com/result")).toMatchObject({ status: "rejected", reason: "external-uri" });
    expect(refs.find((ref) => ref.input === "evidence-other")).toMatchObject({ status: "rejected", reason: "other-project-evidence" });
    expect(refs.find((ref) => ref.input === "unseen-reference")).toMatchObject({ status: "unresolved", reason: "not-found" });
  });

  it("정상 checkpoint의 산출물 참조를 저장하되 파일 경로를 Evidence ID로 승격하지 않는다", async () => {
    const store = fixture();
    const artifact = join(store.root, "결과 파일.txt");
    const client = new FakeClient(async (c) => c.finish(JSON.stringify({ disposition: "equilibrium", summary: "작업공간 산출물을 확인했습니다.", remainingWork: [], evidenceRefs: [artifact], wakeReasons: [] })));
    await runNativeEpisode(store, "native-test", { clientFactory: () => client });
    expect(getProject(store.read(), "native-test")?.status).toBe("EQUILIBRIUM");
    expect(getRun(store.read(), "native-test")?.nativeSession?.checkpointReferences).toMatchObject([{ kind: "artifact", status: "unverified", relativePath: "결과 파일.txt" }]);
    expect(getRun(store.read(), "native-test")?.nativeSession?.checkpointReferences?.[0]?.evidenceId).toBeUndefined();
  });
});
