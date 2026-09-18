import { describe, expect, it } from "vitest";
import {
  activeMission, appendCoverageSnapshot, coverageCounts, createAutonomyProject, hasMaterialUnresolvedWork,
  mergeGapCandidates, mergeSpecialistProposals, mergeSurfaceProposals, settleMission, startMissionForGap,
} from "./autonomyDomain";

const id = (() => { let n = 0; return (prefix: string) => `${prefix}-${++n}`; })();
const at = "2026-09-17T00:00:00.000Z";

describe("autonomy domain", () => {
  it("uses baseline surfaces as seeds, then accepts AI-discovered surfaces and specialists", () => {
    let project = createAutonomyProject("p1", 1, at, id);
    expect(project.gaps).toHaveLength(0);
    expect(project.surfaces?.length).toBe(17);
    expect(project.specialists?.length).toBeGreaterThanOrEqual(4);
    expect(project.surfaces?.every((surface) => surface.origin === "baseline" && surface.status === "UNEXPLORED")).toBe(true);

    project = mergeSurfaceProposals(project, [{
      name: "Migration & Compatibility",
      description: "The local data format may need forwards/backwards compatibility and migration semantics.",
      risk: .78,
      sourceRefs: ["src/storage.ts"],
    }], at, id);
    project = mergeSpecialistProposals(project, [{
      name: "Migration compatibility specialist",
      focus: "Inspect schema evolution, import/export compatibility, upgrade safety, and rollback paths.",
      surfaceNames: ["Migration & Compatibility"],
    }], at, id);
    project = mergeGapCandidates(project, [{
      category: "Migration & Compatibility",
      title: "Schema upgrade path is undefined",
      summary: "No migration contract exists for persisted local project data.",
      impact: .86, uncertainty: .82, novelty: .9, urgency: .7,
      roleHint: "Migration compatibility specialist",
      evidenceNeeded: ["migration implementation", "upgrade fixture"],
      sourceRefs: ["src/storage.ts"],
    }], at, id);

    const discoveredSurface = project.surfaces?.find((surface) => surface.name === "Migration & Compatibility");
    expect(discoveredSurface?.origin).toBe("discovered");
    expect(project.specialists?.some((specialist) => specialist.name === "Migration compatibility specialist" && specialist.origin === "discovered")).toBe(true);
    const gap = project.gaps.find((item) => item.title === "Schema upgrade path is undefined");
    expect(gap?.status).toBe("OPEN");
    expect(gap?.priority).toBeGreaterThan(.6);

    project = startMissionForGap(project, gap!.id, 0, at, id);
    expect(activeMission(project)?.gapId).toBe(gap!.id);
    expect(project.gaps.find((item) => item.id === gap!.id)?.status).toBe("INVESTIGATING");
  });

  it("resolves only the discovered mission-linked gap while unexplored surfaces keep coverage open", () => {
    let project = createAutonomyProject("p2", 1, at, id);
    project = mergeGapCandidates(project, [{
      category: "Security", title: "Threat boundary", summary: "The local trust boundary has not been verified.",
      impact: .9, uncertainty: .8, novelty: .6, urgency: .8, evidenceNeeded: ["boundary test"],
    }], at, id);
    const gap = project.gaps[0];
    project = startMissionForGap(project, gap.id, 0, at, id);
    project = settleMission(project, activeMission(project)!.id, "SUCCEEDED", "2026-09-17T00:01:00.000Z");
    expect(activeMission(project)).toBeUndefined();
    expect(project.gaps.find((item) => item.id === gap.id)?.status).toBe("RESOLVED");
    expect(hasMaterialUnresolvedWork(project)).toBe(true);
    project = appendCoverageSnapshot(project, .4, undefined, at, id);
    expect(coverageCounts(project).resolved).toBe(1);
    expect(coverageCounts(project).unexplored).toBeGreaterThan(0);
    expect(project.coverageSnapshots).toHaveLength(1);
  });
});
