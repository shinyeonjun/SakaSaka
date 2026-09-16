import { describe, it, expect } from "vitest";
import { runCommand } from "./commandRunner";

describe("cancellable command runner", () => {
  it("retains actual output and exit status", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('실제 출력'); process.exit(7)"], { cwd: process.cwd() });
    expect(result.code).toBe(7); expect(result.stdout).toContain("실제 출력");
  });
  it("cancels a command rather than waiting for its normal exit", async () => {
    const controller = new AbortController();
    const result = runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 60);
    expect(await result).toMatchObject({ code: 1, cancelled: true });
  });
  it("terminates output overflow and keeps a bounded log", async () => {
    const result = await runCommand(process.execPath, ["-e", "setInterval(()=>console.log('X'.repeat(1000)),1)"], { cwd: process.cwd(), maxBytes: 4096 });
    expect(result.code).toBe(1); expect(result.errorCode).toBe("OUTPUT_LIMIT"); expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });
});
