import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getDesktopCodexEnvironment,
  installDesktopCodexCli,
  isDesktopApp,
  logoutDesktopCodex,
  startDesktopCodexLogin,
  type DesktopCodexEnvironmentStatus,
} from "../desktop";
import { Button, InlineNotice, Pill } from "./ui";

function authMethodLabel(method: DesktopCodexEnvironmentStatus["authMethod"]): string {
  if (method === "chatgpt") return "ChatGPT";
  if (method === "api-key") return "API key";
  if (method === "agent-identity") return "Agent Identity";
  return "Codex 계정";
}

export function CodexSetupPanel({ compact = false, onReadyChange }: { compact?: boolean; onReadyChange?: (ready: boolean) => void }) {
  const [status, setStatus] = useState<DesktopCodexEnvironmentStatus>();
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const pollCount = useRef(0);

  const ready = Boolean(status?.installed && status.authState === "verified");
  const stateLabel = !status
    ? "확인 전"
    : !status.installed
      ? "설치 필요"
      : status.authState === "verified"
        ? "준비 완료"
        : status.authState === "missing"
          ? "로그인 필요"
          : "확인 필요";
  const stateTone = ready ? "mint" : status?.installed ? "yellow" : "orange";

  const refresh = useCallback(async (quiet = false) => {
    if (!isDesktopApp) return;
    if (!quiet) setLoading(true);
    setError(undefined);
    try {
      const next = await getDesktopCodexEnvironment();
      if (next) setStatus(next);
      return next;
    } catch (reason: unknown) {
      if (!quiet) setError(reason instanceof Error ? reason.message : "Codex 실행 환경을 확인하지 못했습니다.");
      return undefined;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onReadyChange?.(ready); }, [onReadyChange, ready]);

  useEffect(() => {
    if (!polling || !isDesktopApp) return;
    pollCount.current = 0;
    const timer = window.setInterval(() => {
      pollCount.current += 1;
      void refresh(true).then((next) => {
        if (next?.authState === "verified") {
          setPolling(false);
          setMessage("Codex 로그인이 확인되었습니다. 다음 실행부터는 저장된 인증을 자동으로 재사용합니다.");
        } else if (pollCount.current >= 60) {
          setPolling(false);
          setMessage("아직 로그인이 확인되지 않았습니다. 로그인 창을 완료한 뒤 ‘다시 확인’을 눌러 주세요.");
        }
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [polling, refresh]);

  const install = async () => {
    if (!isDesktopApp || loading) return;
    setLoading(true);
    setError(undefined);
    setMessage("공식 @openai/codex CLI를 설치하고 있습니다…");
    try {
      const next = await installDesktopCodexCli();
      setStatus(next);
      setMessage("Codex CLI 설치를 확인했습니다. 이제 ChatGPT 로그인을 한 번만 완료하면 됩니다.");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Codex CLI를 설치하지 못했습니다.");
      setMessage(undefined);
    } finally {
      setLoading(false);
    }
  };

  const login = async (method: "browser" | "device") => {
    if (!isDesktopApp || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await startDesktopCodexLogin(method);
      setStatus(next);
      setMessage(method === "device"
        ? "기기 코드 로그인 터미널을 열었습니다. 안내를 완료하면 이 화면이 자동으로 확인합니다."
        : "Codex 로그인 터미널을 열었습니다. 브라우저에서 ChatGPT 로그인을 완료해 주세요.");
      setPolling(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Codex 로그인 창을 열지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    if (!isDesktopApp || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await logoutDesktopCodex();
      setStatus(next);
      setMessage("Codex에서 로그아웃했습니다. 다시 사용할 때만 로그인하면 됩니다.");
      setPolling(false);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Codex 로그아웃에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const steps = useMemo(() => [
    { label: "CLI", done: Boolean(status?.installed) },
    { label: "로그인", done: ready },
    { label: "실행 준비", done: ready },
  ], [ready, status?.installed]);

  if (!isDesktopApp) {
    return (
      <div className="codex-setup-panel codex-setup-panel-browser">
        <div className="codex-setup-heading"><div><span className="eyebrow">Codex 실행 환경</span><h2>데스크톱 앱에서 자동 준비</h2></div><Pill tone="yellow">데스크톱 필요</Pill></div>
        <p className="muted-copy">브라우저 모드에서는 OS의 Codex CLI 설치·로그인을 직접 준비할 수 없습니다. 데스크톱 앱에서는 설치와 로그인 상태를 한 화면에서 처리합니다.</p>
      </div>
    );
  }

  return (
    <section className={`codex-setup-panel${compact ? " codex-setup-compact" : ""}`} aria-label="Codex 실행 환경 준비">
      <div className="codex-setup-heading">
        <div>
          <span className="eyebrow">Codex 실행 환경</span>
          <h2>{ready ? "바로 실행할 수 있습니다" : "처음 한 번만 준비하면 됩니다"}</h2>
          <p>{status?.detail ?? "Codex CLI 설치와 로그인 상태를 확인하고 있습니다."}</p>
        </div>
        <Pill tone={stateTone}>{loading ? "처리 중…" : polling ? "로그인 확인 중…" : stateLabel}</Pill>
      </div>

      <div className="codex-setup-steps" aria-label="Codex 준비 단계">
        {steps.map((step, index) => <div key={step.label} className={`codex-step ${step.done ? "codex-step-done" : ""}`}><span>{step.done ? "✓" : index + 1}</span><strong>{step.label}</strong></div>)}
      </div>

      {status && <dl className="codex-environment-facts">
        <div><dt>설치</dt><dd>{status.installed ? status.version ?? "설치됨" : "필요"}</dd></div>
        <div><dt>인증</dt><dd>{ready ? `${authMethodLabel(status.authMethod)} · 재사용` : "로그인 필요"}</dd></div>
        {!compact && <div><dt>Codex 홈</dt><dd><code>{status.codexHome}</code></dd></div>}
      </dl>}

      {error && <InlineNotice tone="red" title="Codex 준비 실패">{error}</InlineNotice>}
      {message && <InlineNotice tone={ready ? "mint" : "blue"}>{message}</InlineNotice>}

      <div className="codex-setup-actions">
        {!status?.installed && <Button variant="primary" size="small" onClick={() => void install()} disabled={loading}>Codex CLI 설치</Button>}
        {status?.installed && !ready && <Button variant="primary" size="small" onClick={() => void login("browser")} disabled={loading}>ChatGPT로 로그인</Button>}
        {status?.installed && !ready && <Button variant="neutral" size="small" onClick={() => void login("device")} disabled={loading}>기기 코드 로그인</Button>}
        <Button variant="subtle" size="small" onClick={() => void refresh()} disabled={loading}>다시 확인</Button>
        {ready && !compact && <Button variant="subtle" size="small" onClick={() => void logout()} disabled={loading}>Codex 로그아웃</Button>}
      </div>

      <p className="codex-credential-note">SakaSaka는 ChatGPT 비밀번호나 Codex 토큰을 저장하지 않습니다. 인증은 Codex CLI가 자체 저장소에서 관리하며 앱을 다시 켜도 그대로 사용됩니다.</p>
    </section>
  );
}
