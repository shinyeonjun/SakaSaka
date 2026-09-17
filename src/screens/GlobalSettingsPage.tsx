import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchModelConnectionStatus, isControlPlaneEnabled } from "../apiClient";
import { CodexSetupPanel } from "../components/CodexSetupPanel";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { getDesktopDecisionSettings, isDesktopApp, saveDesktopDecisionSettings, type DesktopDecisionSettingsStatus } from "../desktop";
import { getRecommendedCodexModels } from "../modelCatalog";
import { loadUserPreferences, saveUserPreferences } from "../preferences";
import { useRouter } from "../router";
import type { ModelCatalogEntry, ModelProvider, ModelProviderStatus } from "../types";

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const emptyDecision: DesktopDecisionSettingsStatus = { provider: "codex-cli", jevModel: "jev-latest", apiKeyConfigured: false };

function connectionLabel(state: ModelProviderStatus["state"]): string {
  return ({ connected: "사용 가능", configured: "설정됨", unknown: "확인 필요", "needs-setup": "준비 필요", unavailable: "사용 불가" })[state];
}

function connectionTone(state: ModelProviderStatus["state"]): string {
  return ({ connected: "mint", configured: "blue", unknown: "yellow", "needs-setup": "orange", unavailable: "red" })[state];
}

function browserStatus(provider: ModelProvider, modelName?: string): ModelProviderStatus {
  if (provider === "deterministic") return {
    requested: provider, effective: "deterministic", state: "connected", displayName: "결정론적 연구 기준선",
    detail: "외부 AI를 사용하지 않는 로컬 기준선입니다.", selectedModel: modelName, availableModels: [], authentication: "not-applicable", checkedAt: new Date().toISOString(),
  };
  return {
    requested: provider, effective: "unavailable", state: "needs-setup", displayName: "데스크톱/API 연결 필요",
    detail: "브라우저만으로는 실제 모델 실행환경을 확인할 수 없습니다.", selectedModel: modelName, availableModels: [], authentication: "missing", checkedAt: new Date().toISOString(),
  };
}

