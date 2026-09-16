import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type PropsWithChildren } from "react";
import { fetchServerState, isControlPlaneEnabled, mirrorAction, subscribeToProject } from "./apiClient";
import { createEmptyState } from "./emptyState";
import {
  addIntent,
  createArtifact,
  createExperiment,
  createProject,
  killProject,
  makeId,
  pauseProject,
  refreshWorld,
  resolveHumanItem,
  resumeProject,
  runCycle,
  runExperiment,
  stallProject,
  wakeProject,
} from "./runtime";
import type { AppState, ArtifactKind, ProjectSettings } from "./types";
import type { ExperimentInput } from "./runtime";

const STORAGE_KEY = "intent-world-agent-state-v2";

function loadState(): AppState {
  if (typeof window === "undefined") return createEmptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.events)) return createEmptyState();
    return {
      ...parsed,
      projects: parsed.projects.map((project) => ({
        ...project,
        settings: {
          budgetLimit: 30,
          maxHours: 12,
          localActions: true,
          requireExternalApproval: true,
          productionBlocked: true,
          networkPolicy: "allowlist" as const,
          failureThreshold: 3,
          noProgressThreshold: 5,
          cycleDelayMs: 250,
          approvalTtlMinutes: 60,
          processMaxLifetimeMs: 1_800_000,
          maxConcurrentProcesses: 4,
          ...(project.settings as Partial<ProjectSettings>),
        },
      })),
      runs: Array.isArray(parsed.runs) ? parsed.runs.map((run) => ({
        ...run,
        consecutiveFailures: Number.isFinite(run.consecutiveFailures) ? run.consecutiveFailures : 0,
        noProgressCycles: Number.isFinite(run.noProgressCycles) ? run.noProgressCycles : 0,
        activeProcessIds: Array.isArray(run.activeProcessIds) ? run.activeProcessIds : [],
      })) : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions.map((action) => ({ ...action, schemaVersion: 1 as const })) : [],
      worldSnapshots: Array.isArray(parsed.worldSnapshots) ? parsed.worldSnapshots : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      humanItems: Array.isArray(parsed.humanItems) ? parsed.humanItems : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
      experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
      observations: Array.isArray(parsed.observations) ? parsed.observations.map((observation) => ({
        ...observation,
        status: observation.status ?? (observation.trustLevel === "untrusted" || /unconfigured|unreachable|unanswered|awaiting|blocked|not connected/i.test(observation.compactView) ? "warning" : "healthy"),
      })) : [],
      contexts: Array.isArray(parsed.contexts) ? parsed.contexts.map((context) => ({ ...context, schemaVersion: 1 as const })) : [],
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      resourceLedger: Array.isArray(parsed.resourceLedger) ? parsed.resourceLedger : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      retrievalIndex: Array.isArray(parsed.retrievalIndex) ? parsed.retrievalIndex : [],
      approvalGrants: Array.isArray(parsed.approvalGrants) ? parsed.approvalGrants : [],
      processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    };
  } catch {
    return createEmptyState();
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
  | { type: "STALL_PROJECT"; projectId: string; reason?: string }
  | { type: "KILL_PROJECT"; projectId: string }
  | { type: "CREATE_ARTIFACT"; projectId: string; kind: ArtifactKind; name: string; description: string }
  | { type: "RUN_EXPERIMENT"; experimentId: string }
  | { type: "CREATE_EXPERIMENT"; projectId: string; input: ExperimentInput }
  | { type: "ADD_INTENT"; projectId: string; rawText: string }
  | { type: "SET_ACTIVE_PROJECT"; projectId: string }
  | { type: "HYDRATE_STATE"; state: AppState };

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
    case "STALL_PROJECT":
      return stallProject(state, action.projectId, action.reason);
    case "KILL_PROJECT":
      return killProject(state, action.projectId);
    case "CREATE_ARTIFACT":
      return createArtifact(state, action.projectId, action.kind, action.name, action.description);
    case "RUN_EXPERIMENT":
      return runExperiment(state, action.experimentId);
    case "CREATE_EXPERIMENT":
      return createExperiment(state, action.projectId, action.input);
    case "ADD_INTENT":
      return addIntent(state, action.projectId, action.rawText).state;
    case "SET_ACTIVE_PROJECT":
      return state.projects.some((project) => project.id === action.projectId) ? { ...state, activeProjectId: action.projectId } : state;
    case "HYDRATE_STATE":
      return action.state;
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
  const [state, reducerDispatch] = useReducer(appReducer, undefined, loadState);
  const syncQueue = useRef(Promise.resolve());
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback<Dispatch<AppAction>>((action) => {
    reducerDispatch(action);
    if (!isControlPlaneEnabled || action.type === "SET_ACTIVE_PROJECT" || action.type === "HYDRATE_STATE") return;

    const stateAtDispatch = stateRef.current;
    syncQueue.current = syncQueue.current
      .then(() => mirrorAction(action, stateAtDispatch))
      .then(() => fetchServerState())
      .then((serverState) => reducerDispatch({ type: "HYDRATE_STATE", state: serverState }))
      .catch((error: unknown) => {
        console.warn("Control plane sync failed; local runtime state is retained.", error);
      });
  }, [reducerDispatch]);

  useEffect(() => {
    if (!isControlPlaneEnabled) return;
    let cancelled = false;
    void fetchServerState()
      .then((serverState) => {
        if (!cancelled) reducerDispatch({ type: "HYDRATE_STATE", state: serverState });
      })
      .catch((error: unknown) => console.warn("Control plane bootstrap failed; local runtime state is retained.", error));
    return () => { cancelled = true; };
  }, [reducerDispatch]);

  useEffect(() => {
    if (!isControlPlaneEnabled || !state.activeProjectId) return;
    return subscribeToProject(state.activeProjectId, () => {
      void fetchServerState()
        .then((serverState) => reducerDispatch({ type: "HYDRATE_STATE", state: serverState }))
        .catch((error: unknown) => console.warn("Control plane event sync failed.", error));
    });
  }, [reducerDispatch, state.activeProjectId]);

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
  }), [dispatch, state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
