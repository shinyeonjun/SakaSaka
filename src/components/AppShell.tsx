import { useEffect, useMemo, useRef, useState, type FormEvent, type PropsWithChildren } from "react";
import { latestControlPlane, missionHistory, openHumanItems } from "../controlPlaneView";
import { activeAutonomyMissions, unresolvedAutonomyGaps } from "../autonomyProjection";
import { useAutonomyProjection } from "../useAutonomyProjection";
import { getProject, statusLabel } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import { cn, InlineNotice } from "./ui";
import { confirmDestructiveAction, getDesktopDecisionSettings, isDesktopApp } from "../desktop";

const projectNav = [
  { key: "overview", label: "제어 센터" },
  { key: "missions", label: "미션" },
  { key: "coverage", label: "탐색 범위 & 갭" },
  { key: "needs-you", label: "사람 개입" },
  { key: "evidence", label: "근거" },
  { key: "activity", label: "활동" },
] as const;

type NavKey = (typeof projectNav)[number]["key"];

function selectedNav(key: NavKey, kind: string): boolean {
  if (key === "overview") return kind === "overview";
  if (key === "needs-you") return kind === "needs-you" || kind === "human-item";
  if (key === "evidence") return kind === "evidence" || kind === "world";
  return kind === key;
}

function routeFor(projectId: string, key: NavKey): string {
  return key === "overview" ? projectPath(projectId) : `${projectPath(projectId)}/${key}`;
}

