import { useState } from "react";
import { getProject } from "../runtime";
import { useApp } from "../store";
import type { Artifact } from "../types";
import { Button, Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";
import { artifactKindLabel, formatDate } from "../format";

const kindTone: Record<Artifact["kind"], string> = { build: "blue", report: "mint", screenshot: "purple", release: "red", docs: "yellow" };

export function ArtifactsPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!project) return <div className="screen"><Card className="empty-state"><h1>산출물을 표시할 수 없습니다.</h1></Card></div>;
  const artifacts = state.artifacts.filter((artifact) => artifact.projectId === projectId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id));
  const selected = artifacts.find((artifact) => artifact.id === selectedId);

  return (
    <div className="screen">
      <PageHeading title="산출물" description="빌드·리포트·스크린샷·릴리스·문서를 증거 계보와 함께 보존합니다." actions={<Button variant="primary" size="small" onClick={() => dispatch({ type: "CREATE_ARTIFACT", projectId, kind: "report", name: `월드 스냅샷 리포트 · ${new Date().toLocaleDateString("ko-KR")}`, description: "현재 월드의 원본과 증거 범위를 저장한 런타임 리포트" })}>리포트 기록</Button>} />
      <div className="screen-stack">
        {selected && <Card className="artifact-viewer"><div><Pill tone={kindTone[selected.kind]}>{artifactKindLabel(selected.kind)}</Pill><h2>{selected.name}</h2><p>{selected.description}</p><p className="muted-copy">원본 · {selected.sourceRef} · 갱신 {formatDate(selected.updatedAt)}</p></div><Button variant="subtle" size="small" onClick={() => setSelectedId(null)}>닫기</Button></Card>}
        <div className="artifact-grid">
          {artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} selected={selectedId === artifact.id} onSelect={() => setSelectedId(artifact.id)} />)}
        </div>
        {!artifacts.length && <Card className="empty-state"><h2>아직 산출물이 없습니다.</h2><p>런타임이 검증을 마치면 결과를 여기에서 다시 열 수 있습니다.</p></Card>}
        <Card className="artifact-contract-card">
          <SectionHeader title="산출물 계약" />
          <div className="contract-columns"><div><strong>완료 주장</strong><span>원본 이벤트와 평가 증거로 추적</span></div><div><strong>원본 보존</strong><span>요약이 판정 원본을 대체하지 않음</span></div><div><strong>재현성</strong><span>실행·행동·월드 커서와 연결</span></div></div>
        </Card>
      </div>
    </div>
  );
}

function ArtifactCard({ artifact, selected, onSelect }: { artifact: Artifact; selected: boolean; onSelect: () => void }) {
  return <button className={cn("artifact-card", selected && "artifact-card-selected")} onClick={onSelect}><div className="artifact-card-head"><Pill tone={kindTone[artifact.kind]}>{artifactKindLabel(artifact.kind)}</Pill><span className={`artifact-status artifact-status-${artifact.status}`}>{artifact.status === "ready" ? "준비됨" : artifact.status === "in-review" ? "검토 중" : "보관됨"}</span></div><h2>{artifact.name}</h2><p>{artifact.description}</p><div className="artifact-meta"><span>{artifact.sizeLabel}</span><span>{formatDate(artifact.updatedAt)}</span></div></button>;
}
