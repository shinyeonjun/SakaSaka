import { useMemo, useState } from "react";
import { categoryLabel, categorySignal, coverageCategories, gapHistory, latestControlPlane, priorityBand, relativeAge, type ControlPlaneGapView } from "../controlPlaneView";
import { getProject } from "../runtime";
import { useApp } from "../store";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

const filters = ["전체 영역", "열린 갭", "미탐색", "검증 완료", "최근 발견"] as const;

export function CoveragePage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const control = latestControlPlane(state, projectId);
  const gaps = gapHistory(state, projectId);
  const current = control?.gaps ?? [];
  const [filter, setFilter] = useState<(typeof filters)[number]>("전체 영역");
  const [selectedId, setSelectedId] = useState(current[0]?.id ?? gaps[0]?.id);
  const selected = gaps.find((gap) => gap.id === selectedId) ?? current[0] ?? gaps[0];
  const seenCategories = useMemo(() => new Set(gaps.map((gap) => gap.category)), [gaps]);
  const unresolved = (control?.counts.open ?? 0) + (control?.counts.investigating ?? 0) + (control?.counts.blocked ?? 0);
  const exploredCategories = coverageCategories.filter((category) => seenCategories.has(category) || categorySignal(state, projectId, category).state !== "quiet").length;
  const coveragePercent = Math.round((exploredCategories / coverageCategories.length) * 100);

  if (!project) return <div className="product-loading">프로젝트를 찾을 수 없습니다.</div>;

  const inspector = <>
    <InspectorHeader title="갭 상세" meta={selected?.id ?? "선택 없음"} />
    {selected ? <>
      <InspectorCard title={`${priorityBand(selected.priority)} · ${selected.id}`} meta={selected.priority.toFixed(2)}>
        <p className="inspector-strong">{selected.title}</p>
        <p className="product-muted">{categoryLabel(selected.category)} · autonomy control-plane에서 관찰된 우선순위 갭</p>
        <StatusPill tone={selected.priority >= .85 ? "danger" : selected.priority >= .65 ? "warning" : "evidence"}>현재 frontier 신호</StatusPill>
      </InspectorCard>
      <InspectorCard title="발견 출처" meta="provenance">
        <KeyValue label="출처" value="독립 탐색 / 자율 판단" tone="evidence" />
        <KeyValue label="최근 관찰" value={relativeAge(selected.observedAt)} />
        <KeyValue label="근거 기록" value={selected.evidenceId.slice(-10)} />
        <KeyValue label="영역" value={categoryLabel(selected.category)} />
      </InspectorCard>
      <InspectorCard title="필요한 근거" meta="닫기 전">
        <p className="product-muted">이 UI는 임의로 완료 판정하지 않습니다. 해당 gap이 mission으로 선택되면 evidence contract가 생성되고, 실제 test/browser/world evidence로 닫힙니다.</p>
      </InspectorCard>
      <InspectorCard title="작업" meta="runtime">
        <div className="inspector-button-row"><button onClick={() => dispatch({ type: "WAKE_PROJECT", projectId })}>재평가</button><button disabled>미션은 자동 생성</button></div>
      </InspectorCard>
    </> : <InspectorCard title="갭 없음"><p className="product-muted">선택할 gap이 없습니다.</p></InspectorCard>}
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="탐색 범위 & 갭" title="무엇을 알고 있고, 무엇이 아직 비어 있는가" description="taxonomy + 독립 scout + runtime evidence로 problem space를 계속 갱신" actions={<><StatusPill tone="evidence">{coveragePercent}% 신호</StatusPill><StatusPill tone="warning">{unresolved}개 열림</StatusPill></>} />

    <div className="product-filters">{filters.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div>

    <div className="coverage-content-grid">
      <Surface className="coverage-domains">
        <SurfaceHeader title="영역별 탐색" meta="17개 영역" />
        <div className="domain-grid">{coverageCategories.map((category) => {
          const signal = categorySignal(state, projectId, category);
          const activeGap = current.filter((gap) => gap.category === category);
          const risk = activeGap.length ? Math.max(...activeGap.map((gap) => gap.priority)) : signal.risk;
          const tone = activeGap.length ? (risk >= .85 ? "danger" : risk >= .65 ? "warning" : "evidence") : signal.state === "seen" ? "success" : "neutral";
          return <button key={category} className="domain-card" onClick={() => { const first = current.find((gap) => gap.category === category) ?? gaps.find((gap) => gap.category === category); if (first) setSelectedId(first.id); }}>
            <span className="domain-name"><StatusDot tone={tone} />{categoryLabel(category)}</span>
            <strong className={`text-${tone}`}>{activeGap.length ? `${Math.round((1 - Math.min(.9, risk * .7)) * 100)}%` : signal.state === "seen" ? "검토됨" : "미탐색"}</strong>
            <small>{activeGap.length ? `${activeGap.length}개 열린 갭` : signal.gaps ? `${signal.gaps}개 관찰 기록` : "새 scout 대상"}</small>
          </button>;
        })}</div>
      </Surface>

      <Surface className="coverage-gaps">
        <SurfaceHeader title="열린 갭" meta="가치순" />
        <div className="gap-list coverage-gap-list">{(current.length ? current : gaps).slice(0, 12).map((gap) => <GapButton key={gap.id} gap={gap} selected={selected?.id === gap.id} onClick={() => setSelectedId(gap.id)} />)}{!gaps.length && <div className="product-empty">아직 control-plane gap 신호가 없습니다.</div>}</div>
      </Surface>
    </div>

    <div className="discovery-strip">
      <Discovery label="독립 탐색" value="3개 컨텍스트" tone="evidence" />
      <Discovery label="현재 중요 갭" value={`${control?.counts.highPriority ?? 0}`} tone="warning" />
      <Discovery label="미탐색" value={`${control?.counts.unexplored ?? 0}`} tone="neutral" />
      <Discovery label="최근 갱신" value={control ? relativeAge(control.observedAt) : "-"} tone="working" />
    </div>
  </ProductWorkspace>;
}

function GapButton({ gap, selected, onClick }: { gap: ControlPlaneGapView; selected: boolean; onClick: () => void }) {
  const band = priorityBand(gap.priority);
  return <button className={`gap-row coverage-gap-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`priority priority-${band.toLowerCase()}`}>{band} · {gap.id}</span><span className="gap-copy"><strong>{gap.title}</strong><small>{categoryLabel(gap.category)}</small></span><span className="gap-score">{gap.priority.toFixed(2)}</span></button>;
}

function Discovery({ label, value, tone }: { label: string; value: string; tone: "evidence" | "warning" | "neutral" | "working" }) {
  return <div><span>{label}<StatusDot tone={tone} /></span><strong>{value}</strong></div>;
}
