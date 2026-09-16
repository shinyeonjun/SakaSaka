import { existsSync, readFileSync } from "node:fs";
import { makeId } from "../src/runtime";
import type { JobQueue, RuntimeJob } from "../src/ports";
import { writeJsonAtomically } from "./atomicFile";

/** Small durable queue for local development; the same contract can be backed by Redis/BullMQ. */
export class JsonJobQueue implements JobQueue {
  private jobs: RuntimeJob[];

  constructor(private readonly filePath: string) {
    try { this.jobs = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as RuntimeJob[] : []; } catch { this.jobs = []; }
    if (!Array.isArray(this.jobs)) this.jobs = [];
    this.jobs = this.jobs.filter((job) => typeof job?.id === "string" && typeof job.projectId === "string" && typeof job.runId === "string" && typeof job.trigger === "string" && Number.isFinite(job.attempts) && typeof job.availableAt === "string");
  }

  async enqueue(input: Omit<RuntimeJob, "id" | "attempts" | "availableAt"> & Partial<Pick<RuntimeJob, "id" | "attempts" | "availableAt">>): Promise<RuntimeJob> {
    const existing = this.jobs.find((job) => job.projectId === input.projectId);
    if (existing) {
      if (!existing.leaseUntil || Date.parse(existing.leaseUntil) <= Date.now()) {
        existing.runId = input.runId;
        existing.trigger = input.trigger;
        existing.availableAt = input.availableAt ?? existing.availableAt;
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
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || (workerId && job.leasedBy !== workerId)) return;
    this.jobs = this.jobs.filter((candidate) => candidate.id !== jobId);
    this.persist();
  }

  async retry(jobId: string, delayMs: number, workerId?: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || (workerId && job.leasedBy !== workerId)) return;
    job.availableAt = new Date(Date.now() + Math.max(1000, delayMs)).toISOString();
    job.leaseUntil = undefined;
    job.leasedBy = undefined;
    this.persist();
  }

  private persist(): void {
    writeJsonAtomically(this.filePath, this.jobs);
  }
}
