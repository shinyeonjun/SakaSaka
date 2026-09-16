import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchModelCatalog, fetchModelConnectionStatus, isControlPlaneEnabled } from "../apiClient";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
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

  useEffect(() => {
    void loadStatus(modelProvider, modelName);
  }, [loadStatus, modelProvider]);

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

  return (
    <div className="screen screen-global-settings">
      <PageHeading
        title="환경 설정"
        description="프로젝트를 만들기 전에 연결할 모델과 기본값을 정합니다. 저장한 값은 다음 프로젝트 생성에 자동으로 적용됩니다."
        actions={<Button variant="primary" size="small" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button>}
      />

      <div className="screen-stack settings-stack">
        <Card className="settings-hero-card">
          <div>
            <span className="settings-overline">프로젝트 전 기본값</span>
            <h2>모델을 먼저 정하고 Intent를 시작하세요</h2>
          </div>
          <p>여기서 선택한 provider와 모델은 새 프로젝트의 초기 설정으로 복사됩니다. 프로젝트를 만든 뒤에도 프로젝트별로 바꿀 수 있습니다.</p>
        </Card>

        {error && <InlineNotice tone="red" title="연결 확인 실패">{error}</InlineNotice>}

        <div className="split-grid split-grid-2">
          <Card className="settings-panel">
            <SectionHeader title="새 프로젝트 모델" action={saved ? <Pill tone="mint">저장됨</Pill> : undefined} />
            <p className="settings-panel-title">다음 프로젝트에 사용할 기본 연결</p>
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
            <SectionHeader title="현재 연결 상태" action={<Pill tone={connectionTone(status.state)}>{loading ? "확인 중…" : connectionLabel(status.state)}</Pill>} />
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

        <InlineNotice tone={status.effective === "codex-cli" ? "blue" : status.effective === "deterministic" ? "yellow" : "orange"} title="연결 순서">
          {status.effective === "codex-cli"
            ? "Codex CLI는 도구가 아니라 ModelGateway로 다음 행동 하나를 결정합니다. 실제 파일 변경은 선택한 workspace 경계 안에서 실행됩니다."
            : "실제 Codex를 사용하려면 API 서버를 실행하고 CODEX_CLI_ENABLED=true와 codex login을 설정하세요. 모델 목록은 기본 추천 목록을 먼저 표시하고, CODEX_CLI_MODELS로 서버별 목록을 바꿀 수 있습니다."}
        </InlineNotice>

        <Card className="settings-panel global-settings-next-step">
          <SectionHeader title="다음 단계" />
          <p>모델 설정을 저장한 뒤 새 프로젝트에서 Intent와 작업 폴더를 정하면 됩니다. 작업 폴더를 비워두면 서버가 WORKSPACE_ROOT 안에 전용 폴더를 준비합니다.</p>
          <Button variant="neutral" size="small" onClick={() => navigate("/projects/new")}>Intent 입력으로 이동</Button>
        </Card>
      </div>
    </div>
  );
}
