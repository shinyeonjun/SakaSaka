import { getActivePolicy, getProject } from "../runtime";
import { useApp } from "../store";
import type { Experiment } from "../types";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader, Stat, cn } from "../components/ui";
import { formatDate } from "../format";
import { evaluateProject } from "../evaluation";
import { ablationLadder, benchmarkScenarios } from "../experimentHarness";

export function ExperimentsPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  if (!project) return <div className="screen"><Card className="empty-state"><h1>실험을 표시할 수 없습니다.</h1></Card></div>;
  const experiments = state.experiments.filter((experiment) => experiment.projectId === projectId);
  const policies = state.policies.filter((policy) => policy.projectId === projectId).sort((a, b) => b.version - a.version);
  const activePolicy = getActivePolicy(state, projectId);
  const evaluation = evaluateProject(state, projectId);
  const benchmarks = benchmarkScenarios.filter((scenario) => experiments.some((experiment) => experiment.benchmark === scenario.id));

  return (
    <div className="screen">
      <PageHeading title="실험" description="같은 모델·도구와 시작 상태를 유지한 채 구조만 비교하고, 실패도 아키텍처를 바꿀 근거로 남깁니다." actions={<Pill tone="purple">연구 모드</Pill>} />
      <div className="screen-stack">
        <InlineNotice tone="yellow" title="실험 규칙">모델·temperature·도구 예산·시작 작업공간은 고정합니다. 실제 증거와 독립 평가자가 결과를 판정합니다.</InlineNotice>
        <Card className="evaluation-card">
          <SectionHeader title="평가 지표" />
          <div className="metrics-grid">
            <Stat label="결과 품질" value={`${Math.round(evaluation.metrics.outcomeQuality * 100)}%`} detail="모든 증거의 PASS 비율" tone="mint" />
            <Stat label="질문 정확도" value={`${Math.round(evaluation.metrics.questionPrecision * 100)}%`} detail="사람만 결정할 질문" tone="pink" />
            <Stat label="증거 범위" value={`${Math.round(evaluation.metrics.evidenceCoverage * 100)}%`} detail="행동 계보" tone="blue" />
            <Stat label="비용 효율" value={`${Math.round(evaluation.metrics.costNormalizedUtility * 100)}%`} detail="품질 / 사용 비용" tone="purple" />
            <Stat label="정지 품질" value={`${Math.round(evaluation.metrics.stopQuality * 100)}%`} detail="균형 상태와 깨우기" tone="equilibrium" />
          </div>
        </Card>
        <div className="experiment-grid">{experiments.map((experiment) => <ExperimentCard key={experiment.id} experiment={experiment} onRun={() => dispatch({ type: "RUN_EXPERIMENT", experimentId: experiment.id })} />)}</div>
        <Card className="ablation-card">
          <SectionHeader title="구성요소 비교 단계" />
          <div className="ablation-ladder">{ablationLadder.map((step, index) => <span key={step.key} className="ablation-step-wrap"><AblationStep label={step.key} title={step.title} detail={step.detail} />{index < ablationLadder.length - 1 && <span className="ablation-arrow">→</span>}</span>)}</div>
          <p className="muted-copy">RSI는 현재 시스템에서 실제 필요성이 증명된 뒤 선택적으로 엽니다. 먼저 baseline에서 실패를 관찰합니다.</p>
        </Card>
        <Card className="benchmark-card">
          <SectionHeader title="벤치마크 묶음" />
          <div className="benchmark-list">{benchmarks.map((benchmark) => <div key={benchmark.id}><div className="benchmark-head"><strong>{benchmark.title}</strong><Pill tone="neutral">{benchmark.category}</Pill></div><span>{benchmark.intent}</span><small>hidden criteria · {benchmark.hiddenCriteria.join(" · ")} · acceptance {benchmark.acceptanceRefs.join("/")}</small></div>)}</div>
        </Card>
        <Card className="policy-card">
          <SectionHeader title="정책 / 재생 계약" />
          <div className="contract-columns policy-columns">
            <div><strong>활성 정책</strong><span>{activePolicy ? `v${activePolicy.version} · ${activePolicy.representation}` : "기본 정책 없음"}</span></div>
            <div><strong>후보 정책</strong><span>{policies.filter((policy) => policy.status === "candidate").length}개 · 독립 증거가 있을 때만 승격</span></div>
            <div><strong>판정 원본</strong><span>실험 결과 · 평가 참조 · 원본 이벤트 이력</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ExperimentCard({ experiment, onRun }: { experiment: Experiment; onRun: () => void }) {
  const tone = experiment.status === "passed" ? "mint" : experiment.status === "needs-review" ? "orange" : experiment.status === "running" ? "blue" : "neutral";
  const statusLabel = experiment.status === "ready" ? "준비됨" : experiment.status === "running" ? "실행 중" : experiment.status === "passed" ? "통과" : "검토 필요";
  return <Card className="experiment-card"><div className="experiment-head"><Pill tone={tone}>{statusLabel}</Pill><span>{experiment.key}</span></div><h2>{experiment.title}</h2><p className="experiment-hypothesis">{experiment.hypothesis}</p><p className="muted-copy">{experiment.description}</p><div className="experiment-criteria"><span>벤치마크 · {experiment.benchmark ?? "직접 지정"}</span><span>예산 · ${experiment.budgetLimit ?? "—"}</span><span>평가자 · {experiment.evaluatorRefs?.join(" · ") || "대기 중"}</span></div><div className="experiment-footer"><strong>{experiment.score}</strong><span>갱신 {formatDate(experiment.updatedAt)}</span><Button variant={experiment.status === "ready" ? "primary" : "neutral"} size="small" onClick={onRun} disabled={experiment.status === "running"}>{experiment.status === "ready" ? "실험 실행" : "다시 실행"}</Button></div></Card>;
}

function AblationStep({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div className={cn("ablation-step", label === "B" && "ablation-step-active")}><span>{label}</span><strong>{title}</strong><small>{detail}</small></div>;
}
