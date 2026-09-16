import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { normalizeWorkspacePath } from "./pathPolicy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace path policy", () => {
  it("accepts the configured workspace and rejects paths outside it", () => {
    const previous = process.env.WORKSPACE_ROOT;
    const root = mkdtempSync(join(tmpdir(), "intent-world-workspace-"));
    roots.push(root);
    process.env.WORKSPACE_ROOT = root;
    try {
      const inside = normalizeWorkspacePath(join(root, "future-project"));
      expect(inside).toBe(resolve(root, "future-project"));
      expect(normalizeWorkspacePath(resolve(root, "..", "outside-project"))).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = previous;
    }
  });

  it("rejects a future path whose existing parent is a symlink outside the root when supported", () => {
    const previous = process.env.WORKSPACE_ROOT;
    const root = mkdtempSync(join(tmpdir(), "intent-world-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "intent-world-outside-"));
    roots.push(root, outside);
    process.env.WORKSPACE_ROOT = root;
    const link = join(root, "linked");
    try {
      mkdirSync(link);
      rmSync(link, { recursive: true, force: true });
      try {
        // Windows may deny symlink creation in an unprivileged test runner.
        symlinkSync(outside, link, "junction");
      } catch {
        return;
      }
      expect(normalizeWorkspacePath(join(link, "future-project"))).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = previous;
    }
  });
});
