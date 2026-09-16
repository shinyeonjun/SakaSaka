import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore } from "../src/ports";
import type { EventRecord } from "../src/types";

/** Append-only local event journal used beside the JSON snapshot in development. */
export class JsonlEventStore implements EventStore {
  private readonly ids = new Set<string>();

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line) as Partial<EventRecord>;
        if (typeof event.id === "string") this.ids.add(event.id);
      } catch {
        // A truncated final line is ignored; the snapshot remains authoritative for recovery.
      }
    }
  }

  appendSync(event: EventRecord): EventRecord {
    if (!this.ids.has(event.id) && existsSync(this.filePath)) this.refreshIds();
    if (this.ids.has(event.id)) return event;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    this.ids.add(event.id);
    return event;
  }

  async append(event: EventRecord): Promise<EventRecord> {
    return this.appendSync(event);
  }

  async list(projectId: string, afterCursor?: string): Promise<EventRecord[]> {
    if (!existsSync(this.filePath)) return [];
    const seen = new Set<string>();
    const events = readFileSync(this.filePath, "utf8").split("\n").flatMap((line) => {
      try {
        const event = JSON.parse(line) as EventRecord;
        if (event.projectId !== projectId || typeof event.id !== "string" || seen.has(event.id)) return [];
        seen.add(event.id);
        return [event];
      } catch { return []; }
    }).sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt));
    if (!afterCursor) return events;
    const index = events.findIndex((event) => event.id === afterCursor);
    return index < 0 ? events : events.slice(index + 1);
  }

  private refreshIds(): void {
    try {
      for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
        try {
          const event = JSON.parse(line) as Partial<EventRecord>;
          if (typeof event.id === "string") this.ids.add(event.id);
        } catch {
          // Ignore a truncated final line; the next complete append remains valid.
        }
      }
    } catch {
      // The file may be replaced between existsSync and readFileSync.
    }
  }
}
