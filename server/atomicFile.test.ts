import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";

describe("atomic snapshot persistence", () => {
  it("keeps a recoverable previous snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "intent-world-atomic-"));
    const filePath = join(directory, "state.json");
    try {
      writeJsonAtomically(filePath, { version: 1 });
      writeJsonAtomically(filePath, { version: 2 });
      expect(JSON.parse(readFileSync(`${filePath}.bak`, "utf8"))).toEqual({ version: 1 });
      writeFileSync(filePath, "{broken", "utf8");
      expect(readJsonWithBackup<{ version: number }>(filePath)).toEqual({ version: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips a syntactically valid but structurally invalid primary snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "intent-world-atomic-"));
    const filePath = join(directory, "state.json");
    try {
      writeJsonAtomically(filePath, { projects: [], intents: [], runs: [], events: [] });
      writeJsonAtomically(filePath, { projects: "corrupt", intents: [], runs: [], events: [] });
      expect(readJsonWithBackup<{ projects: unknown }>(filePath, (value) => Array.isArray(value.projects))).toEqual({ projects: [], intents: [], runs: [], events: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
