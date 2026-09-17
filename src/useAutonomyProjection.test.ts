import { describe, expect, it } from "vitest";
import { shouldRequestAutonomyProjection } from "./useAutonomyProjection";

describe("autonomy projection request guard", () => {
  it("does not query without a known project or control plane", () => {
    expect(shouldRequestAutonomyProjection("", true, true)).toBe(false);
    expect(shouldRequestAutonomyProjection("project-1", false, true)).toBe(false);
    expect(shouldRequestAutonomyProjection("project-1", true, false)).toBe(false);
  });

  it("stops retrying a project after its authoritative 404", () => {
    expect(shouldRequestAutonomyProjection("project-1", true, true, "project-1")).toBe(false);
    expect(shouldRequestAutonomyProjection("project-2", true, true, "project-1")).toBe(true);
  });
});
