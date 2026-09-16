import { runCommand } from "./commandRunner";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAllowedNetworkHost, redactSecretLikeText } from "../src/security";
import type { SandboxContext, ToolResult } from "../src/ports";
import type { ActionEnvelope, Evidence, Observation } from "../src/types";

const execFileAsync = promisify(execFile);
const maxReadBytes = 512 * 1024;
const maxWriteBytes = 512 * 1024;
const maxListEntries = 2_000;
const commandTimeoutMs = 120_000;
const maxOutputBytes = 256 * 1024;

interface WorkspaceTarget {
  absolute: string;
  relative: string;
}

interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function rawOutputPath(key: string, extension: "txt" | "json" = "txt"): { path: string; rawRef: string } {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const fileName = `${Date.now()}-${safeKey}.${extension}`;
  const directory = resolve(process.cwd(), process.env.INTENT_WORLD_RAW_DIR ?? ".data/raw");
  mkdirSync(directory, { recursive: true });
  return { path: resolve(directory, fileName), rawRef: `local-raw://${fileName}` };
}

function persistRaw(key: string, value: string, extension: "txt" | "json" = "txt"): string {
  const target = rawOutputPath(key, extension);
  writeFileSync(target.path, redactSecretLikeText(value).slice(0, maxOutputBytes), "utf8");
  return target.rawRef;
}

function workspaceRoot(sandbox: SandboxContext): string {
  const configured = resolve(sandbox.workspaceRef);
  if (!existsSync(configured)) throw new Error("workspace does not exist");
  const resolved = realpathSync.native(configured);
  if (!statSync(resolved).isDirectory()) throw new Error("workspace is not a directory");
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !/^[a-zA-Z]:/.test(distance));
}

function pathInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw new Error("workspace path must be a bounded non-empty string");
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").some((part) => part === "..")) throw new Error("workspace path must be relative and cannot escape the workspace");
  return normalized;
}

function resolveTarget(sandbox: SandboxContext, value: unknown, allowMissing = false): WorkspaceTarget {
  const root = workspaceRoot(sandbox);
  const normalized = pathInput(value);
  const absolute = resolve(root, normalized);
  if (!isInside(root, absolute)) throw new Error("workspace path escapes the workspace root");
  if (existsSync(absolute)) {
    const real = realpathSync.native(absolute);
    if (!isInside(root, real)) throw new Error("workspace symlink escapes the workspace root");
  } else if (!allowMissing) {
    throw new Error("workspace path does not exist");
  } else {
    let ancestor = dirname(absolute);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("workspace parent does not exist");
      ancestor = parent;
    }
    if (!isInside(root, realpathSync.native(ancestor))) throw new Error("workspace parent symlink escapes the workspace root");
  }
  return { absolute, relative: normalized };
}

function evidence(projectId: string, kind: Evidence["kind"], verdict: Evidence["verdict"], summary: string, source: string, rawRef?: string, metadata?: Evidence["metadata"]): Evidence {
  return { id: `evidence-workspace-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, projectId, kind, verdict, summary: redactSecretLikeText(summary).slice(0, 4_000), source, createdAt: new Date().toISOString(), rawRef, evaluator: "local-tool-contract", evaluatorVersion: "workspace-tool-0.1", metadata };
}

function observation(projectId: string, runId: string, compactView: string, rawRef: string, status: Observation["status"] = "healthy"): Observation {
  return { id: `observation-workspace-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, projectId, source: "workspace", status, observedAt: new Date().toISOString(), freshness: "fresh", rawRef, compactView: redactSecretLikeText(compactView).slice(0, 4_000), trustLevel: "observed", confidence: status === "healthy" ? 0.92 : 0.35, relatedEntities: [runId] };
}

function result(sandbox: SandboxContext, summary: string, ev: Evidence, output: string, progress: "meaningful" | "none", changedPaths: string[] = [], observations: Observation[] = []): ToolResult {
  return { tool: "workspace", toolVersion: "workspace-tool-0.1", status: ev.verdict === "FAIL" ? "failed" : "succeeded", outputRef: `tool://${sandbox.projectId}/${sandbox.runId}/workspace/${Date.now()}`, summary, evidence: [ev], cost: 0.08, wallTimeMs: 0, output: redactSecretLikeText(output).slice(0, maxOutputBytes), progress, changedPaths, observations };
}

