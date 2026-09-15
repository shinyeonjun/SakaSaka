import { useState } from "react";
import { formatClock } from "../format";
import { eventLabel, eventTone, getProject, getProjectEvents, getWorldSnapshot } from "../runtime";
import { useApp } from "../store";
import type { EventRecord } from "../types";
import { Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";

const seedGalleryEventIds = new Set(["event-801", "event-802", "event-808", "event-809", "event-810", "event-811", "event-812", "event-813", "event-814", "event-815", "event-816", "event-817", "event-818", "event-819", "event-820"]);

function isSeedGallery(projectId: string, events: EventRecord[]): boolean {
  return projectId === "project-trip-together" && events.length === seedGalleryEventIds.size && events.every((event) => seedGalleryEventIds.has(event.id));
}

function galleryEvent(id: string, type: EventRecord["type"], summary: string, createdAt: string, source?: EventRecord): EventRecord {
  return {
    id,
    sequence: source?.sequence,
    projectId: "project-trip-together",
    type,
    actor: source?.actor ?? "agent",
    summary,
    createdAt,
    schemaVersion: 1,
    modelVersion: source?.modelVersion ?? "local-deterministic-0.1",
    toolVersion: source?.toolVersion ?? "local-tool-gateway-0.1",
    policyVersion: source?.policyVersion ?? 1,
  };
}

function seedTimeline(events: EventRecord[]): EventRecord[] {
  const byType = (type: EventRecord["type"]) => events.find((event) => event.type === type);
  return [
    galleryEvent("gallery-observe", "OBSERVE", "Playwright mobile viewport 관찰", "2026-09-16T14:31:00+09:00", byType("OBSERVE")),
    galleryEvent("gallery-gap", "GAP_FOUND", "초대 모달 overflow 발견", "2026-09-16T14:32:00+09:00", byType("OBSERVE")),
    galleryEvent("gallery-act", "ACTION_SELECTED", "CSS layout 수정", "2026-09-16T14:33:00+09:00", byType("ACTION_SELECTED")),
    galleryEvent("gallery-verify", "VERIFY", "390px/430px 재실행 · PASS", "2026-09-16T14:34:00+09:00", byType("VERIFY")),
    galleryEvent("gallery-world", "WORLD_CHANGED", "evidence + git diff 기록", "2026-09-16T14:35:00+09:00", byType("WORLD_CHANGED")),
  ];
}

function worldInspectorRows(world: NonNullable<ReturnType<typeof getWorldSnapshot>>, testsPassed: number, testsTotal: number, humanSummary: string) {
  return [
    { label: "Repo", summary: world.sources.repo.summary, tone: world.sources.repo.status === "healthy" ? "mint" : "yellow" },
    { label: "Tests", summary: testsTotal ? `${testsPassed} / ${testsTotal}` : "not verified", tone: testsTotal && testsPassed === testsTotal ? "mint" : "yellow" },
    { label: "Browser", summary: world.sources.browser.summary, tone: world.sources.browser.status === "healthy" ? "mint" : "yellow" },
    { label: "DB", summary: world.sources.db.summary, tone: world.sources.db.status === "healthy" ? "mint" : "yellow" },
    { label: "Deploy", summary: "preview only", tone: "yellow" },
    { label: "Human", summary: humanSummary, tone: world.sources.human.status === "healthy" ? "mint" : "pink" },
  ];
}

export function ActivityPage({ projectId }: { projectId: string }) {
  const { state } = useApp();
  const project = getProject(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  const run = state.runs.find((candidate) => candidate.id === project?.activeRunId);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  if (!project || !world || !run) return <div className="screen"><Card className="empty-state"><h1>Activity를 표시할 수 없습니다.</h1></Card></div>;
  const events = getProjectEvents(state, projectId);
  const evidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seedView = isSeedGallery(projectId, events);
  const timelineEvents = seedView ? seedTimeline(events) : events.slice(0, 12);
  const humanSummary = state.humanItems.some((item) => item.projectId === projectId && item.id === "Q-17" && item.status === "OPEN") ? "Q-17 unanswered" : world.sources.human.summary;
  const worldRows = worldInspectorRows(world, project.metrics.testsPassed, project.metrics.testsTotal, humanSummary);

  return (
    <div className="screen">
      <PageHeading title="Activity / World" description="AI가 실제 세계에서 무엇을 보고, 무엇을 했고, 어떤 evidence가 생겼는지 추적합니다." actions={<Pill tone="mint">LIVE</Pill>} />
      <div className="screen-stack">
        <div className="activity-grid">
          <Card className="timeline-card">
            <SectionHeader title="Event Timeline" />
            <div className="timeline-list">
              {timelineEvents.map((event) => <TimelineRow key={event.id} event={event} expanded={selectedEvent === event.id} onToggle={() => setSelectedEvent((current) => current === event.id ? null : event.id)} />)}
            </div>
          </Card>
          <Card className="world-card">
            <SectionHeader title="Current World" />
            <div className="world-health-list">
              {worldRows.map((row) => <div key={row.label} className="world-health-row"><strong>{row.label}</strong><Pill tone={row.tone}>{row.summary}</Pill></div>)}
            </div>
          </Card>
        </div>

        <Card className="evidence-chain-card">
          <SectionHeader title="Evidence Chain" />
          {seedView ? <div className="evidence-chain-flow">{["Observation #811", "Action #812", "Tool Result #813", "Screenshot #814", "E2E #815", "World Snapshot #816"].map((label, index, chain) => <span key={label} className="evidence-chain-node"><strong>{label.split(" #")[0]}</strong><small>#{label.split(" #")[1]}</small>{index < chain.length - 1 && <span className="evidence-arrow">→</span>}</span>)}</div> : <div className="evidence-chain-flow">{evidence.slice(0, 6).reverse().map((item, index) => <span key={item.id} className="evidence-chain-node"><strong>{item.kind}</strong><small>#{item.id.replace("evidence-", "")}</small>{index < Math.min(5, evidence.length - 1) && <span className="evidence-arrow">→</span>}</span>)}</div>}
          <p className="muted-copy">모든 중요한 완료 주장은 raw event / artifact / evaluator evidence로 역추적 가능해야 합니다.</p>
        </Card>
      </div>
    </div>
  );
}

function TimelineRow({ event, expanded, onToggle }: { event: EventRecord; expanded: boolean; onToggle: () => void }) {
  return <button className={cn("timeline-row", expanded && "timeline-row-expanded")} onClick={onToggle} aria-expanded={expanded}>
    <span className="timeline-time">{formatClock(event.createdAt)}</span>
    <Pill tone={eventTone(event.type)}>{eventLabel(event.type)}</Pill>
    <span className="timeline-summary">{event.summary}</span>
    {expanded && <><span className="timeline-detail">{event.detail ?? "source-linked event"}</span><span className="timeline-version-meta">schema {event.schemaVersion} · model {event.modelVersion ?? "legacy"} · tool {event.toolVersion ?? "legacy"} · policy v{event.policyVersion ?? "—"}</span></>}
  </button>;
}
