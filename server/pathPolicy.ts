import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const defaultWorkspaceRootConfig = ".data/workspace-root.txt";

export function workspaceRootConfigPath(): string {
  return resolve(process.env.INTENT_WORLD_WORKSPACE_ROOT_FILE?.trim() || defaultWorkspaceRootConfig);
}

function configuredWorkspaceRoot(): string | undefined {
  try {
    const value = readFileSync(workspaceRootConfigPath(), "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function workspaceRootPath(): string {
  const configured = configuredWorkspaceRoot() || process.env.WORKSPACE_ROOT?.trim();
  const candidate = resolve(process.cwd(), configured || process.cwd());
  try { return realpathSync.native(candidate); } catch { return candidate; }
}

function isInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
}

/**
 * Local execution is intentionally restricted to WORKSPACE_ROOT. Existing
 * symlinks are resolved before the check so a project cannot escape through a
 * directory alias. Non-existent paths are allowed under the root so a future
 * workspace provisioner can create them safely.
 */
export function normalizeWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const root = workspaceRootPath();
  const candidate = resolve(value);
  if (!isInside(root, candidate)) return undefined;
  if (!existsSync(candidate)) {
    // A future path is only safe when its existing ancestor is also inside the
    // root. This prevents `workspace-link/new-project` from escaping through
    // a symlinked parent directory.
    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    try {
      return isInside(root, realpathSync.native(ancestor)) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const resolved = realpathSync.native(candidate);
    return isInside(root, resolved) && statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function workspacePathIsAllowed(value: unknown): boolean {
  return normalizeWorkspacePath(value) !== undefined;
}

/**
 * Changes the explicit desktop workspace boundary. The selected directory
 * itself becomes the root; project workspaces must remain below it.
 */
export function setWorkspaceRootPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = resolve(value);
  let root: string;
  try {
    root = realpathSync.native(candidate);
    if (!statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const configPath = workspaceRootConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${root}\n`, "utf8");
  renameSync(temporaryPath, configPath);
  process.env.WORKSPACE_ROOT = root;
  return root;
}