function blocked(sandbox: SandboxContext, tool: string, reason: string): ToolResult {
  return { tool, toolVersion: "workspace-tool-0.1", status: "blocked", outputRef: `tool://${sandbox.projectId}/${sandbox.runId}/blocked/${Date.now()}`, summary: `BLOCKED · ${reason}`, evidence: [], cost: 0, wallTimeMs: 0, blockedReason: reason, output: "", progress: "none" };
}

function listTree(root: string, current: string, depth: number, maxEntries: number, output: Array<Record<string, string | number>>): void {
  if (output.length >= maxEntries || depth < 0) return;
  const entries = requireDirectoryEntries(current);
  for (const entry of entries) {
    if (output.length >= maxEntries) break;
    const absolute = resolve(current, entry);
    const relativePath = relative(root, absolute).replace(/\\/g, "/");
    let stats: ReturnType<typeof statSync>;
    try { stats = lstatSync(absolute); } catch { continue; }
    if (stats.isSymbolicLink()) {
      let target = "outside-or-unreadable";
      try { target = isInside(root, realpathSync.native(absolute)) ? "symlink-inside-root" : "symlink-outside-root"; } catch { /* keep safe label */ }
      output.push({ path: relativePath, kind: "symlink", size: 0, detail: target });
      continue;
    }
    if (stats.isDirectory()) {
      output.push({ path: relativePath, kind: "directory", size: 0 });
      if (depth > 0) listTree(root, absolute, depth - 1, maxEntries, output);
    } else {
      output.push({ path: relativePath, kind: "file", size: stats.size });
    }
  }
}

function requireDirectoryEntries(directory: string): string[] {
  return readdirSync(directory).sort((a, b) => a.localeCompare(b));
}

function readText(target: WorkspaceTarget): { text: string; binary: boolean; size: number } {
  const stats = statSync(target.absolute);
  if (!stats.isFile()) throw new Error("workspace.read only supports files");
  if (stats.size > maxReadBytes) throw new Error(`file exceeds ${maxReadBytes} byte read limit`);
  const buffer = readFileSync(target.absolute);
  const binary = buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
  return { text: binary ? "" : buffer.toString("utf8"), binary, size: buffer.byteLength };
}

function atomicWrite(target: WorkspaceTarget, content: string): void {
  if (Buffer.byteLength(content, "utf8") > maxWriteBytes) throw new Error(`file exceeds ${maxWriteBytes} byte write limit`);
  mkdirSync(dirname(target.absolute), { recursive: true });
  const temporary = resolve(dirname(target.absolute), `.intent-world-${process.pid}-${Date.now().toString(36)}.tmp`);
  const recovery = `${target.absolute}.intent-world-recovery`;
  writeFileSync(temporary, content, "utf8");
  try {
    try { renameSync(temporary, target.absolute); } catch {
      if (!existsSync(target.absolute)) throw new Error("atomic workspace rename failed");
      // Windows does not replace an existing file with renameSync. Move the
      // old file to a same-directory recovery name first, then perform the
      // second rename while the caller's state lock is held. If the second
      // step fails, restore the original instead of deleting it permanently.
      rmSync(recovery, { force: true });
      renameSync(target.absolute, recovery);
      try { renameSync(temporary, target.absolute); }
      catch (error: unknown) {
        if (!existsSync(target.absolute) && existsSync(recovery)) renameSync(recovery, target.absolute);
        throw error;
      }
      rmSync(recovery, { force: true });
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function backupFile(target: WorkspaceTarget, key: string): string | undefined {
  if (!existsSync(target.absolute) || !statSync(target.absolute).isFile()) return undefined;
  const content = readFileSync(target.absolute).toString("utf8");
  return persistRaw(`${key}-${target.relative}`, content);
}

function parsePatchPath(raw: string): string {
  const value = raw.trim().split(/\s+/)[0];
  if (value === "/dev/null") return value;
  return value.replace(/^(?:a|b)\//, "");
}

function parseUnifiedPatch(raw: string): PatchFile[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFile[] = [];
  let index = 0;
  while (index < lines.length && !lines[index].startsWith("--- ")) index += 1;
  while (index < lines.length) {
    if (!lines[index].startsWith("--- ") || index + 1 >= lines.length || !lines[index + 1].startsWith("+++ ")) throw new Error("invalid unified patch file header");
    const file: PatchFile = { oldPath: parsePatchPath(lines[index].slice(4)), newPath: parsePatchPath(lines[index + 1].slice(4)), hunks: [] };
    index += 2;
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const match = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        if (lines[index] === "" || lines[index].startsWith("\\ No newline")) { index += 1; continue; }
        throw new Error("invalid unified patch hunk header");
      }
      const hunk: PatchHunk = { oldStart: Number(match[1]), oldCount: Number(match[2] ?? "1"), newStart: Number(match[3]), newCount: Number(match[4] ?? "1"), lines: [] };
      index += 1;
      let oldSeen = 0;
      let newSeen = 0;
      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- ")) {
        const line = lines[index];
        if (line.startsWith(" ")) { oldSeen += 1; newSeen += 1; hunk.lines.push(line); }
        else if (line.startsWith("-")) { oldSeen += 1; hunk.lines.push(line); }
        else if (line.startsWith("+")) { newSeen += 1; hunk.lines.push(line); }
        else if (line.startsWith("\\ No newline")) { /* metadata */ }
        else if (line === "" && index === lines.length - 1) { /* trailing split sentinel */ }
        else throw new Error("invalid unified patch line");
        index += 1;
      }
      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) throw new Error("unified patch hunk counts do not match");
      file.hunks.push(hunk);
    }
    if (!file.hunks.length) throw new Error("patch file has no hunks");
    files.push(file);
  }
  if (!files.length) throw new Error("patch is empty or not a unified diff");
  if (files.some((file) => file.newPath === "/dev/null" && file.oldPath === "/dev/null")) throw new Error("patch target is invalid");
  return files;
}