export function GlobalSettingsPage() {
  const { navigate } = useRouter();
  const preferences = useMemo(() => loadUserPreferences(), []);
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
    if (!isControlPlaneEnabled) {
      setModelStatus(browserStatus(provider, selected || undefined));
      setModels(provider === "codex-cli" ? getRecommendedCodexModels() : []);
      return;
    }
    setModelLoading(true);
    setModelError(undefined);
    try {
      const [status, catalog] = await Promise.all([
        fetchModelConnectionStatus(provider, selected || undefined),
        fetchModelCatalog().catch(() => undefined),
      ]);
      setModelStatus(status);
      if (catalog) setModels(catalog.entries ?? catalog.models.map((id) => ({ id, label: id, group: "configured" as const })));
    } catch (reason: unknown) {
      setModelError(reason instanceof Error ? reason.message : "모델 연결 상태를 확인하지 못했습니다.");
    } finally {
      setModelLoading(false);
    }
  }, []);

  const refreshDecision = useCallback(async () => {
    if (!isDesktopApp) return;
    setDecisionLoading(true);
    setDecisionError(undefined);
    try {
      const next = await getDesktopDecisionSettings();
      if (!next) return;
      setDecisionStatus(next);
      setDecisionProvider(next.provider);
      setJevModel(next.jevModel);
    } catch (reason: unknown) {
      setDecisionError(reason instanceof Error ? reason.message : "판단 엔진 설정을 읽지 못했습니다.");
    } finally {
      setDecisionLoading(false);
    }
  }, []);

  useEffect(() => { void refreshModel(modelProvider, modelName); }, [modelProvider, refreshModel]);
  useEffect(() => { void refreshDecision(); }, [refreshDecision]);

  const saveModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = modelName.trim();
    if (normalized && !modelIdPattern.test(normalized)) {
      setModelError("모델 ID 형식이 올바르지 않습니다.");
      return;
    }
    saveUserPreferences({ modelProvider, modelName: normalized || undefined });
    setModelName(normalized);
    setModelSaved(true);
    void refreshModel(modelProvider, normalized);
  };

  const saveDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = jevModel.trim() || "jev-latest";
    if (!modelIdPattern.test(model)) { setDecisionError("Jev 모델 ID 형식이 올바르지 않습니다."); return; }
    if (decisionProvider !== "codex-cli" && !decisionStatus.apiKeyConfigured && !jevApiKey.trim()) {
      setDecisionError("Jev 또는 Hybrid를 사용하려면 TypeSafe API key가 필요합니다.");
      return;
    }
    setDecisionLoading(true);
    setDecisionError(undefined);
    try {
      const next = await saveDesktopDecisionSettings({ provider: decisionProvider, jevModel: model, jevApiKey: jevApiKey.trim() || undefined });
      setDecisionStatus(next);
      setDecisionProvider(next.provider);
      setJevModel(next.jevModel);
      setJevApiKey("");
      setDecisionSaved(true);
    } catch (reason: unknown) {
      setDecisionError(reason instanceof Error ? reason.message : "판단 엔진 설정을 저장하지 못했습니다.");
    } finally {
      setDecisionLoading(false);
    }
  };

  const clearJev = async () => {
    if (!isDesktopApp || decisionLoading) return;
    setDecisionLoading(true);
    try {
      const next = await saveDesktopDecisionSettings({ provider: "codex-cli", jevModel: jevModel.trim() || "jev-latest", clearJevKey: true });
      setDecisionStatus(next);
      setDecisionProvider("codex-cli");
      setJevApiKey("");
      setDecisionSaved(true);
    } catch (reason: unknown) {
      setDecisionError(reason instanceof Error ? reason.message : "Jev API key를 제거하지 못했습니다.");
    } finally {
      setDecisionLoading(false);
    }
  };

  const selectedModel = modelName || modelStatus.selectedModel || "";
  const modelOptions = [...models, ...modelStatus.availableModels.filter((id) => !models.some((entry) => entry.id === id)).map((id) => ({ id, label: id, group: "configured" as const }))];

  return (
    <div className="screen screen-global-settings settings-v2">
      <PageHeading title="환경 설정" description="Codex 실행환경, 작업 모델, 판단 엔진을 한 번 준비해 두면 다음 프로젝트에서도 그대로 재사용합니다." actions={<Button variant="primary" size="small" onClick={() => navigate("/projects/new")}>새 프로젝트</Button>} />
      <div className="screen-stack settings-stack">
        <CodexSetupPanel />

        <div className="settings-v2-grid">
          <Card className="settings-panel">
            <SectionHeader title="시스템 2 · 작업 모델" action={<Pill tone={connectionTone(modelStatus.state)}>{modelLoading ? "확인 중…" : connectionLabel(modelStatus.state)}</Pill>} />
            <p className="muted-copy">설계·코딩·탐색·복구처럼 깊은 작업을 담당합니다. 지속형 실행은 Codex CLI를 사용합니다.</p>
            {modelError && <InlineNotice tone="red">{modelError}</InlineNotice>}
            <form className="settings-model-form" onSubmit={saveModel}>
              <div className="settings-form-field">
                <label htmlFor="global-model-provider">연결 방식</label>
                <select id="global-model-provider" value={modelProvider} onChange={(event) => { setModelProvider(event.target.value as ModelProvider); setModelSaved(false); }}>
                  <option value="codex-cli">Codex CLI · 권장</option>
                  <option value="auto">자동 선택</option>
                  <option value="openai-compatible">OpenAI 호환 API</option>
                  <option value="deterministic">결정론적 연구 기준선</option>
                </select>
              </div>
              {modelProvider !== "deterministic" && <div className="settings-form-field">
                <label htmlFor="global-model-name">모델</label>
                <select value={modelOptions.some((entry) => entry.id === selectedModel) ? selectedModel : ""} onChange={(event) => { setModelName(event.target.value); setModelSaved(false); }}>
                  <option value="">provider 기본 모델</option>
                  {modelOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
                <input id="global-model-name" value={modelName} onChange={(event) => { setModelName(event.target.value); setModelSaved(false); }} placeholder="목록에 없는 모델 ID" maxLength={128} />
              </div>}
              <div className="button-row"><Button variant="neutral" size="small" type="submit">기본값 저장</Button>{modelSaved && <Pill tone="mint">저장됨</Pill>}</div>
            </form>
          </Card>

          <Card className="settings-panel settings-effective-card">
            <SectionHeader title="현재 연결" />
            <dl className="settings-definition-list">
              <div><dt>실제 경로</dt><dd>{modelStatus.effective === "codex-cli" ? "Codex CLI" : modelStatus.effective}</dd></div>
              <div><dt>모델</dt><dd>{modelStatus.selectedModel ?? "기본 모델"}</dd></div>
              <div><dt>인증</dt><dd>{modelStatus.authentication === "verified" ? "확인됨" : modelStatus.authentication === "not-applicable" ? "해당 없음" : "Codex 준비 패널 기준"}</dd></div>
              {modelStatus.binary && <div><dt>실행 파일</dt><dd><code>{modelStatus.binary}</code></dd></div>}
              {modelStatus.version && <div><dt>버전</dt><dd><code>{modelStatus.version}</code></dd></div>}
            </dl>
            <p className="small-copy">{modelStatus.detail}</p>
          </Card>
        </div>

        <Card className="settings-panel decision-settings-v2">
          <SectionHeader title="판단 엔진 · 시스템 1" action={<Pill tone={decisionProvider === "codex-cli" ? "blue" : decisionStatus.apiKeyConfigured ? "mint" : "yellow"}>{decisionProvider === "codex-cli" ? "Codex" : decisionProvider === "hybrid" ? "Hybrid" : "Jev"}</Pill>} />
          <p className="muted-copy">이미 발견된 후보의 우선순위·관련성·진전·완료 가능성을 빠르게 판단합니다. 권한이나 보안 경계는 절대 여기서 허용하지 않습니다.</p>
          {decisionError && <InlineNotice tone="red">{decisionError}</InlineNotice>}
          {isDesktopApp ? <form className="settings-model-form" onSubmit={(event) => void saveDecision(event)}>
            <div className="decision-provider-row">
              {(["codex-cli", "jev", "hybrid"] as const).map((provider) => <label key={provider} className={`decision-choice ${decisionProvider === provider ? "decision-choice-active" : ""}`}>
                <input type="radio" name="decision-provider" value={provider} checked={decisionProvider === provider} onChange={() => { setDecisionProvider(provider); setDecisionSaved(false); }} />
                <strong>{provider === "codex-cli" ? "Codex CLI" : provider === "jev" ? "Jev" : "Hybrid"}</strong>
                <span>{provider === "codex-cli" ? "지금 바로 사용" : provider === "jev" ? "TypeSafe API key 필요" : "Jev 우선 · Codex fallback"}</span>
              </label>)}
            </div>
            {decisionProvider !== "codex-cli" && <div className="split-grid split-grid-2">
              <div className="settings-form-field"><label htmlFor="jev-key">TypeSafe API key</label><input id="jev-key" type="password" autoComplete="off" value={jevApiKey} onChange={(event) => setJevApiKey(event.target.value)} placeholder={decisionStatus.apiKeyConfigured ? "저장됨 · 교체할 때만 입력" : "Jev 승인 후 입력"} /></div>
              <div className="settings-form-field"><label htmlFor="jev-model">Jev 모델</label><input id="jev-model" value={jevModel} onChange={(event) => setJevModel(event.target.value)} /></div>
            </div>}
            <div className="button-row"><Button variant="primary" size="small" type="submit" disabled={decisionLoading}>판단 엔진 저장</Button>{decisionStatus.apiKeyConfigured && <Button variant="subtle" size="small" type="button" onClick={() => void clearJev()}>Jev key 제거</Button>}{decisionSaved && <Pill tone="mint">저장됨</Pill>}</div>
          </form> : <InlineNotice tone="yellow">Jev secret 저장과 Codex 자동 준비 UX는 데스크톱 앱에서 제공됩니다.</InlineNotice>}
        </Card>

        <InlineNotice tone="blue" title="인증 저장 원칙">SakaSaka는 Codex 토큰을 자체 state나 로그에 복사하지 않습니다. Codex CLI가 관리하는 로그인 저장소를 그대로 사용하므로 앱을 다시 켜도 매번 로그인할 필요가 없습니다.</InlineNotice>
      </div>
    </div>
  );
}
