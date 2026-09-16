import { runtimeDiagnostics } from "../runtimeDiagnostics";
import { getHumanCounts, getIntent, getProject, getRun, getWorldSnapshot, modelProviderLabel, phaseLabel, statusLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { formatMoney, runtimeDescription } from "../format";
import { EquilibriumPage } from "./EquilibriumPage";

export function OverviewPage({ projectId }: { projectId: string }) {
  const { state, dispatch, pendingCommands } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  const intent = getIntent(state, projectId);
  const run = getRun(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !intent || !run || !world) return pendingCommands ? <div className="screen"><Card>프로젝트를 서버에 등록하고 있습니다.</Card></div> : <MissingProject />;
  if (project.status === "EQUILIBRIUM") return <EquilibriumPage projectId={projectId} />;
  const counts = getHumanCounts(state, projectId);
  const diagnostics = runtimeDiagnostics(state, projectId);
  const projectEvidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const currentAction = state.actions.find((action) => action.id === project.currentActionId) ?? state.actions.filter((action) => action.projectId === projectId).at(-1);
  const native = run.nativeSession;
  const latestEvent = state.events.filter((event) => event.projectId === projectId).at(-1);

  return (
    <div className="screen">
      <PageHeading
        title={project.name}
        description={project.subtitle}
        status={project.status}
      />

      <div className="screen-stack">
        <Card className="intent-summary-card">
          <SectionHeader title="현재 Intent" />
          <p className="intent-quote">“{intent.rawText}”</p>
          <p className="muted-copy">AI가 이해한 방향은 증거와 사람의 답변에 따라 갱신되지만, 원문 의도는 변경 이력으로 보존됩니다.</p>
        </Card>

        <div className="split-grid overview-work-grid">
          <Card className="work-card">
            <SectionHeader title={diagnostics.stopped ? "실행 중단 원인" : "지금 AI가 하는 일"} />
            <Pill tone="blue">{phaseLabel(run.phase)}</Pill>
            <p className="work-title">{diagnostics.reason ?? (run.phase === "decide" ? (native?.state === "working" ? currentAction?.rationaleSummary ?? "Codex가 프로젝트를 같은 세션에서 진행하고 있습니다." : "모델의 다음 행동 결정을 기다리고 있습니다.") : currentAction?.rationaleSummary ?? latestEvent?.summary ?? "현재 월드를 관찰하고 다음 행동을 선택하는 중")}</p>
            {diagnostics.stopped ? <>
              <p className="work-discovery">오류 유형: {diagnostics.code ?? "런타임 / 경계"} · 반복 실패 {diagnostics.failureCount}회 · 진전 없음 {diagnostics.noProgressCount}회</p>
              <p className="small-copy">마지막 정상 행동: {diagnostics.lastSuccess?.tool ?? "아직 없음"}</p>
              {diagnostics.rawRef && <p className="small-copy">오류 원본: {diagnostics.rawRef}</p>}
              <div className="button-row"><Button size="small" variant="neutral" onClick={() => navigate(`${projectPath(projectId)}/activity`)}>실패 기록 보기</Button><Button size="small" variant="primary" onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })}>원인 조치 후 재개</Button></div>
            </> : <p className="work-discovery">{run.retryAfter ? `모델 오류 재시도 예정: ${run.retryAfter}` : latestEvent?.detail ?? "실제 관찰과 증거를 다음 판단에 사용합니다."}</p>}
            <p className="muted-copy">{runtimeDescription(project.status)} · {phaseLabel(run.phase)}</p>
            <p className="small-copy">다음 행동은 고정 workflow가 아니라 현재 World를 다시 보고 선택됩니다.</p>
          </Card>
          <Card className="needs-summary-card">
            <SectionHeader title="도움 필요" />
            <strong className="big-number">{counts.QUESTION + counts.IDEA + counts.CONCERN + counts.APPROVAL}</strong>
            <p className="muted-copy">질문 {counts.QUESTION} · 아이디어 {counts.IDEA} · 우려 {counts.CONCERN} · 승인 {counts.APPROVAL}</p>
            <Button variant="neutral" size="small" onClick={() => navigate(`${projectPath(projectId)}/needs-you`)}>확인하기</Button>
          </Card>
        </div>

        {project.settings.executionMode === "native" && <Card className="native-session-card">
          <SectionHeader title="지속형 프로젝트 세션" />
          <p>Codex App Server · {native?.state === "working" ? "작업 중" : native?.state === "resting" ? "다음 신호 대기" : native?.state === "failed" ? "연결/실행 확인 필요" : "연결 준비"}</p>
          <p className="small-copy">작업 구간 {native?.turnsStarted ?? 0} / {project.settings.maxNativeTurns ?? 40} · 누적 토큰 {native?.accountedTokens ?? 0} / {project.settings.maxNativeTokens ?? 250000}</p>
          {native?.threadId && <p className="small-copy">세션 {native.threadId}</p>}
          {native?.checkpoint && <><p>{native.checkpoint.summary}</p><p className="small-copy">남은 작업: {native.checkpoint.remainingWork.join(" · ") || "에이전트가 현재 남은 작업을 보고하지 않았습니다."}</p></>}
          <p className="muted-copy">같은 세션 안에서 여러 행동과 오류 복구를 이어갑니다. 에이전트의 checkpoint는 제품 전체의 독립 검증 결과와 다릅니다.</p>
        </Card>}

        <div className="split-grid overview-bottom-grid">
          <Card className="evidence-card">
            <SectionHeader title="증거" />
            {projectEvidence.length ? <ul className="check-list">
              {projectEvidence.slice(0, 4).map((evidence) => <li key={evidence.id}><span className={evidence.verdict === "PASS" ? "check-ok" : "check-warn"}>{evidence.verdict === "PASS" ? "✓" : "!"}</span> {evidence.summary}</li>)}
            </ul> : <p className="muted-copy">아직 이 의도에 연결된 증거가 없습니다.</p>}
          </Card>
          <Card className="living-product-card">
            <SectionHeader title="살아 있는 제품" />
            <p className="muted-copy">{world.sources.runtime.summary}</p>
            <div className="preview-panel">
              <div className="preview-topline"><span className="preview-dot" style={{ opacity: project.settings.previewUrl ? 1 : 0.3 }} /> {project.settings.previewUrl ?? "미리보기가 아직 시작되지 않음"}</div>
              <div className="preview-line preview-line-wide" />
              <div className="preview-line" />
              <span className="preview-chip">{statusLabel(project.status)} <small>{project.status}</small></span>
            </div>
            <div className="runtime-meta"><span>단계 {phaseLabel(run.phase)}</span><span>{formatMoney(project.budgetSpent)} 집계(추정)</span><span>모델 {modelProviderLabel(state, project)}</span><span>커서 {world.cursorEventId}</span></div>
          </Card>
        </div>

        {project.status === "WAITING" && <InlineNotice tone="pink" title="사람의 경계">영향받는 범위만 대기 중입니다. 관련 없는 행동이 남아 있는지는 다음 판단에서 확인합니다.</InlineNotice>}
        {project.status === "PAUSED" && <InlineNotice tone="yellow" title="일시 정지">월드와 경험은 보존됩니다. 재개하면 새 깨우기 신호에서 이어갑니다.</InlineNotice>}
        {project.status === "STALLED" && <InlineNotice tone="orange" title="중단됨">{diagnostics.reason}</InlineNotice>}
        {project.status === "KILLED" && <InlineNotice tone="red" title="종료됨">실행이 종료됐고 lease가 폐기됐습니다. 보존된 월드와 경험을 바탕으로 새 프로젝트에서 다시 시작하세요.</InlineNotice>}
      </div>
    </div>
  );
}

function MissingProject() {
  const { navigate } = useRouter();
  return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1><p>새 의도를 시작해 월드를 만들어 주세요.</p><Button variant="primary" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button></Card></div>;
}