function applyPatch(original: string, hunks: PatchHunk[]): string {
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  let offset = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + offset;
    if (start < 0 || start > lines.length) throw new Error("patch hunk starts outside target file");
    let cursor = start;
    const replacement: string[] = [];
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || marker === "-") {
        if (lines[cursor] !== text) throw new Error("patch context does not match target file");
        if (marker === " ") replacement.push(text);
        cursor += 1;
      } else if (marker === "+") replacement.push(text);
    }
    lines.splice(start, cursor - start, ...replacement);
    offset += replacement.length - (cursor - start);
  }
  return lines.join("\n");
}

async function tracked(workspace: string, relativePath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: workspace, timeout: 5_000, windowsHide: true, shell: false });
    return true;
  } catch { return false; }
}

function managerInvocation(manager: "npm" | "pnpm" | "yarn"): { file: string; prefix: string[] } {
  if (manager !== "npm" || process.platform !== "win32") return { file: manager, prefix: [] };
  return { file: "npm.cmd", prefix: [] };
}

function dockerDependencyInvocation(sandbox: SandboxContext, manager: "npm" | "pnpm" | "yarn", args: string[]): { file: string; args: string[] } {
  const packageCommand = manager === "npm" ? ["npm", ...args] : ["corepack", manager, ...args];
  return {
    file: "docker",
    args: [
      "run", "--rm", "--init", "--network", "bridge", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--cpus", "1", "--pids-limit", "128", "--memory", "1g",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-v", `${resolve(sandbox.workspaceRef)}:/workspace:rw`, "-w", "/workspace",
      sandbox.image ?? process.env.SANDBOX_IMAGE ?? "node:22-alpine", ...packageCommand,
    ],
  };
}

function packageManager(workspace: string, requested: unknown): "npm" | "pnpm" | "yarn" {
  if (requested === "npm" || requested === "pnpm" || requested === "yarn") return requested;
  if (existsSync(resolve(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(workspace, "yarn.lock"))) return "yarn";
  return "npm";
}

function fileDigest(path: string): string | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxReadBytes) return undefined;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function validPackageName(value: string): boolean {
  return value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._-]+)?$/i.test(value);
}

