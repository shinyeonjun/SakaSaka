import { useMemo, useState, type PropsWithChildren } from "react";
import { getHumanCounts, getProject, statusLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { cn, InlineNotice } from "./ui";
import { isDesktopApp } from "../desktop";

const projectNav = [
  { key: "overview", label: "제어 센터", symbol: "◆" },
  { key: "needs-you", label: "사람 개입", symbol: "●" },
  { key: "activity", label: "활동", symbol: "■" },
  { key: "world", label: "월드", symbol: "◈" },
  { key: "artifacts", label: "산출물", symbol: "▰" },
  { key: "experiments", label: "실험", symbol: "◇" },
  { key: "settings", label: "프로젝트 설정", symbol: "⚙" },
] as const;

type NavKey = (typeof projectNav)[number]["key"];

function selectedNav(key: NavKey, kind: string): boolean {
  if (key === "overview") return kind === "overview" || kind === "new";
  if (key === "needs-you") return kind === "needs-you" || kind === "human-item";
  return kind === key;
}

export function AppShell({ children }: PropsWithChildren) {
  const { state, syncError, pendingCommands } = useApp();
  const { route, navigate } = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const projectId = "projectId" in route ? route.projectId : state.activeProjectId;
  const project = getProject(state, projectId);
  const budgetLimit = project?.settings.budgetLimit ?? 30;
  const budgetSpent = project?.budgetSpent ?? 0;
  const runtimeStatus = project?.status ?? "ACTIVE";
  const counts = projectId ? getHumanCounts(state, projectId) : undefined;
  const humanOpen = counts ? counts.QUESTION + counts.IDEA + counts.CONCERN + counts.APPROVAL : 0;
  const evidenceCount = projectId ? state.evidence.filter((item) => item.projectId === projectId).length : 0;

  const projectLinks = useMemo(() => projectNav.map((item) => ({
    ...item,
    badge: item.key === "needs-you" && humanOpen > 0 ? humanOpen : item.key === "world" && evidenceCount > 0 ? evidenceCount : undefined,
  })), [evidenceCount, humanOpen]);

  const go = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  const projectName = project?.name ?? "새 프로젝트";
  const subtitle = project?.subtitle ?? "Intent에서 시작하는 자율 개발";

  return (
    <div className={cn("app-frame app-frame-v2", isDesktopApp && "desktop-shell")}>
      <header className="desktop-topbar">
        <button className="desktop-brand" onClick={() => go("/projects/new")} aria-label="새 프로젝트 시작">
          <strong>SakaSaka</strong>
          <span>{project ? projectName : "Autonomous Dev OS"}</span>
        </button>
        <div className="desktop-topbar-context" aria-label="현재 프로젝트">
          <span className="desktop-context-label">{project ? projectName : "준비"}</span>
          <span className="desktop-context-detail">{project ? subtitle : "원하는 결과만 말하면 나머지는 시스템이 이어갑니다."}</span>
        </div>
        <div className="desktop-topbar-status">
          <span className={cn("runtime-dot", `runtime-dot-${runtimeStatus.toLowerCase()}`)} />
          <span>{statusLabel(runtimeStatus)}</span>
          {project && <span className="topbar-budget">${budgetSpent.toFixed(2)} / ${budgetLimit}</span>}
          {pendingCommands > 0 && <span className="topbar-pending">동기화 {pendingCommands}</span>}
        </div>
        <button className="mobile-menu-button" onClick={() => setMobileOpen((open) => !open)} aria-expanded={mobileOpen} aria-label="메뉴 열기">{mobileOpen ? "×" : "☰"}</button>
      </header>

      <div className="desktop-body">
        <aside className={cn("sidebar sidebar-v2", mobileOpen && "sidebar-open")} aria-label="주요 탐색">
          <div className="sidebar-project-card">
            <span className="sidebar-overline">현재 프로젝트</span>
            <strong>{projectName}</strong>
            <span>{project ? statusLabel(runtimeStatus) : "새 Intent 준비"}</span>
          </div>

          <span className="sidebar-section-label">작업 공간</span>
          <nav className="sidebar-nav sidebar-nav-v2">
            {projectLinks.map((item) => {
              const path = !projectId ? "/projects/new" : item.key === "overview" ? projectPath(projectId) : `${projectPath(projectId)}/${item.key}`;
              const active = selectedNav(item.key, route.kind);
              const disabled = !projectId && item.key !== "overview";
              return (
                <button key={item.key} className={cn("nav-item nav-item-v2", active && "nav-item-active")} onClick={() => go(path)} disabled={disabled} aria-current={active ? "page" : undefined}>
                  <span className="nav-symbol" aria-hidden="true">{item.symbol}</span>
                  <span className="nav-label">{item.label}</span>
                  {item.badge !== undefined && <span className="nav-count">{item.badge}</span>}
                </button>
              );
            })}
          </nav>

          <div className="sidebar-spacer" />
          <span className="sidebar-section-label">시스템</span>
          <nav className="sidebar-nav sidebar-nav-v2">
            <button className={cn("nav-item nav-item-v2", route.kind === "global-settings" && "nav-item-active")} onClick={() => go("/settings")}>
              <span className="nav-symbol" aria-hidden="true">⚙</span><span className="nav-label">환경 설정</span>
            </button>
            <button className="nav-item nav-item-v2" onClick={() => go("/projects/new")}>
              <span className="nav-symbol" aria-hidden="true">＋</span><span className="nav-label">새 프로젝트</span>
            </button>
          </nav>
          <div className="sidebar-runtime-foot">
            <span>{isDesktopApp ? "데스크톱 · 로컬 제어면" : "브라우저 모드"}</span>
            <span>판단 · {project?.settings.modelProvider === "codex-cli" ? "Codex" : project?.settings.modelProvider ?? "기본"}</span>
          </div>
        </aside>

        <main className="main-content main-content-v2">
          {(syncError || pendingCommands > 0) && <div className="global-notice-stack">
            {syncError && <InlineNotice tone="red" title="서버 동기화 실패">{syncError} 서버에 반영되었다고 간주하지 마십시오.</InlineNotice>}
            {pendingCommands > 0 && <InlineNotice tone="blue" title="서버 확인 중">{pendingCommands}개 명령의 처리 결과를 기다리고 있습니다.</InlineNotice>}
          </div>}
          {children}
        </main>
      </div>
    </div>
  );
}
