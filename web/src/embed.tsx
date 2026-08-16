import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeTaskboardStorage } from "./storage";
import { installTaskboardUrl } from "./taskboardUrl";
import {
  onTaskboardThemeChange,
  publishTheme,
  setThemeTarget,
  type TaskboardTheme,
} from "./themeTarget";
import "./styles.css";

export interface TaskboardEmbedOptions {
  /** Initial theme for the board; overrides the app's own resolution. */
  theme?: TaskboardTheme;
  /** Called whenever the board's theme changes (user toggle or host push). */
  onThemeChange?: (theme: TaskboardTheme) => void;
}

/**
 * Mount the full taskboard app into a container inside the host page.
 *
 * The app keeps its project/issue routing on a private virtual URL and writes
 * its theme onto the container, so the host page's history, URL, and theme
 * attributes stay untouched.
 *
 * @param container - the element to render the board into.
 * @returns a function that unmounts the board.
 */
export async function mountTaskboard(
  container: HTMLElement,
  options: TaskboardEmbedOptions = {},
): Promise<() => void> {
  const initialHref = new URL(window.location.href);
  if (options.theme) initialHref.searchParams.set("theme", options.theme);
  initialHref.searchParams.set("host", "dsh");
  installTaskboardUrl({ embedded: true, initialHref: initialHref.href });
  setThemeTarget(container);
  await initializeTaskboardStorage();
  const unsubscribe = options.onThemeChange
    ? onTaskboardThemeChange(options.onThemeChange)
    : null;
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return () => {
    unsubscribe?.();
    root.unmount();
  };
}

/**
 * Push a theme into a mounted board from the host side.
 */
export function setEmbedTheme(theme: TaskboardTheme): void {
  publishTheme(theme);
}
