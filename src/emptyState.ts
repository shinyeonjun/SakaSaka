import type { AppState } from "./types";

/** A new installation has no project or claims until a human submits an Intent. */
export function createEmptyState(): AppState {
  return {
    schemaVersion: 1,
    activeProjectId: "",
    projects: [],
    intents: [],
    runs: [],
    actions: [],
    worldSnapshots: [],
    observations: [],
    contexts: [],
    events: [],
    evidence: [],
    humanItems: [],
    artifacts: [],
    experiences: [],
    policies: [],
    resourceLedger: [],
    relations: [],
    retrievalIndex: [],
    experiments: [],
    approvalGrants: [],
    processes: [],
  };
}
