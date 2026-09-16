import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isStale(lockPath: string, staleAfterMs: number): boolean {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const owner = JSON.parse(raw) as { pid?: number };
    if (owner.pid === process.pid) return false;
    const lockAge = Date.now() - statSync(lockPath).mtimeMs;
    if (lockAge <= staleAfterMs) return false;
    if (typeof owner.pid !== "number" || owner.pid <= 0) return true;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * A small cross-process lease for the local snapshot fallback. Production can
 * replace this boundary with a database transaction or distributed lock.
 */
export async function withFileLock<T>(filePath: string, work: () => Promise<T> | T, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = Math.max(100, options.timeoutMs ?? 15_000);
  const pollMs = Math.max(10, options.pollMs ?? 40);
  const staleAfterMs = Math.max(timeoutMs, options.staleAfterMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let handle: number | undefined;
  // The lock may be the first writer when the local state directory is new.
  // It is derived from the explicit state file path, never from user input.
  const parent = dirname(filePath);
  // mkdirSync is intentionally local and bounded to the lock's parent.
  mkdirSync(parent, { recursive: true });

  while (Date.now() < deadline) {
    try {
      handle = openSync(filePath, "wx");
      writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      break;
    } catch {
      if (existsSync(filePath) && isStale(filePath, staleAfterMs)) {
        try { unlinkSync(filePath); } catch { /* another waiter owns the race */ }
      }
      await wait(pollMs);
    }
  }

  if (handle === undefined) throw new Error(`timed out waiting for local state lock: ${filePath}`);
  try {
    return await work();
  } finally {
    try { closeSync(handle); } catch { /* already closed */ }
    try { unlinkSync(filePath); } catch { /* lock was already reclaimed */ }
  }
}