export function AppShell({ children }: PropsWithChildren) {
  const { state, dispatch, syncError, pendingCommands } = useApp();
  const { route, navigate } = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [query, setQuery] = useState("");
  const [decisionProvider, setDecisionProvider] = useState("Codex");
  const searchRef = useRef<HTMLInputElement>(null);
  const projectId = "projectId" in route ? route.projectId : state.activeProjectId;
  const project = getProject(state, projectId);
  const autonomy = useAutonomyProjection(projectId, state.revision, Boolean(project));
  const control = projectId ? latestControlPlane(state, projectId) : undefined;
  const legacyMissions = projectId ? missionHistory(state, projectId) : [];
  const liveMissions = activeAutonomyMissions(autonomy);
  const liveGaps = unresolvedAutonomyGaps(autonomy);
  const humanOpen = projectId ? openHumanItems(state, projectId).length : 0;
  const evidenceCount = projectId ? state.evidence.filter((item) => item.projectId === projectId).length : 0;
  const unresolvedGaps = autonomy?.available ? liveGaps.length : control ? control.counts.open + control.counts.investigating + control.counts.blocked + control.counts.unexplored : 0;
  const missionCount = autonomy?.available ? liveMissions.length : Math.max(legacyMissions.length, control?.mission ? 1 : 0);
  const recentProjects = useMemo(() => [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6), [state.projects]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isDesktopApp) return;
    void getDesktopDecisionSettings().then((settings) => {
      if (!settings) return;
      setDecisionProvider(settings.provider === "jev" ? "Jev" : settings.provider === "hybrid" ? "Hybrid" : "Codex");
    }).catch(() => undefined);
  }, [route.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (path: string) => { navigate(path); setMobileOpen(false); setQuery(""); };
  const removeRecentProject = async (projectId: string, projectName: string) => {
    const confirmed = await confirmDestructiveAction(`${projectName} 프로젝트를 삭제할까요?\n프로젝트 기록만 삭제되고 작업 폴더의 파일은 보존됩니다.`, "프로젝트 삭제");
    if (!confirmed) return;
    dispatch({ type: "DELETE_PROJECT", projectId });
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim().toLowerCase();
    if (!q) return;
    if (/새|new|project/.test(q)) return go("/projects/new");
    if (/설정|setting|jev|codex/.test(q)) return go("/settings");
    if (!projectId) return;
    if (/미션|mission/.test(q)) return go(`${projectPath(projectId)}/missions`);
    if (/갭|gap|탐색|coverage/.test(q)) return go(`${projectPath(projectId)}/coverage`);
    if (/사람|human|질문|승인/.test(q)) return go(`${projectPath(projectId)}/needs-you`);
    if (/근거|evidence|월드|world/.test(q)) return go(`${projectPath(projectId)}/evidence`);
    if (/활동|activity/.test(q)) return go(`${projectPath(projectId)}/activity`);
    go(projectPath(projectId));
  };

  const navCounts: Partial<Record<NavKey, number>> = {
    missions: missionCount, coverage: unresolvedGaps, "needs-you": humanOpen, evidence: evidenceCount,
  };
  const isGlobalNew = route.kind === "new";
  const topProjectName = project?.name ?? (isGlobalNew ? "새 프로젝트" : "SakaSaka");

  return <div className={cn("app-frame app-frame-v3", isDesktopApp && "desktop-shell")}>
    <header className="ss-toolbar">
      <button className="ss-toolbar-brand" onClick={() => projectId ? go(projectPath(projectId)) : go("/projects/new")}><strong>SakaSaka</strong><span>{project ? project.name : "Autonomous Dev OS"}</span></button>
      <form className="ss-command-search" onSubmit={onSearch}><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="명령, 프로젝트, 근거 검색" aria-label="명령, 프로젝트, 근거 검색" /><kbd>Ctrl K</kbd></form>
      <div className="ss-toolbar-right"><span className="ss-online"><i />{project?.status === "ACTIVE" ? "Worker 연결됨" : statusLabel(project?.status ?? "ACTIVE")}</span>{project && <span>${project.budgetSpent.toFixed(2)} · 무제한</span>}<time>{clock.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div>
      <button className="mobile-menu-button" onClick={() => setMobileOpen((open) => !open)} aria-label="메뉴 열기">{mobileOpen ? "×" : "☰"}</button>
    </header>

    <div className="ss-body">
      <aside className={cn("ss-sidebar", mobileOpen && "sidebar-open")}>
        {isGlobalNew ? <>
          <div className="ss-global-brand"><strong>SAKASAKA</strong><span>자율 개발 OS</span></div>
          <button className="ss-nav-item active" onClick={() => go("/projects/new")}><i /><span>새 프로젝트</span></button>
          <span className="ss-section-label">최근 프로젝트</span>
          <div className="ss-recent-projects">{recentProjects.map((item) => <div className="ss-recent-project-row" key={item.id}><button className="ss-recent-project-open" onClick={() => go(projectPath(item.id))}><span><strong>{item.name}</strong><i className={`project-status-dot status-${item.status.toLowerCase()}`} /></span><small>{statusLabel(item.status)}</small></button><button className="ss-recent-project-delete" aria-label={`${item.name} 프로젝트 삭제`} title="프로젝트 삭제" onClick={(event) => { event.stopPropagation(); void removeRecentProject(item.id, item.name); }}>삭제</button></div>)}</div>
        </> : <>
          <button className="ss-project-switcher" onClick={() => go("/projects/new")}><small>현재 프로젝트</small><strong>{topProjectName}</strong></button>
          <span className="ss-section-label">작업 공간</span>
          <nav className="ss-nav-list">{projectId && projectNav.map((item) => <button key={item.key} className={cn("ss-nav-item", selectedNav(item.key, route.kind) && "active")} onClick={() => go(routeFor(projectId, item.key))}><i className={item.key === "overview" ? "primary" : ""} /><span>{item.label}</span>{navCounts[item.key] !== undefined && <em>{navCounts[item.key]}</em>}</button>)}</nav>
        </>}
        <div className="ss-sidebar-spacer" />
        <span className="ss-section-label">시스템</span>
        {!isGlobalNew && projectId && <button className={cn("ss-nav-item", route.kind === "experiments" && "active")} onClick={() => go(`${projectPath(projectId)}/experiments`)}><i /><span>실험</span></button>}
        <button className={cn("ss-nav-item", route.kind === "global-settings" && "active")} onClick={() => go("/settings")}><i /><span>설정</span></button>
        <div className="ss-runtime-foot">{isGlobalNew ? <span className="text-success">Codex CLI {isDesktopApp ? "desktop" : "browser"}</span> : <><span>Codex CLI · {project?.settings.executionMode ?? "native"}</span><span>판단 · {decisionProvider}</span></>}</div>
      </aside>

      <main className="ss-content">
        {(syncError || pendingCommands > 0) && <div className="global-notice-stack">{syncError && <InlineNotice tone="red" title="서버 동기화 실패">{syncError}</InlineNotice>}{pendingCommands > 0 && <InlineNotice tone="blue" title="서버 확인 중">{pendingCommands}개 명령을 처리하고 있습니다.</InlineNotice>}</div>}
        {children}
      </main>
    </div>
  </div>;
}
