import { useEffect, useState } from "react";
import { getProject, getProjectHumanItems, humanLabel, humanTone } from "../runtime";
import { useRouter } from "../router";
import { useApp } from "../store";
import type { HumanItem } from "../types";
import { Button, Card, InlineNotice, PageHeading, Pill, SectionHeader, cn } from "../components/ui";

export function HumanItemDetailPage({ projectId, itemId }: { projectId: string; itemId: string }) {
  const { state, dispatch } = useApp();
  const { navigate, back } = useRouter();
  const project = getProject(state, projectId);
  const item = getProjectHumanItems(state, projectId).find((candidate) => candidate.id === itemId);
  const [answer, setAnswer] = useState(item?.answer ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAnswer(item?.answer ?? "");
    setSaved(false);
  }, [item?.id]);

  if (!project || !item) return <div className="screen"><Card className="empty-state"><h1>Human item을 찾을 수 없습니다.</h1><Button variant="neutral" onClick={back}>뒤로 가기</Button></Card></div>;

  const isOpen = item.status === "OPEN" || item.status === "DEFERRED";
  const isQuestion = item.kind === "QUESTION";
  const selectedOption = item.options.find((option) => option.id === answer);
  const saveAnswer = () => {
    if (isQuestion && !answer.trim()) return;
    dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "answer", answer });
    setSaved(true);
  };

  return (
    <div className="screen">
      <PageHeading title={`${isQuestion ? "Question" : humanLabel(item.kind)} #${item.id}`} description="AI가 왜 사람에게 왔는지, 답변 전 무엇을 하고 있는지까지 보여줍니다." actions={<Pill tone={humanTone(item.kind)}>{isOpen ? (isQuestion ? "답변 필요" : "검토 필요") : item.status}</Pill>} />
      <div className="screen-stack">
        <Card className="detail-intro-card">
          <Pill tone={humanTone(item.kind)}>{humanLabel(item.kind)} · {isQuestion ? "Human Intent Required" : "impact-aware decision"}</Pill>
          <h2>{item.title}</h2>
          <p className="muted-copy">{item.detailSummary ?? item.summary}</p>
        </Card>

        <div className="split-grid detail-context-grid">
          <Card>
            <SectionHeader title="왜 지금 물어봤나" />
            <p>{item.rationale}</p>
            <p className="muted-copy">AI가 임의로 정하면 제품 가치가 바뀔 수 있어 {humanLabel(item.kind)}으로 승격했습니다.</p>
          </Card>
          <Card>
            <SectionHeader title="답변 전 영향 범위" />
            <p className="detail-strong">{item.blockingScope.length ? `BLOCKED · ${item.blockingScope.join(" · ")}` : "BLOCKED · 없음"}</p>
            <p className="detail-strong">{item.continuingScope.length ? `CONTINUING · ${item.continuingScope.join(" · ")}` : "CONTINUING · 관찰 대기"}</p>
            <p className="muted-copy">프로젝트 전체는 멈추지 않습니다.</p>
          </Card>
        </div>

        {isQuestion ? (
          <Card className="answer-card">
            <SectionHeader title="답변" />
            {item.options.length ? <div className="answer-options" role="radiogroup" aria-label="답변 선택">
              {item.options.map((option) => <label key={option.id} className={cn("answer-option", answer === option.id && "answer-option-selected")}><input type="radio" name="human-answer" value={option.id} checked={answer === option.id} onChange={() => { setAnswer(option.id); setSaved(false); }} /><span className="radio-control" aria-hidden="true" /><span className="answer-option-copy"><strong>{option.id}. {option.title}</strong><small>{option.description}</small></span></label>)}
            </div> : <textarea className="human-free-text" aria-label="자유 텍스트 답변" value={answer} onChange={(event) => { setAnswer(event.target.value); setSaved(false); }} placeholder="결정에 필요한 선호, 기준, 또는 답변을 입력하세요." rows={6} />}
            {saved && <InlineNotice tone="mint" title="저장됨">{selectedOption?.title ?? "Human answer"}가 기록되었습니다. 관련 scope가 다시 계획됩니다.</InlineNotice>}
            <div className="button-row">
              <Button variant="primary" onClick={saveAnswer} disabled={!answer.trim() || !isOpen}>답변 저장</Button>
            </div>
          </Card>
        ) : (
          <Card className="answer-card">
            <SectionHeader title={item.kind === "APPROVAL" ? "승인" : "Human response"} />
            <p className="detail-body-copy">{item.rationale}</p>
            {saved && <InlineNotice tone="mint" title="기록됨">이 결정은 event log와 World Snapshot에 연결되었습니다.</InlineNotice>}
            <div className="button-row">
              {item.kind === "APPROVAL" ? <><Button variant="primary" onClick={() => { dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "approve" }); setSaved(true); }} disabled={!isOpen}>승인</Button><Button variant="neutral" onClick={() => { dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "reject" }); setSaved(true); }} disabled={!isOpen}>거절</Button></> : <Button variant="primary" onClick={() => { dispatch({ type: "RESOLVE_HUMAN_ITEM", itemId: item.id, action: "acknowledge" }); setSaved(true); }} disabled={!isOpen}>확인했습니다</Button>}
              <Button variant="subtle" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}/needs-you`)}>Needs You로 돌아가기</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
