import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Writes a complete snapshot before replacing the visible state file. */
export function writeJsonAtomically(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  try {
    if (existsSync(filePath)) copyFileSync(filePath, `${filePath}.bak`);
    renameSync(temporaryPath, filePath);
  } catch (error: unknown) {
    // Windows cannot always replace an existing file with renameSync. The
    // caller holds the state lock, so this short replacement is recoverable.
    if (!existsSync(filePath)) throw error;
    unlinkSync(filePath);
    renameSync(temporaryPath, filePath);
  }
}

/** Reads the primary snapshot and falls back to the last complete backup. */
export function readJsonWithBackup<T>(filePath: string, isValid?: (value: T) => boolean): T | undefined {
  for (const candidate of [filePath, `${filePath}.bak`]) {
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
