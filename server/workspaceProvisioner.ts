import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeWorkspacePath } from "./pathPolicy";

function safeProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId);
}

/** Creates a project-owned greenfield workspace below WORKSPACE_ROOT. */
export function provisionProjectWorkspace(projectId: string): string {
  if (!safeProjectId(projectId)) throw new Error("projectId is not safe for workspace provisioning");
  const root = normalizeWorkspacePath(resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd()));
  if (!root) throw new Error("WORKSPACE_ROOT is not an allowed directory");
  const candidate = join(root, ".intent-world", "workspaces", projectId);
  const allowed = normalizeWorkspacePath(candidate);
  if (!allowed) throw new Error("project workspace would escape WORKSPACE_ROOT");
  mkdirSync(allowed, { recursive: true });
  if (!statSync(allowed).isDirectory()) throw new Error("provisioned workspace is not a directory");
  return allowed;
}
