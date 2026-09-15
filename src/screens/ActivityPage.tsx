import { useState } from "react";
import { eventCategory, formatClock } from "../format";
import { eventLabel, eventTone, getProject, getProjectEvents, getWorldSnapshot, phaseLabel } from "../runtime";
import { useApp } from "../store";
import type { EventRecord } from "../types";
import { Button, Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";

type ActivityFilter = "all" | "runtime" | "human" | "world" | "evidence";

export function ActivityPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  const run = state.runs.find((candidate) => candidate.id === project?.activeRunId);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  if (!project || !world || !run) return <div className="screen"><Card className="empty-state"><h1>Activity를 표시할 수 없습니다.</h1></Card></div>;
  const events = getProjectEvents(state, projectId);
  const filteredEvents = filter === "all" ? events : events.filter((event) => eventCategory(event) === filter);
  const evidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="screen">
      <PageHeading title="Activity / World" description="AI가 실제 세계에서 무엇을 보고, 무엇을 했고, 어떤 evidence가 생겼는지 추적합니다." actions={(
        <div className="heading-command-row"><Pill tone="mint">LIVE</Pill><Button variant="primary" size="small" onClick={() => dispatch({ type: "RUN_CYCLE", projectId })}>Run cycle</Button></div>
      )} />
      <div className="screen-stack">
        <div className="activity-grid">
          <Card className="timeline-card">
            <SectionHeader title="Event Timeline" action={<span className="timeline-count">{filteredEvents.length} events · {phaseLabel(run.phase)}</span>} />
            <div className="timeline-filter-row" role="tablist" aria-label="Activity 필터">
              {(["all", "runtime", "human", "world", "evidence"] as ActivityFilter[]).map((key) => <button key={key} className={cn("timeline-filter", filter === key && "timeline-filter-active")} onClick={() => setFilter(key)} role="tab" aria-selected={filter === key}>{key}</button>)}
            </div>
            <div className="timeline-list">
              {filteredEvents.slice(0, 12).map((event) => <TimelineRow key={event.id} event={event} expanded={selectedEvent === event.id} onToggle={() => setSelectedEvent((current) => current === event.id ? null : event.id)} />)}
            </div>
          </Card>
          <Card className="world-card">
            <SectionHeader title="Current World" />
            <div className="world-health-list">
              {Object.values(world.sources).map((source) => <div key={source.key} className="world-health-row"><strong>{source.label}</strong><Pill tone={source.status === "warning" ? source.key === "human" ? "pink" : "yellow" : "mint"}>{source.summary}</Pill></div>)}
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
    {expanded && <span className="timeline-detail">{event.detail ?? "source-linked event"}</span>}
  </button>;
}
