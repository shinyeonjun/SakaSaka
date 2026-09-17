import { AppShell } from "./components/AppShell";
import { useRouter } from "./router";
import { ActivityPage } from "./screens/ActivityPage";
import { ArtifactsPage } from "./screens/ArtifactsPage";
import { ControlCenterPage } from "./screens/ControlCenterPage";
import { CoveragePage } from "./screens/CoveragePage";
import { EvidenceWorldPage } from "./screens/EvidenceWorldPage";
import { ExperimentsPage } from "./screens/ExperimentsPage";
import { HandoffRoutesPage, HandoffRuntimePage } from "./screens/HandoffPages";
import { HumanInboxPage } from "./screens/HumanInboxPage";
import { HumanItemDetailPage } from "./screens/HumanItemDetailPage";
import { MissionsPage } from "./screens/MissionsPage";
import { NewProjectPage } from "./screens/NewProjectPage";
import { SettingsPage } from "./screens/SettingsPage";
import { GlobalSettingsPage } from "./screens/GlobalSettingsPage";
import { Button, Card } from "./components/ui";

export function App() {
  const { route, navigate } = useRouter();

  if (route.kind === "handoff-routes") return <HandoffRoutesPage />;
  if (route.kind === "handoff-runtime") return <HandoffRuntimePage />;

  const content = (() => {
    switch (route.kind) {
      case "new": return <NewProjectPage />;
      case "global-settings": return <GlobalSettingsPage />;
      case "overview": return <ControlCenterPage projectId={route.projectId} />;
      case "missions": return <MissionsPage projectId={route.projectId} />;
      case "coverage": return <CoveragePage projectId={route.projectId} />;
      case "needs-you": return <HumanInboxPage projectId={route.projectId} />;
      case "human-item": return <HumanItemDetailPage projectId={route.projectId} itemId={route.itemId} />;
      case "evidence": return <EvidenceWorldPage projectId={route.projectId} />;
      case "activity": return <ActivityPage projectId={route.projectId} />;
      case "world": return <EvidenceWorldPage projectId={route.projectId} />;
      case "artifacts": return <ArtifactsPage projectId={route.projectId} />;
      case "experiments": return <ExperimentsPage projectId={route.projectId} />;
      case "settings": return <SettingsPage projectId={route.projectId} />;
      default: return <NotFoundPage onHome={() => navigate("/projects/new")} />;
    }
  })();

  return <AppShell>{content}</AppShell>;
}

function NotFoundPage({ onHome }: { onHome: () => void }) {
  return <div className="screen"><Card className="empty-state"><h1>이 경로의 World를 찾을 수 없습니다.</h1><p>존재하는 route contract를 확인하거나 새 Intent를 시작해 주세요.</p><Button variant="primary" onClick={onHome}>새 프로젝트로 이동</Button></Card></div>;
}
