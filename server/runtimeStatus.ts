import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import type { Project, RuntimeConnectionStatus, WorkspaceBindingStatus } from "../src/types";
import { inspectModelProvider } from "./localAdapters";
import { normalizeWorkspacePath, workspaceRootPath } from "./pathPolicy";

function workspaceStatus(project: Project): WorkspaceBindingStatus {
  const root = workspaceRootPath();
  const configuredPath = project.settings.workspacePath?.trim() || undefined;
  if (!configuredPath) {
    return {
      state: "unbound",
      root,
      exists: false,
      writable: false,
      detail: "이 프로젝트에 연결된 작업 폴더가 없습니다. API가 WORKSPACE_ROOT 안에 프로젝트 전용 폴더를 만들 수 있습니다.",
    };
  }

  const normalized = normalizeWorkspacePath(configuredPath);
  if (!normalized) {
    return {
      state: "rejected",
      root,
      configuredPath,
      exists: false,
      writable: false,
      detail: "경로가 WORKSPACE_ROOT 밖에 있거나 심볼릭 링크를 통해 경계를 벗어납니다.",
    };
  }

  if (!existsSync(normalized)) {
    return {
      state: "missing",
      root,
      configuredPath,
      resolvedPath: normalized,
      exists: false,
      writable: false,
      detail: "경로는 허용됐지만 아직 폴더가 없습니다. 프로젝트 생성 또는 다음 실행에서 준비됩니다.",
    };
  }

  try {
    const stats = statSync(normalized);
    if (!stats.isDirectory()) {
      return { state: "inaccessible", root, configuredPath, resolvedPath: normalized, exists: true, writable: false, detail: "연결 대상이 디렉터리가 아닙니다." };
    }
    const resolvedPath = realpathSync.native(normalized);
    let writable = false;
    try {
      accessSync(resolvedPath, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    return {
      state: writable ? "bound" : "inaccessible",
      root,
      configuredPath,
      resolvedPath,
      exists: true,
      writable,
      detail: writable ? "이 프로젝트의 실제 파일 변경 대상입니다." : "폴더는 보이지만 쓰기 권한을 확인하지 못했습니다.",
    };
  } catch {
    return { state: "inaccessible", root, configuredPath, resolvedPath: normalized, exists: true, writable: false, detail: "폴더 상태를 확인하지 못했습니다." };
  }
}

export async function inspectRuntimeConnection(project: Project): Promise<RuntimeConnectionStatus> {
  return {
    model: await inspectModelProvider(project),
    workspace: workspaceStatus(project),
  };
}
