import { describe, expect, it } from "vitest";
import { assembleContext, createProject } from "./runtime";
import { rebuildRetrievalIndex, retrieveRelevantExperiencesWithEmbedding, type EmbeddingProvider } from "./memory";
import type { AppState, ContextPacket, Experience } from "./types";

function emptyState(): AppState {
  return { schemaVersion: 1, activeProjectId: "", projects: [], intents: [], runs: [], actions: [], worldSnapshots: [], observations: [], contexts: [], events: [], evidence: [], humanItems: [], artifacts: [], experiences: [], policies: [], resourceLedger: [], relations: [], retrievalIndex: [], experiments: [], approvalGrants: [], processes: [] };
}

function experience(projectId: string, id: string, situation: string, decision: string, outcome: string, createdAt: string): Experience {
  return { id, projectId, situation, decision, action: "inspect and verify", outcome, evidenceIds: [], cost: 0, risk: "P1", humanIntervention: false, createdAt };
}

describe("experience retrieval", () => {
  it("ranks an older relevant failure above a recent unrelated transition", () => {
    let state = createProject(emptyState(), "TypeScript 컴파일 오류를 찾아 고쳐줘", "memory-ranking");
    state = {
      ...state,
      experiences: [
        experience("memory-ranking", "old-relevant", "workspace TypeScript compile error after a patch", "read compiler output and patch the source", "failure: missing import", "2025-01-01T00:00:00.000Z"),
        experience("memory-ranking", "new-unrelated", "browser visual color polish", "adjust the landing page spacing", "pass", new Date().toISOString()),
      ],
    };
    state = { ...state, retrievalIndex: rebuildRetrievalIndex(state, "memory-ranking") };
    const context = assembleContext(state, "memory-ranking")!;
    expect(context.experienceRefs[0]).toBe("old-relevant");
  });

  it("can use a configured embedding provider while preserving source experience refs", async () => {
    let state = createProject(emptyState(), "semantic deployment rollback investigation", "memory-provider");
    state = {
      ...state,
      experiences: [
        experience("memory-provider", "semantic-match", "unrelated wording", "unrelated wording", "successful deployment rollback investigation", "2025-01-01T00:00:00.000Z"),
        experience("memory-provider", "semantic-new", "recent unrelated design", "recent unrelated design", "pass", new Date().toISOString()),
      ],
    };
    state = { ...state, retrievalIndex: rebuildRetrievalIndex(state, "memory-provider") };
    const context = assembleContext(state, "memory-provider")!;
    const provider: EmbeddingProvider = {
      name: "test-embedding",
      async embed(texts: string[]) {
        return texts.map((text) => /deployment|rollback/i.test(text) ? [1, 0] : [0, 1]);
      },
    };
    const retrieved = await retrieveRelevantExperiencesWithEmbedding(state, "memory-provider", context, provider, 1);
    expect(retrieved.map((item) => item.id)).toEqual(["semantic-match"]);
  });
});