export async function executeWorkspaceTool(action: ActionEnvelope, sandbox: SandboxContext, options: { signal?: AbortSignal } = {}): Promise<ToolResult | undefined> {
  if (action.type !== "ACT" || !action.tool?.startsWith("workspace.") && action.tool !== "dependency.install") return undefined;
  const startedAt = Date.now();
  try {
    options.signal?.throwIfAborted();
    const root = workspaceRoot(sandbox);
    if (action.tool === "workspace.list") {
      const depth = typeof action.params?.depth === "number" && Number.isFinite(action.params.depth) ? Math.max(0, Math.min(8, Math.floor(action.params.depth))) : 2;
      const maxEntries = typeof action.params?.maxEntries === "number" && Number.isFinite(action.params.maxEntries) ? Math.max(1, Math.min(maxListEntries, Math.floor(action.params.maxEntries))) : 200;
      const entries: Array<Record<string, string | number>> = [];
      listTree(root, root, depth, maxEntries, entries);
      const compactEntries = entries.map((entry) => `${entry.kind}:${entry.path}`).join(" · ").slice(0, 6_000);
      const output = JSON.stringify({ root, truncated: entries.length >= maxEntries, entries });
      const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-list`, output, "json");
      const ev = evidence(sandbox.projectId, "world", "PASS", `workspace.list returned ${entries.length} bounded entries${compactEntries ? ` · ${compactEntries}` : ""}`, "workspace.list", rawRef, { depth, maxEntries, entryCount: entries.length, truncated: entries.length >= maxEntries });
      return { ...result(sandbox, ev.summary, ev, output, "meaningful", [], [observation(sandbox.projectId, sandbox.runId, `workspace.list · ${entries.length} entries${compactEntries ? ` · ${compactEntries}` : ""}`, rawRef)]), tool: action.tool, cost: 0.01, wallTimeMs: Date.now() - startedAt };
    }

    if (action.tool === "workspace.read") {
      const target = resolveTarget(sandbox, action.params?.path);
      const content = readText(target);
      const rawValue = content.binary ? JSON.stringify({ path: target.relative, binary: true, size: content.size, extension: extname(target.relative) }) : content.text;
      const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-read-${basename(target.relative)}`, rawValue, content.binary ? "json" : "txt");
      if (content.binary) {
        const output = JSON.stringify({ path: target.relative, binary: true, size: content.size, rawRef });
        const ev = evidence(sandbox.projectId, "world", "PASS", `workspace.read metadata · ${target.relative} is binary`, "workspace.read", rawRef, { path: target.relative, binary: true, size: content.size });
        return { ...result(sandbox, ev.summary, ev, output, "meaningful", [], [observation(sandbox.projectId, sandbox.runId, `workspace.read · binary metadata · ${target.relative}`, rawRef)]), tool: action.tool, cost: 0.01, wallTimeMs: Date.now() - startedAt };
      }
      const requestedStart = typeof action.params?.lineStart === "number" && Number.isFinite(action.params.lineStart) ? Math.max(1, Math.floor(action.params.lineStart)) : 1;
      const requestedEnd = typeof action.params?.lineEnd === "number" && Number.isFinite(action.params.lineEnd) ? Math.max(requestedStart, Math.floor(action.params.lineEnd)) : Number.MAX_SAFE_INTEGER;
      const allLines = content.text.split("\n");
      const selected = allLines.slice(requestedStart - 1, requestedEnd);
      const output = JSON.stringify({ path: target.relative, lineStart: requestedStart, lineEnd: Math.min(requestedEnd, allLines.length), totalLines: allLines.length, content: selected.join("\n"), rawRef });
      const compactContent = redactSecretLikeText(selected.join("\n")).slice(0, 6_000);
      const summary = `workspace.read · ${target.relative}:${requestedStart}-${Math.min(requestedEnd, allLines.length)} · content=${compactContent}`;
      const ev = evidence(sandbox.projectId, "world", "PASS", summary, "workspace.read", rawRef, { path: target.relative, lineStart: requestedStart, lineEnd: Math.min(requestedEnd, allLines.length), totalLines: allLines.length, binary: false });
      return { ...result(sandbox, ev.summary, ev, output, "meaningful", [], [observation(sandbox.projectId, sandbox.runId, summary, rawRef)]), tool: action.tool, cost: 0.01, wallTimeMs: Date.now() - startedAt };
    }

    if (action.tool === "workspace.write") {
      const target = resolveTarget(sandbox, action.params?.path, true);
      const content = action.params?.content;
      if (typeof content !== "string") return blocked(sandbox, action.tool, "workspace.write requires text content");
      if (existsSync(target.absolute) && !statSync(target.absolute).isFile()) return blocked(sandbox, action.tool, "workspace.write only overwrites files");
      if (existsSync(target.absolute) && action.params?.overwrite !== true) return blocked(sandbox, action.tool, "workspace.write requires overwrite=true for an existing file");
      const before = existsSync(target.absolute) ? readFileSync(target.absolute).toString("utf8") : undefined;
      const backupRef = before === undefined ? undefined : backupFile(target, `${sandbox.projectId}-${sandbox.runId}-workspace-backup`);
      atomicWrite(target, content);
      const changed = before !== content;
      const diffRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-write-${basename(target.relative)}`, JSON.stringify({ path: target.relative, changed, backupRef, before: before?.slice(0, maxWriteBytes), after: content.slice(0, maxWriteBytes) }), "json");
      const ev = evidence(sandbox.projectId, "world", "PASS", `workspace.write · ${target.relative} · ${changed ? "changed" : "already up to date"}`, "workspace.write", diffRef, { path: target.relative, changed, backupRef: Boolean(backupRef) });
      return { ...result(sandbox, ev.summary, ev, JSON.stringify({ path: target.relative, changed, backupRef, rawRef: diffRef }), changed ? "meaningful" : "none", changed ? [target.relative] : [], [observation(sandbox.projectId, sandbox.runId, `workspace.write · ${target.relative} · ${changed ? "changed" : "unchanged"}`, diffRef)]), tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
    }

    if (action.tool === "workspace.patch") {
      const patch = action.params?.patch;
      if (typeof patch !== "string") return blocked(sandbox, action.tool, "workspace.patch requires a unified patch string");
      const files = parseUnifiedPatch(patch);
      const updates = files.map((file) => {
        const oldTarget = file.oldPath === "/dev/null" ? undefined : resolveTarget(sandbox, file.oldPath);
        const newTarget = file.newPath === "/dev/null" ? undefined : resolveTarget(sandbox, file.newPath, true);
        const original = oldTarget ? readText(oldTarget).text : "";
        const content = file.newPath === "/dev/null" ? undefined : applyPatch(original, file.hunks);
        return { file, oldTarget, newTarget, original, content };
      });
      const backups = updates.map((update) => update.oldTarget && backupFile(update.oldTarget, `${sandbox.projectId}-${sandbox.runId}-patch-backup`));
      try {
        for (const update of updates) {
          if (update.file.newPath === "/dev/null") {
            if (!update.oldTarget) throw new Error("patch delete target is missing");
            rmSync(update.oldTarget.absolute);
          } else if (update.newTarget && update.content !== undefined) {
            atomicWrite(update.newTarget, update.content);
          }
        }
      } catch (error: unknown) {
        for (const update of updates) {
          try {
            if (update.oldTarget && update.original !== undefined) atomicWrite(update.oldTarget, update.original);
            else if (update.newTarget && existsSync(update.newTarget.absolute)) rmSync(update.newTarget.absolute, { force: true });
          } catch { /* preserve the original error; backup refs remain available */ }
        }
        throw error;
      }
      const changedPaths = updates.map((update) => update.file.newPath === "/dev/null" ? update.file.oldPath : update.file.newPath).filter((value) => value !== "/dev/null");
      const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-patch`, JSON.stringify({ patch, changedPaths, backups }), "json");
      const ev = evidence(sandbox.projectId, "world", "PASS", `workspace.patch · ${changedPaths.length} file(s) changed`, "workspace.patch", rawRef, { changedPaths: changedPaths.join(","), backupCount: backups.filter(Boolean).length });
      return { ...result(sandbox, ev.summary, ev, JSON.stringify({ changedPaths, rawRef }), "meaningful", changedPaths, changedPaths.map((path) => observation(sandbox.projectId, sandbox.runId, `workspace.patch · ${path}`, rawRef))) , tool: action.tool, cost: 0.08, wallTimeMs: Date.now() - startedAt };
    }

    if (action.tool === "workspace.delete") {
      const target = resolveTarget(sandbox, action.params?.path);
      const stats = lstatSync(target.absolute);
      const recursive = action.params?.recursive === true;
      if (stats.isDirectory() && !recursive) return blocked(sandbox, action.tool, "directory deletion requires recursive=true");
      const backupRef = stats.isFile() ? backupFile(target, `${sandbox.projectId}-${sandbox.runId}-delete-backup`) : persistRaw(`${sandbox.projectId}-${sandbox.runId}-delete-manifest`, JSON.stringify({ path: target.relative, recursive, entries: requireDirectoryEntries(target.absolute) }), "json");
      const isTracked = await tracked(root, target.relative);
      rmSync(target.absolute, { recursive, force: false });
      const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-delete`, JSON.stringify({ path: target.relative, recursive, tracked: isTracked, backupRef }), "json");
      const ev = evidence(sandbox.projectId, "world", "PASS", `workspace.delete · ${target.relative}`, "workspace.delete", rawRef, { path: target.relative, recursive, tracked: isTracked, backupRef: Boolean(backupRef) });
      return { ...result(sandbox, ev.summary, ev, JSON.stringify({ path: target.relative, recursive, tracked: isTracked, backupRef, rawRef }), "meaningful", [target.relative], [observation(sandbox.projectId, sandbox.runId, `workspace.delete · ${target.relative}`, rawRef)]), tool: action.tool, cost: 0.12, wallTimeMs: Date.now() - startedAt };
    }

    if (action.tool === "dependency.install") {
      if (sandbox.networkPolicy === "deny" || !isAllowedNetworkHost("https://registry.npmjs.org", sandbox.networkPolicy, sandbox.allowedDomains)) return blocked(sandbox, action.tool, "dependency installation requires registry.npmjs.org in the network allowlist");
      const packages = action.params?.packages;
      if (!Array.isArray(packages) || !packages.every((item) => typeof item === "string" && validPackageName(item))) return blocked(sandbox, action.tool, "package names are invalid or empty");
      const manager = packageManager(root, action.params?.packageManager);
      const invocation = managerInvocation(manager);
      const args = manager === "npm" ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org", ...packages] : manager === "pnpm" ? ["add", "--ignore-scripts", "--registry", "https://registry.npmjs.org", ...packages] : ["add", "--ignore-scripts", "--registry", "https://registry.npmjs.org", ...packages];
      const dependencyFiles = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
      const before = dependencyFiles.map((file) => ({ file, digest: fileDigest(resolve(root, file)) })).filter((entry): entry is { file: string; digest: string } => Boolean(entry.digest));
      let code = 0;
      let stdout = "";
      let stderr = "";
      try {
        const dockerInvocation = sandbox.mode === "docker" ? dockerDependencyInvocation(sandbox, manager, args) : undefined;
        const output = await runCommand(dockerInvocation?.file ?? invocation.file, dockerInvocation?.args ?? [...invocation.prefix, ...args], { cwd: root, signal: options.signal, timeoutMs: commandTimeoutMs, maxBytes: maxOutputBytes, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|REDIS_URL)/i.test(key))) });
        code = output.code;
        stdout = output.stdout;
        stderr = output.stderr;
      } catch (error: unknown) {
        const candidate = error as { code?: number; stdout?: string; stderr?: string };
        code = typeof candidate.code === "number" ? candidate.code : 1;
        stdout = String(candidate.stdout ?? "");
        stderr = String(candidate.stderr ?? (error instanceof Error ? error.message : "설치 명령 실패"));
      }
      const output = redactSecretLikeText([stdout, stderr].filter(Boolean).join("\n"));
      const changedPaths = dependencyFiles.filter((file) => {
        const after = fileDigest(resolve(root, file));
        const prior = before.find((entry) => entry.file === file)?.digest;
        return Boolean(after && after !== prior);
      });
      const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-dependency-install`, output);
      const ev = evidence(sandbox.projectId, "test", code === 0 ? "PASS" : "FAIL", `dependency.install ${manager} · ${code === 0 ? "PASS" : "FAIL"}`, "dependency.install", rawRef, { manager, packages: packages.join(","), exitCode: code, changedPaths: changedPaths.join(","), sandbox: sandbox.mode ?? "process" });
      const toolResult = result(sandbox, ev.summary, ev, output, code === 0 && changedPaths.length > 0 ? "meaningful" : "none", changedPaths, [observation(sandbox.projectId, sandbox.runId, `dependency.install · ${manager} · ${code === 0 ? "PASS" : "FAIL"}`, rawRef, code === 0 ? "healthy" : "warning")]);
      return { ...toolResult, tool: action.tool, status: code === 0 ? "succeeded" : "failed", cost: 0.35, wallTimeMs: Date.now() - startedAt };
    }
  } catch (error: unknown) {
    const reason = redactSecretLikeText(error instanceof Error ? error.message : "workspace tool failed");
    const rawRef = persistRaw(`${sandbox.projectId}-${sandbox.runId}-workspace-error`, reason);
    const ev = evidence(sandbox.projectId, "world", "FAIL", `workspace tool failed · ${reason}`, action.tool ?? "workspace", rawRef);
    const failed = result(sandbox, ev.summary, ev, reason, "none", [], [observation(sandbox.projectId, sandbox.runId, `workspace tool failed · ${reason}`, rawRef, "warning")]);
    return { ...failed, tool: action.tool ?? "workspace", status: "failed", cost: 0.08, wallTimeMs: Date.now() - startedAt };
  }
  return undefined;
}
