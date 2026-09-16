import type { AppState } from "./types";

/** Server revisions, not arrival order, decide which snapshot may replace the UI. */
export function acceptServerState(current: AppState, incoming: AppState): AppState {
  if ((incoming.revision ?? 0) < (current.revision ?? 0)) return current;
  const activeProjectId = incoming.projects.some((project) => project.id === current.activeProjectId) ? current.activeProjectId : incoming.activeProjectId;
  return { ...incoming, activeProjectId };
}
