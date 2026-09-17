import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchModelConnectionStatus, isControlPlaneEnabled } from "../apiClient";
import { CodexSetupPanel } from "../components/CodexSetupPanel";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";
import { getDesktopDecisionSettings, isDesktopApp, saveDesktopDecisionSettings, type DesktopDecisionSettingsStatus } from "../desktop";
import { getRecommendedCodexModels } from "../modelCatalog";
import { loadUserPreferences, saveUserPreferences } from "../preferences";
import type { ModelCatalogEntry, ModelProvider, ModelProviderStatus } from "../types";

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const emptyDecision: DesktopDecisionSettingsStatus = { provider: "codex-cli", jevModel: "jev-latest", apiKeyConfigured: false };
const categories = ["일반", "모델 & 판단", "자율 판단", "보안 & 샌드박스", "예산 & 한도", "개발자"] as const;
type SettingsCategory = (typeof categories)[number];

function browserStatus(provider: ModelProvider, modelName?: string): ModelProviderStatus {
  if (provider === "deterministic") return { requested: provider, effective: "deterministic", state: "connected", displayName: "결정론적 연구 기준선", detail: "외부 AI를 사용하지 않는 로컬 기준선입니다.", selectedModel: modelName, availableModels: [], authentication: "not-applicable", checkedAt: new Date().toISOString() };
  return { requested: provider, effective: "unavailable", state: "needs-setup", displayName: "데스크톱/API 연결 필요", detail: "브라우저만으로는 실제 모델 실행환경을 확인할 수 없습니다.", selectedModel: modelName, availableModels: [], authentication: "missing", checkedAt: new Date().toISOString() };
}

