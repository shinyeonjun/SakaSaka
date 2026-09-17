import { useMemo, useState } from "react";
import { relativeAge } from "../controlPlaneView";
import { getProject, getWorldSnapshot } from "../runtime";
import { useApp } from "../store";
import type { Evidence, WorldSource } from "../types";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

export function EvidenceWorldPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const world = getWorldSnapshot(state, projectId);
  const evidence = useMemo(() => state.evidence.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.evidence, projectId]);
  const [selectedId, setSelectedId] = useState(evidence[0]?.id);
  const selected = evidence.find((item) => item.id === selectedId) ?? evidence[0];
  const pass = evidence.filter((item) => item.verdict === "PASS").length;
  const uncertain = evidence.filter((item) => item.verdict === "UNCERTAIN").length;
  const failed = evidence.filter((item) => item.verdict === "FAIL").length;
  if (!project || !world) return <div className="product-loading">월드 상태를 찾을 수 없습니다.</div>;

  const inspector = <>
    <InspectorHeader title="근거 상세" meta={selected?.id.slice(-8)} />
    {selected ? <>
      <InspectorCard title="주장" meta={verdictLabel(selected.verdict)}>
        <p className="inspector-strong">{selected.summary}</p>
        <p className="product-muted">이 근거는 {selected.source}에서 기록되었으며 원본/평가 계보를 통해 추적됩니다.</p>
        <StatusPill tone={verdictTone(selected.verdict)}>{selected.verdict}</StatusPill>
      </InspectorCard>
      <InspectorCard title="출처" meta={selected.kind}>
        <KeyValue label="source" value={selected.source} tone="evidence" />
        <KeyValue label="기록 시각" value={new Date(selected.createdAt).toLocaleTimeString("ko-KR", { hour12: false })} />
        <KeyValue label="World cursor" value={world.cursorEventId} />
        <KeyValue label="원본 참조" value={selected.rawRef ?? "요약만 보존"} />
        {selected.evaluator && <KeyValue label="평가기" value={`${selected.evaluator}${selected.evaluatorVersion ? ` · ${selected.evaluatorVersion}` : ""}`} />}
      </InspectorCard>
      <InspectorCard title="계보" meta="변경 불가 참조">
        <div className="lineage-stack"><strong className="text-evidence">{selected.kind} source</strong><span>↓ observe / execute</span><strong>월드 근거</strong><span>↓ evaluate</span><strong className={selected.verdict === "PASS" ? "text-success" : selected.verdict === "FAIL" ? "text-danger" : "text-warning"}>{verdictLabel(selected.verdict)}</strong></div>
      </InspectorCard>
      <InspectorCard title="작업" meta="evidence">
        <div className="inspector-button-row"><button onClick={() => navigator.clipboard?.writeText(selected.rawRef ?? selected.id)}>참조 복사</button><button onClick={() => dispatch({ type: "REFRESH_WORLD", projectId })}>월드 새로고침</button></div>
        <p className="product-muted">모델 output은 raw trace일 뿐, 검증 전에는 PASS evidence가 아닙니다.</p>
      </InspectorCard>
    </> : <InspectorCard title="근거 없음"><p className="product-muted">아직 기록된 근거가 없습니다.</p></InspectorCard>}
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="근거 & 월드" title="완료 주장이 실제 현실과 연결되어 있는가" description="test · browser · runtime · human · tool output의 provenance를 추적" actions={<><StatusPill tone="success">{pass}개 통과</StatusPill><StatusPill tone="warning">불확실 {uncertain}</StatusPill>{failed > 0 && <StatusPill tone="danger">실패 {failed}</StatusPill>}</>} />

    <div className="evidence-world-grid">
      <Surface className="evidence-ledger">
        <SurfaceHeader title="근거 원장" meta={`${evidence.length}개 기록`} />
        <div className="evidence-table">
          <div className="evidence-head"><span>판정</span><span>주장</span><span>출처</span><span>종류</span><span>경과</span></div>
          {evidence.map((item) => <EvidenceRow key={item.id} evidence={item} selected={selected?.id === item.id} onClick={() => setSelectedId(item.id)} />)}
          {!evidence.length && <div className="product-empty">아직 검증 원장이 비어 있습니다.</div>}
        </div>
      </Surface>

      <div className="world-pane">
        <Surface>
          <SurfaceHeader title="월드 소스" meta="실시간" />
          <div className="world-source-list">{Object.values(world.sources).map((source) => <WorldSourceRow key={source.key} source={source} />)}</div>
        </Surface>
        <Surface><SurfaceHeader title="월드 커서" meta={world.cursorEventId} /><p className="world-summary">{world.summary}</p><KeyValue label="마지막 관찰" value={new Date(world.observedAt).toLocaleTimeString("ko-KR", { hour12: false })} /><KeyValue label="최신성" value={relativeAge(world.observedAt)} tone="evidence" /></Surface>
        <Surface><SurfaceHeader title="최근 계보" meta="3" /><div className="recent-lineage"><span>• tool output → parser → evidence</span><span>• browser/runtime → observer → evidence</span><span>• human answer → constraint → mission</span></div></Surface>
      </div>
    </div>
  </ProductWorkspace>;
}

function EvidenceRow({ evidence, selected, onClick }: { evidence: Evidence; selected: boolean; onClick: () => void }) {
  return <button className={`evidence-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`verdict verdict-${evidence.verdict.toLowerCase()}`}><StatusDot tone={verdictTone(evidence.verdict)} />{verdictLabel(evidence.verdict)}</span><strong>{evidence.summary}</strong><span>{evidence.source}</span><span>{evidence.kind}</span><span>{relativeAge(evidence.createdAt)}</span></button>;
}

function WorldSourceRow({ source }: { source: WorldSource }) {
  const tone = source.status === "healthy" ? "success" : source.status === "warning" ? "warning" : source.status === "blocked" ? "danger" : "neutral";
  return <div className="world-source-row"><div><StatusDot tone={tone} /><span><strong>{source.label}</strong><small>{source.summary}</small></span></div><em className={`text-${tone}`}>{source.status}</em></div>;
}

function verdictLabel(verdict: Evidence["verdict"]): string { return verdict === "PASS" ? "통과" : verdict === "FAIL" ? "실패" : "불확실"; }
function verdictTone(verdict: Evidence["verdict"]): "success" | "danger" | "warning" { return verdict === "PASS" ? "success" : verdict === "FAIL" ? "danger" : "warning"; }
