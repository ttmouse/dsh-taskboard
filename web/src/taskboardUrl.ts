/**
 * Virtual location for embedded mounts.
 *
 * The standalone app routes projects/issues through window.history and URL
 * search params. An embedded mount (DSH GUI direct render) must keep that
 * routing inside its own virtual URL space, or it would rewrite the host
 * page's history and URL.
 */

let embedded = false
let virtualHref = ""

/**
 * Switch the app between real-history routing and virtual routing.
 * @param options.embedded - true keeps history operations on a private URL.
 * @param options.initialHref - the initial virtual URL when embedded; defaults
 * to the current page URL.
 */
export function installTaskboardUrl(options: { embedded: boolean; initialHref?: string }): void {
  embedded = options.embedded
  virtualHref = options.initialHref ?? window.location.href
}

/** Whether history operations currently target the virtual URL space. */
export function isTaskboardUrlEmbedded(): boolean {
  return embedded
}

/**
 * The URL the app should read for routing.
 * @returns the virtual URL when embedded, otherwise the real location.
 */
export function getTaskboardLocation(): URL {
  return embedded ? new URL(virtualHref) : new URL(window.location.href)
}

/**
 * History push that stays on the virtual URL when embedded.
 * Dispatches a popstate event so the app's existing route-sync listener
 * re-reads the (virtual) location, mirroring how real history drives it.
 */
export function taskboardPushState(state: unknown, url: string | URL): void {
  if (!embedded) {
    window.history.pushState(state, "", url)
    return
  }
  virtualHref = new URL(url, virtualHref).href
  window.dispatchEvent(new PopStateEvent("popstate", { state }))
}

/**
 * History replace that stays on the virtual URL when embedded.
 * No event is dispatched: browsers do not fire popstate on replaceState, and
 * route state is re-read on demand or via the following pushState.
 */
export function taskboardReplaceState(state: unknown, url: string | URL): void {
  if (!embedded) {
    window.history.replaceState(state, "", url)
    return
  }
  virtualHref = new URL(url, virtualHref).href
}
