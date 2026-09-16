import { describe, it, expect } from "vitest";
import { acceptServerState } from "./stateSync";
import { createEmptyState } from "./emptyState";
import { createProject } from "./runtime";

describe("authoritative server snapshots", () => {
  it("ignores a late older response", () => {
    const state = { ...createEmptyState(), revision: 10 };
    expect(acceptServerState(state, { ...createEmptyState(), revision: 9 })).toBe(state);
  });
  it("preserves local project navigation without rewriting server content", () => {
    const state = createProject(createProject(createEmptyState(), "a", "a"), "b", "b");
    const current = { ...state, activeProjectId: "a", revision: 5 };
    expect(acceptServerState(current, { ...state, revision: 6 }).activeProjectId).toBe("a");
  });
});
