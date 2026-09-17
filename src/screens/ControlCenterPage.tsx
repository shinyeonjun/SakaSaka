import { getHumanCounts, getIntent, getProject, getRun, getWorldSnapshot, phaseLabel } from "../runtime";
import { latestControlPlane, openHumanItems, priorityBand, relativeAge } from "../controlPlaneView";
import { activeAutonomyMissions, autonomyCounts, autonomyMissionHistory, latestAutonomyDecision, unresolvedAutonomyGaps } from "../autonomyProjection";
import { useAutonomyProjection } from "../useAutonomyProjection";
import { useApp } from "../store";
import { projectPath, useRouter } from "../router";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

export function ControlCenterPage({ projectId }: { projectId: string }) {
  const { state, dispatch, pendingCommands } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  const intent = getIntent(state, projectId);
  const run = getRun(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  const autonomy = useAutonomyProjection(projectId, state.revision, Boolean(project));
  if (!project || !intent || !run || !world) return <div className="product-loading">{pendingCommands ? "프로젝트를 준비하고 있습니다…" : "프로젝트를 찾을 수 없습니다."}</div>;

  const legacyControl = latestControlPlane(state, projectId);
  const fullMissions = autonomyMissionHistory(autonomy);
  const liveMissions = activeAutonomyMissions(autonomy);
  const mission = autonomy?.available ? fullMissions[0] : legacyControl?.mission;
  const gaps = autonomy?.available ? unresolvedAutonomyGaps(autonomy) : legacyControl?.gaps ?? [];
  const fullCounts = autonomyCounts(autonomy);
  const decision = latestAutonomyDecision(autonomy);
  const human = openHumanItems(state, projectId);
  const counts = getHumanCounts(state, projectId);
  const evidence = state.evidence.filter((item) => item.projectId === projectId && item.source !== "sakasaka-autonomy").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const events = state.events.filter((item) => item.projectId === projectId).slice(-8).reverse();
  const verified = state.evidence.filter((item) => item.projectId === projectId && item.verdict === "PASS").length;
  const openGapCount = fullCounts
    ? fullCounts.open + fullCounts.investigating + fullCounts.blocked
    : (legacyControl?.counts.open ?? 0) + (legacyControl?.counts.investigating ?? 0) + (legacyControl?.counts.blocked ?? 0);
  const unexploredCount = fullCounts?.unexplored ?? legacyControl?.counts.unexplored ?? 0;
  const activeMissionCount = autonomy?.available ? liveMissions.length : mission ? 1 : 0;
  const missionProgress = mission ? Math.min(92, 28 + Math.min(run.cycleCount, 16) * 4) : 0;
  const missionStatus = mission?.status ?? (mission ? "RUNNING" : "대기");

  const inspector = <>
    <InspectorHeader title="상세" meta={project.status} />
    <InspectorCard title="사람 개입" meta={`${human.length}개 열림`}>
      {human.length ? human.slice(0, 2).map((item) => <button key={item.id} className="inspector-action-row" onClick={() => navigate(`${projectPath(projectId)}/needs-you`)}>
        <span><StatusDot tone={item.kind === "APPROVAL" ? "danger" : "human"} />{item.title}</span><small>{item.kind}</small>
      </button>) : <p className="product-muted">지금 필요한 사람 결정이 없습니다.</p>}
    </InspectorCard>
    <InspectorCard title="런타임" meta={phaseLabel(run.phase)}>
      <KeyValue label="프로젝트" value={project.status} tone={project.status === "ACTIVE" ? "success" : "warning"} />
      <KeyValue label="작업 단계" value={phaseLabel(run.phase)} tone="working" />
      <KeyValue label="작업 구간" value={`${run.cycleCount}`} />
      <KeyValue label="월드 커서" value={world.cursorEventId} />
      <KeyValue label="Codex" value={run.nativeSession?.state ?? (project.settings.executionMode === "native" ? "준비" : "atomic")} />
      {decision && <KeyValue label="최근 판단" value={`${decision.provider} · ${decision.model}`} tone="evidence" />}
    </InspectorCard>
    <InspectorCard title="현재 미션" meta={mission ? missionStatus : "없음"}>
      {mission ? <><p className="inspector-strong">{mission.objective}</p><p className="product-muted">역할 · {mission.role}</p><KeyValue label="상태" value={missionStatus} tone={missionStatus === "BLOCKED" || missionStatus === "FAILED" ? "warning" : "working"} /><KeyValue label="진행 추정" value={`${missionProgress}%`} tone="working" /><KeyValue label="근거 조건" value={`${mission.evidenceContract.length}개`} /></> : <p className="product-muted">다음 discovery / prioritization cycle에서 미션이 선택됩니다.</p>}
    </InspectorCard>
    <InspectorCard title="제어" meta="정책 경계">
      <div className="inspector-button-row">
        {project.status === "PAUSED" ? <button onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })}>재개</button> : <button onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })}>일시정지</button>}
        <button onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })}>다시 깨우기</button>
      </div>
      <p className="product-muted">파괴적 외부 영향은 이 화면의 제어와 별개로 승인 경계를 통과해야 합니다.</p>
    </InspectorCard>
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="현재 Intent" title={intent.rawText} description="지금 무엇을 왜 하는지 · 무엇이 비어 있는지 · 사람이 뭘 해야 하는지" actions={<StatusPill tone={project.status === "ACTIVE" ? "success" : "warning"}>{project.status}</StatusPill>} />

    <div className="metric-strip">
      <Metric label="열린 갭" value={openGapCount} hint={`미탐색 ${unexploredCount}`} tone="warning" />
      <Metric label="실행 중 미션" value={activeMissionCount} hint={mission?.role ?? "선택 대기"} tone="working" />
      <Metric label="사람 답변 대기" value={human.length} hint={`질문 ${counts.QUESTION} · 승인 ${counts.APPROVAL}`} tone="human" />
      <Metric label="검증 완료" value={verified} hint={`전체 근거 ${state.evidence.filter((item) => item.projectId === projectId).length}`} tone="success" />
    </div>

    <Surface className="current-mission-surface">
      <SurfaceHeader title="현재 미션" meta={mission ? `${missionStatus} · 진행 ${missionProgress}%` : "미션 선택 대기"} action={mission && <button className="product-link-button" onClick={() => navigate(`${projectPath(projectId)}/missions`)}>상세 보기</button>} />
      {mission ? <div className="mission-focus">
        <div className="mission-focus-copy"><StatusPill tone={missionStatus === "BLOCKED" || missionStatus === "FAILED" ? "warning" : "working"}>{missionStatus}</StatusPill><h3>{mission.objective}</h3><p>{mission.role} · autonomy 상태 {relativeAge(mission.observedAt)} 전</p></div>
        <div className="mission-progress"><span style={{ width: `${missionProgress}%` }} /></div>
        <div className="mission-contract">{mission.evidenceContract.slice(0, 3).map((item, index) => <span key={item}><b>{index + 1}</b>{item}</span>)}</div>
      </div> : <div className="product-empty">현재 활성 미션이 없습니다. 탐색 결과와 현재 Intent를 바탕으로 다음 미션을 선택합니다.</div>}
    </Surface>

    <div className="control-center-grid">
      <Surface>
        <SurfaceHeader title="우선 처리 후보" meta={`${gaps.length}개 표시`} action={<button className="product-link-button" onClick={() => navigate(`${projectPath(projectId)}/coverage`)}>전체 갭</button>} />
        <div className="gap-list">{gaps.length ? gaps.slice(0, 5).map((gap) => <button className="gap-row" key={gap.id} onClick={() => navigate(`${projectPath(projectId)}/coverage`)}>
          <span className={`priority priority-${priorityBand(gap.priority).toLowerCase()}`}>{priorityBand(gap.priority)}</span>
          <span className="gap-copy"><strong>{gap.title}</strong><small>{gap.category} · {gap.status ?? "OPEN"} · {gap.id}</small></span>
          <span className="gap-score">{gap.priority.toFixed(2)}</span>
        </button>) : <div className="product-empty">현재 미해결 priority frontier가 없습니다.</div>}</div>
      </Surface>

      <Surface>
        <SurfaceHeader title="최근 근거" meta={`${evidence.length}개`} action={<button className="product-link-button" onClick={() => navigate(`${projectPath(projectId)}/evidence`)}>근거 원장</button>} />
        <div className="evidence-mini-list">{evidence.slice(0, 4).map((item) => <div className="evidence-mini-row" key={item.id}><StatusDot tone={item.verdict === "PASS" ? "success" : item.verdict === "FAIL" ? "danger" : "warning"} /><span><strong>{item.summary}</strong><small>{item.source} · {relativeAge(item.createdAt)}</small></span></div>)}</div>
      </Surface>
    </div>

    <Surface>
      <SurfaceHeader title="최근 활동" meta={`${events.length}개`} action={<button className="product-link-button" onClick={() => navigate(`${projectPath(projectId)}/activity`)}>전체 활동</button>} />
      <div className="activity-compact">{events.slice(0, 4).map((event) => <div key={event.id}><span>{relativeAge(event.createdAt)}</span><StatusDot tone={event.actor === "human" ? "human" : event.type.includes("EVIDENCE") ? "evidence" : "working"} /><strong>{event.summary}</strong></div>)}</div>
    </Surface>
  </ProductWorkspace>;
}

function Metric({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: "warning" | "working" | "human" | "success" }) {
  return <div className="metric-cell"><span><StatusDot tone={tone} />{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}
