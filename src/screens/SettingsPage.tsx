import { useCallback, useEffect, useState } from "react";
import { fetchRuntimeConnectionStatus, isControlPlaneEnabled } from "../apiClient";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader } from "../components/ui";
import { getProject } from "../runtime";
import { useApp } from "../store";
import type { ModelProvider, Project, ResolvedModelProvider, RuntimeConnectionStatus } from "../types";
import { projectPath, useRouter } from "../router";

function providerLabel(provider: ModelProvider): string {
  return {
    auto: "자동 선택",
    deterministic: "결정론적 연구 기준선",
    "openai-compatible": "OpenAI 호환 API",
    "codex-cli": "Codex CLI",
  }[provider];
}

function resolvedProviderLabel(provider: ResolvedModelProvider): string {
  return { deterministic: "결정론적 기준선", "openai-compatible": "OpenAI 호환 API", "codex-cli": "Codex CLI", unavailable: "사용 가능한 provider 없음" }[provider];
}

function connectionLabel(state: RuntimeConnectionStatus["model"]["state"]): string {
  return {
    connected: "사용 가능",
    configured: "설정됨 · 첫 실행 확인",
    unknown: "설치 확인 · 인증 미확인",
    "needs-setup": "설정 필요",
    unavailable: "사용 불가",
  }[state];
}

function connectionTone(state: RuntimeConnectionStatus["model"]["state"]): string {
  return { connected: "mint", configured: "blue", unknown: "yellow", "needs-setup": "orange", unavailable: "red" }[state];
}

function workspaceLabel(state: RuntimeConnectionStatus["workspace"]["state"]): string {
  return { bound: "연결됨", missing: "폴더 준비 필요", inaccessible: "접근 불가", unbound: "미연결", rejected: "거부됨" }[state];
}

function workspaceTone(state: RuntimeConnectionStatus["workspace"]["state"]): string {
  return { bound: "mint", missing: "yellow", inaccessible: "red", unbound: "yellow", rejected: "red" }[state];
}

function authenticationLabel(value: RuntimeConnectionStatus["model"]["authentication"]): string {
  return { "not-applicable": "해당 없음", configured: "환경 설정 있음", verified: "로그인 확인됨", unverified: "확인되지 않음", missing: "없음" }[value];
}

function localStatus(project: Project): RuntimeConnectionStatus {
  const requested = project.settings.modelProvider ?? "deterministic";
  const deterministic = requested === "deterministic";
  return {
    model: {
      requested,
      effective: deterministic ? "deterministic" : "unavailable",
      state: deterministic ? "connected" : "needs-setup",
      displayName: deterministic ? "브라우저 로컬 결정론적 기준선" : "서버 provider 확인 필요",
      detail: deterministic
        ? "브라우저 상태에서 동작하는 결정론적 기준선입니다. 실제 AI 연결로 표시하지 않습니다."
        : "브라우저 전용 모드에서는 Codex CLI와 OpenAI 호환 API를 실행할 수 없습니다. API와 worker를 연결하면 서버에서 확인합니다.",
      authentication: deterministic ? "not-applicable" : "missing",
      checkedAt: new Date().toISOString(),
    },
    workspace: {
      state: "unbound",
      root: "브라우저 전용 상태",
      exists: false,
      writable: false,
      detail: "브라우저 localStorage 프로젝트는 OS 폴더에 연결되지 않습니다.",
    },
  };
}

