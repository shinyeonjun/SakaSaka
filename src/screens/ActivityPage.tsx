import { useState } from "react";
import { formatClock } from "../format";
import { eventLabel, eventTone, getProject, getProjectEvents, getWorldSnapshot } from "../runtime";
import { useApp } from "../store";
import type { EventRecord } from "../types";
import { Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";

function worldInspectorRows(world: NonNullable<ReturnType<typeof getWorldSnapshot>>, testsPassed: number, testsTotal: number, humanSummary: string) {
  return [
    { label: "Repo", summary: world.sources.repo.summary, tone: world.sources.repo.status === "healthy" ? "mint" : "yellow" },
    { label: "Tests", summary: testsTotal ? `${testsPassed} / ${testsTotal}` : "not verified", tone: testsTotal && testsPassed === testsTotal ? "mint" : "yellow" },
    { label: "Browser", summary: world.sources.browser.summary, tone: world.sources.browser.status === "healthy" ? "mint" : "yellow" },
    { label: "DB", summary: world.sources.db.summary, tone: world.sources.db.status === "healthy" ? "mint" : "yellow" },
    { label: "Preview", summary: world.sources.runtime.summary, tone: world.sources.runtime.status === "healthy" ? "mint" : "yellow" },
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
  const evidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const timelineEvents = events.slice(0, 12);
  const actionableHumanCount = state.humanItems.filter((item) => item.projectId === projectId && (item.status === "OPEN" || item.status === "DEFERRED")).length;
  const humanSummary = actionableHumanCount ? `${actionableHumanCount} actionable item${actionableHumanCount === 1 ? "" : "s"}` : world.sources.human.summary;
  const worldRows = worldInspectorRows(world, project.metrics.testsPassed, project.metrics.testsTotal, humanSummary);

  return (
    <div className="screen">
      <PageHeading title="Activity / World" description="AI가 실제 세계에서 무엇을 보고, 무엇을 했고, 어떤 evidence가 생겼는지 추적합니다." actions={<Pill tone={project.status === "ACTIVE" ? "mint" : "yellow"}>{project.status}</Pill>} />
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
          <div className="evidence-chain-flow">{evidence.slice(0, 6).reverse().map((item, index) => <span key={item.id} className="evidence-chain-node"><strong>{item.kind}</strong><small>#{item.id.replace("evidence-", "")}</small>{index < Math.min(5, evidence.length - 1) && <span className="evidence-arrow">→</span>}</span>)}</div>
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
