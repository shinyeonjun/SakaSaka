import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeWorkspaceTool } from "./workspaceTools";
import type { SandboxContext } from "../src/ports";
import type { ActionEnvelope } from "../src/types";

const roots: string[] = [];
const previousRawDirectory = process.env.INTENT_WORLD_RAW_DIR;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousRawDirectory === undefined) delete process.env.INTENT_WORLD_RAW_DIR;
  else process.env.INTENT_WORLD_RAW_DIR = previousRawDirectory;
});

function sandbox(workspaceRef: string): SandboxContext {
  process.env.INTENT_WORLD_RAW_DIR = join(workspaceRef, "raw");
  return { projectId: "workspace-test", runId: "run-test", permissionClass: "P1", networkPolicy: "allowlist", allowedDomains: ["registry.npmjs.org"], workspaceRef, mode: "process" };
}

function action(tool: string, params: ActionEnvelope["params"]): ActionEnvelope {
  return { type: "ACT", intentRef: "intent-test", worldCursor: "world-test", rationaleSummary: `test ${tool}`, tool, params };
}

describe("workspace modification capabilities", () => {
  it("lists, reads, and writes only bounded workspace content", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-tools-"));
    roots.push(root);
    const context = sandbox(root);
    const written = await executeWorkspaceTool(action("workspace.write", { path: "src/app.ts", content: "export const value = 1;\n" }), context);
    expect(written?.status).toBe("succeeded");
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toContain("value = 1");
    expect(written?.changedPaths).toEqual(["src/app.ts"]);
    expect(written?.evidence[0]?.rawRef).toBeTruthy();

    const read = await executeWorkspaceTool(action("workspace.read", { path: "src/app.ts", lineStart: 1, lineEnd: 1 }), context);
    expect(read?.status).toBe("succeeded");
    expect(read?.output).toContain("export const value = 1");
    const listed = await executeWorkspaceTool(action("workspace.list", { depth: 3, maxEntries: 20 }), context);
    expect(listed?.status).toBe("succeeded");
    expect(listed?.output).toContain("src/app.ts");
  });

  it("requires explicit overwrite and blocks workspace escape", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-tools-"));
    const outside = mkdtempSync(join(tmpdir(), "intent-world-outside-"));
    roots.push(root, outside);
    const context = sandbox(root);
    writeFileSync(join(root, "existing.txt"), "before", "utf8");
    const withoutOverwrite = await executeWorkspaceTool(action("workspace.write", { path: "existing.txt", content: "after" }), context);
    expect(withoutOverwrite?.status).toBe("blocked");
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("before");
    const escaped = await executeWorkspaceTool(action("workspace.read", { path: "../outside.txt" }), context);
    expect(escaped?.status).toBe("failed");
    expect(existsSync(join(outside, "outside.txt"))).toBe(false);
  });

  it("validates every patch target before applying any file change", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-tools-"));
    roots.push(root);
    const context = sandbox(root);
    writeFileSync(join(root, "a.txt"), "one\n", "utf8");
    writeFileSync(join(root, "b.txt"), "two\n", "utf8");
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-wrong\n+TWO\n";
    const result = await executeWorkspaceTool(action("workspace.patch", { patch }), context);
    expect(result?.status).toBe("failed");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("two\n");
  });

  it("records a backup and tracked flag for deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-tools-"));
    roots.push(root);
    const context = sandbox(root);
    writeFileSync(join(root, "remove.txt"), "recoverable", "utf8");
    const result = await executeWorkspaceTool(action("workspace.delete", { path: "remove.txt" }), context);
    expect(result?.status).toBe("succeeded");
    expect(existsSync(join(root, "remove.txt"))).toBe(false);
    expect(result?.output).toContain("backupRef");
    expect(result?.evidence[0]?.metadata?.tracked).toBe(false);
  });
});
