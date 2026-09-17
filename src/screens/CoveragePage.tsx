import { useMemo, useState } from "react";
import { categoryLabel, categorySignal, coverageCategories, gapHistory, latestControlPlane, priorityBand, relativeAge, type ControlPlaneGapView } from "../controlPlaneView";
import { autonomyCounts, autonomyGapHistory, unresolvedAutonomyGaps } from "../autonomyProjection";
import { useAutonomyProjection } from "../useAutonomyProjection";
import { getProject } from "../runtime";
import { useApp } from "../store";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

const filters = ["전체 영역", "열린 갭", "미탐색", "검증 완료", "최근 발견"] as const;

export function CoveragePage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const autonomy = useAutonomyProjection(projectId, state.revision);
  const control = latestControlPlane(state, projectId);
  const legacyGaps = gapHistory(state, projectId);
  const fullGaps = autonomyGapHistory(autonomy);
  const gaps = autonomy?.available ? fullGaps : legacyGaps;
  const current = autonomy?.available ? unresolvedAutonomyGaps(autonomy) : control?.gaps ?? [];
  const counts = autonomyCounts(autonomy);
  const [filter, setFilter] = useState<(typeof filters)[number]>("전체 영역");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const filteredGaps = useMemo(() => {
    const sorted = [...gaps].sort((a, b) => b.priority - a.priority || b.observedAt.localeCompare(a.observedAt));
    if (!autonomy?.available) return filter === "최근 발견" ? [...gaps].sort((a, b) => b.observedAt.localeCompare(a.observedAt)) : (current.length ? current : sorted);
    if (filter === "열린 갭") return sorted.filter((gap) => ["OPEN", "INVESTIGATING", "BLOCKED"].includes(gap.status ?? "OPEN"));
    if (filter === "미탐색") return sorted.filter((gap) => gap.status === "UNEXPLORED");
    if (filter === "검증 완료") return sorted.filter((gap) => gap.status === "RESOLVED");
    if (filter === "최근 발견") return [...gaps].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return sorted;
  }, [autonomy?.available, current, filter, gaps]);
  const selected = gaps.find((gap) => gap.id === selectedId) ?? filteredGaps[0] ?? gaps[0];
  const seenCategories = useMemo(() => new Set(gaps.map((gap) => gap.category)), [gaps]);
  const unresolved = counts
    ? counts.open + counts.investigating + counts.blocked
    : (control?.counts.open ?? 0) + (control?.counts.investigating ?? 0) + (control?.counts.blocked ?? 0);
  const exploredCategories = coverageCategories.filter((category) => seenCategories.has(category) || categorySignal(state, projectId, category).state !== "quiet").length;
  const coveragePercent = counts ? Math.round(counts.convergence * 100) : Math.round((exploredCategories / coverageCategories.length) * 100);
  const unexplored = counts?.unexplored ?? control?.counts.unexplored ?? 0;
  const highPriority = counts?.highPriority ?? control?.counts.highPriority ?? 0;
  const observedAt = counts?.observedAt || control?.observedAt;

  if (!project) return <div className="product-loading">프로젝트를 찾을 수 없습니다.</div>;

  const inspector = <>
    <InspectorHeader title="갭 상세" meta={selected?.id ?? "선택 없음"} />
    {selected ? <>
      <InspectorCard title={`${priorityBand(selected.priority)} · ${selected.id}`} meta={selected.priority.toFixed(2)}>
        <p className="inspector-strong">{selected.title}</p>
        <p className="product-muted">{selected.summary ?? `${categoryLabel(selected.category)} 관점에서 발견된 control-plane gap`}</p>
        <StatusPill tone={gapTone(selected)}>{selected.status ?? "FRONTIER"}</StatusPill>
      </InspectorCard>
      <InspectorCard title="발견 출처" meta="provenance">
        <KeyValue label="출처" value={selected.source ?? "autonomy evidence"} tone="evidence" />
        <KeyValue label="최근 관찰" value={relativeAge(selected.observedAt)} />
        <KeyValue label="근거 기록" value={selected.evidenceId.slice(-18)} />
        <KeyValue label="영역" value={categoryLabel(selected.category)} />
        {selected.impact !== undefined && <KeyValue label="영향" value={selected.impact.toFixed(2)} tone="warning" />}
        {selected.uncertainty !== undefined && <KeyValue label="불확실성" value={selected.uncertainty.toFixed(2)} tone="evidence" />}
      </InspectorCard>
      <InspectorCard title="필요한 근거" meta={`${selected.evidenceNeeded?.length ?? 0}개`}>
        {selected.evidenceNeeded?.length ? selected.evidenceNeeded.slice(0, 6).map((item) => <p key={item} className="dependency-line"><StatusDot tone="evidence" />{item}</p>) : <p className="product-muted">해당 gap이 mission으로 선택되면 evidence contract를 통해 검증 조건이 구체화됩니다.</p>}
      </InspectorCard>
      {!!selected.sourceRefs?.length && <InspectorCard title="소스 참조" meta="discovery"><div className="mission-simple-list">{selected.sourceRefs.slice(0, 5).map((ref) => <div key={ref}><small>{ref}</small></div>)}</div></InspectorCard>}
      <InspectorCard title="작업" meta="runtime">
        <div className="inspector-button-row"><button onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })}>재평가</button><button disabled>미션은 자동 생성</button></div>
      </InspectorCard>
    </> : <InspectorCard title="갭 없음"><p className="product-muted">선택할 gap이 없습니다.</p></InspectorCard>}
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="탐색 범위 & 갭" title="무엇을 알고 있고, 무엇이 아직 비어 있는가" description="taxonomy + 독립 scout + runtime evidence로 problem space를 계속 갱신" actions={<><StatusPill tone="evidence">{coveragePercent}% 수렴</StatusPill><StatusPill tone="warning">{unresolved}개 열림</StatusPill></>} />

    <div className="product-filters">{filters.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div>

    <div className="coverage-content-grid">
      <Surface className="coverage-domains">
        <SurfaceHeader title="영역별 탐색" meta="17개 영역" />
        <div className="domain-grid">{coverageCategories.map((category) => {
          const categoryGaps = gaps.filter((gap) => gap.category === category);
          const unresolvedCategory = current.filter((gap) => gap.category === category);
          const legacySignal = categorySignal(state, projectId, category);
          const risk = unresolvedCategory.length ? Math.max(...unresolvedCategory.map((gap) => gap.priority)) : categoryGaps.length ? Math.max(...categoryGaps.map((gap) => gap.priority)) : legacySignal.risk;
          const resolvedCount = categoryGaps.filter((gap) => gap.status === "RESOLVED").length;
          const tone = unresolvedCategory.length ? (risk >= .85 ? "danger" : risk >= .65 ? "warning" : "evidence") : categoryGaps.length || legacySignal.state === "seen" ? "success" : "neutral";
          return <button key={category} className="domain-card" onClick={() => { const first = unresolvedCategory[0] ?? categoryGaps[0] ?? current.find((gap) => gap.category === category) ?? gaps.find((gap) => gap.category === category); if (first) setSelectedId(first.id); }}>
            <span className="domain-name"><StatusDot tone={tone} />{categoryLabel(category)}</span>
            <strong className={`text-${tone}`}>{unresolvedCategory.length ? `${Math.round((1 - Math.min(.9, risk * .7)) * 100)}%` : resolvedCount ? "검증됨" : categoryGaps.length ? "검토됨" : "미탐색"}</strong>
            <small>{unresolvedCategory.length ? `${unresolvedCategory.length}개 미해결` : categoryGaps.length ? `${categoryGaps.length}개 기록` : "새 scout 대상"}</small>
          </button>;
        })}</div>
      </Surface>

      <Surface className="coverage-gaps">
        <SurfaceHeader title={filter === "전체 영역" ? "Gap Graph" : filter} meta={`${filteredGaps.length}개 · 가치순`} />
        <div className="gap-list coverage-gap-list">{filteredGaps.slice(0, 18).map((gap) => <GapButton key={gap.id} gap={gap} selected={selected?.id === gap.id} onClick={() => setSelectedId(gap.id)} />)}{!filteredGaps.length && <div className="product-empty">이 필터에 해당하는 gap이 없습니다.</div>}</div>
      </Surface>
    </div>

    <div className="discovery-strip">
      <Discovery label="전체 갭" value={`${gaps.length}`} tone="evidence" />
      <Discovery label="현재 중요 갭" value={`${highPriority}`} tone="warning" />
      <Discovery label="미탐색" value={`${unexplored}`} tone="neutral" />
      <Discovery label="최근 갱신" value={observedAt ? relativeAge(observedAt) : "-"} tone="working" />
    </div>
  </ProductWorkspace>;
}

function GapButton({ gap, selected, onClick }: { gap: ControlPlaneGapView; selected: boolean; onClick: () => void }) {
  const band = priorityBand(gap.priority);
  return <button className={`gap-row coverage-gap-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`priority priority-${band.toLowerCase()}`}>{band} · {gap.id}</span><span className="gap-copy"><strong>{gap.title}</strong><small>{categoryLabel(gap.category)} · {gap.status ?? "FRONTIER"}</small></span><span className="gap-score">{gap.priority.toFixed(2)}</span></button>;
}

function gapTone(gap: ControlPlaneGapView): "danger" | "warning" | "evidence" | "success" | "neutral" {
  if (gap.status === "RESOLVED") return "success";
  if (gap.status === "DEFERRED") return "neutral";
  if (gap.status === "BLOCKED" || gap.priority >= .85) return "danger";
  if (gap.status === "UNEXPLORED" || gap.priority >= .65) return "warning";
  return "evidence";
}

function Discovery({ label, value, tone }: { label: string; value: string; tone: "evidence" | "warning" | "neutral" | "working" }) {
  return <div><span>{label}<StatusDot tone={tone} /></span><strong>{value}</strong></div>;
}
