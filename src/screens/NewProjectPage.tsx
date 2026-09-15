import { useState, type FormEvent } from "react";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, Card, InlineNotice, Label, PageHeading } from "../components/ui";

export function NewProjectPage() {
  const { createProject } = useApp();
  const { navigate } = useRouter();
  const [intent, setIntent] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [budget, setBudget] = useState(30);
  const [maxHours, setMaxHours] = useState(12);
  const [showError, setShowError] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!intent.trim()) {
      setShowError(true);
      return;
    }
    const id = createProject(intent, { budgetLimit: budget, maxHours });
    navigate(projectPath(id));
  };

  return (
    <div className="screen screen-new-project">
      <PageHeading title="무엇을 원하나요?" description="방법은 정하지 않아도 됩니다. 원하는 결과와 꼭 지켜야 할 것만 남겨주세요." />
      <form onSubmit={onSubmit} className="screen-stack">
        <Card className="intent-card">
          <Label htmlFor="intent">Intent</Label>
          <textarea
            id="intent"
            value={intent}
            onChange={(event) => { setIntent(event.target.value); setShowError(false); }}
            placeholder="예: 친구들이 여행 계획을 같이 세우고 실제 여행에서도 쓸 수 있는 서비스가 있었으면 좋겠어."
            aria-describedby={showError ? "intent-error" : "intent-help"}
          />
          <p id="intent-help" className="field-help">AI는 이 문장을 task 목록으로 고정 변환하지 않습니다. 실제 World를 보며 필요한 일을 스스로 발견합니다.</p>
          {showError && <p id="intent-error" className="field-error" role="alert">먼저 원하는 결과를 한 문장으로 남겨주세요.</p>}
        </Card>

        <div className="split-grid split-grid-2">
          <Card className="setting-card">
            <h2>자율성 경계</h2>
            <p>기본: 로컬·샌드박스 안에서는 자유롭게 행동</p>
            <span>외부 배포 · 결제 · 파괴적 작업은 승인 필요</span>
          </Card>
          <Card className="setting-card">
            <h2>초기 Budget</h2>
            <p>${budget} · 최대 {maxHours}시간 · 필요하면 Equilibrium</p>
            <span>Budget은 개발 순서를 지시하지 않고 피해 반경만 제한</span>
          </Card>
        </div>

        <div className="button-row">
          <Button variant="primary" size="medium" type="submit">시작하기</Button>
          <Button variant="neutral" size="medium" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>고급 설정</Button>
        </div>

        {advancedOpen && (
          <Card className="advanced-settings">
            <div className="advanced-setting-row">
              <div><strong>Run budget</strong><span>실행 비용 상한을 정합니다.</span></div>
              <input type="number" min="1" max="1000" value={budget} onChange={(event) => setBudget(Number(event.target.value) || 1)} aria-label="실행 budget" />
            </div>
            <div className="advanced-setting-row">
              <div><strong>Wall time</strong><span>lease가 유지되는 최대 시간입니다.</span></div>
              <input type="number" min="1" max="168" value={maxHours} onChange={(event) => setMaxHours(Number(event.target.value) || 1)} aria-label="최대 실행 시간" />
            </div>
            <InlineNotice tone="yellow" title="경계 기본값">외부 side effect와 production 배포는 사람 승인 전까지 차단됩니다.</InlineNotice>
          </Card>
        )}

        <Card className="start-principle-card">
          <h2>Human = START</h2>
          <p>Intent · Preference · Value · Approval만 제공합니다. 다음 task를 사람이 계속 생성하지 않는 것이 목표입니다.</p>
        </Card>
      </form>
    </div>
  );
}
