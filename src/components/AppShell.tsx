import { useState, type PropsWithChildren } from "react";
import { getProject } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { Button, cn, Divider } from "./ui";

const navItems = [
  { key: "overview", label: "Overview" },
  { key: "needs-you", label: "Needs You" },
  { key: "activity", label: "Activity" },
  { key: "world", label: "World" },
  { key: "artifacts", label: "Artifacts" },
  { key: "experiments", label: "Experiments" },
] as const;

type NavKey = (typeof navItems)[number]["key"];

function selectedNav(key: NavKey, kind: string): boolean {
  if (key === "overview") return kind === "overview" || kind === "new";
  if (key === "needs-you") return kind === "needs-you" || kind === "human-item";
  return kind === key;
}

export function AppShell({ children }: PropsWithChildren) {
  const { state } = useApp();
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
    <div className="app-frame">
      <div className="mobile-bar">
        <button className="mobile-brand" onClick={() => go("/projects/new")} aria-label="새 프로젝트로 이동">INTENT WORLD</button>
        <button className="mobile-menu-button" onClick={() => setMobileOpen((open) => !open)} aria-expanded={mobileOpen} aria-label="메뉴 열기">{mobileOpen ? "×" : "☰"}</button>
      </div>
      <aside className={cn("sidebar", mobileOpen && "sidebar-open")} aria-label="주요 탐색">
        <button className="brand-block" onClick={() => go("/projects/new")}>
          <span className="brand-title">INTENT WORLD</span>
          <span className="brand-subtitle">Persistent AI Studio</span>
        </button>
        <Divider />
        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const path = item.key === "overview" ? projectPath(projectId) : `${projectPath(projectId)}/${item.key}`;
            const isActive = selectedNav(item.key, route.kind);
            return <button key={item.key} className={cn("nav-item", isActive && "nav-item-active")} onClick={() => go(path)} aria-current={isActive ? "page" : undefined}>{item.label}</button>;
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-system-links">
          <span className="sidebar-overline">SYSTEM CONTRACTS</span>
          <button className={cn("sidebar-quiet-link", route.kind === "handoff-routes" && "sidebar-quiet-link-active")} onClick={() => go("/handoff/routes")}>Routes & Components</button>
          <button className={cn("sidebar-quiet-link", route.kind === "handoff-runtime" && "sidebar-quiet-link-active")} onClick={() => go("/handoff/runtime")}>Runtime states</button>
        </div>
        <div className="sidebar-footer" aria-label="런타임 리소스">
          <span>Budget&nbsp; {`$${budgetSpent.toFixed(2)} / $${budgetLimit}`}</span>
          <span>Runtime&nbsp; {runtimeStatus}</span>
        </div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  );
}
