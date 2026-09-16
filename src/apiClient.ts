import { getRun } from "./runtime";
import type { AppAction } from "./store";
import type { AppState, ModelCatalog, ModelProvider, ModelProviderStatus, RuntimeConnectionStatus } from "./types";
import { isDesktopApp } from "./desktop";

const baseUrl = (import.meta.env.VITE_API_URL ?? (isDesktopApp ? "http://127.0.0.1:8787" : "")).replace(/\/+$/, "");

export const isControlPlaneEnabled = baseUrl.length > 0;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Control plane request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function post(path: string, body?: unknown): Promise<unknown> {
  return request(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function fetchServerState(): Promise<AppState> {
  return request<AppState>("/state");
}

export async function fetchServerStateWithRetry(attempts = 24, delayMs = 250): Promise<AppState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchServerState();
    } catch (error: unknown) {
      lastError = error;
      if (!(error instanceof TypeError) || attempt === attempts - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Control plane state를 읽지 못했습니다.");
}

export function fetchRuntimeConnectionStatus(projectId: string): Promise<RuntimeConnectionStatus> {
  return request<RuntimeConnectionStatus>(`/projects/${encodeURIComponent(projectId)}/runtime-status`);
}

export function fetchModelCatalog(): Promise<ModelCatalog> {
  return request<ModelCatalog>("/runtime/model-catalog");
}

export function fetchModelConnectionStatus(provider: ModelProvider, modelName?: string): Promise<ModelProviderStatus> {
  const query = new URLSearchParams({ provider });
  if (modelName?.trim()) query.set("model", modelName.trim());
  return request<ModelProviderStatus>(`/runtime/model-status?${query.toString()}`);
}

export interface WorkspaceRootStatus {
  root: string;
  configPath: string;
}

export function fetchWorkspaceRoot(): Promise<WorkspaceRootStatus> {
  return request<WorkspaceRootStatus>("/runtime/workspace-root");
}

export function setWorkspaceRoot(path: string): Promise<WorkspaceRootStatus> {
  return request<WorkspaceRootStatus>("/runtime/workspace-root", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function mirrorAction(action: AppAction, state: AppState): Promise<void> {
  if (!isControlPlaneEnabled) return;

  switch (action.type) {
    case "UPDATE_PROJECT_EXECUTION":
      await post(`/projects/${encodeURIComponent(action.projectId)}/execution`, { executionMode: action.executionMode, maxNativeTurns: action.maxNativeTurns, maxNativeTokens: action.maxNativeTokens });
      return;
    case "CREATE_PROJECT":
      await post("/projects", {
        rawIntent: action.rawIntent,
        projectId: action.projectId,
        settings: action.settings,
      });
      return;
    case "UPDATE_PROJECT_MODEL":
      await post(`/projects/${encodeURIComponent(action.projectId)}/model`, {
        modelProvider: action.modelProvider,
        modelName: action.modelName,
      });
      return;
    case "DELETE_PROJECT":
      await request(`/projects/${encodeURIComponent(action.projectId)}`, { method: "DELETE" });
      return;
    case "RESOLVE_HUMAN_ITEM":
      await post(`/human-items/${encodeURIComponent(action.itemId)}/${action.action}`, action.answer ? { answer: action.answer } : undefined);
      return;
    case "RUN_CYCLE":
      await post(`/projects/${encodeURIComponent(action.projectId)}/run`);
      return;
    case "REFRESH_WORLD":
      await post(`/projects/${encodeURIComponent(action.projectId)}/world/refresh`);
      return;
    case "PAUSE_PROJECT":
    case "RESUME_PROJECT":
    case "KILL_PROJECT": {
      const run = getRun(state, action.projectId);
      if (run) await post(`/runs/${encodeURIComponent(run.id)}/${action.type === "PAUSE_PROJECT" ? "pause" : action.type === "RESUME_PROJECT" ? "resume" : "kill"}`);
      return;
    }
    case "WAKE_PROJECT":
      await post(`/projects/${encodeURIComponent(action.projectId)}/wake`);
      return;
    case "STALL_PROJECT":
      await post(`/projects/${encodeURIComponent(action.projectId)}/stall`, { reason: action.reason });
      return;
    case "CREATE_ARTIFACT":
      await post(`/projects/${encodeURIComponent(action.projectId)}/artifacts`, {
        kind: action.kind,
        name: action.name,
        description: action.description,
      });
      return;
    case "RUN_EXPERIMENT":
      await post(`/experiments/${encodeURIComponent(action.experimentId)}/run`);
      return;
    case "CREATE_EXPERIMENT":
      await post(`/projects/${encodeURIComponent(action.projectId)}/experiments`, action.input);
      return;
    case "ADD_INTENT":
      await post(`/projects/${encodeURIComponent(action.projectId)}/intents`, { rawText: action.rawText });
      return;
    case "SET_ACTIVE_PROJECT":
    case "HYDRATE_STATE":
      return;
  }
}

export function subscribeToProject(projectId: string, onEvent: () => void): () => void {
  if (!isControlPlaneEnabled || typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(`${baseUrl}/projects/${encodeURIComponent(projectId)}/stream`);
  let scheduled = false;
  const scheduleHydration = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onEvent();
    });
  };
  for (const eventName of ["event.created", "run.state", "world.changed", "human-item.created", "evidence.created"]) source.addEventListener(eventName, scheduleHydration);
  source.onerror = () => {
    // EventSource reconnects itself; the next event will hydrate the state again.
  };
  return () => source.close();
}
