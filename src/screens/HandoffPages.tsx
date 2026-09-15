import { Card, PageHeading, Pill, SectionHeader } from "../components/ui";

const routes = [
  ["/projects/new", "Intent 입력 · budget/boundary 설정 · 프로젝트 시작"],
  ["/projects/:id", "Overview · ACTIVE / WAITING / EQUILIBRIUM 상태"],
  ["/projects/:id/needs-you", "Questions / Ideas / Concerns / Approvals 목록"],
  ["/projects/:id/human-items/:itemId", "질문/승인 상세 · 영향범위 · 답변"],
  ["/projects/:id/activity", "event timeline · evidence chain"],
  ["/projects/:id/world", "repo/app/db/log/browser/human World 상태"],
  ["/projects/:id/artifacts", "build, report, screenshot, release, docs"],
  ["/projects/:id/experiments", "architecture A/B · benchmark · self-improvement 실험"],
];

const coreComponents = ["AppShell", "SidebarNav", "ProjectStatusBadge", "IntentComposer", "NeedsYouSummary", "HumanItemCard", "HumanItemDetail", "EventTimeline", "WorldHealthGrid", "EvidenceChain", "BudgetMeter", "ArtifactViewer"];

export function HandoffRoutesPage() {
  return <div className="spec-screen"><PageHeading title="UI Handoff · Routes & Components" description="구현 시 화면 의미와 실시간 상태가 달라지지 않도록 하는 최소 계약." /><Card className="routes-contract-card"><SectionHeader title="Routes" /><div className="route-table">{routes.map(([route, description]) => <div key={route} className="route-row"><strong>{route}</strong><span>{description}</span></div>)}</div></Card><div className="spec-split-grid"><Card><SectionHeader title="Core UI Components" /><ul className="component-list">{coreComponents.map((component) => <li key={component}>{component}</li>)}</ul></Card><Card><SectionHeader title="Live Data Contract" /><div className="contract-copy"><p>SSE/WebSocket가 event.created / run.state / world.changed / human-item.created / evidence.created를 전달.</p><p>UI는 polling된 “진행률 %”를 핵심으로 삼지 않고 실제 state/evidence/activity를 보여준다.</p><p>Optimistic update는 Human answer 저장에만 제한적으로 사용하고, runtime state는 server event를 source of truth로 둔다.</p></div></Card></div></div>;
}

const stateCards = [
  { status: "ACTIVE", tone: "mint", title: "AI가 직접 World를 바꾸고 있음", description: "Pause / Kill 가능" },
  { status: "WAITING", tone: "pink", title: "Human answer/approval이 필요한 범위가 있음", description: "독립 작업은 계속 가능" },
  { status: "EQUILIBRIUM", tone: "equilibrium", title: "현재 비용 대비 가치 높은 행동이 없음", description: "새 signal에서 wake" },
  { status: "STALLED", tone: "orange", title: "반복 실패 또는 진전 없음", description: "전략 재고 → 그래도 실패하면 Human" },
  { status: "PAUSED", tone: "gray", title: "사용자가 실행을 일시 정지", description: "World/Memory는 보존" },
  { status: "KILLED", tone: "red", title: "Run 강제 종료 · lease revoked", description: "재시작은 새 run으로" },
];

export function HandoffRuntimePage() {
  return <div className="spec-screen"><PageHeading title="Runtime State Gallery" description="상태는 workflow 단계가 아니라 AI와 환경의 현재 관계를 나타냅니다." /><div className="runtime-state-grid">{stateCards.map((card) => <Card key={card.status} className="runtime-state-card"><Pill tone={card.tone}>{card.status}</Pill><h2>{card.title}</h2><p>{card.description}</p></Card>)}</div><Card className="state-rules-card"><SectionHeader title="State Transition UI Rules" /><div className="rules-list"><p>ACTIVE→WAITING: Needs You badge 증가, 관련 blocking scope 표시.</p><p>ACTIVE→EQUILIBRIUM: “완료” 대신 현재 Required Gap/위험/추가 탐색 가치 근거 표시.</p><p>ACTIVE→STALLED: 반복된 시도, 비용 slope, 마지막 evidence를 보여주고 Human에게 “다음 task”가 아닌 상황 판단만 요청.</p><p>어떤 상태에서도 Activity/Event 기록은 사라지지 않음.</p></div></Card></div>;
}
