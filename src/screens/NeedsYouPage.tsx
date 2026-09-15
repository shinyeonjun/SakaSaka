import { useState } from "react";
import { getHumanCounts, getProject, getProjectHumanItems, humanLabel, humanTone } from "../runtime";
import { projectPath, useRouter } from "../router";
import { useApp } from "../store";
import type { HumanItem, HumanItemKind } from "../types";
import { Button, Card, PageHeading, Pill, cn } from "../components/ui";
import { humanStatusLabel } from "../format";

type Filter = "ALL" | HumanItemKind;

const filters: Array<{ key: HumanItemKind; label: string; tone: string }> = [
  { key: "QUESTION", label: "Questions", tone: "pink" },
  { key: "IDEA", label: "Ideas", tone: "yellow" },
  { key: "CONCERN", label: "Concerns", tone: "orange" },
  { key: "APPROVAL", label: "Approvals", tone: "red" },
];

export function NeedsYouPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const { navigate } = useRouter();
  const [filter, setFilter] = useState<Filter>("ALL");
  const project = getProject(state, projectId);
  if (!project) return <div className="screen"><Card className="empty-state"><h1>프로젝트를 찾을 수 없습니다.</h1></Card></div>;
  const counts = getHumanCounts(state, projectId);
  const allItems = getProjectHumanItems(state, projectId);
  const primaryItems = allItems
    .filter((item) => item.status === "OPEN" && (item.kind === "QUESTION" || item.kind === "APPROVAL" || item.id === "IDEA-21"))
    .sort((a, b) => ["QUESTION", "IDEA", "CONCERN", "APPROVAL"].indexOf(a.kind) - ["QUESTION", "IDEA", "CONCERN", "APPROVAL"].indexOf(b.kind));
  const items = filter === "ALL" ? primaryItems : allItems.filter((item) => item.kind === filter);

  return (
    <div className="screen">
      <PageHeading title="Needs You" description="AI가 인간만 제공할 수 있는 판단과 제품 기회를 비동기로 모읍니다." />
      <div className="screen-stack">
        <div className="filter-row" role="tablist" aria-label="Needs You 종류">
          {filters.map((item) => <button key={item.key} className={cn("filter-pill", `filter-${item.tone}`, filter === item.key && "filter-pill-active")} onClick={() => setFilter(item.key)} role="tab" aria-selected={filter === item.key}>{item.label} {counts[item.key]}</button>)}
        </div>
        {items.length === 0 && <Card className="empty-state"><h2>지금은 이 범위에 열린 항목이 없습니다.</h2><p>새 signal이 들어오면 여기로 올라옵니다.</p></Card>}
        {items.map((item) => <HumanItemCard key={item.id} item={item} onOpen={() => navigate(`${projectPath(projectId)}/human-items/${encodeURIComponent(item.id)}`)} onDefer={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "defer" })} onApprove={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "approve" })} onReject={() => dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "reject" })} />)}
      </div>
    </div>
  );
}

function HumanItemCard({ item, onOpen, onDefer, onApprove, onReject }: { item: HumanItem; onOpen: () => void; onDefer: () => void; onApprove: () => void; onReject: () => void }) {
  const isOpen = item.status === "OPEN";
  const tone = humanTone(item.kind);
  return (
    <Card className={cn("human-item-card", !isOpen && "human-item-resolved")}>
      <div className="human-card-topline"><Pill tone={tone}>{humanLabel(item.kind)}{item.kind === "QUESTION" ? " · 제품 판단 필요" : item.kind === "IDEA" ? " · 기회 발견" : item.kind === "APPROVAL" ? " · 외부 영향" : " · 관찰 필요"}</Pill><span className="item-id">{item.id}</span></div>
      <h2>{item.title}</h2>
      <p className="muted-copy">{item.kind === "QUESTION" ? `왜 물어봄: ${item.summary}` : item.kind === "IDEA" ? `근거: ${item.summary}` : item.summary}</p>
      {item.kind === "QUESTION" && <p className="small-copy">답변 전: {item.blockingScope.length ? `${item.blockingScope.join(" · ")} 관련 작업만 보류` : "영향 범위 확인 필요"}. {item.continuingScope.join(" · ")}는 계속 진행 중.</p>}
      {item.kind === "IDEA" && <p className="small-copy">{item.rationale}</p>}
      {!isOpen ? <Pill tone="neutral">{humanStatusLabel(item.status)}{item.answerLabel ? ` · ${item.answerLabel}` : ""}</Pill> : item.kind === "APPROVAL" ? <div className="button-row">
        <Button variant="primary" size="small" onClick={onApprove}>승인</Button>
        <Button variant="neutral" size="small" onClick={onReject}>거절</Button>
      </div> : item.kind === "QUESTION" ? <div className="button-row">
        <Button variant="primary" size="small" onClick={onOpen}>답변하기</Button>
        <Button variant="subtle" size="small" onClick={onDefer}>나중에</Button>
      </div> : item.kind === "CONCERN" ? <div className="button-row"><Button variant="neutral" size="small" onClick={onOpen}>확인하기</Button></div> : null}
    </Card>
  );
}
