import { useEffect, useState, type FormEvent } from "react";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { fetchModelCatalog, fetchWorkspaceRoot, isControlPlaneEnabled, setWorkspaceRoot } from "../apiClient";
import { Button, Card, InlineNotice, Label, PageHeading } from "../components/ui";
import { getRecommendedCodexModels } from "../modelCatalog";
import { loadUserPreferences, saveUserPreferences } from "../preferences";
import type { ModelCatalogEntry, ProjectSettings } from "../types";
import { isDesktopApp, pickDirectory } from "../desktop";

export function NewProjectPage() {
  const { createProject } = useApp();
  const { navigate } = useRouter();
  const [intent, setIntent] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [budget, setBudget] = useState(30);
  const [maxHours, setMaxHours] = useState(12);
  const [maxModelCalls, setMaxModelCalls] = useState(200);
  const [modelProvider, setModelProvider] = useState<NonNullable<ProjectSettings["modelProvider"]>>(() => loadUserPreferences().modelProvider);
  const [modelName, setModelName] = useState(() => loadUserPreferences().modelName ?? "");
  const [availableModels, setAvailableModels] = useState<ModelCatalogEntry[]>(() => modelProvider === "codex-cli" ? getRecommendedCodexModels() : []);
  const [defaultModel, setDefaultModel] = useState("");
  const [sandboxMode, setSandboxMode] = useState<"process" | "docker">(isControlPlaneEnabled ? "docker" : "process");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceRoot, setWorkspaceRootValue] = useState("");
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (!isControlPlaneEnabled) return;
    let cancelled = false;
    void fetchWorkspaceRoot().then((status) => {
      if (!cancelled) setWorkspaceRootValue(status.root);
    }).catch(() => {
      // The API may still be starting with the desktop shell.
    });
    return () => { cancelled = true; };
  }, []);

  const chooseWorkspaceFolder = async () => {
    if (!isDesktopApp || workspacePicking) return;
    setWorkspacePicking(true);
    setWorkspaceError(undefined);
    try {
      const selected = await pickDirectory();
      if (!selected) return;
      const status = await setWorkspaceRoot(selected);
      setWorkspaceRootValue(status.root);
      setWorkspacePath(status.root);
    } catch (reason: unknown) {
      setWorkspaceError(reason instanceof Error ? reason.message : "작업 폴더를 연결하지 못했습니다.");
    } finally {
      setWorkspacePicking(false);
    }
  };

  useEffect(() => {
    if (!isControlPlaneEnabled) {
      setAvailableModels(modelProvider === "codex-cli" ? getRecommendedCodexModels() : []);
      setDefaultModel("");
      return;
    }
    let cancelled = false;
    void fetchModelCatalog().then((catalog) => {
      if (!cancelled) {
        setAvailableModels(catalog.entries ?? catalog.models.map((id) => ({ id, label: id, group: "configured" as const })));
        setDefaultModel(catalog.defaultModel ?? "");
      }
    }).catch(() => {
      // The model id remains editable when the API is still starting or has no catalog.
    });
    return () => { cancelled = true; };
  }, [modelProvider]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!intent.trim()) {
      setShowError(true);
      return;
    }
    saveUserPreferences({ modelProvider, modelName: modelName.trim() || undefined });
    const settings: Partial<ProjectSettings> = { budgetLimit: budget, maxHours, maxModelCalls, modelProvider, modelName: modelName.trim() || undefined, sandboxMode };
    if (isControlPlaneEnabled && workspacePath.trim()) settings.workspacePath = workspacePath.trim();
    const id = createProject(intent, settings);
    navigate(projectPath(id));
  };

  const showDirectModelInput = availableModels.length === 0 || (Boolean(modelName) && !availableModels.some((model) => model.id === modelName));

  return (
    <div className="screen screen-new-project">
      <PageHeading title="무엇을 원하나요?" description="방법은 정하지 않아도 됩니다. 원하는 결과와 꼭 지켜야 할 것만 남겨주세요." actions={<Button variant="neutral" size="small" onClick={() => navigate("/settings")}>시작 전 환경 설정</Button>} />
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
            {isDesktopApp && <Button variant="neutral" size="small" onClick={() => void chooseWorkspaceFolder()} disabled={workspacePicking}>{workspacePicking ? "폴더 연결 중…" : "폴더 선택"}</Button>}
          </div>
          {workspaceRoot && <p className="field-help workspace-root-status">현재 데스크톱 작업 경계: <code>{workspaceRoot}</code></p>}
          {workspaceError && <p className="field-error" role="alert">{workspaceError}</p>}
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
            <h2>초기 예산</h2>
            <p>${budget} 추정 · 최대 {maxHours}시간 · 모델 호출 {maxModelCalls}회</p>
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
              <div><strong>모델 호출 상한</strong><span>단가가 없는 CLI도 무제한 호출하지 않습니다.</span></div>
              <input type="number" min="1" max="10000" value={maxModelCalls} onChange={(event) => setMaxModelCalls(Math.max(1, Math.min(10000, Math.floor(Number(event.target.value) || 1))))} aria-label="모델 호출 상한" />
            </div>
            <div className="advanced-setting-row">
              <div><strong>모델 연결 방식</strong><span>auto는 설정된 실제 모델을 우선 사용하고, 연결 실패는 모델 오류로 표시합니다.</span></div>
              <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value as typeof modelProvider)} aria-label="모델 연결 방식"><option value="auto">자동 선택</option><option value="codex-cli">Codex CLI</option><option value="openai-compatible">OpenAI 호환 API</option><option value="deterministic">결정론적 연구 기준선</option></select>
            </div>
            {modelProvider !== "deterministic" && (
              <div className="advanced-setting-row model-setting-row">
                <div><strong>{modelProvider === "codex-cli" ? "Codex 모델" : "모델 ID"}</strong><span>{modelProvider === "codex-cli" ? "목록은 서버의 CODEX_CLI_MODELS 설정에서 읽습니다." : "선택한 provider가 지원하는 모델 ID를 입력합니다."} 비워두면 provider 기본 모델을 사용합니다.</span></div>
                <div className="model-picker">
                  <select
                    value={availableModels.some((model) => model.id === (modelName || defaultModel)) ? modelName || defaultModel : ""}
                    onChange={(event) => setModelName(event.target.value)}
                    aria-label={modelProvider === "codex-cli" ? "Codex 모델 목록" : "모델 목록"}
                  >
                    <option value="">provider 기본 모델</option>
                    {availableModels.some((model) => model.group === "recommended") && <optgroup label="기본 · 추천 모델 세트">
                      {availableModels.filter((model) => model.group === "recommended").map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                    </optgroup>}
                    {availableModels.some((model) => model.group === "configured") && <optgroup label="서버 설정 모델">
                      {availableModels.filter((model) => model.group === "configured").map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                    </optgroup>}
                  </select>
                  {showDirectModelInput && <input
                    value={modelName}
                    onChange={(event) => setModelName(event.target.value)}
                    maxLength={128}
                    pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}"
                    placeholder="목록에 없는 모델 ID 직접 입력"
                    aria-label="모델 ID"
                  />}
                  <span>{availableModels.length && !showDirectModelInput ? `추천 모델 ${availableModels.length}개에서 선택` : "서버 선택 목록 없음 · provider 기본 모델 또는 직접 입력 사용"}</span>
                </div>
              </div>
            )}
            <div className="advanced-setting-row">
              <div><strong>샌드박스</strong><span>개발 명령을 격리할 실행 모드입니다.</span></div>
              <select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as typeof sandboxMode)} aria-label="샌드박스 모드"><option value="docker">Docker 격리</option><option value="process">프로세스(호스트 실행 · 비격리)</option></select>
            </div>
            <InlineNotice tone="yellow" title="경계 기본값">production 배포 도구는 구현되지 않아 비활성화되어 있습니다. 프로세스 모드는 보안 격리가 아닙니다. 생성된 코드가 호스트 권한으로 실행되므로 비밀 정보가 없는 전용 환경에서만 시험하십시오.</InlineNotice>
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
