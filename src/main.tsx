import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppProvider } from "./store";
import "./styles.css";
import "./runtimeDiagnostics.css";
import "./desktopV2.css";
import "./desktopV2Screens.css";
import "./productUI.css";
import "./productForms.css";
import "./productCompat.css";
import "./readability.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
