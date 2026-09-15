import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type PropsWithChildren } from "react";
import { createSeedState } from "./seed";
import {
  addIntent,
  createArtifact,
  createProject,
  killProject,
  makeId,
  pauseProject,
  refreshWorld,
  resolveHumanItem,
  resumeProject,
  runCycle,
  runExperiment,
  wakeProject,
} from "./runtime";
import type { AppState, ArtifactKind, ProjectSettings } from "./types";

const STORAGE_KEY = "intent-world-agent-state-v1";

function loadState(): AppState {
  if (typeof window === "undefined") return createSeedState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeedState();
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.events)) return createSeedState();
    return parsed;
  } catch {
    return createSeedState();
  }
}

export type AppAction =
  | { type: "CREATE_PROJECT"; rawIntent: string; projectId: string; settings?: Partial<ProjectSettings> }
  | { type: "RESOLVE_HUMAN_ITEM"; itemId: string; action: "answer" | "approve" | "reject" | "defer" | "acknowledge"; answer?: string }
  | { type: "RUN_CYCLE"; projectId: string }
  | { type: "REFRESH_WORLD"; projectId: string }
  | { type: "PAUSE_PROJECT"; projectId: string }
  | { type: "RESUME_PROJECT"; projectId: string }
  | { type: "WAKE_PROJECT"; projectId: string }
  | { type: "KILL_PROJECT"; projectId: string }
  | { type: "CREATE_ARTIFACT"; projectId: string; kind: ArtifactKind; name: string; description: string }
  | { type: "RUN_EXPERIMENT"; experimentId: string }
  | { type: "ADD_INTENT"; projectId: string; rawText: string }
  | { type: "SET_ACTIVE_PROJECT"; projectId: string };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "CREATE_PROJECT":
      return createProject(state, action.rawIntent, action.projectId, action.settings);
    case "RESOLVE_HUMAN_ITEM":
      return resolveHumanItem(state, action.itemId, action.action, action.answer);
    case "RUN_CYCLE":
      return runCycle(state, action.projectId);
    case "REFRESH_WORLD":
      return refreshWorld(state, action.projectId);
    case "PAUSE_PROJECT":
      return pauseProject(state, action.projectId);
    case "RESUME_PROJECT":
      return resumeProject(state, action.projectId);
    case "WAKE_PROJECT":
      return wakeProject(state, action.projectId);
    case "KILL_PROJECT":
      return killProject(state, action.projectId);
    case "CREATE_ARTIFACT":
      return createArtifact(state, action.projectId, action.kind, action.name, action.description);
    case "RUN_EXPERIMENT":
      return runExperiment(state, action.experimentId);
    case "ADD_INTENT":
      return addIntent(state, action.projectId, action.rawText).state;
    case "SET_ACTIVE_PROJECT":
      return state.projects.some((project) => project.id === action.projectId) ? { ...state, activeProjectId: action.projectId } : state;
    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  createProject: (rawIntent: string, settings?: Partial<ProjectSettings>) => string;
  setActiveProject: (projectId: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(appReducer, undefined, loadState);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Persistence is best-effort when the browser blocks localStorage.
    }
  }, [state]);

  const value = useMemo<AppContextValue>(() => ({
    state,
    dispatch,
    createProject: (rawIntent, settings) => {
      const projectId = makeId("project");
      dispatch({ type: "CREATE_PROJECT", rawIntent, projectId, settings });
      return projectId;
    },
    setActiveProject: (projectId) => dispatch({ type: "SET_ACTIVE_PROJECT", projectId }),
  }), [state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
