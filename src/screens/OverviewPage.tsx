import { getHumanCounts, getIntent, getProject, getRun, getWorldSnapshot, phaseLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { formatMoney, runtimeDescription } from "../format";
import { EquilibriumPage } from "./EquilibriumPage";

export function OverviewPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  const intent = getIntent(state, projectId);
  const run = getRun(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !intent || !run || !world) return <MissingProject />;
  if (project.status === "EQUILIBRIUM") return <EquilibriumPage projectId={projectId} />;
  const counts = getHumanCounts(state, projectId);
  const isTripTogether = project.id === "project-trip-together";
  const projectEvidence = state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const isPaused = project.status === "PAUSED";
  const canRun = project.status !== "KILLED" && project.status !== "PAUSED" && project.status !== "STALLED";
  const canPause = project.status === "ACTIVE" || project.status === "WAITING";
  const killProject = () => {
    if (typeof window === "undefined" || window.confirm("현재 run을 강제 종료할까요? 종료 후에는 새 run으로 다시 시작해야 합니다.")) {
      dispatch({ type: "KILL_PROJECT", projectId });
    }
  };

  return (
    <div className="screen">
      <PageHeading
        title={project.name}
        description={project.subtitle}
        status={project.status}
        actions={(
          <div className="heading-command-row">
            <Button size="small" variant="primary" onClick={() => dispatch({ type: "RUN_CYCLE", projectId })} disabled={!canRun}>Run cycle</Button>
            {canPause && <Button size="small" variant="subtle" onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })}>Pause</Button>}
            {isPaused && <Button size="small" variant="subtle" onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })}>Resume</Button>}
            {project.status !== "KILLED" && <Button size="small" variant="danger" onClick={killProject}>Kill</Button>}
            {project.status === "STALLED" && <Button size="small" variant="subtle" onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })}>재시작</Button>}
          </div>
        )}
      />

      <div className="screen-stack">
        <Card className="intent-summary-card">
          <SectionHeader title="현재 Intent" />
          <p className="intent-quote">“{intent.rawText}”</p>
          <p className="muted-copy">AI가 이해한 방향은 evidence와 Human answer에 따라 갱신되지만, 원문 Intent는 변경 이력으로 보존됩니다.</p>
        </Card>

        <div className="split-grid overview-work-grid">
          <Card className="work-card">
            <SectionHeader title="지금 AI가 하는 일" />
            <Pill tone="blue">OBSERVE → ACT → VERIFY</Pill>
            <p className="work-title">{isTripTogether ? "Playwright로 초대 링크를 실제 브라우저에서 검증 중" : "Intent에 연결된 World source와 evidence를 검증 중"}</p>
            <p className="work-discovery">{isTripTogether ? "방금 발견: 모바일 390px에서 초대 모달이 화면 밖으로 넘침" : "방금 확인: 현재 World를 기준으로 다음 가치 있는 gap을 비교하는 중"}</p>
            <p className="muted-copy">{runtimeDescription(project.status)} · {phaseLabel(run.phase)}</p>
            <p className="small-copy">다음 행동은 고정 workflow가 아니라 현재 World를 다시 보고 선택됩니다.</p>
          </Card>
          <Card className="needs-summary-card">
            <SectionHeader title="Needs You" />
            <strong className="big-number">{counts.QUESTION + counts.APPROVAL + Math.min(1, counts.IDEA)}</strong>
            <p className="muted-copy">Question {counts.QUESTION} · Idea {Math.min(1, counts.IDEA)} · Approval {counts.APPROVAL}</p>
            <Button variant="neutral" size="small" onClick={() => navigate(`${projectPath(projectId)}/needs-you`)}>확인하기</Button>
          </Card>
        </div>

        <div className="split-grid overview-bottom-grid">
          <Card className="evidence-card">
            <SectionHeader title="Evidence" />
            {isTripTogether ? <ul className="check-list">
              <li><span className="check-ok">✓</span> API E2E 42/42</li>
              <li><span className="check-ok">✓</span> Chrome desktop flow</li>
              <li><span className="check-warn">!</span> Mobile invite flow issue</li>
              <li><span className="check-ok">✓</span> DB migration dry-run</li>
            </ul> : projectEvidence.length ? <ul className="check-list">
              {projectEvidence.slice(0, 4).map((evidence) => <li key={evidence.id}><span className={evidence.verdict === "PASS" ? "check-ok" : "check-warn"}>{evidence.verdict === "PASS" ? "✓" : "!"}</span> {evidence.summary}</li>)}
            </ul> : <p className="muted-copy">아직 이 Intent에 연결된 evidence가 없습니다.</p>}
          </Card>
          <Card className="living-product-card">
            <SectionHeader title="Living Product" />
            <p className="muted-copy">Preview environment · healthy</p>
            <div className="preview-panel">
              <div className="preview-topline"><span className="preview-dot" /> {project.name.toLowerCase()} / preview</div>
              <div className="preview-line preview-line-wide" />
              <div className="preview-line" />
              <span className="preview-chip">{project.status}</span>
            </div>
            <div className="runtime-meta"><span>phase {phaseLabel(run.phase)}</span><span>{formatMoney(project.budgetSpent)} spent</span><span>cursor {world.cursorEventId}</span></div>
          </Card>
        </div>

        {project.status === "WAITING" && <InlineNotice tone="pink" title="Human boundary">영향받는 scope만 대기 중입니다. 일정 편집·알림·QA는 계속 진행할 수 있습니다.</InlineNotice>}
        {project.status === "PAUSED" && <InlineNotice tone="yellow" title="Paused">World와 Memory는 보존됩니다. Resume을 누르면 새 wake에서 이어갑니다.</InlineNotice>}
        {project.status === "STALLED" && <InlineNotice tone="orange" title="Stalled">반복 실패·lease·예산 경계로 run이 멈췄습니다. 원인을 확인한 뒤 재시작할 수 있습니다.</InlineNotice>}
        {project.status === "KILLED" && <InlineNotice tone="red" title="Killed">Run이 종료됐고 lease가 revoke됐습니다. 보존된 World/Memory를 바탕으로 새 프로젝트에서 다시 시작하세요.</InlineNotice>}
      </div>
    </div>
  );
}

function MissingProject() {
  const { navigate } = useRouter();
  return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1><p>새 Intent를 시작해 World를 만들어 주세요.</p><Button variant="primary" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button></Card></div>;
}
