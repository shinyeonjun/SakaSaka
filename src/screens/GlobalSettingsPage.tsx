import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchModelConnectionStatus, isControlPlaneEnabled } from "../apiClient";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { getDesktopDecisionSettings, isDesktopApp, saveDesktopDecisionSettings, type DesktopDecisionSettingsStatus } from "../desktop";
import { getRecommendedCodexModels } from "../modelCatalog";
import { loadUserPreferences, saveUserPreferences, type UserPreferences } from "../preferences";
import { useRouter } from "../router";
import type { ModelCatalogEntry, ModelProvider, ModelProviderStatus } from "../types";

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function providerLabel(provider: ModelProvider): string {
  return {
    auto: "자동 선택",
    deterministic: "결정론적 연구 기준선",
    "openai-compatible": "OpenAI 호환 API",
    "codex-cli": "Codex CLI",
  }[provider];
}

function connectionLabel(value: ModelProviderStatus["state"]): string {
  return {
    connected: "사용 가능",
    configured: "설정됨 · 첫 실행 확인",
    unknown: "설치 확인 · 인증 미확인",
    "needs-setup": "설정 필요",
    unavailable: "사용 불가",
  }[value];
}

function connectionTone(value: ModelProviderStatus["state"]): string {
  return { connected: "mint", configured: "blue", unknown: "yellow", "needs-setup": "orange", unavailable: "red" }[value];
}

