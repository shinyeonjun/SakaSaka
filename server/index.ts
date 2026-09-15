import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";
import { createSeedState } from "../src/seed";
import {
  addIntent,
  createArtifact,
  createExperiment,
  createProject,
  getProject,
  getProjectContexts,
  getProjectEvents,
  getProjectHumanItems,
  getProjectObservations,
  getProjectRelations,
  getProjectRetrievalEntries,
  getResourceLedger,
  getRun,
  getWorldSnapshot,
  killProject,
  makeId,
  pauseProject,
  resolveHumanItem,
  resumeProject,
  refreshWorld,
  runCycle,
  runExperiment,
  stallProject,
  wakeProject,
} from "../src/runtime";
import type { AppState, ArtifactKind, Experiment, ProjectSettings } from "../src/types";

const port = Number(process.env.API_PORT ?? "8787");
const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
const subscribers = new Map<string, Set<ServerResponse>>();

function normalizeState(candidate: unknown): AppState {
  const value = candidate as Partial<AppState>;
  if (!Array.isArray(value.projects) || !Array.isArray(value.intents) || !Array.isArray(value.runs) || !Array.isArray(value.events)) return createSeedState();
  return {
    ...(value as AppState),
    observations: Array.isArray(value.observations) ? value.observations : [],
    contexts: Array.isArray(value.contexts) ? value.contexts : [],
    policies: Array.isArray(value.policies) ? value.policies : [],
    resourceLedger: Array.isArray(value.resourceLedger) ? value.resourceLedger : [],
    relations: Array.isArray(value.relations) ? value.relations : [],
    retrievalIndex: Array.isArray(value.retrievalIndex) ? value.retrievalIndex : [],
  };
}

function loadState(): AppState {
  if (!existsSync(statePath)) return createSeedState();
  try {
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    return createSeedState();
  }
}

let state = loadState();

function persistState(next: AppState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(next, null, 2), "utf8");
}

