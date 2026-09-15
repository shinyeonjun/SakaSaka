import { getActivePolicy, getProject } from "../runtime";
import { useApp } from "../store";
import type { Experiment } from "../types";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader, cn } from "../components/ui";
import { formatDate } from "../format";

export function ExperimentsPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  if (!project) return <div className="screen"><Card className="empty-state"><h1>Experiments를 표시할 수 없습니다.</h1></Card></div>;
  const experiments = state.experiments.filter((experiment) => experiment.projectId === projectId);
  const policies = state.policies.filter((policy) => policy.projectId === projectId).sort((a, b) => b.version - a.version);
  const activePolicy = getActivePolicy(state, projectId);

  return (
    <div className="screen">
      <PageHeading title="Experiments" description="같은 모델·도구에서 구조만 바꿔 비교하고, 실패도 architecture를 바꿀 근거로 남깁니다." actions={<Pill tone="purple">RESEARCH MODE</Pill>} />
      <div className="screen-stack">
        <InlineNotice tone="yellow" title="실험 규칙">모델·temperature·tool budget·seed project는 고정합니다. deterministic evidence와 blind evaluator가 결과를 판정합니다.</InlineNotice>
        <div className="experiment-grid">{experiments.map((experiment) => <ExperimentCard key={experiment.id} experiment={experiment} onRun={() => dispatch({ type: "RUN_EXPERIMENT", experimentId: experiment.id })} />)}</div>
        <Card className="ablation-card">
          <SectionHeader title="Ablation Ladder" />
          <div className="ablation-ladder"><AblationStep label="A" title="기존 Task Agent" detail="명시 task → completion" /><span className="ablation-arrow">→</span><AblationStep label="B" title="+ Persistent Closed Loop" detail="Intent + World + Actions" /><span className="ablation-arrow">→</span><AblationStep label="C" title="+ Discovery / Uncertainty" detail="숨은 Gap 탐색" /><span className="ablation-arrow">→</span><AblationStep label="D" title="+ Experience Memory" detail="transition memory" /><span className="ablation-arrow">→</span><AblationStep label="E" title="+ Meta Improvement" detail="policy update" /></div>
          <p className="muted-copy">RSI는 현재 시스템에서 실제 필요성이 증명된 뒤 선택적으로 엽니다. 먼저 baseline에서 실패를 관찰합니다.</p>
        </Card>
        <Card className="policy-card">
          <SectionHeader title="Policy / Replay Contract" />
          <div className="contract-columns policy-columns">
            <div><strong>Active policy</strong><span>{activePolicy ? `v${activePolicy.version} · ${activePolicy.representation}` : "기본 정책 없음"}</span></div>
            <div><strong>Candidate policies</strong><span>{policies.filter((policy) => policy.status === "candidate").length}개 · independent evidence 후에만 승격</span></div>
            <div><strong>Source of truth</strong><span>experiment result · evaluator refs · raw event history</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ExperimentCard({ experiment, onRun }: { experiment: Experiment; onRun: () => void }) {
  const tone = experiment.status === "passed" ? "mint" : experiment.status === "needs-review" ? "orange" : experiment.status === "running" ? "blue" : "neutral";
  return <Card className="experiment-card"><div className="experiment-head"><Pill tone={tone}>{experiment.status}</Pill><span>{experiment.key}</span></div><h2>{experiment.title}</h2><p className="experiment-hypothesis">{experiment.hypothesis}</p><p className="muted-copy">{experiment.description}</p><div className="experiment-footer"><strong>{experiment.score}</strong><span>updated {formatDate(experiment.updatedAt)}</span><Button variant={experiment.status === "ready" ? "primary" : "neutral"} size="small" onClick={onRun} disabled={experiment.status === "running"}>{experiment.status === "ready" ? "Run experiment" : "Re-run"}</Button></div></Card>;
}

function AblationStep({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div className={cn("ablation-step", label === "B" && "ablation-step-active")}><span>{label}</span><strong>{title}</strong><small>{detail}</small></div>;
}
