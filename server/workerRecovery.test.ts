import { ModelGatewayError, modelFailure } from "../src/modelFailure";
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject, getRun, getWorldSnapshot, recordModelFailure, recordNonToolAction } from "../src/runtime";
import type { AppState } from "../src/types";

const originalStatePath = process.env.INTENT_WORLD_STATE_FILE;
const originalRawDirectory = process.env.INTENT_WORLD_RAW_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalStatePath === undefined) delete process.env.INTENT_WORLD_STATE_FILE;
  else process.env.INTENT_WORLD_STATE_FILE = originalStatePath;
  if (originalRawDirectory === undefined) delete process.env.INTENT_WORLD_RAW_DIR;
  else process.env.INTENT_WORLD_RAW_DIR = originalRawDirectory;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function providerFailure(state: AppState, projectId: string): AppState {
  return recordModelFailure(state, projectId, new ModelGatewayError(modelFailure("PROVIDER_UNAVAILABLE", "모델 게이트웨이를 사용할 수 없습니다 · legacy fixture", true)));
}

describe("worker provider recovery", () => {
  it("앱 재시작 시 이전 provider 실패로 고립된 프로젝트를 durable state에서 다시 깨운다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sakasaka-worker-recovery-test-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.json");
    process.env.INTENT_WORLD_STATE_FILE = statePath;
    process.env.INTENT_WORLD_RAW_DIR = join(directory, "raw");

    const projectId = "worker-provider-recovery";
    let state = createProject(createEmptyState(), "provider 실패 뒤 다시 연결해줘", projectId, { failureThreshold: 3 });
    state = providerFailure(state, projectId);
    state = providerFailure(state, projectId);
    state = providerFailure(state, projectId);
    expect(getProject(state, projectId)?.status).toBe("STALLED");
    const legacyState = {
      ...state,
      runs: state.runs.map((run) => run.projectId === projectId ? { ...run, consecutiveFailures: 0, noProgressCycles: 0, lastFailureSignature: undefined } : run),
    };
    writeFileSync(statePath, JSON.stringify(legacyState), "utf8");

    const worker = await import("./worker");
    await worker.runWorkerOnce();
    const recovered = JSON.parse(readFileSync(statePath, "utf8")) as AppState;
    expect(getProject(recovered, projectId)?.status).toBe("ACTIVE");
    expect(getRun(recovered, projectId)).toMatchObject({ status: "ACTIVE", phase: "wake", consecutiveFailures: 0 });
  });
});
