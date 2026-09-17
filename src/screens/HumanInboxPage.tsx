import { useMemo, useState } from "react";
import { openHumanItems, relativeAge } from "../controlPlaneView";
import { getProject } from "../runtime";
import { useApp } from "../store";
import type { HumanItem, HumanItemKind } from "../types";
import { InspectorCard, InspectorHeader, KeyValue, ProductHeader, ProductWorkspace, StatusDot, StatusPill, Surface, SurfaceHeader } from "../components/ProductWorkspace";

const kinds: Array<{ key: "ALL" | HumanItemKind; label: string }> = [
  { key: "ALL", label: "전체" }, { key: "QUESTION", label: "질문" }, { key: "IDEA", label: "아이디어" }, { key: "CONCERN", label: "우려" }, { key: "APPROVAL", label: "승인" },
];

export function HumanInboxPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const open = openHumanItems(state, projectId);
  const all = state.humanItems.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [kind, setKind] = useState<"ALL" | HumanItemKind>("ALL");
  const filtered = useMemo(() => all.filter((item) => kind === "ALL" || item.kind === kind), [all, kind]);
  const [selectedId, setSelectedId] = useState<string | undefined>(open[0]?.id ?? all[0]?.id);
  const selected = all.find((item) => item.id === selectedId) ?? filtered[0];
  const [draft, setDraft] = useState("");
  const [choice, setChoice] = useState<string>();

  if (!project) return <div className="product-loading">프로젝트를 찾을 수 없습니다.</div>;

  const sendAnswer = () => {
    if (!selected) return;
    const answer = draft.trim() || choice || undefined;
    if (selected.kind === "QUESTION") {
      if (!answer) return;
      dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: selected.id, action: "answer", answer });
    } else if (selected.kind === "IDEA" || selected.kind === "CONCERN") {
      dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: selected.id, action: "acknowledge", answer });
    }
    setDraft(""); setChoice(undefined);
  };

  const inspector = <>
    <InspectorHeader title="결정 영향" meta={selected?.id.slice(-8)} />
    {selected ? <>
      <InspectorCard title="영향 분석" meta="부분 영향">
        <KeyValue label="차단" value={`${selected.blockingScope.length}개 범위`} tone="human" />
        <KeyValue label="계속" value={`${selected.continuingScope.length}개 범위`} tone="success" />
        <KeyValue label="기존 작업" value={selected.blockingScope.length ? "선택적 재검증" : "계속"} tone="evidence" />
        <KeyValue label="우선순위" value={selected.priority} />
      </InspectorCard>
      <InspectorCard title="영향 범위" meta="dependency graph">
        {selected.blockingScope.slice(0, 5).map((scope) => <p className="dependency-line" key={scope}><StatusDot tone="human" />{scope}</p>)}
        {!selected.blockingScope.length && <p className="product-muted">직접 차단하는 범위가 없습니다.</p>}
      </InspectorCard>
      <InspectorCard title="답변 도착 시" meta="자동">
        <ol className="compact-steps"><li>authoritative human decision 기록</li><li>기존 가정과 충돌 검사</li><li>영향 범위만 supersede / replan</li><li>선택적 재작업 + verify</li></ol>
      </InspectorCard>
    </> : <InspectorCard title="선택 없음"><p className="product-muted">항목을 선택하세요.</p></InspectorCard>}
  </>;

  return <ProductWorkspace inspector={inspector}>
    <ProductHeader eyebrow="사람 개입" title="내가 결정해야 하는 것만 모아서 본다" description="답변을 기다리는 동안 관련 없는 미션은 계속 진행" actions={<><StatusPill tone={open.length ? "human" : "success"}>{open.length}개 열림</StatusPill><StatusPill tone={project.status === "ACTIVE" ? "success" : "warning"}>{project.status === "ACTIVE" ? "조직 계속 실행 중" : project.status}</StatusPill></>} />

    <div className="product-filters">{kinds.map((item) => { const count = item.key === "ALL" ? all.length : all.filter((candidate) => candidate.kind === item.key).length; return <button key={item.key} className={kind === item.key ? "active" : ""} onClick={() => setKind(item.key)}>{item.label} {count}</button>; })}</div>

    <div className="human-inbox-grid">
      <Surface className="human-list-pane">
        <SurfaceHeader title="내 결정 필요" meta={`${filtered.length}개 항목`} />
        <div className="human-item-list">{filtered.map((item) => <HumanRow key={item.id} item={item} selected={selected?.id === item.id} onClick={() => { setSelectedId(item.id); setDraft(""); setChoice(undefined); }} />)}{!filtered.length && <div className="product-empty">이 필터에 해당하는 항목이 없습니다.</div>}</div>
      </Surface>

      <Surface className="human-detail-pane">
        {selected ? <>
          <div className="human-detail-top"><StatusPill tone={kindTone(selected.kind)}>{kindLabel(selected.kind)}</StatusPill><span>{selected.id.slice(-10)}</span><span>{relativeAge(selected.createdAt)} 전</span></div>
          <h2>{selected.title}</h2>
          <p className="human-detail-summary">{selected.detailSummary ?? selected.summary}</p>

          <div className="scope-grid">
            <Scope title="차단 범위" items={selected.blockingScope} tone="human" empty="직접 차단 없음" />
            <Scope title="계속 진행 범위" items={selected.continuingScope} tone="success" empty="명시된 계속 범위 없음" />
          </div>

          <Surface className="assumption-panel"><SurfaceHeader title="현재 가정 / 이유" meta="되돌릴 수 있는 범위만" /><p>{selected.rationale}</p><small>답변과 충돌하면 영향받는 작업만 재계획하고 다시 검증합니다.</small></Surface>

          {!!selected.options.length && <div className="human-options"><span className="human-options-label">선택지</span>{selected.options.map((option) => <button key={option.id} className={choice === option.title || choice === option.id ? "active" : ""} onClick={() => setChoice(option.title)}><strong>{option.title}</strong><small>{option.description}</small></button>)}</div>}

          {selected.status === "OPEN" ? <div className="human-answer-box">
            {selected.kind === "APPROVAL" ? <div className="approval-actions"><button className="danger" onClick={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: selected.id, action: "reject" })}>거부</button><button className="primary" onClick={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: selected.id, action: "approve" })}>승인</button></div> : <>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="답변을 입력하거나 위 옵션을 선택…" />
              <div><button onClick={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: selected.id, action: "defer" })}>나중에</button><button className="primary" onClick={sendAnswer}>{selected.kind === "QUESTION" ? "답변 보내기" : "확인"}</button></div>
            </>}
          </div> : <div className="resolved-human"><StatusDot tone="success" /><strong>{selected.status}</strong><span>{selected.answerLabel ?? selected.answer ?? "처리됨"}</span></div>}
        </> : <div className="product-empty">왼쪽에서 항목을 선택하세요.</div>}
      </Surface>
    </div>
  </ProductWorkspace>;
}