function publishEvents(previous: AppState, next: AppState): void {
  const known = new Set(previous.events.map((event) => event.id));
  const created = next.events.filter((event) => !known.has(event.id));
  for (const event of created) {
    const listeners = subscribers.get(event.projectId);
    if (!listeners) continue;
    const eventNames = new Set(["event.created"]);
    if (event.type === "RUN_STATE_CHANGED") eventNames.add("run.state");
    if (event.type === "WORLD_CHANGED" || event.type === "OBSERVATION_REFRESHED") eventNames.add("world.changed");
    if (event.type === "HUMAN_ITEM_CREATED") eventNames.add("human-item.created");
    if (event.type === "EVIDENCE_RECORDED") eventNames.add("evidence.created");
    const payload = [...eventNames]
      .map((name) => `id: ${event.id}\nevent: ${name}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    for (const listener of listeners) listener.write(payload);
  }
}

function commit(next: AppState): void {
  const previous = state;
  state = next;
  persistState(state);
  publishEvents(previous, state);
}

function headers(contentType = "application/json"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": contentType,
  };
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, headers());
  response.end(JSON.stringify(data));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

function projectPayload(projectId: string): Record<string, unknown> | undefined {
  const project = getProject(state, projectId);
  if (!project) return undefined;
  return {
    project,
    intent: state.intents.find((intent) => intent.id === project.intentId),
    run: getRun(state, projectId),
    world: getWorldSnapshot(state, projectId),
    needsYou: getProjectHumanItems(state, projectId),
    evidence: state.evidence.filter((item) => item.projectId === projectId),
    artifacts: state.artifacts.filter((item) => item.projectId === projectId),
    events: getProjectEvents(state, projectId),
    observations: getProjectObservations(state, projectId),
    contexts: getProjectContexts(state, projectId),
    experiences: state.experiences.filter((item) => item.projectId === projectId),
    ledger: getResourceLedger(state, projectId),
    relations: getProjectRelations(state, projectId),
    retrievalIndex: getProjectRetrievalEntries(state, projectId),
  };
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function afterCursor(events: AppState["events"], cursor: string | null): AppState["events"] {
  if (!cursor) return events;
  const index = events.findIndex((event) => event.id === cursor);
  return index < 0 ? events : events.slice(index + 1);
}

function parseExperimentInput(body: Record<string, unknown>): Pick<Experiment, "key" | "title" | "hypothesis" | "description" | "variant"> {
  return {
    key: typeof body.key === "string" ? body.key : "H-custom",
    title: typeof body.title === "string" ? body.title : "Custom experiment",
    hypothesis: typeof body.hypothesis === "string" ? body.hypothesis : "Custom hypothesis",
    description: typeof body.description === "string" ? body.description : "Created by the control plane",
    variant: typeof body.variant === "string" ? body.variant : "local",
  };
}

function findProjectIdByRun(runId: string): string | undefined {
  return state.runs.find((run) => run.id === runId)?.projectId;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsedUrl = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "localhost"));
  const parts = routeParts(parsedUrl.pathname);
  const method = request.method ?? "GET";

  if (method === "OPTIONS") {
    response.writeHead(204, headers());
    response.end();
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "intent-world-control-plane", statePath });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/state") {
    sendJson(response, 200, state);
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "projects") {
    const body = await readJson(request);
    const rawIntent = typeof body.rawIntent === "string" ? body.rawIntent.trim() : "";
    if (!rawIntent) {
      sendError(response, 400, "rawIntent is required");
      return;
    }
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : makeId("project");
    const settings = body.settings && typeof body.settings === "object" ? body.settings as Partial<ProjectSettings> : undefined;
    commit(createProject(state, rawIntent, projectId, settings));
    sendJson(response, 201, projectPayload(projectId));
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "experiments") {
    const body = await readJson(request);
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId || !getProject(state, projectId)) {
      sendError(response, 400, "projectId is required and must reference an existing project");
      return;
    }
    commit(createExperiment(state, projectId, parseExperimentInput(body)));
    sendJson(response, 201, { experiment: state.experiments.at(-1), project: getProject(state, projectId) });
    return;
  }

  if (parts[0] === "projects" && parts[1]) {
    const projectId = parts[1];
    const project = getProject(state, projectId);
    if (!project) {
      sendError(response, 404, "project not found");
      return;
    }

    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && parts[2] === "intents" && parts.length === 3) {
      const body = await readJson(request);
      const rawText = typeof body.rawText === "string" ? body.rawText : typeof body.rawIntent === "string" ? body.rawIntent : "";
      if (!rawText.trim()) {
        sendError(response, 400, "rawText is required");
        return;
      }
      commit(addIntent(state, projectId, rawText).state);
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && parts[2] === "wake" && parts.length === 3) {
      let next = wakeProject(state, projectId);
      if (getProject(next, projectId)?.status === "ACTIVE") next = runCycle(next, projectId);
      commit(next);
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && parts[2] === "run" && parts.length === 3) {
      commit(runCycle(state, projectId));
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "POST" && parts[2] === "stall" && parts.length === 3) {
      const body = await readJson(request);
      const reason = typeof body.reason === "string" ? body.reason : "manual stall review";
      commit(stallProject(state, projectId, reason));
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "human-items" && parts.length === 3) {
      sendJson(response, 200, { items: getProjectHumanItems(state, projectId) });
      return;
    }

    if (method === "GET" && parts[2] === "world" && parts.length === 3) {
      sendJson(response, 200, { world: getWorldSnapshot(state, projectId), observations: getProjectObservations(state, projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "world" && parts[3] === "refresh" && parts.length === 4) {
      commit(refreshWorld(state, projectId));
      sendJson(response, 200, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "events" && parts.length === 3) {
      const cursor = parsedUrl.searchParams.get("after");
      const allEvents = state.events.filter((event) => event.projectId === projectId);
      sendJson(response, 200, { events: afterCursor(allEvents, cursor) });
      return;
    }

    if (method === "GET" && parts[2] === "stream" && parts.length === 3) {
      response.writeHead(200, {
        ...headers("text/event-stream"),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("event: ready\ndata: " + JSON.stringify({ projectId, cursor: getProjectEvents(state, projectId)[0]?.id ?? null }) + "\n\n");
      const listeners = subscribers.get(projectId) ?? new Set<ServerResponse>();
      listeners.add(response);
      subscribers.set(projectId, listeners);
      request.on("close", () => {
        listeners.delete(response);
        if (!listeners.size) subscribers.delete(projectId);
      });
      return;
    }

    if (method === "GET" && parts[2] === "artifacts" && parts.length === 3) {
      sendJson(response, 200, { artifacts: state.artifacts.filter((artifact) => artifact.projectId === projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "artifacts" && parts.length === 3) {
      const body = await readJson(request);
      const kind = typeof body.kind === "string" ? body.kind as ArtifactKind : "report";
      const name = typeof body.name === "string" && body.name ? body.name : "Runtime artifact";
      const description = typeof body.description === "string" ? body.description : "Created by the control plane";
      commit(createArtifact(state, projectId, kind, name, description));
      sendJson(response, 201, projectPayload(projectId));
      return;
    }

    if (method === "GET" && parts[2] === "experiments" && parts.length === 3) {
      sendJson(response, 200, { experiments: state.experiments.filter((experiment) => experiment.projectId === projectId) });
      return;
    }

    if (method === "POST" && parts[2] === "experiments" && parts.length === 3) {
      const body = await readJson(request);
      commit(createExperiment(state, projectId, parseExperimentInput(body)));
      sendJson(response, 201, projectPayload(projectId));
      return;
    }
  }

  if (parts[0] === "runs" && parts[1]) {
    const runId = parts[1];
    const projectId = findProjectIdByRun(runId);
    if (!projectId) {
      sendError(response, 404, "run not found");
      return;
    }
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, { run: getRun(state, projectId), project: getProject(state, projectId) });
      return;
    }
    if (method === "POST" && parts.length === 3) {
      const next = parts[2] === "pause" ? pauseProject(state, projectId) : parts[2] === "resume" ? resumeProject(state, projectId) : parts[2] === "kill" ? killProject(state, projectId) : state;
      if (next === state) {
        sendError(response, 400, "unsupported run action");
        return;
      }
      commit(next);
      sendJson(response, 200, { run: getRun(state, projectId), project: getProject(state, projectId) });
      return;
    }
  }

  if (parts[0] === "human-items" && parts[1] && parts[2] && method === "POST") {
    const item = state.humanItems.find((candidate) => candidate.id === parts[1]);
    if (!item) {
      sendError(response, 404, "human item not found");
      return;
    }
    const body = await readJson(request);
    const action = parts[2] === "answer" ? "answer" : parts[2] === "approve" ? "approve" : parts[2] === "reject" ? "reject" : parts[2] === "defer" ? "defer" : "acknowledge";
    const answer = typeof body.answer === "string" ? body.answer : undefined;
    commit(resolveHumanItem(state, item.id, action, answer));
    sendJson(response, 200, projectPayload(item.projectId));
    return;
  }

  if (parts[0] === "evidence" && parts[1] && method === "GET") {
    const evidence = state.evidence.find((item) => item.id === parts[1]);
    if (!evidence) sendError(response, 404, "evidence not found");
    else sendJson(response, 200, { evidence });
    return;
  }

  if (parts[0] === "artifacts" && parts[1] && method === "GET") {
    const artifact = state.artifacts.find((item) => item.id === parts[1]);
    if (!artifact) sendError(response, 404, "artifact not found");
    else sendJson(response, 200, { artifact });
    return;
  }

  if (parts[0] === "experiments" && parts[1]) {
    const experiment = state.experiments.find((item) => item.id === parts[1]);
    if (!experiment) {
      sendError(response, 404, "experiment not found");
      return;
    }
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, { experiment });
      return;
    }
    if (method === "POST" && parts[2] === "run") {
      commit(runExperiment(state, experiment.id));
      sendJson(response, 200, { experiment: state.experiments.find((item) => item.id === experiment.id) });
      return;
    }
  }

  if (method === "GET" && parts[0] === "events") {
    const projectId = parsedUrl.searchParams.get("projectId");
    const cursor = parsedUrl.searchParams.get("after");
    const events = projectId ? state.events.filter((event) => event.projectId === projectId) : state.events;
    sendJson(response, 200, { events: afterCursor(events, cursor) });
    return;
  }

  sendError(response, 404, "route not found");
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "internal server error";
    if (!response.headersSent) sendError(response, 500, message);
    else response.end();
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log("Intent World control plane listening on http://localhost:" + port);
});