function browserStatus(provider: ModelProvider, modelName?: string): ModelProviderStatus {
  if (provider === "deterministic") {
    return {
      requested: provider,
      effective: "deterministic",
      state: "connected",
      displayName: "브라우저 로컬 결정론적 기준선",
      detail: "외부 AI가 아닌 브라우저 기준선입니다. 실제 Codex 실행은 API와 worker를 연결한 뒤 사용합니다.",
      selectedModel: modelName,
      availableModels: [],
      authentication: "not-applicable",
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    requested: provider,
    effective: "unavailable",
    state: "needs-setup",
    displayName: "API 연결 필요",
    detail: "브라우저 전용 모드에서는 provider 상태를 확인할 수 없습니다. API 서버를 연결하면 실제 실행 파일과 인증 상태를 확인합니다.",
    selectedModel: modelName,
    availableModels: [],
    authentication: "missing",
    checkedAt: new Date().toISOString(),
  };
}

const emptyDecisionStatus: DesktopDecisionSettingsStatus = { provider: "codex-cli", jevModel: "jev-latest", apiKeyConfigured: false };

export function GlobalSettingsPage() {
  const { navigate } = useRouter();
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => loadUserPreferences().modelProvider);
  const [modelName, setModelName] = useState(() => loadUserPreferences().modelName ?? "");
  const [catalogModels, setCatalogModels] = useState<ModelCatalogEntry[]>(() => modelProvider === "codex-cli" ? getRecommendedCodexModels() : []);
  const [catalogDefaultModel, setCatalogDefaultModel] = useState("");
  const [status, setStatus] = useState<ModelProviderStatus>(() => browserStatus(modelProvider, modelName));
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [decisionStatus, setDecisionStatus] = useState<DesktopDecisionSettingsStatus>(emptyDecisionStatus);
  const [decisionProvider, setDecisionProvider] = useState<DesktopDecisionSettingsStatus["provider"]>("codex-cli");
  const [jevModel, setJevModel] = useState("jev-latest");
  const [jevApiKey, setJevApiKey] = useState("");
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionSaved, setDecisionSaved] = useState(false);
  const [decisionError, setDecisionError] = useState<string | undefined>();
  const modelOptions = [...catalogModels, ...status.availableModels.filter((id) => !catalogModels.some((entry) => entry.id === id)).map((id) => ({ id, label: id, group: "configured" as const }))];
  const selectedDropdownModel = modelName || status.selectedModel || catalogDefaultModel;

  const loadStatus = useCallback(async (provider: ModelProvider, selectedModel: string) => {
    if (!isControlPlaneEnabled) {
      setStatus(browserStatus(provider, selectedModel || undefined));
      setCatalogModels(provider === "codex-cli" ? getRecommendedCodexModels() : []);
      setCatalogDefaultModel("");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const connection = await fetchModelConnectionStatus(provider, selectedModel || undefined);
      setStatus(connection);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "모델 연결 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
    try {
      const catalog = await fetchModelCatalog();
      setCatalogModels(catalog.entries ?? catalog.models.map((id) => ({ id, label: id, group: "configured" as const })));
      setCatalogDefaultModel(catalog.defaultModel ?? "");
    } catch {
      // The direct model field remains available when the API has no catalog.
    }
  }, []);

  const loadDecisionStatus = useCallback(async () => {
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
      setDecisionError(reason instanceof Error ? reason.message : "자율 판단 계층 설정을 읽지 못했습니다.");
    } finally {
      setDecisionLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus(modelProvider, modelName);
  }, [loadStatus, modelProvider]);

  useEffect(() => { void loadDecisionStatus(); }, [loadDecisionStatus]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedModel = modelName.trim();
    if (normalizedModel && !modelIdPattern.test(normalizedModel)) {
      setError("모델 ID는 영문·숫자로 시작하고 영문·숫자·._:/-만 사용할 수 있습니다.");
      setSaved(false);
      return;
    }
    const next: UserPreferences = { modelProvider, modelName: normalizedModel || undefined };
    saveUserPreferences(next);
    setModelName(normalizedModel);
    setSaved(true);
    void loadStatus(modelProvider, normalizedModel);
  };

  const saveDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = jevModel.trim();
    if (!modelIdPattern.test(model)) {
      setDecisionError("Jev 모델 ID는 영문·숫자로 시작하고 영문·숫자·._:/-만 사용할 수 있습니다.");
      setDecisionSaved(false);
      return;
    }
    if (decisionProvider !== "codex-cli" && !decisionStatus.apiKeyConfigured && !jevApiKey.trim()) {
      setDecisionError("Jev 또는 hybrid를 사용하려면 TypeSafe API key를 입력해야 합니다.");
      setDecisionSaved(false);
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
      setDecisionError(reason instanceof Error ? reason.message : "자율 판단 계층 설정을 저장하지 못했습니다.");
      setDecisionSaved(false);
    } finally {
      setDecisionLoading(false);
    }
  };

  const clearDecisionKey = async () => {
    if (!isDesktopApp || decisionLoading) return;
    setDecisionLoading(true);
    setDecisionError(undefined);
    try {
      const next = await saveDesktopDecisionSettings({ provider: "codex-cli", jevModel: jevModel.trim() || "jev-latest", clearJevKey: true });
      setDecisionStatus(next);
      setDecisionProvider("codex-cli");
      setJevApiKey("");
      setDecisionSaved(true);
    } catch (reason: unknown) {
      setDecisionError(reason instanceof Error ? reason.message : "TypeSafe API key를 지우지 못했습니다.");
    } finally {
      setDecisionLoading(false);
    }
  };

  return (
    <div className="screen screen-global-settings">
      <PageHeading
        title="환경 설정"
        description="프로젝트를 만들기 전에 모델과 자율 판단 계층을 정합니다. 모델 기본값은 다음 프로젝트에 복사됩니다."
        actions={<Button variant="primary" size="small" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button>}
      />

      <div className="screen-stack settings-stack">
        <Card className="settings-hero-card">
          <div>
            <span className="settings-overline">Intent-driven runtime</span>
            <h2>Codex는 깊게 작업하고, 판단 계층은 무엇을 볼지 계속 고릅니다</h2>
          </div>
          <p>Coverage scout가 사용자가 미리 알지 못한 문제 영역을 찾고, bounded DecisionGateway가 다음 mission과 완료 여부를 판단합니다. 실제 권한과 검증은 deterministic boundary에 남습니다.</p>
        </Card>

        {error && <InlineNotice tone="red" title="연결 확인 실패">{error}</InlineNotice>}

        <div className="split-grid split-grid-2">
          <Card className="settings-panel">
            <SectionHeader title="새 프로젝트 모델" action={saved ? <Pill tone="mint">저장됨</Pill> : undefined} />
            <p className="settings-panel-title">실제 코딩·설계·복구를 맡을 System 2</p>
            <form className="settings-model-form" onSubmit={save}>
              <div className="settings-form-field">
                <label htmlFor="global-model-provider">모델 연결 방식</label>
                <select id="global-model-provider" value={modelProvider} onChange={(event) => { setModelProvider(event.target.value as ModelProvider); setSaved(false); }}>
                  <option value="auto">자동 선택</option>
                  <option value="codex-cli">Codex CLI</option>
                  <option value="openai-compatible">OpenAI 호환 API</option>
                  <option value="deterministic">결정론적 연구 기준선</option>
                </select>
              </div>
              {modelProvider !== "deterministic" && (
                <div className="settings-form-field">
                  <label htmlFor="global-model-name">{modelProvider === "codex-cli" ? "Codex 모델" : "모델 ID"}</label>
                  <select id="global-model-options" value={modelOptions.some((entry) => entry.id === selectedDropdownModel) ? selectedDropdownModel : ""} onChange={(event) => { setModelName(event.target.value); setSaved(false); }} aria-label={modelProvider === "codex-cli" ? "Codex 모델 목록" : "모델 목록"}>
                    <option value="">provider 기본 모델</option>
                    {modelOptions.some((entry) => entry.group === "recommended") && <optgroup label="기본 · 추천 모델 세트">
                      {modelOptions.filter((entry) => entry.group === "recommended").map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </optgroup>}
                    {modelOptions.some((entry) => entry.group === "configured") && <optgroup label="서버 설정 모델">
                      {modelOptions.filter((entry) => entry.group === "configured").map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </optgroup>}
                  </select>
                  <input
                    id="global-model-name"
                    value={modelName}
                    onChange={(event) => { setModelName(event.target.value); setSaved(false); }}
                    maxLength={128}
                    pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}"
                    placeholder="목록에 없는 모델 ID 직접 입력"
                    aria-describedby="global-model-help"
                  />
                  <span id="global-model-help" className="field-help">{modelOptions.length ? `드롭다운에서 선택하거나 목록 밖 모델 ID를 직접 입력할 수 있습니다 · ${modelOptions.length}개 표시` : "provider 기본 모델 또는 모델 ID를 직접 입력할 수 있습니다."}</span>
                </div>
              )}
              <div className="button-row">
                <Button variant="primary" size="small" type="submit">기본 모델 저장</Button>
                {saved && <span className="settings-save-state" role="status">다음 프로젝트에 적용됩니다</span>}
              </div>
            </form>
          </Card>

          <Card className="settings-panel">
            <SectionHeader title="현재 모델 연결" action={<Pill tone={connectionTone(status.state)}>{loading ? "확인 중…" : connectionLabel(status.state)}</Pill>} />
            <p className="settings-panel-title">{status.displayName}</p>
            <dl className="settings-definition-list">
              <div><dt>선택 provider</dt><dd>{providerLabel(status.requested)}</dd></div>
              <div><dt>실제 사용 경로</dt><dd>{status.effective === "codex-cli" ? "Codex CLI" : status.effective === "openai-compatible" ? "OpenAI 호환 API" : status.effective === "deterministic" ? "결정론적 기준선" : "사용 가능한 provider 없음"}</dd></div>
              <div><dt>선택 모델</dt><dd>{status.selectedModel ? <code>{status.selectedModel}</code> : "provider 기본 모델"}</dd></div>
              <div><dt>인증 상태</dt><dd>{status.authentication === "verified" ? "로그인 확인됨" : status.authentication === "configured" ? "환경 설정 있음" : status.authentication === "not-applicable" ? "해당 없음" : status.authentication === "unverified" ? "확인되지 않음" : "없음"}</dd></div>
              {status.binary && <div><dt>실행 파일</dt><dd><code>{status.binary}</code></dd></div>}
              {status.version && <div><dt>CLI 버전</dt><dd><code>{status.version}</code></dd></div>}
            </dl>
            <p className="muted-copy">{status.detail}</p>
          </Card>
        </div>

        <Card className="settings-panel">
          <SectionHeader title="자율 판단 계층 · System 1" action={<Pill tone={decisionStatus.apiKeyConfigured ? "mint" : decisionProvider === "codex-cli" ? "blue" : "yellow"}>{decisionLoading ? "확인 중…" : decisionStatus.apiKeyConfigured ? "Jev key 설정됨" : "Codex 판단"}</Pill>} />
          <p className="settings-panel-title">발견된 gap 중 무엇을 우선할지, evidence가 충분한지 빠르게 판단합니다.</p>
          {decisionError && <InlineNotice tone="red" title="판단 계층 설정 실패">{decisionError}</InlineNotice>}
          {isDesktopApp ? (
            <form className="settings-model-form" onSubmit={(event) => void saveDecision(event)}>
              <div className="split-grid split-grid-2">
                <div className="settings-form-field">
                  <label htmlFor="decision-provider">Decision provider</label>
                  <select id="decision-provider" value={decisionProvider} onChange={(event) => { setDecisionProvider(event.target.value as DesktopDecisionSettingsStatus["provider"]); setDecisionSaved(false); }}>
                    <option value="codex-cli">Codex CLI · 별도 키 없음</option>
                    <option value="hybrid">Jev 우선 · Codex fallback</option>
                    <option value="jev">Jev only</option>
                  </select>
                </div>
                <div className="settings-form-field">
                  <label htmlFor="jev-model">Jev model</label>
                  <input id="jev-model" value={jevModel} onChange={(event) => { setJevModel(event.target.value); setDecisionSaved(false); }} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}" placeholder="jev-latest" />
                </div>
              </div>
              {decisionProvider !== "codex-cli" && <div className="settings-form-field">
                <label htmlFor="jev-api-key">TypeSafe API key</label>
                <input
                  id="jev-api-key"
                  type="password"
                  autoComplete="off"
                  value={jevApiKey}
                  onChange={(event) => { setJevApiKey(event.target.value); setDecisionSaved(false); }}
                  placeholder={decisionStatus.apiKeyConfigured ? "이미 앱 데이터에 저장됨 · 교체할 때만 입력" : "Jev 승인 후 발급된 API key"}
                  maxLength={4096}
                />
                <span className="field-help">브라우저 localStorage, AppState, event journal, Codex/Jev model context에는 key를 넣지 않습니다.</span>
              </div>}
              <div className="button-row">
                <Button variant="primary" size="small" type="submit" disabled={decisionLoading}>판단 계층 저장</Button>
                {decisionStatus.apiKeyConfigured && <Button variant="neutral" size="small" type="button" disabled={decisionLoading} onClick={() => void clearDecisionKey()}>Jev key 제거 · Codex로 전환</Button>}
                {decisionSaved && <span className="settings-save-state" role="status">앱 데이터에 저장됨</span>}
              </div>
            </form>
          ) : (
            <div>
              <p className="muted-copy">브라우저 개발 모드에서는 secret을 페이지에 저장하지 않습니다. 터미널에서 <code>npm run decision:setup</code>을 실행하거나 TypeSafe 환경변수를 worker에 전달하세요.</p>
            </div>
          )}
          <p className="small-copy">Jev/Codex의 확률 판단은 권한 승인이 아닙니다. workspace, production, network, budget, human approval은 기존 deterministic boundary가 계속 강제합니다.</p>
        </Card>

        <InlineNotice tone={status.effective === "codex-cli" ? "blue" : status.effective === "deterministic" ? "yellow" : "orange"} title="System 2 연결 순서">
          {status.effective === "codex-cli"
            ? "Codex CLI는 지속형 프로젝트 세션에서 실제 파일·명령·복구를 수행합니다. Coverage scout와 DecisionGateway가 그 앞뒤에서 누락된 영역과 다음 mission을 계속 찾습니다."
            : "실제 지속형 Codex를 사용하려면 API/desktop runtime에서 CODEX_CLI_ENABLED=true와 codex login을 준비하고 새 프로젝트의 모델을 Codex CLI로 설정하세요."}
        </InlineNotice>

        <Card className="settings-panel global-settings-next-step">
          <SectionHeader title="다음 단계" />
          <p>모델과 판단 계층을 저장한 뒤 새 프로젝트에서 Intent와 작업 폴더를 정하면 됩니다. 사용자가 PM·보안·인프라 체크리스트를 미리 만들 필요 없이 coverage scout가 현재 World에서 필요한 전문 관점을 탐색합니다.</p>
          <Button variant="neutral" size="small" onClick={() => navigate("/projects/new")}>Intent 입력으로 이동</Button>
        </Card>
      </div>
    </div>
  );
}
