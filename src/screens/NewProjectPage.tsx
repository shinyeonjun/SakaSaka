import { useState, type FormEvent } from "react";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { isControlPlaneEnabled } from "../apiClient";
import { Button, Card, InlineNotice, Label, PageHeading } from "../components/ui";
import type { ProjectSettings } from "../types";

export function NewProjectPage() {
  const { createProject } = useApp();
  const { navigate } = useRouter();
  const [intent, setIntent] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [budget, setBudget] = useState(30);
  const [maxHours, setMaxHours] = useState(12);
  const [modelProvider, setModelProvider] = useState<"auto" | "deterministic" | "openai-compatible" | "codex-cli">(isControlPlaneEnabled ? "auto" : "deterministic");
  const [sandboxMode, setSandboxMode] = useState<"process" | "docker">(isControlPlaneEnabled ? "docker" : "process");
  const [workspacePath, setWorkspacePath] = useState("");
  const [showError, setShowError] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!intent.trim()) {
      setShowError(true);
      return;
    }
    const settings: Partial<ProjectSettings> = { budgetLimit: budget, maxHours, modelProvider, sandboxMode };
    if (isControlPlaneEnabled && workspacePath.trim()) settings.workspacePath = workspacePath.trim();
    const id = createProject(intent, settings);
    navigate(projectPath(id));
  };

  return (
    <div className="screen screen-new-project">
      <PageHeading title="무엇을 원하나요?" description="방법은 정하지 않아도 됩니다. 원하는 결과와 꼭 지켜야 할 것만 남겨주세요." />
      <form onSubmit={onSubmit} className="screen-stack">
        <Card className="intent-card">
          <Label htmlFor="intent">의도</Label>
          <textarea
            id="intent"
            value={intent}
            onChange={(event) => { setIntent(event.target.value); setShowError(false); }}
            placeholder="예: 팀이 반복 업무를 줄일 수 있는 작은 웹앱을 만들어줘."
            aria-describedby={showError ? "intent-error" : "intent-help"}
          />
            <p id="intent-help" className="field-help">AI는 이 문장을 작업 목록으로 고정 변환하지 않습니다. 실제 월드를 보며 필요한 일을 스스로 발견합니다.</p>
          {showError && <p id="intent-error" className="field-error" role="alert">먼저 원하는 결과를 한 문장으로 남겨주세요.</p>}
        </Card>

        <Card className="workspace-binding-card">
          <div className="workspace-binding-heading">
            <div>
              <Label htmlFor="workspace-path">작업 폴더 선택</Label>
              <h2>이 프로젝트가 실제로 변경할 폴더</h2>
            </div>
            <span className={isControlPlaneEnabled ? "connection-mark connection-mark-ready" : "connection-mark connection-mark-muted"}>
              {isControlPlaneEnabled ? "API 모드" : "브라우저 전용"}
            </span>
          </div>
          <input
            id="workspace-path"
            className="workspace-path-input"
            type="text"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            placeholder="예: D:\\workspace\\my-project"
            disabled={!isControlPlaneEnabled}
            aria-label="작업 폴더 경로"
            aria-describedby="workspace-path-help"
          />
          <div className="workspace-binding-footer">
            <p id="workspace-path-help" className="field-help">
              {isControlPlaneEnabled
                ? "경로를 입력하면 이 프로젝트는 해당 폴더 하나만 사용합니다. 비워두면 WORKSPACE_ROOT 안에 전용 폴더를 자동으로 만듭니다."
                : "브라우저 보안상 이 모드에서는 OS 폴더를 직접 연결할 수 없습니다. 실제 파일 작업은 API와 worker를 함께 실행한 뒤 시작하세요."}
            </p>
            {isControlPlaneEnabled && workspacePath && <Button variant="subtle" size="small" onClick={() => setWorkspacePath("")}>전용 폴더 자동 생성</Button>}
          </div>
          <InlineNotice tone={isControlPlaneEnabled ? "blue" : "yellow"} title="경계">
            서버는 WORKSPACE_ROOT 밖의 경로, 심볼릭 링크 탈출, 쓰기 불가 폴더를 거부합니다.
          </InlineNotice>
        </Card>

        <div className="split-grid split-grid-2">
          <Card className="setting-card">
            <h2>자율성 경계</h2>
            <p>기본: 로컬·샌드박스 안에서는 자유롭게 행동합니다.</p>
            <span>외부 배포 · 결제 · 파괴적 작업은 승인 필요</span>
          </Card>
          <Card className="setting-card">
            <h2>초기 Budget</h2>
            <p>${budget} · 최대 {maxHours}시간 · 필요하면 균형 상태</p>
            <span>예산은 개발 순서를 지시하지 않고 피해 반경만 제한합니다.</span>
          </Card>
        </div>

        <div className="button-row">
          <Button variant="primary" size="medium" type="submit">시작하기</Button>
          <Button variant="neutral" size="medium" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>고급 설정</Button>
        </div>

        {advancedOpen && (
          <Card className="advanced-settings">
            <div className="advanced-setting-row">
              <div><strong>실행 예산</strong><span>실행 비용 상한을 정합니다.</span></div>
              <input type="number" min="1" max="1000" value={budget} onChange={(event) => setBudget(Number(event.target.value) || 1)} aria-label="실행 budget" />
            </div>
            <div className="advanced-setting-row">
              <div><strong>실행 시간</strong><span>lease가 유지되는 최대 시간입니다.</span></div>
              <input type="number" min="1" max="168" value={maxHours} onChange={(event) => setMaxHours(Number(event.target.value) || 1)} aria-label="최대 실행 시간" />
            </div>
            <div className="advanced-setting-row">
              <div><strong>모델 연결 방식</strong><span>auto는 설정된 실제 모델을 우선 사용하고 없으면 명확한 오류로 대기합니다.</span></div>
              <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value as typeof modelProvider)} aria-label="모델 연결 방식"><option value="auto">자동 선택</option><option value="codex-cli">Codex CLI</option><option value="openai-compatible">OpenAI 호환 API</option><option value="deterministic">결정론적 연구 기준선</option></select>
            </div>
            <div className="advanced-setting-row">
              <div><strong>샌드박스</strong><span>개발 명령을 격리할 실행 모드입니다.</span></div>
              <select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as typeof sandboxMode)} aria-label="샌드박스 모드"><option value="docker">Docker 격리</option><option value="process">프로세스(허용 목록)</option></select>
            </div>
            <InlineNotice tone="yellow" title="경계 기본값">외부 side effect와 production 배포는 사람 승인 전까지 차단됩니다.</InlineNotice>
          </Card>
        )}

        <Card className="start-principle-card">
          <h2>사람 = 시작</h2>
          <p>의도·선호·가치·승인만 제공합니다. 사람이 다음 작업을 계속 만들어 주지 않아도 되는 것이 목표입니다.</p>
        </Card>
      </form>
    </div>
  );
}