export function GlobalSettingsPage() {
  const preferences = useMemo(() => loadUserPreferences(), []);
  const [category, setCategory] = useState<SettingsCategory>("모델 & 판단");
  const [modelProvider, setModelProvider] = useState<ModelProvider>(preferences.modelProvider);
  const [modelName, setModelName] = useState(preferences.modelName ?? "");
  const [models, setModels] = useState<ModelCatalogEntry[]>(() => modelProvider === "codex-cli" ? getRecommendedCodexModels() : []);
  const [modelStatus, setModelStatus] = useState<ModelProviderStatus>(() => browserStatus(modelProvider, modelName));
  const [modelLoading, setModelLoading] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [modelError, setModelError] = useState<string>();
  const [decisionStatus, setDecisionStatus] = useState<DesktopDecisionSettingsStatus>(emptyDecision);
  const [decisionProvider, setDecisionProvider] = useState<DesktopDecisionSettingsStatus["provider"]>("codex-cli");
  const [jevModel, setJevModel] = useState("jev-latest");
  const [jevApiKey, setJevApiKey] = useState("");
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionSaved, setDecisionSaved] = useState(false);
  const [decisionError, setDecisionError] = useState<string>();

  const refreshModel = useCallback(async (provider: ModelProvider, selected: string) => {
    if (!isControlPlaneEnabled) { setModelStatus(browserStatus(provider, selected || undefined)); setModels(provider === "codex-cli" ? getRecommendedCodexModels() : []); return; }
    setModelLoading(true); setModelError(undefined);
    try {
      const [status, catalog] = await Promise.all([fetchModelConnectionStatus(provider, selected || undefined), fetchModelCatalog().catch(() => undefined)]);
      setModelStatus(status);
      if (catalog) setModels(catalog.entries ?? catalog.models.map((id) => ({ id, label: id, group: "configured" as const })));
    } catch (reason: unknown) { setModelError(reason instanceof Error ? reason.message : "모델 연결 상태를 확인하지 못했습니다."); }
    finally { setModelLoading(false); }
  }, []);

  const refreshDecision = useCallback(async () => {
    if (!isDesktopApp) return;
    setDecisionLoading(true); setDecisionError(undefined);
    try {
      const next = await getDesktopDecisionSettings();
      if (!next) return;
      setDecisionStatus(next); setDecisionProvider(next.provider); setJevModel(next.jevModel);
    } catch (reason: unknown) { setDecisionError(reason instanceof Error ? reason.message : "판단 엔진 설정을 읽지 못했습니다."); }
    finally { setDecisionLoading(false); }
  }, []);

  useEffect(() => { void refreshModel(modelProvider, modelName); }, [modelProvider, refreshModel]);
  useEffect(() => { void refreshDecision(); }, [refreshDecision]);

  const saveModel = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const normalized = modelName.trim();
    if (normalized && !modelIdPattern.test(normalized)) { setModelError("모델 ID 형식이 올바르지 않습니다."); return; }
    saveUserPreferences({ modelProvider, modelName: normalized || undefined }); setModelName(normalized); setModelSaved(true); void refreshModel(modelProvider, normalized);
  };

  const saveDecision = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const model = jevModel.trim() || "jev-latest";
    if (!modelIdPattern.test(model)) { setDecisionError("Jev 모델 ID 형식이 올바르지 않습니다."); return; }
    if (decisionProvider !== "codex-cli" && !decisionStatus.apiKeyConfigured && !jevApiKey.trim()) { setDecisionError("Jev 또는 Hybrid를 사용하려면 TypeSafe API key가 필요합니다."); return; }
    setDecisionLoading(true); setDecisionError(undefined);
    try {
      const next = await saveDesktopDecisionSettings({ provider: decisionProvider, jevModel: model, jevApiKey: jevApiKey.trim() || undefined });
      setDecisionStatus(next); setDecisionProvider(next.provider); setJevModel(next.jevModel); setJevApiKey(""); setDecisionSaved(true);
    } catch (reason: unknown) { setDecisionError(reason instanceof Error ? reason.message : "판단 엔진 설정을 저장하지 못했습니다."); }
    finally { setDecisionLoading(false); }
  };

  const clearJev = async () => {
    if (!isDesktopApp || decisionLoading) return;
    setDecisionLoading(true);
    try {
      const next = await saveDesktopDecisionSettings({ provider: "codex-cli", jevModel: jevModel.trim() || "jev-latest", clearJevKey: true });
      setDecisionStatus(next); setDecisionProvider("codex-cli"); setJevApiKey(""); setDecisionSaved(true);
    } catch (reason: unknown) { setDecisionError(reason instanceof Error ? reason.message : "Jev API key를 제거하지 못했습니다."); }
    finally { setDecisionLoading(false); }
  };

  const selectedModel = modelName || modelStatus.selectedModel || "";
  const modelOptions = [...models, ...modelStatus.availableModels.filter((id) => !models.some((entry) => entry.id === id)).map((id) => ({ id, label: id, group: "configured" as const }))];
  const effectiveDecision = decisionProvider === "jev" ? "Jev" : decisionProvider === "hybrid" ? "Hybrid" : "Codex CLI";
  const inspector = <>
    <InspectorHeader title="적용 설정" meta="실시간" />
    <InspectorCard title="적용값" meta="우선순위 반영 후">
      <KeyValue label="판단" value={effectiveDecision} tone="evidence" /><KeyValue label="작업자" value="Codex CLI" tone="working" /><KeyValue label="실행" value="native" tone="evidence" /><KeyValue label="샌드박스" value="workspace-write" tone="success" /><KeyValue label="네트워크" value="정책 경계" tone="success" />
    </InspectorCard>
    <InspectorCard title="설정 우선순위" meta="높은 순"><ol className="compact-steps"><li>환경 변수</li><li>로컬 decision-settings.json</li><li>앱 기본값</li></ol><p className="product-muted">API key는 AppState / event journal / model context에 저장되지 않습니다.</p></InspectorCard>
    <InspectorCard title="환경 변수" meta="선택"><p className="settings-env-line">SAKASAKA_DECISION_PROVIDER</p><p className="settings-env-line">TYPESAFE_API_KEY</p><p className="settings-env-line">TYPESAFE_DEFAULT_MODEL</p></InspectorCard>
    <InspectorCard title="연결 상태"><KeyValue label="Codex CLI" value={modelStatus.state === "connected" || modelStatus.authentication === "verified" ? "연결됨" : "확인 필요"} tone={modelStatus.state === "connected" ? "success" : "warning"} /><KeyValue label="Jev" value={decisionStatus.apiKeyConfigured ? "키 저장됨" : "미설정"} tone={decisionStatus.apiKeyConfigured ? "success" : "warning"} /></InspectorCard>
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="설정" title="환경 설정" description="런타임의 정책과 모델 연결을 바꿉니다. 프로젝트 Intent와는 별개입니다." />
    <div className="figma-settings-region">
      <nav className="figma-settings-categories">{categories.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</nav>
      <div className="figma-settings-content">
        {category === "모델 & 판단" ? <>
          <Surface>
            <SurfaceHeader title="판단 엔진" meta="시스템 1" />
            <p className="product-muted settings-lead">이미 주어진 후보를 빠르게 분류·점수화·라우팅하는 경계가 정해진 의미 판단 계층</p>
            <div className="figma-decision-options">{(["codex-cli", "jev", "hybrid"] as const).map((provider) => <label key={provider} className={decisionProvider === provider ? "active" : ""}><input type="radio" name="decision-provider" value={provider} checked={decisionProvider === provider} onChange={() => { setDecisionProvider(provider); setDecisionSaved(false); }} /><span><strong>{provider === "codex-cli" ? "Codex CLI" : provider === "jev" ? "Jev" : "혼합(Hybrid)"}</strong><small>{provider === "codex-cli" ? "즉시 사용" : provider === "jev" ? "API 키 필요" : "Jev → Codex 대체 경로"}</small></span></label>)}</div>
          </Surface>

          <Surface>
            <SurfaceHeader title="TypeSafe Jev" meta={decisionStatus.apiKeyConfigured ? "키 저장됨" : "미설정"} />
            {decisionError && <div className="figma-form-error">{decisionError}</div>}
            {isDesktopApp ? <form className="jev-form-figma" onSubmit={(event) => void saveDecision(event)}>
              <div className="settings-field-label"><span>API 키</span><StatusPill tone={decisionStatus.apiKeyConfigured ? "success" : "warning"}>{decisionStatus.apiKeyConfigured ? "설정 완료" : "미설정"}</StatusPill></div>
              <div className="jev-secret-row"><input type="password" autoComplete="off" value={jevApiKey} onChange={(event) => setJevApiKey(event.target.value)} placeholder={decisionStatus.apiKeyConfigured ? "저장됨 · 교체할 때만 입력" : "TypeSafe API key"} /><button type="submit" disabled={decisionLoading}>키 저장</button></div>
              <div className={`jev-key-status ${decisionStatus.apiKeyConfigured ? "configured" : "missing"}`} role="status" aria-live="polite"><StatusDot tone={decisionStatus.apiKeyConfigured ? "success" : "warning"} /><span>{decisionStatus.apiKeyConfigured ? "Jev API 키가 안전하게 저장되어 있습니다." : "Jev API 키를 입력하면 이곳에 설정 완료로 표시됩니다."}</span></div>
              <div className="settings-two-fields"><label><span>모델</span><input value={jevModel} onChange={(event) => setJevModel(event.target.value)} /></label><label><span>기본 URL</span><input value="api.typesafe.ai" readOnly /></label></div>
              <div className="settings-inline-actions"><button type="submit" disabled={decisionLoading}>{decisionLoading ? "저장 중…" : "판단 엔진 저장"}</button>{decisionStatus.apiKeyConfigured && <button type="button" onClick={() => void clearJev()}>Jev key 제거</button>}{decisionSaved && <StatusPill tone="success">저장됨</StatusPill>}</div>
            </form> : <p className="product-muted">Jev secret 저장은 데스크톱 앱에서 제공됩니다.</p>}
            <p className="product-muted">Jev는 강제 정책을 허용하지 않으며, Hybrid에서 판단 실패 시 Codex의 경계형 판단으로 대체합니다.</p>
          </Surface>

          <Surface>
            <SurfaceHeader title="시스템 2 작업자" meta="Codex" />
            {modelError && <div className="figma-form-error">{modelError}</div>}
            <form className="system2-settings" onSubmit={saveModel}>
              <KeyValue label="제공자" value={modelProvider === "codex-cli" ? "Codex CLI" : modelProvider} tone="working" /><KeyValue label="실행" value="지속형 App Server" tone="evidence" /><KeyValue label="상태" value={modelLoading ? "확인 중" : modelStatus.state} tone={modelStatus.state === "connected" ? "success" : "warning"} />
              <div className="settings-two-fields"><label><span>연결 방식</span><select value={modelProvider} onChange={(event) => { setModelProvider(event.target.value as ModelProvider); setModelSaved(false); }}><option value="codex-cli">Codex CLI · 권장</option><option value="auto">자동 선택</option><option value="openai-compatible">OpenAI 호환 API</option><option value="deterministic">결정론적 기준선</option></select></label><label><span>모델</span><select value={modelOptions.some((entry) => entry.id === selectedModel) ? selectedModel : ""} onChange={(event) => { setModelName(event.target.value); setModelSaved(false); }}><option value="">provider 기본값</option>{modelOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label></div>
              <div className="settings-inline-actions"><button type="submit">작업 모델 저장</button>{modelSaved && <StatusPill tone="success">저장됨</StatusPill>}</div>
            </form>
            <div className="settings-codex-setup"><CodexSetupPanel compact /></div>
          </Surface>

          <Surface><SurfaceHeader title="역할 분리" meta="고정" /><div className="responsibility-grid"><Role title="결정론적 코드" tone="success" items={["권한","경로","예산","스키마","테스트"]} /><Role title="판단 엔진" tone="evidence" items={["라우팅","우선순위","관련성","진행도"]} /><Role title="Codex 시스템 2" tone="working" items={["탐색","계획","코딩","레드팀"]} /></div></Surface>
        </> : <CategoryContent category={category} />}
      </div>
    </div>
  </ProductWorkspace>;
}

function Role({ title, tone, items }: { title: string; tone: "success" | "evidence" | "working"; items: string[] }) { return <div className="responsibility-card"><strong className={`text-${tone}`}>{title}</strong>{items.map((item) => <span key={item}>{item}</span>)}</div>; }
function CategoryContent({ category }: { category: SettingsCategory }) {
  const content: Record<Exclude<SettingsCategory,"모델 & 판단">,{ title:string; copy:string; rows:Array<[string,string]> }> = {
    "일반": { title:"일반", copy:"앱 표시와 프로젝트 기본 동작을 관리합니다.", rows:[["언어","한국어 우선"],["테마","Dark-first"],["데스크톱","1440×900 권장"]] },
    "자율 판단": { title:"자율 판단", copy:"탐색·우선순위·수렴 판단의 런타임 원칙입니다.", rows:[["탐색","독립 read-only scout"],["판단","typed decision gateway"],["완료","evidence 기반 equilibrium"]] },
    "보안 & 샌드박스": { title:"보안 & 샌드박스", copy:"생각의 자유와 실행 권한을 분리합니다.", rows:[["워크스페이스","경로 경계"],["외부 영향","사람 승인"],["비밀값","모델 컨텍스트 제외"]] },
    "예산 & 한도": { title:"예산 & 한도", copy:"프로젝트마다 설정되는 피해 반경의 기본 원칙입니다.", rows:[["기본 예산","$30"],["기본 시간","12h"],["모델 호출","200"]] },
    "개발자": { title:"개발자", copy:"런타임과 진단 정보를 확인합니다.", rows:[["Control Plane","127.0.0.1:8787"],["Desktop","Tauri 2"],["UI","React 19 + TypeScript"]] },
  };
  const selected = content[category as Exclude<SettingsCategory,"모델 & 판단">];
  return <Surface className="settings-category-placeholder"><SurfaceHeader title={selected.title} meta="설정 그룹" /><p className="settings-lead product-muted">{selected.copy}</p>{selected.rows.map(([label,value]) => <KeyValue key={label} label={label} value={value} />)}</Surface>;
}
