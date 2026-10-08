import { useEffect } from "react";
import { resolveTaskboardUrl } from "./api";

const BUNDLE_PATTERN = /assets\/index-([A-Za-z0-9_-]+)\.js/g;

function extractBundleHashes(html: string): string[] {
  return [...html.matchAll(BUNDLE_PATTERN)].map((match) => match[1]);
}

function ownBundleHash(): string | null {
  for (const script of document.querySelectorAll('script[src*="index-"]')) {
    const match = script.getAttribute("src")?.match(/index-([A-Za-z0-9_-]+)\.js/);
    if (match) return match[1];
  }
  return null;
}

function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem("taskboard-reloaded-for");
  } catch {
    return null;
  }
}

/**
 * A long-lived webview (the desktop GUI keeps the board iframe alive for
 * days) keeps running whatever bundle it booted with, so fixes shipped to
 * disk never reach the user until a manual refresh — repeatedly mistaken
 * for "the bug is still there". Poll the served index.html and hard-reload
 * once when a different bundle is deployed. The sessionStorage guard keeps
 * a broken/looping deployment from reloading forever.
 */
export function useAppVersionCheck(): void {
  useEffect(() => {
    let disposed = false;

    async function check(): Promise<void> {
      if (disposed) return;
      const current = ownBundleHash();
      if (!current) return;
      let hashes: string[] = [];
      try {
        const response = await fetch(resolveTaskboardUrl("/"), { cache: "no-store" });
        if (!response.ok) return;
        hashes = extractBundleHashes(await response.text());
      } catch {
        return;
      }
      if (disposed) return;
      if (hashes.length > 0 && !hashes.includes(current)) {
        if (reloadedFor() === hashes[0]) return;
        try {
          sessionStorage.setItem("taskboard-reloaded-for", hashes[0]);
        } catch {
          /* ignore */
        }
        window.location.reload();
      }
    }

    const interval = window.setInterval(() => void check(), 60_000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    void check();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
