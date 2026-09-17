import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchWorkspaceRoot, isControlPlaneEnabled, setWorkspaceRoot } from "../apiClient";
import { CodexSetupPanel } from "../components/CodexSetupPanel";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";
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
    if (!isControlPlaneEnabled) { setAvailableModels(modelProvider === "codex-cli" ? getRecommendedCodexModels() : []); return; }
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
    setWorkspacePicking(true); setWorkspaceError(undefined);
    try {
      const selected = await pickDirectory();
      if (!selected) return;
      const status = await setWorkspaceRoot(selected);
      setWorkspaceRootValue(status.root); setWorkspacePath(status.root);
    } catch (reason: unknown) {
      setWorkspaceError(reason instanceof Error ? reason.message : "작업 폴더를 연결하지 못했습니다.");
    } finally { setWorkspacePicking(false); }
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
      budgetLimit: budget, maxHours, maxModelCalls, executionMode, maxNativeTurns, maxNativeTokens,
      modelProvider: effectiveProvider, modelName: modelName.trim() || undefined, sandboxMode,
      networkPolicy: "allowlist", requireExternalApproval: true, productionBlocked: true, localActions: true,
    };
    if (isControlPlaneEnabled && workspacePath.trim()) settings.workspacePath = workspacePath.trim();
    navigate(projectPath(createProject(intent.trim(), settings)));
  };
  const selectedModel = modelName || defaultModel;

  const inspector = <>
    <InspectorHeader title="실행 프로필" meta="기본값" />
    <InspectorCard title="실행" meta="안전 기본값">
      <KeyValue label="작업자" value="Codex CLI" tone="working" />
      <KeyValue label="모드" value={executionMode === "native" ? "native / 지속형" : "atomic"} tone="evidence" />
      <KeyValue label="샌드박스" value="workspace-write" tone="success" />
      <KeyValue label="네트워크" value="정책 경계" tone="success" />
      <KeyValue label="최대 작업 구간" value={maxNativeTurns} />
      <KeyValue label="토큰 상한" value={`${Math.round(maxNativeTokens / 1000)}k`} />
    </InspectorCard>
    <InspectorCard title="예산 & 한도" meta="수정 가능">
      <KeyValue label="예산" value={`$${budget}`} /><KeyValue label="최대 시간" value={`${maxHours}h`} /><KeyValue label="모델 호출" value={maxModelCalls} /><KeyValue label="재탐색" value="60m" />
    </InspectorCard>
    <InspectorCard title="사람 경계" meta="강제">
      <strong className="text-success new-boundary-title">자동</strong><p className="product-muted">로컬 파일 · 테스트 · 분석 · 되돌릴 수 있는 작업</p>
      <strong className="text-danger new-boundary-title">승인 필요</strong><p className="product-muted">외부 배포 · 결제 · 데이터 삭제 · 되돌릴 수 없는 외부 영향</p>
    </InspectorCard>
    <InspectorCard title="고급 설정" meta={advancedOpen ? "열림" : "접힘"}><p className="product-muted">Model · sandbox · budgets · discovery cadence · preview URL</p></InspectorCard>
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="새 프로젝트" title="원하는 결과만 말해 주세요" description="방법·기술 스택·작업 분해는 시스템이 스스로 발견합니다." />
    <form className="figma-new-project-form" onSubmit={onSubmit}>
      <Surface className="figma-intent-composer">
        <SurfaceHeader title="의도" meta="필수" />
        <label className="sr-only" htmlFor="intent">원하는 결과</label>
        <textarea id="intent" value={intent} onChange={(event) => { setIntent(event.target.value); setShowError(false); }} placeholder="예: 개발자가 개인 프로젝트를 관리하는 로컬 우선 프로젝트 대시보드를 만들어줘. 프로젝트, 할 일, 메모, 마일스톤을 관리할 수 있고 실제로 매일 쓸 수 있는 완성된 제품이었으면 좋겠어. 나머지 제품/UX/기술 결정은 네가 판단해서 진행해." />
        <p className="product-muted">이 문장은 task list로 고정되지 않고, World를 관찰하면서 Goals / Gaps / Missions로 계속 재구성됩니다.</p>
        {showError && <p className="figma-form-error">먼저 원하는 결과를 적어 주세요.</p>}
      </Surface>

      <Surface>
        <SurfaceHeader title="작업 공간" meta="로컬 경계" />
        <div className="figma-workspace-row"><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder={workspaceRoot ? `${workspaceRoot} 아래 전용 폴더를 자동 생성` : "프로젝트 작업 폴더"} disabled={!isControlPlaneEnabled} />{isDesktopApp && <button type="button" onClick={() => void chooseWorkspace()}>{workspacePicking ? "연결 중…" : "폴더 선택"}</button>}</div>
        <p className="product-muted">이 경로 밖은 강제 경계로 거부합니다. 비우면 WORKSPACE_ROOT 아래 전용 폴더를 자동 생성합니다.</p>{workspaceError && <p className="figma-form-error">{workspaceError}</p>}
      </Surface>

      {requiresCodex && <CodexSetupPanel compact onReadyChange={setCodexReady} />}

      <Surface>
        <SurfaceHeader title="권장 기본값" meta="권장" />
        <div className="strong-defaults-figma">
          <DefaultRow label="실행" value="지속형 Codex App Server" tone="working" />
          <DefaultRow label="판단" value="Jev / Hybrid 사용 가능" tone="evidence" />
          <DefaultRow label="네트워크" value="허용목록 + production 차단" tone="success" />
          <DefaultRow label="탐색" value="읽기 전용 독립 탐색 3개" tone="evidence" />
          <DefaultRow label="사람 개입" value="비동기 질문 · 부분 차단" tone="human" />
        </div>
      </Surface>

      {advancedOpen && <Surface className="figma-advanced-settings"><SurfaceHeader title="고급 설정" meta="필요할 때만" />
        <SettingRow label="실행 방식"><select value={executionMode} onChange={(event) => { const mode = event.target.value as "native" | "atomic"; setExecutionMode(mode); if (mode === "native") setModelProvider("codex-cli"); }}><option value="native">지속형 Codex</option><option value="atomic">Atomic 호환 실행</option></select></SettingRow>
        <SettingRow label="예산"><input type="number" min="1" max="1000" value={budget} onChange={(event) => setBudget(Number(event.target.value) || 1)} /></SettingRow>
        <SettingRow label="최대 실행 시간"><input type="number" min="1" max="168" value={maxHours} onChange={(event) => setMaxHours(Number(event.target.value) || 1)} /></SettingRow>
        <SettingRow label="모델 호출 상한"><input type="number" min="1" max="10000" value={maxModelCalls} onChange={(event) => setMaxModelCalls(Number(event.target.value) || 1)} /></SettingRow>
        {executionMode === "native" && <><SettingRow label="최대 작업 구간"><input type="number" min="1" max="1000" value={maxNativeTurns} onChange={(event) => setMaxNativeTurns(Number(event.target.value) || 1)} /></SettingRow><SettingRow label="Codex 토큰 상한"><input type="number" min="1000" max="10000000" value={maxNativeTokens} onChange={(event) => setMaxNativeTokens(Number(event.target.value) || 1000)} /></SettingRow></>}
        <SettingRow label="모델"><div className="figma-model-row"><select value={availableModels.some((model) => model.id === selectedModel) ? selectedModel : ""} onChange={(event) => setModelName(event.target.value)}><option value="">기본 모델</option>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="직접 모델 ID" /></div></SettingRow>
        <SettingRow label="도구 샌드박스"><select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as "process" | "docker")}><option value="docker">Docker</option><option value="process">Host process</option></select></SettingRow>
      </Surface>}

      <div className="figma-launch-row"><div><strong>시작하면 바로 observe → discovery → first mission</strong><span>필요할 때만 사람이 개입합니다.</span></div><div><button type="button" className="figma-secondary-button" onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? "고급 설정 닫기" : "고급 설정"}</button><button type="submit" className="figma-primary-button" disabled={!canStart}>프로젝트 시작</button></div></div>
      {isDesktopApp && requiresCodex && !codexReady && <div className="figma-warning">지속형 Codex 실행을 시작하려면 위의 Codex 실행환경 준비를 완료해 주세요.</div>}
    </form>
  </ProductWorkspace>;
}

function DefaultRow({ label, value, tone }: { label: string; value: string; tone: "working" | "evidence" | "success" | "human" }) { return <div><span>{label}</span><strong><StatusDot tone={tone} />{value}</strong></div>; }
function SettingRow({ label, children }: { label: string; children: React.ReactNode }) { return <div className="figma-setting-row"><span>{label}</span><div>{children}</div></div>; }
