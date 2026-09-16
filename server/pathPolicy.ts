import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function workspaceRootPath(): string {
  const configured = process.env.WORKSPACE_ROOT?.trim();
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
