import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalToolGateway } from "./localAdapters";
import type { SandboxContext } from "../src/ports";
import type { ActionEnvelope } from "../src/types";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local repo adapter", () => {
  it("returns the actual bounded git diff as evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-repo-"));
    roots.push(root);
    await execFileAsync("git", ["init"], { cwd: root, windowsHide: true, shell: false });
    writeFileSync(join(root, "app.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "app.txt"], { cwd: root, windowsHide: true, shell: false });
    await execFileAsync("git", ["-c", "user.name=Intent World Test", "-c", "user.email=intent-world@example.test", "commit", "-m", "initial"], { cwd: root, windowsHide: true, shell: false });
    writeFileSync(join(root, "app.txt"), "after\n", "utf8");

    const sandbox: SandboxContext = { projectId: "repo-test", runId: "run-repo", permissionClass: "P0", networkPolicy: "deny", allowedDomains: [], workspaceRef: root, mode: "process" };
    const action: ActionEnvelope = { type: "ACT", intentRef: "intent-repo", worldCursor: "world-repo", rationaleSummary: "inspect current changes", tool: "repo.read", params: { commandId: "repo-diff" } };
    const result = await new LocalToolGateway().execute(action, sandbox);

    expect(result.status).toBe("succeeded");
    expect(result.evidence[0]?.verdict).toBe("PASS");
    expect(result.output).toContain("after");
    expect(result.evidence[0]?.source).toBe("local-command:repo-diff");
  });
});
