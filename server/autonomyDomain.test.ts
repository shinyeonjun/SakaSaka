import { describe, expect, it } from "vitest";
import { activeMission, appendCoverageSnapshot, coverageCounts, createAutonomyProject, hasMaterialUnresolvedWork, mergeGapCandidates, settleMission, startMissionForGap } from "./autonomyDomain";

const id = (() => { let n = 0; return (prefix: string) => `${prefix}-${++n}`; })();
const at = "2026-09-17T00:00:00.000Z";

describe("autonomy domain", () => {
  it("seeds known software surfaces and turns discovered gaps into missions", () => {
    let project = createAutonomyProject("p1", 1, at, id);
    expect(project.gaps.length).toBeGreaterThan(10);
    project = mergeGapCandidates(project, [{ category: "Security", title: "Refresh token storage", summary: "Token storage has not been verified.", impact: .95, uncertainty: .8, novelty: .7, urgency: .9, evidenceNeeded: ["storage implementation"] }], at, id);
    const gap = project.gaps.find((item) => item.key.includes("refresh-token-storage"));
    expect(gap?.status).toBe("OPEN");
    expect(gap?.priority).toBeGreaterThan(.7);
    project = startMissionForGap(project, gap!.id, 0, at, id);
    expect(activeMission(project)?.gapId).toBe(gap!.id);
    expect(project.gaps.find((item) => item.id === gap!.id)?.status).toBe("INVESTIGATING");
  });

  it("resolves only the mission-linked gap and preserves other coverage", () => {
    let project = createAutonomyProject("p2", 1, at, id);
    const gap = project.gaps[0];
    project = startMissionForGap(project, gap.id, 0, at, id);
    project = settleMission(project, activeMission(project)!.id, "SUCCEEDED", "2026-09-17T00:01:00.000Z");
    expect(activeMission(project)).toBeUndefined();
    expect(project.gaps.find((item) => item.id === gap.id)?.status).toBe("RESOLVED");
    expect(hasMaterialUnresolvedWork(project)).toBe(true);
    project = appendCoverageSnapshot(project, .4, undefined, at, id);
    expect(coverageCounts(project).resolved).toBe(1);
    expect(project.coverageSnapshots).toHaveLength(1);
  });
});
