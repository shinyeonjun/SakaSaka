import { allWorldSources, getProject, getProjectContexts, getProjectObservations, getResourceLedger, getRun, getWorldSnapshot, modelProviderLabel } from "../runtime";
import { useApp } from "../store";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader, cn } from "../components/ui";
import { formatDate, freshnessLabel, trustLevelLabel, worldStatusLabel } from "../format";
import { statusLabel } from "../runtime";

export function WorldPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const snapshot = getWorldSnapshot(state, projectId);
  const run = getRun(state, projectId);
  if (!project || !snapshot || !run) return <div className="screen"><Card className="empty-state"><h1>월드를 표시할 수 없습니다.</h1></Card></div>;
  const sources = allWorldSources(snapshot);
  const observations = getProjectObservations(state, projectId);
  const latestObservationBySource = new Map(observations.map((observation) => [observation.source, observation]));
  const context = getProjectContexts(state, projectId)[0];
  const ledger = getResourceLedger(state, projectId);

  return (
    <div className="screen">
      <PageHeading title="현재 월드" description="요약을 진실로 두지 않고, 필요한 순간 실제 원본을 다시 관찰합니다." actions={<Button variant="primary" size="small" onClick={() => dispatch({ type: "REFRESH_WORLD", projectId })}>직접 관찰 새로고침</Button>} />
      <div className="screen-stack">
        <Card className="world-snapshot-banner">
          <div><Pill tone="purple">스냅샷 · {snapshot.cursorEventId}</Pill><h2>{snapshot.summary}</h2><p className="muted-copy">마지막 관찰 {formatDate(snapshot.observedAt)} · 스냅샷은 실제 환경 관찰과 이벤트 provenance에 연결됩니다.</p></div>
          <div className="snapshot-stat"><strong>{sources.filter((source) => source.status === "healthy").length}/{sources.length}</strong><span>정상 원본</span></div>
        </Card>
        <div className="world-source-grid">
          {sources.map((source) => <Card key={source.key} className={cn("world-source-card", `source-${source.status}`)}>
            <div className="source-card-head"><h2>{source.label}</h2><Pill tone={source.status === "healthy" ? "mint" : source.key === "human" ? "pink" : "yellow"}>{worldStatusLabel(source.status)}</Pill></div>
            <p className="source-summary">{source.summary}</p>
            <dl className="source-details"><div><dt>신선도</dt><dd>{freshnessLabel(source.freshness)}</dd></div><div><dt>신뢰도</dt><dd>{trustLevelLabel(source.trustLevel)}</dd></div><div><dt>관찰 시각</dt><dd>{formatDate(source.observedAt)}</dd></div></dl>
            <p className="source-raw-ref">원본 · {latestObservationBySource.get(source.key)?.rawRef ?? "아직 수집되지 않음"}</p>
            <p className="source-refs">연결 · {source.relatedEntities.length ? source.relatedEntities.join(" · ") : "없음"}</p>
          </Card>)}
        </div>
        <div className="split-grid world-contract-grid">
          <Card>
            <SectionHeader title="관찰 어댑터" />
            <p className="muted-copy">각 세계를 모델이 읽을 수 있는 관찰로 변환합니다.</p>
            <ul className="contract-list"><li><strong>rawRef</strong><span>source-linked 원본 보존</span></li><li><strong>observedAt</strong><span>freshness를 판단할 기준</span></li><li><strong>trustLevel</strong><span>untrusted 결과는 authority가 아님</span></li><li><strong>relatedEntities</strong><span>event · evidence · artifact 연결</span></li></ul>
          </Card>
          <Card>
            <SectionHeader title="런타임 경계" />
            <div className="boundary-list"><div><span>모델 연결</span><Pill tone="blue">{modelProviderLabel(state, project)}</Pill></div><div><span>샌드박스 모드</span><Pill tone={project.settings.sandboxMode === "docker" ? "mint" : "yellow"}>{project.settings.sandboxMode === "docker" ? "Docker" : "프로세스"}</Pill></div><div><span>작업공간</span><Pill tone={project.settings.workspacePath ? "mint" : "yellow"}>{project.settings.workspacePath ? "연결됨" : "브라우저 전용"}</Pill></div><div><span>네트워크</span><Pill tone="yellow">{project.settings.networkPolicy === "allowlist" ? "허용 목록" : "차단"}</Pill></div><div><span>운영 환경</span><Pill tone="red">{project.settings.productionBlocked ? "강제 차단" : "승인 필요"}</Pill></div><div><span>비밀값</span><Pill tone="neutral">환경값 가림</Pill></div></div>
          </Card>
        </div>
        <Card className="world-runtime-card">
          <SectionHeader title="실시간 런타임 계약" />
          <div className="contract-columns runtime-contract-columns">
            <div><strong>관찰</strong><span>{observations.length}개 원본 관찰 · 최신 rawRef 연결됨</span></div>
            <div><strong>컨텍스트</strong><span>{context ? `${context.id} · 연결 ${context.observationRefs.length}개 · 활성 도구 ${context.toolSurface.filter((tool) => tool.enabled).length}개` : "아직 컨텍스트가 구성되지 않음"}</span></div>
            <div><strong>자원 장부</strong><span>{ledger ? `${ledger.tokens.toLocaleString()} 토큰 · 도구 호출 ${ledger.toolCalls}회 · ${ledger.wallTimeMs}ms` : "아직 사용량이 기록되지 않음"}</span></div>
            <div><strong>자율성</strong><span>연속 실패 {run.consecutiveFailures}회 · 진전 없음 {run.noProgressCycles}주기</span></div>
          </div>
        </Card>
        <details className="runtime-controls">
          <summary>고급 런타임 제어</summary>
          <div className="runtime-controls-body">
            <div><strong>{statusLabel(project.status)} <small>{project.status}</small></strong><span>수동 제어는 현재 실행의 lease와 경계를 그대로 따릅니다.</span></div>
            <div className="button-row">
              <Button size="small" variant="primary" onClick={() => dispatch({ type: "RUN_CYCLE", projectId })} disabled={project.status !== "ACTIVE" && project.status !== "WAITING"}>한 cycle 실행</Button>
              <Button size="small" variant="neutral" onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })} disabled={project.status === "KILLED" || project.status === "ACTIVE"}>깨우기</Button>
              <Button size="small" variant="subtle" onClick={() => dispatch({ type: "PAUSE_PROJECT", projectId })} disabled={project.status !== "ACTIVE"}>일시 정지</Button>
              <Button size="small" variant="neutral" onClick={() => dispatch({ type: "RESUME_PROJECT", projectId })} disabled={project.status !== "PAUSED" && project.status !== "STALLED"}>재개</Button>
              <Button size="small" variant="danger" onClick={() => { if (globalThis.confirm?.("현재 실행을 종료할까요?")) dispatch({ type: "KILL_PROJECT", projectId }); }} disabled={project.status === "KILLED"}>종료</Button>
            </div>
          </div>
        </details>
        <InlineNotice tone="purple" title="월드 스냅샷">캐시·색인은 컨텍스트를 구성하는 보조 수단입니다. 모델의 요약이 실제 상태보다 우선하지 않습니다.</InlineNotice>
      </div>
    </div>
  );
}
