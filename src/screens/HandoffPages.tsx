import { Card, PageHeading, Pill, SectionHeader } from "../components/ui";

const routes = [
  ["/projects/new", "의도 입력 · 예산/경계 설정 · 프로젝트 시작"],
  ["/projects/:id", "개요 · ACTIVE / WAITING / EQUILIBRIUM 상태"],
  ["/projects/:id/needs-you", "질문 / 아이디어 / 우려 / 승인 목록"],
  ["/projects/:id/human-items/:itemId", "질문/승인 상세 · 영향범위 · 답변"],
  ["/projects/:id/activity", "이벤트 타임라인 · 증거 연결"],
  ["/projects/:id/world", "repo/app/db/log/browser/human 월드 상태"],
  ["/projects/:id/artifacts", "빌드·리포트·스크린샷·릴리스·문서"],
  ["/projects/:id/experiments", "아키텍처 A/B · 벤치마크 · 자기 개선 실험"],
  ["/projects/:id/settings", "작업 폴더 바인딩 · 모델 provider 연결 · 실행 경계"],
];

const coreComponents = ["AppShell", "SidebarNav", "ProjectStatusBadge", "IntentComposer", "NeedsYouSummary", "HumanItemCard", "HumanItemDetail", "EventTimeline", "WorldHealthGrid", "EvidenceChain", "BudgetMeter", "ArtifactViewer", "ProjectSettingsPage"];

export function HandoffRoutesPage() {
  return <div className="spec-screen"><PageHeading title="UI 인계 · 경로와 구성요소" description="구현 시 화면 의미와 실시간 상태가 달라지지 않도록 하는 최소 계약." /><Card className="routes-contract-card"><SectionHeader title="경로" /><div className="route-table">{routes.map(([route, description]) => <div key={route} className="route-row"><strong>{route}</strong><span>{description}</span></div>)}</div></Card><div className="spec-split-grid"><Card><SectionHeader title="핵심 UI 구성요소" /><ul className="component-list">{coreComponents.map((component) => <li key={component}>{component}</li>)}</ul></Card><Card><SectionHeader title="실시간 데이터 계약" /><div className="contract-copy"><p>SSE/WebSocket가 event.created / run.state / world.changed / human-item.created / evidence.created를 전달합니다.</p><p>UI는 폴링된 “진행률 %”를 핵심으로 삼지 않고 실제 상태·증거·활동을 보여줍니다.</p><p>낙관적 갱신은 사람의 답변 저장에만 제한적으로 사용하고, 런타임 상태는 서버 이벤트와 원본 기록을 따릅니다.</p></div></Card></div></div>;
}

const stateCards = [
  { status: "ACTIVE", tone: "mint", title: "AI가 직접 월드를 바꾸는 중", description: "일시 정지·종료 가능" },
  { status: "WAITING", tone: "pink", title: "사람의 답변 또는 승인이 필요한 범위가 있음", description: "독립 작업은 계속 가능" },
  { status: "EQUILIBRIUM", tone: "equilibrium", title: "현재 비용 대비 가치 높은 행동이 없음", description: "새 신호에서 다시 깨움" },
  { status: "STALLED", tone: "orange", title: "반복 실패 또는 진전 없음", description: "전략을 바꾸고 그래도 실패하면 사람에게 알림" },
  { status: "PAUSED", tone: "gray", title: "사용자가 실행을 일시 정지", description: "월드와 경험은 보존" },
  { status: "KILLED", tone: "red", title: "실행 강제 종료 · lease 폐기", description: "재시작은 새 실행으로" },
];

export function HandoffRuntimePage() {
  return <div className="spec-screen"><PageHeading title="런타임 상태 갤러리" description="상태는 작업 순서가 아니라 AI와 환경의 현재 관계를 나타냅니다." /><div className="runtime-state-grid">{stateCards.map((card) => <Card key={card.status} className="runtime-state-card"><Pill tone={card.tone}>{card.status}</Pill><h2>{card.title}</h2><p>{card.description}</p></Card>)}</div><Card className="state-rules-card"><SectionHeader title="상태 전환 UI 규칙" /><div className="rules-list"><p>ACTIVE→WAITING: 도움이 필요한 배지를 늘리고 관련 보류 범위를 표시합니다.</p><p>ACTIVE→EQUILIBRIUM: “완료” 대신 현재 필수 공백·위험·추가 탐색 가치의 근거를 표시합니다.</p><p>ACTIVE→STALLED: 반복 시도·비용 증가·마지막 증거를 보여주고 사람에게 다음 작업이 아닌 상황 판단을 요청합니다.</p><p>어떤 상태에서도 활동과 이벤트 기록은 사라지지 않습니다.</p></div></Card></div>;
}
