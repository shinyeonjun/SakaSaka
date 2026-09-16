import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState } from "../src/emptyState";
import { assembleContext, createProject, getRun } from "../src/runtime";
import type { ActionEnvelope } from "../src/types";
import { CodexCliModelGateway } from "./codexCliGateway";

const originalRawDir = process.env.INTENT_WORLD_RAW_DIR;
const originalFixtureAction = process.env.CODEX_GATEWAY_ACTION;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalRawDir === undefined) delete process.env.INTENT_WORLD_RAW_DIR;
  else process.env.INTENT_WORLD_RAW_DIR = originalRawDir;
  if (originalFixtureAction === undefined) delete process.env.CODEX_GATEWAY_ACTION;
  else process.env.CODEX_GATEWAY_ACTION = originalFixtureAction;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function contextFixture() {
  const state = createProject(createEmptyState(), "브라우저에서 실행할 수 있는 작은 도구를 만들어줘", "gateway-project");
  const context = assembleContext(state, "gateway-project");
  const run = getRun(state, "gateway-project");
  if (!context || !run) throw new Error("gateway context fixture could not be assembled");
  return context;
}

function writeCliFixture(output: string, exitCode = 0): { binary: string; prefix: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "sakasaka-codex-cli-test-"));
  temporaryDirectories.push(directory);
  const script = join(directory, "fixture.mjs");
  writeFileSync(script, `
const action = process.env.CODEX_GATEWAY_ACTION;
if (!process.argv.slice(2).includes("exec")) process.exit(41);
process.stdout.write(${JSON.stringify(output)});
if (${exitCode} !== 0) process.exit(${exitCode});
`, "utf8");
  return { binary: process.execPath, prefix: [script] };
}

describe("Codex CLI ModelGateway", () => {
  it("실제 codex exec 형식의 JSONL을 읽어 ActionEnvelope과 사용량 provenance를 만든다", async () => {
    const context = contextFixture();
    const action: ActionEnvelope = {
      type: "ACT",
      intentRef: context.intentRef,
      worldCursor: context.worldCursor,
      rationaleSummary: "현재 workspace를 읽고 필요한 변경을 판단",
      tool: "repo.read",
      params: { commandId: "repo-status" },
      expectedValue: 0.7,
      riskClass: "P0",
      evidencePlan: ["world"],
    };
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-fixture" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(action) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 13, output_tokens: 9, total_tokens: 22 } }),
      "",
    ].join("\n");
    const fixture = writeCliFixture(output);
    process.env.INTENT_WORLD_RAW_DIR = temporaryDirectories[0];
    process.env.CODEX_GATEWAY_ACTION = JSON.stringify(action);
    const gateway = new CodexCliModelGateway({ binary: fixture.binary, commandPrefix: fixture.prefix, model: "codex-test", timeoutMs: 5_000 });

    await expect(gateway.decide(context)).resolves.toEqual(action);
    const usageKey = context.runId ?? context.projectId;
    await expect(gateway.usage(usageKey)).resolves.toMatchObject({ modelVersion: "codex-cli:codex-test", tokens: 22, inputTokens: 13, outputTokens: 9, usageKnown: true, requestId: "thread-fixture" });
    await expect(gateway.usage(usageKey)).resolves.toHaveProperty("rawRef", expect.stringMatching(/^local-raw:\/\//));
  });

  it("malformed output 또는 실행 불가 CLI는 fake ACT가 아닌 명확한 WAIT로 끝난다", async () => {
    const context = contextFixture();
    const malformed = writeCliFixture(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not-json" } }));
    process.env.INTENT_WORLD_RAW_DIR = temporaryDirectories[0];
    const gateway = new CodexCliModelGateway({ binary: malformed.binary, commandPrefix: malformed.prefix, timeoutMs: 5_000 });
    const malformedAction = await gateway.decide(context);
    expect(malformedAction.type).toBe("WAIT");
    expect(malformedAction.rationaleSummary).toMatch(/모델 게이트웨이를 사용할 수 없습니다/);

    const unavailable = new CodexCliModelGateway({ binary: join(temporaryDirectories[0], "missing-codex"), timeoutMs: 1_000 });
    const unavailableAction = await unavailable.decide(context);
    expect(unavailableAction.type).toBe("WAIT");
    expect(unavailableAction.rationaleSummary).toMatch(/Codex CLI를 실행할 수 없습니다|모델 게이트웨이를 사용할 수 없습니다/);
  });
});
