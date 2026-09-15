import { useState } from "react";
import { getProject } from "../runtime";
import { useApp } from "../store";
import type { Artifact } from "../types";
import { Button, Card, PageHeading, Pill, SectionHeader, cn } from "../components/ui";
import { formatDate } from "../format";

const kindTone: Record<Artifact["kind"], string> = { build: "blue", report: "mint", screenshot: "purple", release: "red", docs: "yellow" };

export function ArtifactsPage({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const project = getProject(state, projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!project) return <div className="screen"><Card className="empty-state"><h1>Artifacts를 표시할 수 없습니다.</h1></Card></div>;
  const artifacts = state.artifacts.filter((artifact) => artifact.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = artifacts.find((artifact) => artifact.id === selectedId);

  return (
    <div className="screen">
      <PageHeading title="Artifacts" description="build, report, screenshot, release, docs를 evidence lineage와 함께 보존합니다." actions={<Button variant="primary" size="small" onClick={() => dispatch({ type: "CREATE_ARTIFACT", projectId, kind: "report", name: `World snapshot report · ${new Date().toLocaleDateString("ko-KR")}`, description: "현재 World source와 evidence coverage를 저장한 runtime report" })}>리포트 기록</Button>} />
      <div className="screen-stack">
        {selected && <Card className="artifact-viewer"><div><Pill tone={kindTone[selected.kind]}>{selected.kind}</Pill><h2>{selected.name}</h2><p>{selected.description}</p><p className="muted-copy">source · {selected.sourceRef} · updated {formatDate(selected.updatedAt)}</p></div><Button variant="subtle" size="small" onClick={() => setSelectedId(null)}>닫기</Button></Card>}
        <div className="artifact-grid">
          {artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} selected={selectedId === artifact.id} onSelect={() => setSelectedId(artifact.id)} />)}
        </div>
        {!artifacts.length && <Card className="empty-state"><h2>아직 artifact가 없습니다.</h2><p>runtime이 검증을 마치면 결과를 여기에서 다시 열 수 있습니다.</p></Card>}
        <Card className="artifact-contract-card">
          <SectionHeader title="Artifact contract" />
          <div className="contract-columns"><div><strong>완료 주장</strong><span>raw event와 evaluator evidence로 추적</span></div><div><strong>원본 보존</strong><span>summary가 source of truth를 대체하지 않음</span></div><div><strong>재현성</strong><span>run · action · world cursor와 연결</span></div></div>
        </Card>
      </div>
    </div>
  );
}

function ArtifactCard({ artifact, selected, onSelect }: { artifact: Artifact; selected: boolean; onSelect: () => void }) {
  return <button className={cn("artifact-card", selected && "artifact-card-selected")} onClick={onSelect}><div className="artifact-card-head"><Pill tone={kindTone[artifact.kind]}>{artifact.kind}</Pill><span className={`artifact-status artifact-status-${artifact.status}`}>{artifact.status}</span></div><h2>{artifact.name}</h2><p>{artifact.description}</p><div className="artifact-meta"><span>{artifact.sizeLabel}</span><span>{formatDate(artifact.updatedAt)}</span></div></button>;
}
