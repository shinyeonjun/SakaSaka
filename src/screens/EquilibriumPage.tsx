import { getActionableHumanItems, getProject, getProjectEvents, getRun } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, Card, PageHeading, Pill, SectionHeader } from "../components/ui";
import { formatClock } from "../format";

const wakeTriggers = [
  "새로운 Human Intent",
  "Question 답변",
  "production incident",
  "test / health failure",
  "dependency / security event",
  "사용자 feedback",
];

export function EquilibriumPage({ projectId }: { projectId: string }) {
  const { state } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  if (!project) return <MissingEquilibrium />;

  const ideas = getActionableHumanItems(state, projectId).filter((item) => item.kind === "IDEA");
  const equilibriumEvent = getProjectEvents(state, projectId).find((event) => event.summary.startsWith("EQUILIBRIUM"));
  const lastWait = state.actions.filter((action) => action.projectId === projectId && action.type === "WAIT").at(-1);
  const run = getRun(state, projectId);
  const reviewTime = project.nextReviewAt ? `다음 review · ${formatClock(project.nextReviewAt)}` : equilibriumEvent ? `오늘 ${formatClock(equilibriumEvent.createdAt)}` : "scheduled review 대기";

  return (
    <div className="screen">
      <PageHeading title={project.name} description="Task가 끝난 게 아니라, 현재는 바꿀 가치가 높은 일이 없는 상태입니다." status="EQUILIBRIUM" />
      <div className="screen-stack equilibrium-screen-stack">
        <Card className="equilibrium-main-card">
          <h2>현재 Equilibrium</h2>
          <p className="equilibrium-reason">{equilibriumEvent?.detail ?? "모델이 WAIT를 선택했고 현재 저장된 evidence에서 즉시 가치 있는 다음 action을 확인하지 못했습니다."}</p>
          <p className="muted-copy">AI는 프로젝트의 Intent와 경험을 계속 보존합니다. 새 signal이 들어오면 다시 World를 관찰하고 ACTIVE로 전환합니다.</p>
        </Card>

        <div className="split-grid equilibrium-summary-grid">
          <Card className="equilibrium-detail-card">
            <SectionHeader title="Wake Triggers" />
            <ul className="plain-list wake-trigger-list">
              {wakeTriggers.map((trigger) => <li key={trigger}>• {trigger}</li>)}
            </ul>
          </Card>
          <Card className="equilibrium-detail-card">
            <SectionHeader title="Last Steward Review" />
            <strong>{reviewTime}</strong>
            <p className="muted-copy">{lastWait?.rationaleSummary ?? equilibriumEvent?.detail ?? "아직 WAIT rationale이 저장되지 않았습니다."}</p>
            <p className="small-copy">cycle {run?.cycleCount ?? 0} · 다음 review는 새 signal과 함께 다시 World를 관찰합니다.</p>
            <Pill tone="equilibrium">WAIT · 정상 상태</Pill>
          </Card>
        </div>

        <Card className="equilibrium-ideas-card">
          <SectionHeader title="보류 중 Ideas" />
          <p className="idea-primary-line">{formatIdea(ideas[0], "현재 보류 중인 Idea 없음")}</p>
          <p className="muted-copy">{formatIdea(ideas[1], "새로운 signal이 들어오면 추가 탐색을 다시 평가합니다.")}</p>
          <div className="button-row">
            <Button variant="neutral" onClick={() => navigate(`${projectPath(projectId)}/needs-you`)}>Needs You 열기</Button>
            <Button variant="primary" onClick={() => navigate("/projects/new")}>새 Intent 추가</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function formatIdea(item: { id: string; title: string } | undefined, fallback: string): string {
  if (!item) return fallback;
  return `${item.id} · ${item.title}`;
}

function MissingEquilibrium() {
  const { navigate } = useRouter();
  return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1><Button variant="primary" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button></Card></div>;
}
