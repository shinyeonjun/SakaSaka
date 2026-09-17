import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject, getWorldSnapshot, recordNonToolAction } from "../src/runtime";
import type { AppState } from "../src/types";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
  if (!port) throw new Error("Vite 포트를 확보하지 못했습니다.");
  return port;
}

async function waitForVite(baseUrl: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite가 UI 준비 전에 종료되었습니다: ${logs.join("")}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite 상태 확인 시간이 초과되었습니다: ${logs.join("")}`);
}

async function open(page: Page, baseUrl: string, path: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  assert.ok(response?.ok(), `${path} 로드 실패`);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { documentElement: { clientWidth: number; scrollWidth: number } } }).document;
    return { clientWidth: doc.documentElement.clientWidth, scrollWidth: doc.documentElement.scrollWidth };
  });
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label} 가로 overflow: ${JSON.stringify(dimensions)}`);
}

function dynamicQuestionState(): AppState {
  const projectId = "ui-acceptance-project";
  let state = createProject(createEmptyState(), "사용자 기준에 맞는 품질 확인 화면을 만들어줘", projectId, { modelProvider: "deterministic" });
  const project = getProject(state, projectId)!;
  state = recordNonToolAction(state, projectId, {
    type: "QUESTION",
    intentRef: project.intentId,
    worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId,
    rationaleSummary: "검증 기준을 선택해 주세요",
    riskClass: "P2",
    params: { options: ["첫 번째 기준", "두 번째 기준"], blockingScope: ["사용자 기준"], continuingScope: ["독립 관찰"] },
  });
  return state;
}

