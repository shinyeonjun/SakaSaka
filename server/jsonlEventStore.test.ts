import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlEventStore } from "./jsonlEventStore";
import type { EventRecord } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(id: string, sequence: number, projectId = "project-1"): EventRecord {
  return { id, sequence, projectId, type: "MODEL_TURN", actor: "agent", summary: id, createdAt: new Date(1_000 + sequence).toISOString(), schemaVersion: 1 };
}

describe("append-only event journal", () => {
  it("deduplicates events across store instances and resumes after a cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-events-"));
    roots.push(root);
    const path = join(root, "events.jsonl");
    const first = new JsonlEventStore(path);
    await first.append(event("event-2", 2));
    const second = new JsonlEventStore(path);
    await second.append(event("event-1", 1));
    await second.append(event("event-2", 2));
    await second.append(event("other", 3, "project-2"));
    expect((await first.list("project-1")).map((item) => item.id)).toEqual(["event-1", "event-2"]);
    expect((await first.list("project-1", "event-1")).map((item) => item.id)).toEqual(["event-2"]);
  });
});
