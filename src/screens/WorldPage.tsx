import { allWorldSources, getProject, getProjectContexts, getProjectObservations, getResourceLedger, getRun, getWorldSnapshot, modelProviderLabel } from "../runtime";
import { useApp } from "../store";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader, cn } from "../components/ui";
import { formatDate } from "../format";

export function WorldPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const snapshot = getWorldSnapshot(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !snapshot || !run) return <div className="screen"><Card className="empty-state"><h1>World를 표시할 수 없습니다.</h1></Card></div>;
  const sources = allWorldSources(snapshot);
  const observations = getProjectObservations(state, projectId);
  const latestObservationBySource = new Map(observations.map((observation) => [observation.source, observation]));
  const context = getProjectContexts(state, projectId)[0];
  const ledger = getResourceLedger(state, projectId);

  return (
    <div className="screen">
      <PageHeading title="Current World" description="요약을 진실로 두지 않고, 필요한 순간 실제 source를 다시 관찰합니다." actions={<Button variant="primary" size="small" onClick={() => dispatch({ type: "REFRESH_WORLD", projectId })}>직접 관찰 새로고침</Button>} />
      <div className="screen-stack">
        <Card className="world-snapshot-banner">
          <div><Pill tone="purple">SNAPSHOT · {snapshot.cursorEventId}</Pill><h2>{snapshot.summary}</h2><p className="muted-copy">Last observed {formatDate(snapshot.observedAt)} · snapshot은 실제 environment 관찰과 event provenance에 연결됩니다.</p></div>
          <div className="snapshot-stat"><strong>{sources.filter((source) => source.status === "healthy").length}/{sources.length}</strong><span>sources healthy</span></div>
        </Card>
        <div className="world-source-grid">
          {sources.map((source) => <Card key={source.key} className={cn("world-source-card", `source-${source.status}`)}>
            <div className="source-card-head"><h2>{source.label}</h2><Pill tone={source.status === "healthy" ? "mint" : source.key === "human" ? "pink" : "yellow"}>{source.status}</Pill></div>
            <p className="source-summary">{source.summary}</p>
            <dl className="source-details"><div><dt>freshness</dt><dd>{source.freshness}</dd></div><div><dt>trust</dt><dd>{source.trustLevel}</dd></div><div><dt>observed</dt><dd>{formatDate(source.observedAt)}</dd></div></dl>
            <p className="source-raw-ref">raw · {latestObservationBySource.get(source.key)?.rawRef ?? "not captured"}</p>
            <p className="source-refs">refs · {source.relatedEntities.length ? source.relatedEntities.join(" · ") : "none"}</p>
          </Card>)}
        </div>
        <div className="split-grid world-contract-grid">
          <Card>
            <SectionHeader title="Observation Adapter" />
            <p className="muted-copy">각 세계를 모델이 읽을 수 있는 관찰로 변환합니다.</p>
            <ul className="contract-list"><li><strong>rawRef</strong><span>source-linked 원본 보존</span></li><li><strong>observedAt</strong><span>freshness를 판단할 기준</span></li><li><strong>trustLevel</strong><span>untrusted 결과는 authority가 아님</span></li><li><strong>relatedEntities</strong><span>event · evidence · artifact 연결</span></li></ul>
          </Card>
          <Card>
            <SectionHeader title="Runtime Boundary" />
            <div className="boundary-list"><div><span>Model provider</span><Pill tone="blue">{modelProviderLabel(state, project)}</Pill></div><div><span>Sandbox mode</span><Pill tone={project.settings.sandboxMode === "docker" ? "mint" : "yellow"}>{project.settings.sandboxMode ?? "process"}</Pill></div><div><span>Workspace</span><Pill tone={project.settings.workspacePath ? "mint" : "yellow"}>{project.settings.workspacePath ? "bound" : "browser-only"}</Pill></div><div><span>Network</span><Pill tone="yellow">{project.settings.networkPolicy}</Pill></div><div><span>Production</span><Pill tone="red">{project.settings.productionBlocked ? "hard-blocked" : "approval"}</Pill></div><div><span>Secrets</span><Pill tone="neutral">env redacted</Pill></div></div>
          </Card>
        </div>
        <Card className="world-runtime-card">
          <SectionHeader title="Live Runtime Contract" />
          <div className="contract-columns runtime-contract-columns">
            <div><strong>Observations</strong><span>{observations.length} source observations · latest rawRef linked</span></div>
            <div><strong>Context</strong><span>{context ? `${context.id} · ${context.observationRefs.length} refs · ${context.toolSurface.filter((tool) => tool.enabled).length} tools enabled` : "아직 context가 assembled되지 않음"}</span></div>
            <div><strong>Resource Ledger</strong><span>{ledger ? `${ledger.tokens.toLocaleString()} tokens · ${ledger.toolCalls} tool calls · ${ledger.wallTimeMs}ms` : "아직 사용량이 기록되지 않음"}</span></div>
            <div><strong>Autonomy</strong><span>{run.consecutiveFailures} consecutive failures · {run.noProgressCycles} no-progress cycles</span></div>
          </div>
        </Card>
        <details className="runtime-controls">
          <summary>Advanced runtime controls</summary>
          <div className="runtime-controls-body">
            <div><strong>{project.status}</strong><span>수동 제어는 현재 run의 lease와 boundary를 그대로 따릅니다.</span></div>
            <div className="button-row">
              <Button size="small" variant="primary" onClick={() => dispatch({ type: "RUN_CYCLE", projectId })} disabled={project.status !== "ACTIVE" && project.status !== "WAITING"}>한 cycle 실행</Button>
              <Button size="small" variant="neutral" onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })} disabled={project.status === "KILLED" || project.status === "ACTIVE"}>Wake</Button>
              <Button size="small" variant="subtle" onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })} disabled={project.status !== "ACTIVE"}>Pause</Button>
              <Button size="small" variant="neutral" onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })} disabled={project.status !== "PAUSED" && project.status !== "STALLED"}>Resume</Button>
              <Button size="small" variant="danger" onClick={() => { if (globalThis.confirm?.("현재 run을 종료할까요?")) dispatch({ type: "KILL_PROJECT", projectId }); }} disabled={project.status === "KILLED"}>Kill</Button>
            </div>
          </div>
        </details>
        <InlineNotice tone="purple" title="World Snapshot">캐시·색인은 context를 구성하는 보조 수단입니다. 모델의 요약이 실제 상태보다 우선하지 않습니다.</InlineNotice>
      </div>
    </div>
  );
}
