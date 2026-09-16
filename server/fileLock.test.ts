import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock } from "./fileLock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local state lock", () => {
  it("serializes concurrent writers and releases after an exception", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-lock-"));
    roots.push(root);
    const lockPath = join(root, "state.lock");
    const order: string[] = [];
    const first = withFileLock(lockPath, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push("first:end");
      return "first";
    });
    const second = withFileLock(lockPath, async () => {
      order.push("second:start");
      return "second";
    });
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    await expect(withFileLock(lockPath, () => { throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(withFileLock(lockPath, () => "recovered")).resolves.toBe("recovered");
  });
});
