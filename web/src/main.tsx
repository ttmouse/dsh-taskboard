import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RoutinesView } from "./components/RoutinesView";
import { resolveTaskboardLanguage, TaskboardLanguageProvider } from "./i18n";
import { initializeTaskboardStorage } from "./storage";
import "./styles.css";

type Theme = "light" | "dark";

/** Apply the theme onto the document root (styles.css keys on :root[data-theme]). */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/**
 * Standalone-mode theme bootstrap: read ?theme= (the DSH shell sets it),
 * fall back to the stored/preferred theme, then follow live pushes from the
 * parent window (taskboard:theme messages), so the page matches the shell.
 */
function bootStandaloneTheme(): void {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  const initial: Theme = fromQuery === "dark" || fromQuery === "light"
    ? fromQuery
    : window.localStorage.getItem("taskboard.theme") === "dark"
      ? "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  applyTheme(initial);
  window.addEventListener("message", (event) => {
    const data = event.data as { type?: string; theme?: unknown } | undefined;
    if (data?.type === "taskboard:theme" && (data.theme === "dark" || data.theme === "light")) {
      applyTheme(data.theme);
    }
  });
}

async function main() {
  await initializeTaskboardStorage();
  // Standalone mode (?view=routines): the global automation/routines page,
  // mounted by the DSH shell's 「自动化」 panel — no project context needed.
  const params = new URLSearchParams(window.location.search);
  const standalone = params.get("view");
  if (standalone === "routines") bootStandaloneTheme();
  const language = resolveTaskboardLanguage(params.get("lang") ?? navigator.language);
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      {standalone === "routines" ? (
        <TaskboardLanguageProvider language={language}>
          <RoutinesView />
        </TaskboardLanguageProvider>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
}

void main();