function HumanRow({ item, selected, onClick }: { item: HumanItem; selected: boolean; onClick: () => void }) {
  return <button className={`human-row ${selected ? "selected" : ""}`} onClick={onClick}><div><span><StatusDot tone={kindTone(item.kind)} />{kindLabel(item.kind)} · {item.id.slice(-7)}</span><small>{relativeAge(item.createdAt)} 전</small></div><strong>{item.title}</strong><small className={item.status === "OPEN" ? "text-success" : ""}>{item.status === "OPEN" ? `계속 진행 · 차단 ${item.blockingScope.length}` : item.status}</small></button>;
}

function Scope({ title, items, tone, empty }: { title: string; items: string[]; tone: "human" | "success"; empty: string }) {
  return <div className="scope-card"><div><strong>{title}</strong><span>{items.length}</span></div>{items.length ? items.slice(0, 6).map((item) => <p key={item} className={`text-${tone}`}>• {item}</p>) : <p className="product-muted">{empty}</p>}</div>;
}

function kindLabel(kind: HumanItemKind): string { return ({ QUESTION: "질문", IDEA: "아이디어", CONCERN: "우려", APPROVAL: "승인" })[kind]; }
function kindTone(kind: HumanItemKind): "human" | "warning" | "danger" | "evidence" { return kind === "QUESTION" ? "human" : kind === "APPROVAL" ? "danger" : kind === "CONCERN" ? "warning" : "evidence"; }
