import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeId } from "../src/runtime";
import { redactSecretLikeText } from "../src/security";
import type { ObservabilitySink } from "../src/ports";

function safeAttributes(attributes: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" ? redactSecretLikeText(value).slice(0, 500) : value]));
}

export class JsonlObservabilitySink implements ObservabilitySink {
  constructor(private readonly filePath = process.env.OTEL_LOCAL_FILE ?? ".data/observability.jsonl") {}

  span(name: string, attributes: Record<string, string | number | boolean>) {
    const startedAt = Date.now();
    const spanId = makeId("span");
    this.write({ kind: "span.start", spanId, name, startedAt: new Date(startedAt).toISOString(), attributes: safeAttributes(attributes) });
    return {
      end: (endAttributes: Record<string, string | number | boolean> = {}) => this.write({ kind: "span.end", spanId, name, endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, attributes: safeAttributes(endAttributes) }),
    };
  }

  metric(name: string, value: number, attributes: Record<string, string | number | boolean> = {}): void {
    this.write({ kind: "metric", metric: name, value, recordedAt: new Date().toISOString(), attributes: safeAttributes(attributes) });
  }

  private write(value: unknown): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(value)}\n`, "utf8");
  }
}
