import { useCallback, useEffect, useState } from "react";

export type RouteMatch =
  | { kind: "new" }
  | { kind: "overview"; projectId: string }
  | { kind: "needs-you"; projectId: string }
  | { kind: "human-item"; projectId: string; itemId: string }
  | { kind: "activity"; projectId: string }
  | { kind: "world"; projectId: string }
  | { kind: "artifacts"; projectId: string }
  | { kind: "experiments"; projectId: string }
  | { kind: "settings"; projectId: string }
  | { kind: "handoff-routes" }
  | { kind: "handoff-runtime" }
  | { kind: "not-found" };

export function matchRoute(pathname: string): RouteMatch {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "new" };
  if (parts[0] === "handoff" && parts[1] === "routes") return { kind: "handoff-routes" };
  if (parts[0] === "handoff" && parts[1] === "runtime") return { kind: "handoff-runtime" };
  if (parts[0] === "projects" && parts[1] === "new") return { kind: "new" };
  if (parts[0] !== "projects" || !parts[1]) return { kind: "not-found" };
  const projectId = decodeURIComponent(parts[1]);
  if (parts.length === 2) return { kind: "overview", projectId };
  if (parts[2] === "needs-you" && parts.length === 3) return { kind: "needs-you", projectId };
  if (parts[2] === "human-items" && parts[3]) return { kind: "human-item", projectId, itemId: decodeURIComponent(parts[3]) };
  if (parts[2] === "activity" && parts.length === 3) return { kind: "activity", projectId };
  if (parts[2] === "world" && parts.length === 3) return { kind: "world", projectId };
  if (parts[2] === "artifacts" && parts.length === 3) return { kind: "artifacts", projectId };
  if (parts[2] === "experiments" && parts.length === 3) return { kind: "experiments", projectId };
  if (parts[2] === "settings" && parts.length === 3) return { kind: "settings", projectId };
  return { kind: "not-found" };
}

export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function useRouter() {
  const [pathname, setPathname] = useState(() => (typeof window === "undefined" ? "/projects/new" : window.location.pathname || "/projects/new"));

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname || "/projects/new");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (typeof window === "undefined") return;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    setPathname(nextPath);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const back = useCallback(() => {
    if (typeof window !== "undefined") window.history.back();
  }, []);

  return { pathname, navigate, back, route: matchRoute(pathname) };
}
