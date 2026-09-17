import { useEffect, useState } from "react";
import { fetchAutonomyProjection, isControlPlaneEnabled } from "./apiClient";
import type { AutonomyProjectProjection } from "./autonomyProjection";

export function useAutonomyProjection(projectId: string, revision: number | undefined): AutonomyProjectProjection | undefined {
  const [projection, setProjection] = useState<AutonomyProjectProjection>();

  useEffect(() => {
    if (!isControlPlaneEnabled || !projectId) {
      setProjection(undefined);
      return;
    }
    let cancelled = false;
    void fetchAutonomyProjection(projectId)
      .then((next) => { if (!cancelled) setProjection(next); })
      .catch(() => { if (!cancelled) setProjection(undefined); });
    return () => { cancelled = true; };
  }, [projectId, revision]);

  return projection;
}