export function SettingsPage({ projectId }: { projectId: string }) {
  const { state } = useApp();
  const { navigate } = useRouter();
  const project = getProject(state, projectId);
  const [status, setStatus] = useState<RuntimeConnectionStatus | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadStatus = useCallback(async () => {
    if (!project) return;
    if (!isControlPlaneEnabled) {
      setStatus(localStatus(project));
      setError(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setStatus(await fetchRuntimeConnectionStatus(projectId));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "런타임 연결 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [project, projectId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  if (!project) {
    return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1><p>먼저 프로젝트를 만든 뒤 설정을 확인해 주세요.</p><Button variant="primary" onClick={() => navigate("/projects/new")}>새 프로젝트 시작</Button></Card></div>;
  }

  const current = status ?? localStatus(project);
  const model = current.model;
  const workspace = current.workspace;
  const workspacePath = workspace.resolvedPath ?? workspace.configuredPath ?? "API가 프로젝트 전용 폴더를 자동 생성합니다.";

  return (
    <div className="screen">
      <PageHeading
        title="프로젝트 설정"
        description="이 프로젝트가 사용할 단 하나의 작업 폴더와 모델 연결을 확인합니다."
        actions={<Button variant="neutral" size="small" onClick={() => void loadStatus()} disabled={loading}>{loading ? "확인 중…" : "상태 새로 확인"}</Button>}
      />

      <div className="screen-stack settings-stack">
        {error && <InlineNotice tone="red" title="상태 확인 실패">{error} API 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.</InlineNotice>}

        <Card className="settings-hero-card">
          <div>
            <span className="settings-overline">현재 연결 경로</span>
            <h2>{isControlPlaneEnabled ? "API 제어면 · 로컬 worker" : "브라우저 전용 상태"}</h2>
          </div>
          <p>{isControlPlaneEnabled ? "서버가 실제 workspace와 ModelGateway를 확인했습니다. 파일 변경은 선택한 workspace 안에서만 실행됩니다." : "실제 파일 생성·프로세스 실행·Codex 연결을 사용하려면 VITE_API_URL로 API를 연결해야 합니다."}</p>
        </Card>

        <div className="split-grid split-grid-2">
          <Card className="settings-panel">
            <SectionHeader title="작업 폴더" action={<Pill tone={workspaceTone(workspace.state)}>{workspaceLabel(workspace.state)}</Pill>} />
            <p className="settings-panel-title">이 프로젝트의 실제 변경 대상</p>
            <code className="settings-path">{workspacePath}</code>
            <dl className="settings-definition-list">
              <div><dt>허용 루트</dt><dd><code>{workspace.root}</code></dd></div>
              <div><dt>폴더 존재</dt><dd>{workspace.exists ? "확인됨" : "없음"}</dd></div>
              <div><dt>쓰기 권한</dt><dd>{workspace.writable ? "확인됨" : "확인되지 않음"}</dd></div>
            </dl>
            <p className="muted-copy">{workspace.detail}</p>
          </Card>

          <Card className="settings-panel">
            <SectionHeader title="모델 연결" action={<Pill tone={connectionTone(model.state)}>{connectionLabel(model.state)}</Pill>} />
            <p className="settings-panel-title">{model.displayName}</p>
            <dl className="settings-definition-list">
              <div><dt>프로젝트 선택</dt><dd>{providerLabel(model.requested)}</dd></div>
              <div><dt>실제 사용 경로</dt><dd>{resolvedProviderLabel(model.effective)}</dd></div>
              <div><dt>인증 상태</dt><dd>{authenticationLabel(model.authentication)}</dd></div>
              {model.binary && <div><dt>실행 파일</dt><dd><code>{model.binary}</code></dd></div>}
              {model.version && <div><dt>CLI 버전</dt><dd><code>{model.version}</code></dd></div>}
            </dl>
            <p className="muted-copy">{model.detail}</p>
          </Card>
        </div>

        <Card className="settings-panel">
          <SectionHeader title="실행 경계" />
          <div className="settings-boundary-grid">
            <div><span>샌드박스</span><strong>{project.settings.sandboxMode === "docker" ? "Docker 격리" : "프로세스 허용 목록"}</strong></div>
            <div><span>네트워크</span><strong>{project.settings.networkPolicy === "allowlist" ? "허용 목록" : "차단"}</strong></div>
            <div><span>외부 승인</span><strong>{project.settings.requireExternalApproval ? "필요" : "필요 없음"}</strong></div>
            <div><span>운영 환경</span><strong>{project.settings.productionBlocked ? "강제 차단" : "승인 전제"}</strong></div>
          </div>
          <p className="muted-copy">Governor는 개발 순서를 정하지 않고 예산·권한·위험·중단 경계만 적용합니다.</p>
        </Card>

        <InlineNotice tone={model.effective === "codex-cli" ? "blue" : model.state === "connected" ? "mint" : "yellow"} title="Codex 연결 방식">
          {model.effective === "codex-cli"
            ? `Codex CLI는 도구가 아니라 ModelGateway로 다음 행동 하나를 결정합니다. 실제 파일 변경과 명령 실행은 SakaSaka의 ToolGateway가 담당합니다. ${model.authentication === "verified" ? "CLI와 로그인 상태는 확인됐으며, 실제 모델 응답과 ActionEnvelope 파싱은 첫 인지 주기에서 검증합니다." : "CLI는 확인됐지만 로그인 상태가 확인되지 않았습니다. codex login 후 다시 확인하세요."}`
            : model.effective === "deterministic"
              ? "현재는 결정론적 연구 기준선입니다. 실제 AI가 연결된 것처럼 간주하지 않습니다."
              : "Codex CLI를 쓰려면 서버 환경에서 CODEX_CLI_ENABLED=true와 codex login을 설정하고, 이 프로젝트의 모델 연결 방식을 Codex CLI 또는 자동 선택으로 지정하세요."}
        </InlineNotice>

        <div className="button-row"><Button variant="subtle" size="small" onClick={() => navigate(projectPath(projectId))}>개요로 돌아가기</Button></div>
      </div>
    </div>
  );
}
