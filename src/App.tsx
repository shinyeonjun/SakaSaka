import { AppShell } from "./components/AppShell";
import { useRouter } from "./router";
import { ActivityPage } from "./screens/ActivityPage";
import { ArtifactsPage } from "./screens/ArtifactsPage";
import { ExperimentsPage } from "./screens/ExperimentsPage";
import { HandoffRoutesPage, HandoffRuntimePage } from "./screens/HandoffPages";
import { HumanItemDetailPage } from "./screens/HumanItemDetailPage";
import { NeedsYouPage } from "./screens/NeedsYouPage";
import { NewProjectPage } from "./screens/NewProjectPage";
import { OverviewPage } from "./screens/OverviewPage";
import { WorldPage } from "./screens/WorldPage";
import { Button, Card } from "./components/ui";

export function App() {
  const { route, navigate } = useRouter();

  if (route.kind === "handoff-routes") return <HandoffRoutesPage />;
  if (route.kind === "handoff-runtime") return <HandoffRuntimePage />;

  const content = (() => {
    switch (route.kind) {
      case "new": return <NewProjectPage />;
      case "overview": return <OverviewPage projectId={route.projectId} />;
      case "needs-you": return <NeedsYouPage projectId={route.projectId} />;
      case "human-item": return <HumanItemDetailPage projectId={route.projectId} itemId={route.itemId} />;
      case "activity": return <ActivityPage projectId={route.projectId} />;
      case "world": return <WorldPage projectId={route.projectId} />;
      case "artifacts": return <ArtifactsPage projectId={route.projectId} />;
      case "experiments": return <ExperimentsPage projectId={route.projectId} />;
      default: return <NotFoundPage onHome={() => navigate("/projects/new")} />;
    }
  })();

  return <AppShell>{content}</AppShell>;
}

function NotFoundPage({ onHome }: { onHome: () => void }) {
  return <div className="screen"><Card className="empty-state"><h1>이 경로의 World를 찾을 수 없습니다.</h1><p>존재하는 route contract를 확인하거나 새 Intent를 시작해 주세요.</p><Button variant="primary" onClick={onHome}>새 프로젝트로 이동</Button></Card></div>;
}
