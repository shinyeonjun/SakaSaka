import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { assembleContext, createProject, getRun } from "../src/runtime";
import { OpenAICompatibleModelGateway, UnavailableModelGateway } from "./localAdapters";
import type { AppState, ContextPacket } from "../src/types";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function emptyState(): AppState {
  return { schemaVersion: 1, activeProjectId: "", projects: [], intents: [], runs: [], actions: [], worldSnapshots: [], observations: [], contexts: [], events: [], evidence: [], humanItems: [], artifacts: [], experiences: [], policies: [], resourceLedger: [], relations: [], retrievalIndex: [], experiments: [], approvalGrants: [], processes: [] };
}

async function mockEndpoint(content: string, usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }): Promise<{ endpoint: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
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
    expect(usage).toMatchObject({ modelVersion: "openai-compatible:test-model", tokens: 12 });
    expect(response.requests).toHaveLength(1);
    const payload = JSON.parse(response.requests[0]!) as { messages?: Array<{ role?: string; content?: string }> };
    const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(JSON.parse(user)).toMatchObject({ projectId: packet.projectId, intentRef: packet.intentRef, worldCursor: packet.worldCursor });
  });

  it("rejects malformed model output instead of fabricating an action", async () => {
    const { context: packet } = context();
    const response = await mockEndpoint("not-json");
    const gateway = new OpenAICompatibleModelGateway(response.endpoint, "test-key");
    await expect(gateway.decide(packet)).rejects.toThrow("invalid JSON ActionEnvelope");
  });

  it("returns an explicit WAIT when a provider is unavailable", async () => {
    const { context: packet } = context();
    const gateway = new UnavailableModelGateway("provider is not configured");
    await expect(gateway.decide(packet)).resolves.toMatchObject({ type: "WAIT", rationaleSummary: expect.stringContaining("unavailable") });
    await expect(gateway.usage("run")).resolves.toMatchObject({ modelVersion: "unavailable", tokens: 0 });
  });
});
