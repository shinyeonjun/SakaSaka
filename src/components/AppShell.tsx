import { useState, type PropsWithChildren } from "react";
import { getProject, statusLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, cn, Divider, InlineNotice } from "./ui";
import { isDesktopApp } from "../desktop";

const navItems = [
  { key: "overview", label: "개요" },
  { key: "needs-you", label: "도움 필요" },
  { key: "activity", label: "활동" },
  { key: "world", label: "월드" },
  { key: "artifacts", label: "산출물" },
  { key: "experiments", label: "실험" },
  { key: "settings", label: "설정" },
  { key: "global-settings", label: "환경 설정" },
] as const;

type NavKey = (typeof navItems)[number]["key"];

function selectedNav(key: NavKey, kind: string): boolean {
  if (key === "overview") return kind === "overview" || kind === "new";
  if (key === "needs-you") return kind === "needs-you" || kind === "human-item";
  if (key === "global-settings") return kind === "global-settings";
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

  const go = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  return (
    <div className={cn("app-frame", isDesktopApp && "desktop-shell")}>
      <div className="mobile-bar">
        <button className="mobile-brand" onClick={() => go("/projects/new")} aria-label="새 프로젝트로 이동">INTENT WORLD</button>
        <button className="mobile-menu-button" onClick={() => setMobileOpen((open) => !open)} aria-expanded={mobileOpen} aria-label="메뉴 열기">{mobileOpen ? "×" : "☰"}</button>
      </div>
      <aside className={cn("sidebar", mobileOpen && "sidebar-open")} aria-label="주요 탐색">
        <button className="brand-block" onClick={() => go("/projects/new")}>
          <span className="brand-title">INTENT WORLD</span>
          <span className="brand-subtitle">지속형 AI 개발 스튜디오</span>
        </button>
        <Divider />
        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const path = item.key === "global-settings" ? "/settings" : !projectId ? "/projects/new" : item.key === "overview" ? projectPath(projectId) : `${projectPath(projectId)}/${item.key}`;
            const isActive = selectedNav(item.key, route.kind);
            const disabled = !projectId && item.key !== "overview" && item.key !== "global-settings";
            return <button key={item.key} className={cn("nav-item", isActive && "nav-item-active")} onClick={() => go(path)} disabled={disabled} aria-current={isActive ? "page" : undefined}>{item.label}</button>;
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-system-links">
          <span className="sidebar-overline">시스템 계약</span>
          <button className={cn("sidebar-quiet-link", route.kind === "handoff-routes" && "sidebar-quiet-link-active")} onClick={() => go("/handoff/routes")}>경로와 구성요소</button>
          <button className={cn("sidebar-quiet-link", route.kind === "handoff-runtime" && "sidebar-quiet-link-active")} onClick={() => go("/handoff/runtime")}>런타임 상태</button>
        </div>
        <div className="sidebar-footer" aria-label="런타임 리소스">
          {isDesktopApp && <span>데스크톱&nbsp; 로컬 API 연결</span>}
          <span>예산&nbsp; {`$${budgetSpent.toFixed(2)} / $${budgetLimit}`}</span>
          <span>런타임&nbsp; {statusLabel(runtimeStatus)}</span>
        </div>
      </aside>
      <main className="main-content">
        {syncError && <InlineNotice tone="red" title="서버 동기화 실패">{syncError} 서버에 반영되었다고 간주하지 마십시오.</InlineNotice>}
        {pendingCommands > 0 && <InlineNotice tone="blue" title="서버 확인 중">{pendingCommands}개 명령의 처리 결과를 기다리고 있습니다.</InlineNotice>}
        {children}
      </main>
    </div>
  );
}
