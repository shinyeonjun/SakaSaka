import { useMemo, useState } from "react";
import { missionHistory, latestControlPlane, relativeAge, type ControlPlaneMissionView } from "../controlPlaneView";
import { autonomyMissionHistory } from "../autonomyProjection";
import { useAutonomyProjection } from "../useAutonomyProjection";
import { getProject, getRun } from "../runtime";
import { useApp } from "../store";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

const tabs = ["실행", "변경", "근거", "의존성", "가정"] as const;
type MissionTab = (typeof tabs)[number];

export function MissionsPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const run = getRun(state, projectId);
  const autonomy = useAutonomyProjection(projectId, state.revision, Boolean(project));
  const legacyMissions = missionHistory(state, projectId);
  const fullMissions = autonomyMissionHistory(autonomy);
  const missions = autonomy?.available ? fullMissions : legacyMissions;
  const control = latestControlPlane(state, projectId);
  const active = missions.find((mission) => ["RUNNING", "VERIFYING", "READY", "BLOCKED", "PROPOSED"].includes(mission.status ?? "RUNNING")) ?? control?.mission ?? missions[0];
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [tab, setTab] = useState<MissionTab>("실행");
  const selected = missions.find((mission) => mission.id === selectedKey) ?? active;
  const events = useMemo(() => state.events.filter((event) => event.projectId === projectId).slice(-36).reverse(), [state.events, projectId]);
  const evidence = useMemo(() => state.evidence.filter((item) => item.projectId === projectId && item.source !== "sakasaka-autonomy").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.evidence, projectId]);
  const openHumans = state.humanItems.filter((item) => item.projectId === projectId && item.status === "OPEN");

  if (!project || !run) return <div className="product-loading">프로젝트 런타임을 찾을 수 없습니다.</div>;

  const progress = selected ? missionProgress(selected, run.cycleCount) : 0;
  const relatedEvidence = selected ? evidence.filter((item) => Date.parse(item.createdAt) >= Date.parse(selected.observedAt) - 120_000).slice(0, 8) : evidence.slice(0, 8);
  const selectedStatus = selected?.status ?? (selected ? "RUNNING" : "없음");
  const inspector = <>
    <InspectorHeader title="미션 상세" meta={selected ? selected.role : "없음"} />
    <InspectorCard title="상태" meta={selectedStatus}>
      <KeyValue label="프로젝트" value={project.status} tone={project.status === "ACTIVE" ? "success" : "warning"} />
      <KeyValue label="미션" value={selectedStatus} tone={missionTone(selectedStatus)} />
      <KeyValue label="실행 단계" value={run.phase} tone="working" />
      <KeyValue label="진행 추정" value={`${progress}%`} tone="evidence" />
      {selected?.priority !== undefined && <KeyValue label="우선순위" value={selected.priority.toFixed(2)} tone="evidence" />}
      {selected?.attempt !== undefined && <KeyValue label="시도" value={`${selected.attempt}`} />}
      <KeyValue label="최근 신호" value={selected ? relativeAge(selected.observedAt) : "-"} />
    </InspectorCard>
    <InspectorCard title="연결된 근거" meta={`${relatedEvidence.length}개`}>
      {relatedEvidence.slice(0, 4).map((item) => <div className="inspector-evidence-row" key={item.id}><StatusDot tone={item.verdict === "PASS" ? "success" : item.verdict === "FAIL" ? "danger" : "warning"} /><span>{item.summary}</span></div>)}
      {!relatedEvidence.length && <p className="product-muted">아직 직접 연결된 검증 근거가 없습니다.</p>}
    </InspectorCard>
    <InspectorCard title="의존성" meta={`${openHumans.length} human`}>
      {selected?.gapId && <div className="inspector-dependency"><strong>Gap</strong><small>{selected.gapId}</small></div>}
      {openHumans.slice(0, 3).map((item) => <div className="inspector-dependency" key={item.id}><strong>{item.title}</strong><small>차단 {item.blockingScope.length} · 계속 {item.continuingScope.length}</small></div>)}
      {!openHumans.length && !selected?.gapId && <p className="product-muted">현재 사람 결정으로 막힌 범위가 없습니다.</p>}
    </InspectorCard>
    <InspectorCard title="제어" meta="runtime">
      <div className="inspector-button-row"><button onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })}>재평가</button>{project.status === "PAUSED" ? <button onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })}>재개</button> : <button onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })}>일시정지</button>}</div>
    </InspectorCard>
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="미션" title={selected?.objective ?? "현재 실행 중인 미션이 없습니다"} description={selected ? `${selected.role} · autonomy가 Intent와 Gap Graph에서 만든 실행 단위` : "새 gap이 우선순위 frontier에 들어오면 미션이 만들어집니다."} actions={selected && <StatusPill tone={missionTone(selectedStatus)}>{selectedStatus}</StatusPill>} />

    <div className="mission-switcher">
      <div className="mission-switcher-label">미션 기록 · {missions.length}</div>
      {missions.length ? missions.slice(0, 10).map((mission, index) => <button className={`mission-switcher-item ${selected?.id === mission.id ? "active" : ""}`} key={mission.id} onClick={() => setSelectedKey(mission.id)}><span>{mission.status ?? (index === 0 ? "현재" : `이전 ${index}`)}</span><strong>{mission.objective}</strong><small>{mission.role}</small></button>) : <div className="product-empty">미션 기록이 아직 없습니다.</div>}
    </div>

    {selected && <Surface className="mission-hero">
      <div className="mission-hero-top"><div><StatusPill tone={missionTone(selectedStatus)}>{selectedStatus}</StatusPill><span className="mission-id">{selected.id.slice(-10)}</span></div><span>{progress}%</span></div>
      <h2>{selected.objective}</h2>
      <p>{selected.role}</p>
      <div className="mission-progress"><span style={{ width: `${progress}%` }} /></div>
      <div className="mission-meta-row"><span>최근 갱신 {relativeAge(selected.observedAt)} 전</span><span>cycle {run.cycleCount}</span><span>worker {project.settings.modelProvider ?? "auto"}</span></div>
    </Surface>}

    <div className="mission-tabs">{tabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>

    <div className="mission-detail-grid">
      <Surface>
        <SurfaceHeader title={tab === "실행" ? "실행 타임라인" : tab} meta={tab === "실행" ? `${events.length}개 이벤트` : undefined} />
        {tab === "실행" && <div className="mission-timeline">{events.slice(0, 12).map((event) => <div key={event.id}><div className="timeline-time">{relativeAge(event.createdAt)}</div><StatusDot tone={event.actor === "human" ? "human" : event.type.includes("EVIDENCE") ? "evidence" : event.type.includes("ERROR") || event.type.includes("FAILED") ? "danger" : "working"} /><div><strong>{event.summary}</strong><small>{event.detail ?? event.type}</small></div></div>)}</div>}
        {tab === "변경" && <div className="mission-simple-list">{state.observations.filter((item) => item.projectId === projectId && ["workspace", "repo"].includes(item.source)).slice(-10).reverse().map((item) => <div key={item.id}><strong>{item.compactView}</strong><small>{item.rawRef}</small></div>)}</div>}
        {tab === "근거" && <div className="mission-simple-list">{relatedEvidence.map((item) => <div key={item.id}><strong>{item.verdict} · {item.summary}</strong><small>{item.source} · {relativeAge(item.createdAt)}</small></div>)}</div>}
        {tab === "의존성" && <div className="mission-simple-list">{selected?.gapId && <div><strong>Gap Graph</strong><small>{selected.gapId}</small></div>}{openHumans.map((item) => <div key={item.id}><strong>{item.title}</strong><small>차단: {item.blockingScope.join(", ") || "없음"}</small></div>)}</div>}
        {tab === "가정" && <div className="mission-simple-list">{openHumans.filter((item) => item.kind === "QUESTION").map((item) => <div key={item.id}><strong>{item.rationale}</strong><small>답변 전에는 되돌릴 수 있는 경로만 계속 진행</small></div>)}</div>}
      </Surface>

      <div className="mission-side-stack">
        <Surface><SurfaceHeader title="근거 계약" meta={`${selected?.evidenceContract.length ?? 0}개`} />{selected?.evidenceContract.length ? <ol className="evidence-contract-list">{selected.evidenceContract.map((item) => <li key={item}>{item}</li>)}</ol> : <p className="product-muted">게시된 evidence contract가 없습니다.</p>}</Surface>
        <Surface><SurfaceHeader title="최근 실제 근거" meta={`${relatedEvidence.length}`} /><div className="evidence-mini-list">{relatedEvidence.slice(0, 5).map((item) => <div className="evidence-mini-row" key={item.id}><StatusDot tone={item.verdict === "PASS" ? "success" : item.verdict === "FAIL" ? "danger" : "warning"} /><span><strong>{item.summary}</strong><small>{item.source}</small></span></div>)}</div></Surface>
      </div>
    </div>
  </ProductWorkspace>;
}

function missionProgress(mission: ControlPlaneMissionView, cycleCount: number): number {
  const fixed: Record<string, number> = { PROPOSED: 8, READY: 18, RUNNING: Math.min(84, 30 + Math.min(cycleCount, 16) * 3), VERIFYING: 90, SUCCEEDED: 100, BLOCKED: 55, FAILED: 45, SUPERSEDED: 100, CANCELLED: 100 };
  return fixed[mission.status ?? "RUNNING"] ?? 35;
}

function missionTone(status: string): "working" | "success" | "warning" | "danger" | "neutral" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "BLOCKED") return "warning";
  if (status === "SUPERSEDED" || status === "CANCELLED") return "neutral";
  return "working";
}
