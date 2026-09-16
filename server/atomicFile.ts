import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Writes a complete snapshot before replacing the visible state file. */
export function writeJsonAtomically(filePath: string, value: unknown, isCurrentValid?: (value: unknown) => boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const recoveryPath = `${filePath}.recover`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  try {
    if (!existsSync(filePath) && existsSync(recoveryPath)) renameSync(recoveryPath, filePath);
    if (existsSync(filePath) && existsSync(recoveryPath)) unlinkSync(recoveryPath);
    if (existsSync(filePath)) {
      let shouldBackup = true;
      if (isCurrentValid) {
        try { shouldBackup = isCurrentValid(JSON.parse(readFileSync(filePath, "utf8"))); } catch { shouldBackup = false; }
      }
      // Never replace a known-good recovery point with a truncated or
      // structurally invalid primary snapshot.
      if (shouldBackup) copyFileSync(filePath, `${filePath}.bak`);
    }
    renameSync(temporaryPath, filePath);
  } catch (error: unknown) {
    // Windows cannot always replace an existing file with renameSync. Keep
    // the previous file as a recovery point while the caller holds the state
    // lock; never remove it before the replacement is ready.
    if (!existsSync(filePath)) throw error;
    try {
      if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
      renameSync(filePath, recoveryPath);
      try { renameSync(temporaryPath, filePath); }
      catch (replacementError: unknown) {
        if (!existsSync(filePath) && existsSync(recoveryPath)) renameSync(recoveryPath, filePath);
        throw replacementError;
      }
      unlinkSync(recoveryPath);
    } catch (replacementError: unknown) {
      if (!existsSync(filePath) && existsSync(recoveryPath)) renameSync(recoveryPath, filePath);
      throw replacementError;
    }
  }
}

/** Reads the primary snapshot and falls back to the last complete backup. */
export function readJsonWithBackup<T>(filePath: string, isValid?: (value: T) => boolean): T | undefined {
  for (const candidate of [filePath, `${filePath}.bak`, `${filePath}.recover`]) {
    if (!existsSync(candidate)) continue;
    try {
      const value = JSON.parse(readFileSync(candidate, "utf8")) as T;
      if (isValid && !isValid(value)) continue;
      return value;
    } catch {
      // Try the next recovery source before failing closed.
    }
  }
  return undefined;
}
