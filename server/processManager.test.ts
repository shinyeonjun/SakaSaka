import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeProcessTool, stopManagedProcess } from "./processManager";
import type { SandboxContext } from "../src/ports";
import type { ActionEnvelope } from "../src/types";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(tool: "process.start" | "process.status" | "process.stop", params: ActionEnvelope["params"]): ActionEnvelope {
  return { type: "ACT", intentRef: "intent-process", worldCursor: "world-process", rationaleSummary: tool, tool, params };
}

describe("managed process lifecycle", () => {
  it("starts, observes, and stops a real child without shell interpolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-process-"));
    roots.push(root);
    writeFileSync(join(root, "keepalive.js"), "setTimeout(() => {}, 10000);\n", "utf8");
    const sandbox: SandboxContext = { projectId: "process-test", runId: "run-process", permissionClass: "P1", networkPolicy: "deny", allowedDomains: [], workspaceRef: root, mode: "process", processMaxLifetimeMs: 20_000, maxConcurrentProcesses: 1 };
    let processId: string | undefined;
    try {
      const started = await executeProcessTool(action("process.start", { argv: ["node", "keepalive.js"] }), sandbox, 20_000);
      expect(started?.status).toBe("succeeded");
      expect(started?.process?.status).toBe("running");
      processId = started?.process?.id;
      expect(started?.process?.stdoutRawRef).toBeTruthy();
      expect(started?.observations?.[0]?.source).toBe("process");

      const status = await executeProcessTool(action("process.status", { processId: processId ?? "missing" }), sandbox, 20_000);
      expect(status?.status).toBe("succeeded");
      expect(status?.process?.id).toBe(processId);
      expect(status?.process?.status).toBe("running");

      const stopped = await executeProcessTool(action("process.stop", { processId: processId ?? "missing" }), sandbox, 20_000);
      expect(stopped?.status).toBe("succeeded");
      expect(stopped?.process?.status).toBe("stopped");
    } finally {
      if (processId) await stopManagedProcess(processId);
    }
  });
});
