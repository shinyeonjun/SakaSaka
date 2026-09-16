import { describe, expect, it } from "vitest";
import { createEmptyState } from "../src/emptyState";
import { createProject } from "../src/runtime";
import { nativeActionId, recordNativeItem, recordNativeRawTool } from "./nativeEvidence";

const fresh = () => createProject(createEmptyState(), "작은 앱", "evidence-native");
const rawRef = "local-raw://native-fixture.jsonl";

describe("native evidence provenance", () => {
  it("raw 실패 출력은 버리지 않지만 구조화 exitCode를 지어내지 않는다", () => {
    let s = recordNativeRawTool(fresh(), "evidence-native", "t", "u", { type: "function_call", name: "exec_command", call_id: "call" }, rawRef);
    s = recordNativeRawTool(s, "evidence-native", "t", "u", { type: "function_call_output", call_id: "call", output: "Process exited with code 1. Test failed." }, rawRef);
    expect(s.evidence[0].verdict).toBe("UNCERTAIN");
    expect(s.evidence[0].metadata?.exitCode).toBeUndefined();
    expect(s.experiences[0].evidenceIds).toContain(s.evidence[0].id);
    expect(s.retrievalIndex.some((i) => i.sourceRef === s.experiences[0].id)).toBe(true);
    const duplicate = recordNativeRawTool(s, "evidence-native", "t", "u", { type: "function_call_output", call_id: "call", output: "same" }, rawRef);
    expect(duplicate).toBe(s);
  });
  it("나중에 실제 구조화 완료 이벤트가 오면 출처를 보존하며 실행 상태를 갱신한다", () => {
    let s = recordNativeRawTool(fresh(), "evidence-native", "t", "u", { type: "function_call_output", call_id: "call", output: "error" }, rawRef);
    const item = { id: "call", type: "commandExecution", status: "failed", command: "node test.mjs", exitCode: 1 };
    s = recordNativeItem(s, "evidence-native", "t", "u", item, true, rawRef);
    expect(s.actions.find((a) => a.id === nativeActionId("evidence-native", "t", "u", "call"))?.status).toBe("FAILED");
    expect(s.evidence.map((e) => e.verdict)).toEqual(["UNCERTAIN", "FAIL"]);
    expect(recordNativeItem(s, "evidence-native", "t", "u", item, true, rawRef)).toBe(s);
  });
  it("숨겨진 reasoning 항목은 도구 실행 증거나 경험에 넣지 않는다", () => {
    const s = fresh();
    expect(recordNativeRawTool(s, "evidence-native", "t", "u", { type: "reasoning", call_id: "secret", encrypted_content: "not-for-logs" }, rawRef)).toBe(s);
    expect(recordNativeItem(s, "evidence-native", "t", "u", { type: "reasoning", id: "secret", text: "not-for-logs" }, true, rawRef)).toBe(s);
  });
  it("검색·MCP 이벤트는 허용된 실행 증거로 기록하지 않고 프로토콜 위반으로 남긴다", () => {
    const s = recordNativeItem(fresh(), "evidence-native", "t", "u", { type: "webSearch", id: "search-1", status: "completed" }, true, rawRef);
    expect(s.actions[0].status).toBe("FAILED");
    expect(s.actions[0].tool).toBe("codex.webSearch");
    expect(s.evidence[0].verdict).toBe("UNCERTAIN");
    expect(s.evidence[0].summary).toContain("프로토콜 위반");
  });
});
