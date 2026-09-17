import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchWorkspaceRoot, isControlPlaneEnabled, setWorkspaceRoot } from "../apiClient";
import { CodexSetupPanel } from "../components/CodexSetupPanel";
import { Button, Card, InlineNotice, Label, PageHeading, Pill } from "../components/ui";
import { isDesktopApp, pickDirectory } from "../desktop";
import { getRecommendedCodexModels } from "../modelCatalog";
import { loadUserPreferences, saveUserPreferences } from "../preferences";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import type { ModelCatalogEntry, ProjectSettings } from "../types";

export function NewProjectPage() {
  const { createProject } = useApp();
  const { navigate } = useRouter();
  const preferences = useMemo(() => loadUserPreferences(), []);
  const [intent, setIntent] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceRoot, setWorkspaceRootValue] = useState("");
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [codexReady, setCodexReady] = useState(!isDesktopApp);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showError, setShowError] = useState(false);

  const [executionMode, setExecutionMode] = useState<"native" | "atomic">(isControlPlaneEnabled ? "native" : "atomic");
  const [modelProvider, setModelProvider] = useState<NonNullable<ProjectSettings["modelProvider"]>>(isDesktopApp ? "codex-cli" : preferences.modelProvider);
  const [modelName, setModelName] = useState(preferences.modelName ?? "");
  const [availableModels, setAvailableModels] = useState<ModelCatalogEntry[]>(() => getRecommendedCodexModels());
  const [defaultModel, setDefaultModel] = useState("");
  const [sandboxMode, setSandboxMode] = useState<"process" | "docker">(isControlPlaneEnabled ? "docker" : "process");
  const [budget, setBudget] = useState(30);
  const [maxHours, setMaxHours] = useState(12);
  const [maxModelCalls, setMaxModelCalls] = useState(200);
  const [maxNativeTurns, setMaxNativeTurns] = useState(40);
  const [maxNativeTokens, setMaxNativeTokens] = useState(250000);

  useEffect(() => {
    if (!isControlPlaneEnabled) return;
    let cancelled = false;
    void fetchWorkspaceRoot().then((status) => { if (!cancelled) setWorkspaceRootValue(status.root); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isControlPlaneEnabled) {
      setAvailableModels(modelProvider === "codex-cli" ? getRecommendedCodexModels() : []);
      return;
    }
    let cancelled = false;
    void fetchModelCatalog().then((catalog) => {
      if (cancelled) return;
      setAvailableModels(catalog.entries ?? catalog.models.map((id) => ({ id, label: id, group: "configured" as const })));
      setDefaultModel(catalog.defaultModel ?? "");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [modelProvider]);

  const chooseWorkspace = async () => {
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

  const requiresCodex = executionMode === "native";
  const canStart = Boolean(intent.trim()) && (!isDesktopApp || !requiresCodex || codexReady);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!intent.trim()) { setShowError(true); return; }
    if (isDesktopApp && requiresCodex && !codexReady) return;
    const effectiveProvider = executionMode === "native" ? "codex-cli" : modelProvider;
    saveUserPreferences({ modelProvider: effectiveProvider, modelName: modelName.trim() || undefined });
    const settings: Partial<ProjectSettings> = {
      budgetLimit: budget,
      maxHours,
      maxModelCalls,
      executionMode,
      maxNativeTurns,
      maxNativeTokens,
      modelProvider: effectiveProvider,
      modelName: modelName.trim() || undefined,
      sandboxMode,
      networkPolicy: "allowlist",
      requireExternalApproval: true,
      productionBlocked: true,
      localActions: true,
    };
    if (isControlPlaneEnabled && workspacePath.trim()) settings.workspacePath = workspacePath.trim();
    const id = createProject(intent.trim(), settings);
    navigate(projectPath(id));
  };

  const selectedModel = modelName || defaultModel;

  return (
    <div className="screen screen-new-project screen-new-project-v2">
      <PageHeading title="원하는 결과만 말해 주세요" description="방법·기술 스택·작업 분해는 SakaSaka가 월드를 관찰하며 스스로 만들어갑니다." actions={<Button variant="subtle" size="small" onClick={() => navigate("/settings")}>환경 설정</Button>} />
      <form onSubmit={onSubmit} className="new-project-layout">
        <div className="new-project-main">
          <Card className="intent-card intent-card-v2">
            <div className="new-project-card-heading"><div><span className="eyebrow">Intent</span><h2>무엇을 갖고 싶은지 적어 주세요</h2></div><Pill tone={intent.trim() ? "mint" : "neutral"}>{intent.trim() ? "입력됨" : "필수"}</Pill></div>
            <Label htmlFor="intent">원하는 결과</Label>
            <textarea
              id="intent"
              value={intent}
              onChange={(event) => { setIntent(event.target.value); setShowError(false); }}
              placeholder="예: 개발자가 개인 프로젝트를 관리하는 로컬 우선 프로젝트 대시보드를 만들어줘. 실제로 매일 쓸 수 있는 완성된 제품이었으면 좋겠어. 나머지 제품/UX/기술 결정은 네가 판단해서 진행해."
              aria-describedby={showError ? "intent-error" : "intent-help"}
            />
            <p id="intent-help" className="field-help">이 문장은 고정 task list가 아니라 지속적으로 유지할 의도입니다. 시스템이 Goals · Gaps · Missions를 필요에 따라 다시 구성합니다.</p>
            {showError && <p id="intent-error" className="field-error" role="alert">먼저 원하는 결과를 적어 주세요.</p>}
          </Card>

          <Card className="workspace-binding-card workspace-v2-card">
            <div className="workspace-binding-heading"><div><span className="eyebrow">작업 공간</span><h2>실제로 변경할 로컬 폴더</h2></div><Pill tone={workspacePath ? "mint" : "blue"}>{workspacePath ? "연결됨" : "자동 생성 가능"}</Pill></div>
            <div className="workspace-v2-row">
              <input className="workspace-path-input" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder={workspaceRoot ? `${workspaceRoot} 아래 전용 폴더를 자동 생성` : "프로젝트 작업 폴더"} disabled={!isControlPlaneEnabled} />
              {isDesktopApp && <Button variant="neutral" size="small" onClick={() => void chooseWorkspace()} disabled={workspacePicking}>{workspacePicking ? "연결 중…" : "폴더 선택"}</Button>}
            </div>
            <p className="field-help">비우면 안전한 프로젝트 전용 폴더를 자동 생성합니다. 지정된 작업 경계 밖의 파일 접근과 심볼릭 링크 탈출은 거부됩니다.</p>
            {workspaceError && <p className="field-error">{workspaceError}</p>}
          </Card>

          {requiresCodex && <CodexSetupPanel compact onReadyChange={setCodexReady} />}

          <Card className="strong-defaults-card">
            <div className="new-project-card-heading"><div><span className="eyebrow">강한 기본값</span><h2>대부분은 이대로 시작하면 됩니다</h2></div><Pill tone="purple">권장</Pill></div>
            <dl className="strong-defaults-list">
              <div><dt>실행</dt><dd>지속형 Codex App Server</dd></div>
              <div><dt>판단</dt><dd>Codex CLI · Jev 연결 준비됨</dd></div>
              <div><dt>네트워크</dt><dd>허용목록 기반 · production 차단</dd></div>
              <div><dt>탐색</dt><dd>독립 read-only scout + Gap Graph</dd></div>
              <div><dt>사람</dt><dd>비동기 질문 · 영향 범위만 부분 대기</dd></div>
              <div><dt>위험 행동</dt><dd>외부 배포·결제·파괴적 작업 승인 필요</dd></div>
            </dl>
          </Card>

          {advancedOpen && <Card className="advanced-settings advanced-settings-v2">
            <div className="advanced-setting-row"><div><strong>실행 방식</strong><span>지속형 Codex가 기본입니다. atomic은 연구/호환용입니다.</span></div><select value={executionMode} onChange={(event) => { const mode = event.target.value as "native" | "atomic"; setExecutionMode(mode); if (mode === "native") setModelProvider("codex-cli"); }}><option value="native">지속형 Codex</option><option value="atomic">Atomic 호환 실행</option></select></div>
            <div className="advanced-setting-row"><div><strong>예산</strong><span>비용 피해 반경</span></div><input type="number" min="1" max="1000" value={budget} onChange={(event) => setBudget(Number(event.target.value) || 1)} /></div>
            <div className="advanced-setting-row"><div><strong>최대 실행 시간</strong><span>worker lease 상한</span></div><input type="number" min="1" max="168" value={maxHours} onChange={(event) => setMaxHours(Number(event.target.value) || 1)} /></div>
            <div className="advanced-setting-row"><div><strong>모델 호출 상한</strong><span>탐색·판단·작업 전체 공유</span></div><input type="number" min="1" max="10000" value={maxModelCalls} onChange={(event) => setMaxModelCalls(Number(event.target.value) || 1)} /></div>
            {executionMode === "native" && <>
              <div className="advanced-setting-row"><div><strong>최대 작업 구간</strong><span>같은 Codex thread에서 이어갈 turn 수</span></div><input type="number" min="1" max="1000" value={maxNativeTurns} onChange={(event) => setMaxNativeTurns(Number(event.target.value) || 1)} /></div>
              <div className="advanced-setting-row"><div><strong>Codex 토큰 상한</strong><span>프로젝트 세션 누적 한도</span></div><input type="number" min="1000" max="10000000" value={maxNativeTokens} onChange={(event) => setMaxNativeTokens(Number(event.target.value) || 1000)} /></div>
            </>}
            <div className="advanced-setting-row model-setting-row"><div><strong>모델</strong><span>비워두면 Codex/provider 기본값을 사용합니다.</span></div><div className="model-picker"><select value={availableModels.some((model) => model.id === selectedModel) ? selectedModel : ""} onChange={(event) => setModelName(event.target.value)}><option value="">기본 모델</option>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="직접 모델 ID" /></div></div>
            <div className="advanced-setting-row"><div><strong>도구 샌드박스</strong><span>Codex 자체 workspace sandbox와 별도의 로컬 도구 실행 경계</span></div><select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as "process" | "docker")}><option value="docker">Docker</option><option value="process">Host process</option></select></div>
          </Card>}

          <div className="new-project-actions">
            <div><strong>시작하면 바로 관찰 → 탐색 → 첫 미션으로 이어집니다.</strong><span>필요할 때만 사람이 개입합니다.</span></div>
            <div className="button-row"><Button variant="subtle" size="medium" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>{advancedOpen ? "고급 설정 닫기" : "고급 설정"}</Button><Button variant="primary" size="medium" type="submit" disabled={!canStart}>프로젝트 시작</Button></div>
          </div>
          {isDesktopApp && requiresCodex && !codexReady && <InlineNotice tone="yellow">지속형 Codex 실행을 시작하려면 위의 Codex 실행환경 준비를 완료해 주세요.</InlineNotice>}
        </div>

        <aside className="new-project-inspector" aria-label="새 프로젝트 실행 프로필">
          <Card className="settings-panel">
            <SectionHeader title="실행 프로필" action={<Pill tone="blue">기본값</Pill>} />
            <dl className="settings-definition-list"><div><dt>작업자</dt><dd>Codex CLI</dd></div><div><dt>방식</dt><dd>{executionMode === "native" ? "지속형" : "Atomic"}</dd></div><div><dt>샌드박스</dt><dd>workspace-write</dd></div><div><dt>네트워크</dt><dd>정책 경계 적용</dd></div><div><dt>작업 구간</dt><dd>{maxNativeTurns}</dd></div><div><dt>토큰 상한</dt><dd>{Math.round(maxNativeTokens / 1000)}k</dd></div></dl>
          </Card>
          <Card className="settings-panel"><SectionHeader title="예산 & 한도" /><dl className="settings-definition-list"><div><dt>예산</dt><dd>${budget}</dd></div><div><dt>최대 시간</dt><dd>{maxHours}h</dd></div><div><dt>모델 호출</dt><dd>{maxModelCalls}</dd></div></dl></Card>
          <Card className="settings-panel"><SectionHeader title="사람 경계" /><p className="small-copy"><strong className="safe-copy">자동:</strong> 로컬 파일 · 테스트 · 분석 · 되돌릴 수 있는 작업</p><p className="small-copy"><strong className="danger-copy">승인 필요:</strong> 외부 배포 · 결제 · 데이터 삭제 · 되돌리기 어려운 영향</p></Card>
        </aside>
      </form>
    </div>
  );
}
