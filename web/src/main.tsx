import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RoutinesView } from "./components/RoutinesView";
import { initializeTaskboardStorage } from "./storage";
import "./styles.css";

async function main() {
  await initializeTaskboardStorage();
  // Standalone mode (?view=routines): the global automation/routines page,
  // mounted by the DSH shell's 「自动化」 panel — no project context needed.
  const params = new URLSearchParams(window.location.search);
  const standalone = params.get("view");
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      {standalone === "routines" ? <RoutinesView /> : <App />}
    </StrictMode>,
  );
}

void main();
