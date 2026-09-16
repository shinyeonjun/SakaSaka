import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonJobQueue } from "./jobQueue";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable runtime job queue", () => {
  it("deduplicates a project and leases/acks the durable job", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-queue-"));
    tempRoots.push(root);
    const queue = new JsonJobQueue(join(root, "queue.json"));
    const first = await queue.enqueue({ projectId: "project-1", runId: "run-1", trigger: "intent" });
    const duplicate = await queue.enqueue({ projectId: "project-1", runId: "run-1", trigger: "manual" });
    expect(duplicate.id).toBe(first.id);
    const leased = await queue.lease("worker-1", 10_000);
    expect(leased?.projectId).toBe("project-1");
    expect((await queue.lease("worker-2", 10_000))).toBeUndefined();
    await queue.ack(first.id);
    expect((await queue.lease("worker-1", 10_000))).toBeUndefined();
  });

  it("makes a failed job available again after retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-queue-"));
    tempRoots.push(root);
    const queue = new JsonJobQueue(join(root, "queue.json"));
    const job = await queue.enqueue({ projectId: "project-2", runId: "run-2", trigger: "incident" });
    await queue.lease("worker-1", 10_000);
    await queue.retry(job.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect((await queue.lease("worker-2", 10_000))?.projectId).toBe("project-2");
  });

  it("does not let another worker acknowledge or retry an active lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-world-queue-"));
    tempRoots.push(root);
    const queue = new JsonJobQueue(join(root, "queue.json"));
    const job = await queue.enqueue({ projectId: "project-3", runId: "run-3", trigger: "manual" });
    await queue.lease("worker-owner", 10_000);
    await queue.ack(job.id, "worker-other");
    expect((await queue.lease("worker-other", 10_000))).toBeUndefined();
    await queue.retry(job.id, 1, "worker-other");
    expect((await queue.lease("worker-other", 10_000))).toBeUndefined();
    await queue.ack(job.id, "worker-owner");
    expect((await queue.lease("worker-owner", 10_000))).toBeUndefined();
  });
});
