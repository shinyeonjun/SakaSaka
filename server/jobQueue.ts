import { existsSync } from "node:fs";
import { makeId } from "../src/runtime";
import type { JobQueue, RuntimeJob } from "../src/ports";
import { readJsonWithBackup, writeJsonAtomically } from "./atomicFile";

/** Small durable queue for local development; the same contract can be backed by Redis/BullMQ. */
export class JsonJobQueue implements JobQueue {
  private jobs: RuntimeJob[];

  constructor(private readonly filePath: string) {
    this.jobs = [];
    this.reload();
  }

  async enqueue(input: Omit<RuntimeJob, "id" | "attempts" | "availableAt"> & Partial<Pick<RuntimeJob, "id" | "attempts" | "availableAt">>): Promise<RuntimeJob> {
    this.reload();
    const existing = this.jobs.find((job) => job.projectId === input.projectId);
    if (existing) {
      if (!existing.leaseUntil || Date.parse(existing.leaseUntil) <= Date.now()) {
        existing.runId = input.runId;
        existing.trigger = input.trigger;
        if (input.availableAt) {
          const requestedAt = Date.parse(input.availableAt);
          const existingAt = Date.parse(existing.availableAt);
          if (!Number.isFinite(existingAt) || (Number.isFinite(requestedAt) && requestedAt < existingAt)) existing.availableAt = input.availableAt;
        }
        existing.leasedBy = undefined;
        this.persist();
      }
      return { ...existing };
    }
    const job: RuntimeJob = { id: input.id ?? makeId("job"), projectId: input.projectId, runId: input.runId, trigger: input.trigger, attempts: input.attempts ?? 0, availableAt: input.availableAt ?? new Date().toISOString() };
    this.jobs.push(job);
    this.persist();
    return job;
  }

  async lease(workerId: string, leaseMs: number): Promise<RuntimeJob | undefined> {
    this.reload();
    const now = Date.now();
    const job = this.jobs.find((candidate) => Date.parse(candidate.availableAt) <= now && (!candidate.leaseUntil || Date.parse(candidate.leaseUntil) <= now));
    if (!job) return undefined;
    job.leaseUntil = new Date(now + leaseMs).toISOString();
    job.attempts += 1;
    job.leasedBy = workerId;
    this.persist();
    return { ...job };
  }

  async ack(jobId: string, workerId?: string): Promise<void> {
    this.reload();
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || (workerId && job.leasedBy !== workerId)) return;
    this.jobs = this.jobs.filter((candidate) => candidate.id !== jobId);
    this.persist();
  }

  async retry(jobId: string, delayMs: number, workerId?: string): Promise<void> {
    this.reload();
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || (workerId && job.leasedBy !== workerId)) return;
    job.availableAt = new Date(Date.now() + Math.max(1000, delayMs)).toISOString();
    job.leaseUntil = undefined;
    job.leasedBy = undefined;
    this.persist();
  }

  private persist(): void {
    writeJsonAtomically(this.filePath, this.jobs, (value) => Array.isArray(value));
  }

  private reload(): void {
    if (!existsSync(this.filePath)) { this.jobs = []; return; }
    const parsed = readJsonWithBackup<unknown>(this.filePath, (value) => Array.isArray(value));
    this.jobs = Array.isArray(parsed) ? parsed.filter((job): job is RuntimeJob => Boolean(job) && typeof job === "object" && typeof (job as RuntimeJob).id === "string" && typeof (job as RuntimeJob).projectId === "string" && typeof (job as RuntimeJob).runId === "string" && typeof (job as RuntimeJob).trigger === "string" && Number.isFinite((job as RuntimeJob).attempts) && typeof (job as RuntimeJob).availableAt === "string") : [];
  }
}
