import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { assembleContext, createProject, getRun } from "../src/runtime";
import { CodexCliModelGateway } from "./codexCliGateway";
import { OpenAICompatibleModelGateway, UnavailableModelGateway, createModelGateway, inspectModelProvider } from "./localAdapters";
import { getRecommendedCodexModels } from "../src/modelCatalog";
import type { AppState, ContextPacket } from "../src/types";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function emptyState(): AppState {
  return { schemaVersion: 1, activeProjectId: "", projects: [], intents: [], runs: [], actions: [], worldSnapshots: [], observations: [], contexts: [], events: [], evidence: [], humanItems: [], artifacts: [], experiences: [], policies: [], resourceLedger: [], relations: [], retrievalIndex: [], experiments: [], approvalGrants: [], processes: [] };
}

async function mockEndpoint(content: string, usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }, status = 200): Promise<{ endpoint: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  return { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, requests };
}

function context(): { context: ContextPacket; runId: string } {
  const state = createProject(emptyState(), "실제 gateway 요청을 검증해줘", "gateway-test");
  const run = getRun(state, "gateway-test")!;
  return { context: assembleContext(state, "gateway-test")!, runId: run.id };
}

describe("OpenAI-compatible model gateway", () => {
  it("sends the source-linked ContextPacket and records provider usage", async () => {
    const { context: packet, runId } = context();
    const response = await mockEndpoint(JSON.stringify({ type: "WAIT", intentRef: packet.intentRef, worldCursor: packet.worldCursor, rationaleSummary: "no useful action now", riskClass: "P0" }));
    const gateway = new OpenAICompatibleModelGateway(response.endpoint, "test-key", "test-model");
    await expect(gateway.decide(packet)).resolves.toMatchObject({ type: "WAIT", worldCursor: packet.worldCursor });
    const usage = await gateway.usage(runId);
    expect(usage).toMatchObject({ modelVersion: "openai-compatible:test-model", tokens: 12, inputTokens: 5, outputTokens: 7, usageKnown: true });
    expect(response.requests).toHaveLength(1);
    const payload = JSON.parse(response.requests[0]!) as { messages?: Array<{ role?: string; content?: string }> };
    expect(payload).toMatchObject({ model: "test-model" });
    const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(JSON.parse(user)).toMatchObject({ projectId: packet.projectId, intentRef: packet.intentRef, worldCursor: packet.worldCursor });
  });

  it("rejects malformed model output instead of fabricating an action", async () => {
    const { context: packet } = context();
    const response = await mockEndpoint("not-json");
    const gateway = new OpenAICompatibleModelGateway(response.endpoint, "test-key", "test-model");
    await expect(gateway.decide(packet)).rejects.toMatchObject({ failure: { code: "INVALID_OUTPUT" } });
  });

  it("returns typed failure and usage when the HTTP provider is unavailable", async () => {
    const { context: packet, runId } = context();
    const response = await mockEndpoint(JSON.stringify({ error: "temporarily unavailable" }), undefined, 503);
    const gateway = new OpenAICompatibleModelGateway(response.endpoint, "test-key", "test-model");
    await expect(gateway.decide(packet)).rejects.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
    await expect(gateway.usage(runId)).resolves.toMatchObject({ modelVersion: "openai-compatible:test-model", tokens: 0, usageKnown: false, rawRef: expect.stringMatching(/^local-raw:\/\//) });
  });

  it("throws typed configuration failure, never an AI WAIT", async () => {
    const { context: packet } = context();
    const gateway = new UnavailableModelGateway("provider가 설정되지 않았습니다.");
    await expect(gateway.decide(packet)).rejects.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE", retryable: false } });
    await expect(gateway.usage("run")).resolves.toMatchObject({ modelVersion: "unavailable", tokens: 0, usageKnown: false });
  });

  it("routes an explicit Codex CLI provider through ModelGateway", () => {
    const state = createProject(emptyState(), "Codex CLI 모델 연결을 검증해줘", "gateway-codex", { modelProvider: "codex-cli" });
    const project = state.projects.find((candidate) => candidate.id === "gateway-codex");
    expect(project).toBeDefined();
    expect(createModelGateway(project!)).toBeInstanceOf(CodexCliModelGateway);
  });

  it("provides the selectable Codex model defaults when the CLI has no list command", () => {
    expect(getRecommendedCodexModels().map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
    ]);
  });

  it("exposes a truthful provider status without starting a model turn", async () => {
    const state = createProject(emptyState(), "오프라인 기준선 상태를 확인해줘", "gateway-status", { modelProvider: "deterministic" });
    const project = state.projects.find((candidate) => candidate.id === "gateway-status");
    expect(project).toBeDefined();
    await expect(inspectModelProvider(project!)).resolves.toMatchObject({
      requested: "deterministic",
      effective: "deterministic",
      state: "connected",
      authentication: "not-applicable",
    });
  });
});
