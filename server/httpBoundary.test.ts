import { describe, expect, it } from "vitest";
import { trustedOrigin, isLoopbackHost } from "./httpBoundary";

describe("local API origin boundary", () => {
  it("allows local UI and Tauri origins, not attacker-controlled hostnames", () => {
    expect(trustedOrigin("http://localhost:5173")).toBe(true);
    expect(trustedOrigin("tauri://localhost")).toBe(true);
    expect(trustedOrigin("http://tauri.localhost")).toBe(true);
    expect(trustedOrigin("https://localhost.evil.example")).toBe(false);
    expect(trustedOrigin("null")).toBe(false);
    expect(trustedOrigin("https://evil.example")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
