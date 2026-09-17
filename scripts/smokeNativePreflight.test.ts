import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient, RpcRecord } from "../server/codexAppServer";
import { runNativePreflight, shouldRunNativeModel } from "./smokeNativePreflight";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MockAppServer implements AppServerClient {
  readonly calls: string[] = [];
  readonly closed = Promise.resolve(new Error("closed"));

  constructor(private readonly readiness: string = "ready", private readonly commandExitCode = 0) { }
  async start() { }
  async close() { }
  onNotification() { }
  onRequest() { }

  async request(method: string, params: RpcRecord): Promise<unknown> {
    this.calls.push(method);
    if (method === "windowsSandbox/readiness") return { status: this.readiness };
    if (method === "command/exec") {
      const command = Array.isArray(params.command) ? params.command.map(String) : [];
      if (this.commandExitCode === 0) {
        const fileName = command.at(-1);
        const cwd = typeof params.cwd === "string" ? params.cwd : "";
        if (fileName && cwd) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(join(cwd, fileName), "SakaSaka native", "utf8");
        }
      }
      return { exitCode: this.commandExitCode, stdout: this.commandExitCode === 0 ? "SAKASAKA_NODE_OK\n" : "", stderr: "" };
    }
    throw new Error(`unexpected mock request: ${method}`);
  }
}

describe("native smoke preflight", () => {
  it("비Windows에서는 Windows sandbox와 PowerShell을 요구하지 않고 Node 검사는 유지한다", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sakasaka-smoke-preflight-"));
    roots.push(workspace);
    const client = new MockAppServer("notConfigured");

    const result = await runNativePreflight(client, workspace, "linux");

    expect(result.windowsSandbox.status).toBe("not-applicable");
    expect(result.executablesAndWorkspace.powershell.status).toBe("not-applicable");
    expect(result.executablesAndWorkspace.node.passed).toBe(true);
    expect(result.passed).toBe(true);
    expect(client.calls).not.toContain("windowsSandbox/readiness");
    expect(client.calls.filter((method) => method === "command/exec")).toHaveLength(1);
  });

  it("Windows sandbox가 notConfigured이면 실패하고 모델 실행을 허용하지 않는다", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sakasaka-smoke-preflight-"));
    roots.push(workspace);
    const client = new MockAppServer("notConfigured");

    await expect(runNativePreflight(client, workspace, "win32")).rejects.toThrow("Windows sandbox 준비 상태가 ready가 아닙니다");
    expect(client.calls).toEqual(["windowsSandbox/readiness"]);
    if (shouldRunNativeModel(true, { passed: false })) await client.request("turn/start", {});
    expect(shouldRunNativeModel(true, { passed: false })).toBe(false);
    expect(client.calls).not.toContain("turn/start");
  });

  it("공통 Node 사전 검사가 실패하면 모델 실행을 허용하지 않는다", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sakasaka-smoke-preflight-"));
    roots.push(workspace);
    const client = new MockAppServer("notConfigured", 1);

    const result = await runNativePreflight(client, workspace, "darwin");

    expect(result.passed).toBe(false);
    expect(result.windowsSandbox.status).toBe("not-applicable");
    if (shouldRunNativeModel(true, result)) await client.request("turn/start", {});
    expect(shouldRunNativeModel(true, result)).toBe(false);
    expect(client.calls).not.toContain("turn/start");
  });
});
