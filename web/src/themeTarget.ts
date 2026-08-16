/**
 * Injectable theme target and theme bridge for embedded mounts.
 *
 * The standalone app writes its theme (data-theme / color-scheme) onto
 * `document.documentElement`. An embedded mount (DSH GUI direct render) must
 * write onto its own container instead, or it would restyle the host page.
 * Defaults keep the standalone behavior unchanged. The bridge lets the host
 * push a theme into the app and observe the app's own theme changes.
 */

export type TaskboardTheme = "light" | "dark"

let themeTarget: HTMLElement | null = null
const changeListeners = new Set<(theme: TaskboardTheme) => void>()

/**
 * Redirect where the app applies its theme attributes.
 * @param element - the element to write data-theme / color-scheme onto, or
 * null to restore the document-element default.
 */
export function setThemeTarget(element: HTMLElement | null): void {
  themeTarget = element
}

/**
 * The element the app currently writes its theme to.
 * @returns the configured target, or `document.documentElement` by default.
 */
export function getThemeTarget(): HTMLElement {
  return themeTarget ?? document.documentElement
}

/**
 * Publish a theme change to bridge subscribers.
 * The app calls this from its theme effect; the host calls it to push a
 * theme into the app.
 */
export function publishTheme(theme: TaskboardTheme): void {
  for (const listener of changeListeners) listener(theme)
}

/**
 * Subscribe to theme changes (app-internal or host-pushed).
 * @returns a function that removes the subscription.
 */
export function onTaskboardThemeChange(listener: (theme: TaskboardTheme) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