function seedState(state: AppState): void {
  const storage = (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
  storage.setItem("intent-world-agent-state-v2", JSON.stringify(state));
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close();
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(process.execPath, [resolve(repoRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  try {
    await waitForVite(baseUrl, child, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.SAKASAKA_BROWSER_EXECUTABLE ? { executablePath: process.env.SAKASAKA_BROWSER_EXECUTABLE } : {}) });

    // Intent-first empty/new-project UX.
    const newContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(newContext);
    const newPage = await newContext.newPage();
    await open(newPage, baseUrl, "/projects/new");
    await assertNoHorizontalOverflow(newPage, "신규 프로젝트 데스크톱");
    assert.equal(await newPage.getByRole("heading", { name: "원하는 결과만 말해 주세요", exact: true }).count(), 1);
    assert.equal(await newPage.getByLabel("원하는 결과").count(), 1, "Intent 입력이 없습니다.");
    assert.equal(await newPage.getByText("강한 기본값", { exact: true }).count(), 1, "강한 기본값 요약이 없습니다.");
    assert.equal(await newPage.getByText("데스크톱 앱에서 자동 준비", { exact: true }).count(), 1, "브라우저 모드 Codex 준비 안내가 없습니다.");

    // Global settings: model preference remains reusable between projects.
    await newPage.getByRole("button", { name: "환경 설정", exact: true }).click();
    await newPage.waitForURL(/\/settings$/);
    assert.equal(await newPage.getByRole("heading", { name: "환경 설정", exact: true }).count(), 1);
    await newPage.getByLabel("연결 방식").selectOption("codex-cli");
    await newPage.getByLabel("모델").fill("configured-test-model");
    await newPage.getByRole("button", { name: "기본값 저장" }).click();
    assert.equal(await newPage.getByText("저장됨", { exact: true }).count() > 0, true);
    await newPage.getByRole("button", { name: "새 프로젝트", exact: true }).click();
    await newPage.waitForURL(/\/projects\/new$/);

    // Browser-only mode keeps atomic compatibility, while remembering model preference.
    await newPage.getByRole("button", { name: "고급 설정", exact: true }).click();
    const executionRow = newPage.locator(".advanced-setting-row").filter({ hasText: "실행 방식" });
    assert.equal(await executionRow.locator("select").inputValue(), "atomic", "브라우저 모드에서 지속형 데스크톱 실행을 강제하면 안 됩니다.");
    assert.equal(await newPage.locator(".model-picker input").inputValue(), "configured-test-model", "저장된 모델 기본값이 새 프로젝트에 적용되지 않았습니다.");
    await newPage.getByLabel("원하는 결과").fill("팀이 함께 사용할 수 있는 품질 검증 workspace를 만들어줘");
    await newPage.getByRole("button", { name: "프로젝트 시작", exact: true }).click();
    await newPage.waitForURL(/\/projects\/[^/]+$/);
    const createdProjectPath = new URL(newPage.url()).pathname;
    await assertNoHorizontalOverflow(newPage, "생성된 프로젝트 데스크톱");
    assert.equal(await newPage.getByRole("heading").count() > 0, true);

    // A fixture with an asynchronous human question must remain operable.
    const fixtureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(fixtureContext);
    const desktop = await fixtureContext.newPage();
    await fixtureContext.addInitScript(seedState, dynamicQuestionState());
    const projectPath = "/projects/ui-acceptance-project";
    await open(desktop, baseUrl, projectPath);
    await assertNoHorizontalOverflow(desktop, "프로젝트 개요 데스크톱");
    assert.equal(await desktop.getByText("제어 센터", { exact: true }).count() > 0, true, "새 데스크톱 shell의 제어 센터 탐색이 없습니다.");

    await open(desktop, baseUrl, `${projectPath}/needs-you`);
    for (const label of [/질문 1/, /아이디어 0/, /우려 0/, /승인 0/]) assert.equal(await desktop.getByRole("tab", { name: label }).count(), 1, `사람 개입 필터 누락: ${label}`);
    await desktop.getByRole("button", { name: "나중에" }).click();
    assert.equal(await desktop.getByText("나중에 답변 가능").count(), 1);
    await desktop.getByRole("button", { name: "답변하기" }).click();
    await desktop.locator("label").filter({ hasText: "두 번째 기준" }).click();
    await desktop.getByRole("button", { name: "답변 저장" }).click();
    assert.equal(await desktop.getByText("저장됨").count(), 1);

    for (const [path, heading] of [
      [`${projectPath}/activity`, "활동 / 월드"],
      [`${projectPath}/world`, "현재 월드"],
      [`${projectPath}/artifacts`, "산출물"],
      [`${projectPath}/experiments`, "실험"],
      [`${projectPath}/settings`, "프로젝트 설정"],
    ] as const) {
      await open(desktop, baseUrl, path);
      await assertNoHorizontalOverflow(desktop, `${heading} 데스크톱`);
      assert.equal(await desktop.getByRole("heading", { name: heading, exact: true }).count(), 1, `${heading} 누락`);
    }

    // Existing project settings and delete flow remain functional.
    await open(newPage, baseUrl, `${createdProjectPath}/settings`);
    await newPage.getByLabel("모델 연결 방식").selectOption("codex-cli");
    await newPage.getByPlaceholder("목록에 없는 모델 ID 직접 입력").fill("configured-third-model");
    await newPage.getByRole("button", { name: "모델 설정 저장" }).click();
    assert.equal(await newPage.getByText("저장 요청됨").count(), 1);
    newPage.once("dialog", (dialog) => { void dialog.accept(); });
    await newPage.getByRole("button", { name: "이 프로젝트 삭제" }).click();
    await newPage.waitForURL(/\/projects\/new$/);
    assert.equal(await newPage.getByRole("heading", { name: "원하는 결과만 말해 주세요", exact: true }).count(), 1);

    // Mobile shell must not introduce horizontal overflow even though desktop is primary.
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(mobileContext);
    const mobile = await mobileContext.newPage();
    await mobileContext.addInitScript(seedState, dynamicQuestionState());
    for (const path of ["/projects/new", projectPath, `${projectPath}/needs-you`, `${projectPath}/world`, `${projectPath}/experiments`]) {
      await open(mobile, baseUrl, path);
      await assertNoHorizontalOverflow(mobile, `${path} 모바일`);
    }

    console.log("UI acceptance passed: desktop v2 shell, intent-first project creation, reusable model defaults, async human question flow, routes, and responsive overflow");
  } finally {
    for (const context of contexts.reverse()) await closeContext(context);
    await browser?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      child.once("exit", () => resolvePromise());
      setTimeout(resolvePromise, 2_000);
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
