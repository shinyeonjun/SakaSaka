import { useEffect, useRef, useState } from "react";
import { ApiClientError, fetchAutonomyProjection, isControlPlaneEnabled } from "./apiClient";
import type { AutonomyProjectProjection } from "./autonomyProjection";

export function shouldRequestAutonomyProjection(projectId: string, enabled: boolean, controlPlaneEnabled: boolean, missingProjectId?: string): boolean {
  return controlPlaneEnabled && enabled && projectId.length > 0 && missingProjectId !== projectId;
}

export function useAutonomyProjection(projectId: string, revision: number | undefined, enabled = true): AutonomyProjectProjection | undefined {
  const [projection, setProjection] = useState<AutonomyProjectProjection>();
  const missingProjectRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isControlPlaneEnabled || !projectId || !enabled) {
      missingProjectRef.current = undefined;
      setProjection(undefined);
      return;
    }
    if (!shouldRequestAutonomyProjection(projectId, enabled, isControlPlaneEnabled, missingProjectRef.current)) {
      setProjection(undefined);
      return;
    }
    let cancelled = false;
    void fetchAutonomyProjection(projectId)
      .then((next) => { if (!cancelled) setProjection(next); })
      .catch((error: unknown) => {
        // A stale URL or a project deleted in another window is not a retryable
        // autonomy failure. Stop issuing the same 404 on every state revision;
        // the project guard above will re-enable lookup if it becomes present.
        if (error instanceof ApiClientError && error.status === 404) missingProjectRef.current = projectId;
        if (!cancelled) setProjection(undefined);
      });
    return () => { cancelled = true; };
  }, [projectId, revision, enabled]);

  return projection;
}
