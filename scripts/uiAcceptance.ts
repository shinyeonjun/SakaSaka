import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
  if (!port) throw new Error("could not reserve a Vite port");
  return port;
}

async function waitForVite(baseUrl: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before the UI was ready: ${logs.join("")}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite may still be binding its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite health check timed out: ${logs.join("")}`);
}

async function open(page: Page, baseUrl: string, path: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  assert.ok(response?.ok(), `failed to load ${path}`);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: (globalThis as unknown as { document: { documentElement: { clientWidth: number } } }).document.documentElement.clientWidth,
    scrollWidth: (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label} overflows horizontally: ${JSON.stringify(dimensions)}`);
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close();
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(process.execPath, [resolve(repoRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    await assertNoHorizontalOverflow(newPage, "New Project desktop");
    await newPage.getByLabel("Intent").fill("팀이 함께 사용할 수 있는 품질 검증 workspace를 만들어줘");
    await newPage.getByRole("button", { name: "시작하기" }).click();
    await newPage.waitForURL(/\/projects\/[^/]+$/);
    await assertNoHorizontalOverflow(newPage, "created project desktop");

    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(desktopContext);
    const desktop = await desktopContext.newPage();
    await open(desktop, baseUrl, "/projects/project-trip-together");
    await assertNoHorizontalOverflow(desktop, "Overview desktop");
    await assert.equal(await desktop.getByRole("heading", { name: "TripTogether" }).count(), 1);
    await assert.equal(await desktop.getByRole("button", { name: "한 cycle 실행" }).count(), 0);

    await open(desktop, baseUrl, "/projects/project-trip-together/needs-you");
    for (const label of [/Questions 1/, /Ideas 2/, /Concerns 1/, /Approvals 1/]) {
      assert.equal(await desktop.getByRole("tab", { name: label }).count(), 1, `missing Needs You filter ${label}`);
    }
    await desktop.getByRole("button", { name: "답변하기" }).click();
    await desktop.locator("label").filter({ hasText: "여행 생성자만 초대 가능" }).click();
    await desktop.getByRole("button", { name: "답변 저장" }).click();
    await assert.equal(await desktop.getByText("저장됨").count(), 1);

    for (const [path, heading] of [
      ["/projects/project-trip-together/activity", "Activity / World"],
      ["/projects/project-trip-together/world", "Current World"],
      ["/projects/project-trip-together/artifacts", "Artifacts"],
      ["/projects/project-trip-together/experiments", "Experiments"],
    ] as const) {
      await open(desktop, baseUrl, path);
      await assertNoHorizontalOverflow(desktop, `${heading} desktop`);
      assert.equal(await desktop.getByRole("heading", { name: heading }).count(), 1, `missing ${heading}`);
    }
    await open(desktop, baseUrl, "/projects/project-trip-together/activity");
    assert.equal(await desktop.getByText("Evidence Chain").count(), 1);
    await open(desktop, baseUrl, "/projects/project-trip-together/world");
    assert.equal(await desktop.getByText("Runtime Boundary").count(), 1);

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(mobileContext);
    const mobile = await mobileContext.newPage();
    for (const path of ["/projects/new", "/projects/project-trip-together", "/projects/project-trip-together/needs-you", "/projects/project-trip-together/world", "/projects/project-trip-together/experiments"]) {
      await open(mobile, baseUrl, path);
      await assertNoHorizontalOverflow(mobile, `${path} mobile`);
    }

    console.log("UI acceptance passed: routes, human answer flow, desktop layout, and 390px responsive overflow checks");
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
