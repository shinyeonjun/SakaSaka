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
    } catch {
      // Vite가 아직 포트를 여는 중일 수 있습니다.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite 상태 확인 시간이 초과되었습니다: ${logs.join("")}`);
}

async function open(page: Page, baseUrl: string, path: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  assert.ok(response?.ok(), `${path} 로드 실패`);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: (globalThis as unknown as { document: { documentElement: { clientWidth: number; scrollWidth: number } } }).document.documentElement.clientWidth,
    scrollWidth: (globalThis as unknown as { document: { documentElement: { clientWidth: number; scrollWidth: number } } }).document.documentElement.scrollWidth,
  }));
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
    browser = await chromium.launch({ headless: true });

    const newContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(newContext);
    const newPage = await newContext.newPage();
    await open(newPage, baseUrl, "/projects/new");
    await assertNoHorizontalOverflow(newPage, "신규 프로젝트 데스크톱");
    assert.equal(await newPage.getByLabel("작업 폴더 경로").isDisabled(), true, "브라우저 전용 모드가 OS 폴더를 연결하면 안 됩니다.");
    await newPage.getByRole("button", { name: "고급 설정" }).click();
    await newPage.getByLabel("모델 연결 방식").selectOption("codex-cli");
    assert.equal(await newPage.getByLabel("모델 ID").count(), 1, "Codex 모델 선택 입력이 없습니다.");
    await newPage.getByLabel("모델 ID").fill("configured-codex-model");
    await newPage.getByLabel("의도").fill("팀이 함께 사용할 수 있는 품질 검증 workspace를 만들어줘");
    await newPage.getByRole("button", { name: "시작하기" }).click();
    await newPage.waitForURL(/\/projects\/[^/]+$/);
    await assertNoHorizontalOverflow(newPage, "생성된 프로젝트 데스크톱");
    assert.equal(await newPage.getByRole("heading").count() > 0, true);

    const fixtureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(fixtureContext);
    const desktop = await fixtureContext.newPage();
    await fixtureContext.addInitScript((state: AppState) => (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem("intent-world-agent-state-v2", JSON.stringify(state)), dynamicQuestionState());
    const projectPath = "/projects/ui-acceptance-project";
    await open(desktop, baseUrl, projectPath);
    await assertNoHorizontalOverflow(desktop, "프로젝트 개요 데스크톱");
    assert.equal(await desktop.getByRole("heading").count() > 0, true);

    await open(desktop, baseUrl, `${projectPath}/needs-you`);
    for (const label of [/질문 1/, /아이디어 0/, /우려 0/, /승인 0/]) assert.equal(await desktop.getByRole("tab", { name: label }).count(), 1, `도움 필요 필터 누락: ${label}`);
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
    await open(desktop, baseUrl, `${projectPath}/activity`);
    assert.equal(await desktop.getByText("증거 연결").count(), 1);
    await open(desktop, baseUrl, `${projectPath}/world`);
    assert.equal(await desktop.getByText("런타임 경계").count(), 1);
    await open(desktop, baseUrl, `${projectPath}/settings`);
    assert.equal(await desktop.getByRole("heading", { name: "프로젝트 설정", exact: true }).count(), 1);

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(mobileContext);
    const mobile = await mobileContext.newPage();
    await mobileContext.addInitScript((state: AppState) => (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem("intent-world-agent-state-v2", JSON.stringify(state)), dynamicQuestionState());
    for (const path of ["/projects/new", projectPath, `${projectPath}/needs-you`, `${projectPath}/world`, `${projectPath}/experiments`]) {
      await open(mobile, baseUrl, path);
      await assertNoHorizontalOverflow(mobile, `${path} 모바일`);
    }

    console.log("UI acceptance passed: 빈 초기 상태, 실제 프로젝트 생성, dynamic Question defer/재답변, 전체 route, 데스크톱·390px 레이아웃");
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
