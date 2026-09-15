import { getHumanCounts, getIntent, getProject, getRun, getWorldSnapshot, phaseLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { formatMoney, runtimeDescription } from "../format";

export function OverviewPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  const intent = getIntent(state, projectId);
  const run = getRun(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  if (!project || !intent || !run || !world) return <MissingProject />;
  const counts = getHumanCounts(state, projectId);
  const isPaused = project.status === "PAUSED";
  const canRun = project.status !== "KILLED";

  return (
    <div className="screen">
      <PageHeading
        title={project.name}
        description={project.subtitle}
        status={project.status}
        actions={(
          <div className="heading-command-row">
            <Button size="small" variant="primary" onClick={() => dispatch({ type: "RUN_CYCLE", projectId })} disabled={!canRun}>{project.status === "EQUILIBRIUM" ? "다시 관찰" : "Run cycle"}</Button>
            {project.status === "EQUILIBRIUM" && <Button size="small" variant="subtle" onClick={() => navigate("/projects/new")}>새 Intent 추가</Button>}
            {project.status === "ACTIVE" && <Button size="small" variant="subtle" onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })}>Pause</Button>}
            {isPaused && <Button size="small" variant="subtle" onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })}>Resume</Button>}
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
            <p className="work-title">{project.status === "EQUILIBRIUM" ? "현재 비용 대비 가치 높은 행동이 없음" : "Playwright로 초대 링크를 실제 브라우저에서 검증 중"}</p>
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
            <ul className="check-list">
              <li><span className="check-ok">✓</span> API E2E 42/42</li>
              <li><span className="check-ok">✓</span> Chrome desktop flow</li>
              <li><span className="check-warn">!</span> Mobile invite flow issue</li>
              <li><span className="check-ok">✓</span> DB migration dry-run</li>
            </ul>
          </Card>
          <Card className="living-product-card">
            <SectionHeader title="Living Product" />
            <p className="muted-copy">Preview environment · healthy</p>
            <div className="preview-panel">
              <div className="preview-topline"><span className="preview-dot" /> trip-together / preview</div>
              <div className="preview-line preview-line-wide" />
              <div className="preview-line" />
              <span className="preview-chip">{project.status}</span>
            </div>
            <div className="runtime-meta"><span>phase {phaseLabel(run.phase)}</span><span>{formatMoney(project.budgetSpent)} spent</span><span>cursor {world.cursorEventId}</span></div>
          </Card>
        </div>

        {project.status === "WAITING" && <InlineNotice tone="pink" title="Human boundary">영향받는 scope만 대기 중입니다. 일정 편집·알림·QA는 계속 진행할 수 있습니다.</InlineNotice>}
        {project.status === "EQUILIBRIUM" && <InlineNotice tone="equilibrium" title="Equilibrium">새 signal이 들어오면 다시 World를 관찰합니다. 현재는 무리한 개선을 시작하지 않습니다.</InlineNotice>}
      </div>
    </div>
  );
}

function MissingProject() {
  const { navigate } = useRouter();
  return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1><p>새 Intent를 시작해 World를 만들어 주세요.</p><Button variant="primary" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button></Card></div>;
}
