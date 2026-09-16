import { useState } from "react";
import { formatClock } from "../format";
import { eventLabel, eventTone, getProject, getProjectEvents, getWorldSnapshot, statusLabel } from "../runtime";
import { useApp } from "../store";
import type { EventRecord } from "../types";
import { Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";

function worldInspectorRows(world: NonNullable<ReturnType<typeof getWorldSnapshot>>, testsPassed: number, testsTotal: number, humanSummary: string) {
  return [
    { label: "저장소", summary: world.sources.repo.summary, tone: world.sources.repo.status === "healthy" ? "mint" : "yellow" },
    { label: "검증", summary: testsTotal ? `${testsPassed} / ${testsTotal}` : "아직 확인되지 않음", tone: testsTotal && testsPassed === testsTotal ? "mint" : "yellow" },
    { label: "브라우저", summary: world.sources.browser.summary, tone: world.sources.browser.status === "healthy" ? "mint" : "yellow" },
    { label: "데이터베이스", summary: world.sources.db.summary, tone: world.sources.db.status === "healthy" ? "mint" : "yellow" },
    { label: "미리보기", summary: world.sources.runtime.summary, tone: world.sources.runtime.status === "healthy" ? "mint" : "yellow" },
    { label: "사람", summary: humanSummary, tone: world.sources.human.status === "healthy" ? "mint" : "pink" },
  ];
}

export function ActivityPage({ projectId }: { projectId: string }) {
  const { state } = useApp();
  const project = getProject(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  const run = state.runs.find((candidate) => candidate.id === project?.activeRunId);
  const [visibleCount, setVisibleCount] = useState(40);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  if (!project || !world || !run) return <div className="screen"><Card className="empty-state"><h1>활동을 표시할 수 없습니다.</h1></Card></div>;
  const events = getProjectEvents(state, projectId);
  const evidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const timelineEvents = events.slice(0, visibleCount);
  const actionableHumanCount = state.humanItems.filter((item) => item.projectId === projectId && (item.status === "OPEN" || item.status === "DEFERRED")).length;
  const humanSummary = actionableHumanCount ? `도움이 필요한 항목 ${actionableHumanCount}개` : world.sources.human.summary;
  const worldRows = worldInspectorRows(world, project.metrics.testsPassed, project.metrics.testsTotal, humanSummary);

  return (
    <div className="screen">
      <PageHeading title="활동 / 월드" description="AI가 실제 세계에서 무엇을 보고, 무엇을 했고, 어떤 증거가 생겼는지 추적합니다." actions={<Pill tone={project.status === "ACTIVE" ? "mint" : "yellow"}>{statusLabel(project.status)} <small>{project.status}</small></Pill>} />
      <div className="screen-stack">
        <div className="activity-grid">
          <Card className="timeline-card">
            <SectionHeader title="이벤트 타임라인" />
            <div className="timeline-list">
              {timelineEvents.map((event) => <TimelineRow key={event.id} event={event} expanded={selectedEvent === event.id} onToggle={() => setSelectedEvent((current) => current === event.id ? null : event.id)} />)}
            </div>
            {visibleCount < events.length && <button onClick={() => setVisibleCount((count) => count + 40)}>이전 이벤트 더 보기</button>}
          </Card>
          <Card className="world-card">
            <SectionHeader title="현재 월드" />
            <div className="world-health-list">
              {worldRows.map((row) => <div key={row.label} className="world-health-row"><strong>{row.label}</strong><Pill tone={row.tone}>{row.summary}</Pill></div>)}
            </div>
          </Card>
        </div>

        <Card className="evidence-chain-card">
          <SectionHeader title="증거 연결" />
          <div className="evidence-chain-flow">{evidence.slice(0, 6).reverse().map((item, index) => <span key={item.id} className="evidence-chain-node"><strong>{item.kind}</strong><small>#{item.id.replace("evidence-", "")}</small>{index < Math.min(5, evidence.length - 1) && <span className="evidence-arrow">→</span>}</span>)}</div>
          <p className="muted-copy">모든 중요한 완료 주장은 원본 이벤트·산출물·평가 증거로 역추적할 수 있어야 합니다.</p>
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
    {expanded && <><span className="timeline-detail">{event.detail ?? "원본 연결 이벤트"}{event.payload && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(event.payload, null, 2)}</pre>}</span><span className="timeline-version-meta">스키마 {event.schemaVersion} · 모델 {event.modelVersion ?? "이전 버전"} · 도구 {event.toolVersion ?? "이전 버전"} · 정책 v{event.policyVersion ?? "—"}</span></>}
  </button>;
}
