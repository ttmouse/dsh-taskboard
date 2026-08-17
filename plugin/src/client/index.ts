/**
 * dsh-taskboard — browser half.
 *
 * Injects the sidebar entry row and mounts the full taskboard app in an
 * iframe inside the center column, same-origin at /dsh-taskboard/ (served by
 * the host half through the shared webserver). The iframe keeps the fork's
 * entire UI (board/list/gantt/workflow/dashboard/AI chat) pixel-identical and
 * lets the app's own relative API base resolve without CORS.
 *
 * Mounting follows the sibling-panel protocol of the official plugin family:
 * sidebar entry = plain DOM row injected after the New Session button
 * (MutationObserver self-healing), board view = extra trailing child of the
 * conversation grid item toggled by a data attribute on <html>, and panel
 * exclusivity via the shared `data-dsh-ssh-active` / `dsh-panel-activate`
 * protocol. Failure policy: DOM mounting problems are logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws.
 */

import { TaskboardSettingsCard } from './settings-card'

/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'

/** One side panel: sidebar entry row + center-column iframe view, exclusive with siblings. */
interface PanelSpec {
  /** Panel name carried in the cross-plugin activation event. */
  name: string
  /** Data attribute identifying the injected sidebar entry row. */
  entrySelector: string
  /** html attribute toggling this panel's center view. */
  activeAttr: string
  /** data attribute on the panel's view container. */
  viewAttr: string
  /** App URL (proxied by the host half on the shared webserver). */
  url: string
  /** Locale key for the entry label. */
  entryLabelKey: string
}

/** The taskboard panel: the full board app. */
const TASKBOARD_PANEL: PanelSpec = {
  name: 'taskboard',
  entrySelector: '[data-dsh-taskboard-entry]',
  activeAttr: 'data-dsh-taskboard-active',
  viewAttr: 'data-dsh-taskboard-view',
  url: '/dsh-taskboard/',
  entryLabelKey: 'entry.label',
}

/** The automation panel: the global routines list page (standalone mode). */
const AUTOMATION_PANEL: PanelSpec = {
  name: 'automation',
  entrySelector: '[data-dsh-automation-entry]',
  activeAttr: 'data-dsh-automation-active',
  viewAttr: 'data-dsh-automation-view',
  url: '/dsh-taskboard/?view=routines&host=dsh',
  entryLabelKey: 'entry.automation',
}

/** All panels owned by this plugin, in sidebar order. */
const PANELS: PanelSpec[] = [TASKBOARD_PANEL, AUTOMATION_PANEL]

/** GUI theme attribute (ui-theme writes it on <body>); absence means light. */
const GUI_THEME_ATTR = 'data-ds-dark-theme'

/** Message the app accepts from its parent window to switch theme. */
const THEME_MESSAGE = 'taskboard:theme'

/** host=dsh turns on the app's parent-message protocol without Codex automation routing. */
const HOST_QUERY = 'host'
const HOST_VALUE = 'dsh'

/** The app's initial-theme query param (also honors its own storage fallback). */
const THEME_QUERY = 'theme'

/**
 * Current GUI theme: dark when the shell's dark-theme attribute is present.
 * @returns 'dark' or 'light'.
 */
function currentGuiTheme(): 'dark' | 'light' {
  return document.body.hasAttribute(GUI_THEME_ATTR) ? 'dark' : 'light'
}

/** Inline icon (matches the shell's 16px nav-icon look). */
const ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>`

/** Theme-following styles, scoped by plugin data attributes (rides --dsw-* tokens). */
function buildStyleText(): string {
  const viewRules = PANELS.map((panel) => `
[${panel.viewAttr}] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base);
}
[${panel.viewAttr}] iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
html[${panel.activeAttr}]:not([data-dsh-ssh-active]) [data-pane='conversation'] > div[${panel.viewAttr}],
html[${panel.activeAttr}]:not([data-dsh-ssh-active]) [class*='centerCol'] > div[${panel.viewAttr}] {
  display: block !important;
}
html[${panel.activeAttr}]:not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([${panel.viewAttr}]),
html[${panel.activeAttr}]:not([data-dsh-ssh-active]) [class*='centerCol'] > :not([${panel.viewAttr}]) {
  display: none !important;
}
`)
  const entryRules = PANELS.map((panel) => `
[${panel.entrySelector}] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
[${panel.entrySelector}]:hover {
  background: var(--dsw-specific-sidebar-nav-item-hover);
  color: var(--dsw-alias-label-primary);
}
[${panel.entrySelector}][data-active] {
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[${panel.entrySelector}] span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
`)
  return `${viewRules.join('')}${entryRules.join('')}`.trim()
}

/** Inject the theme-following stylesheet once (plugin-owned tag). */
function ensureStyle(): void {
  const tagId = 'dsh-taskboard-shell'
  if (document.querySelector(`style[data-taskboard-shell-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.taskboardShellCss = tagId
  tag.textContent = buildStyleText()
  document.head.appendChild(tag)
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(
  toggle: () => void,
  isOpen: () => boolean,
  label: () => string,
): { element: HTMLButtonElement; refreshLabel(): void } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshTaskboardEntry = ''
  const labelSpan = document.createElement('span')
  const refreshLabel = (): void => {
    entry.setAttribute('aria-label', label())
    labelSpan.textContent = label()
  }
  refreshLabel()
  entry.innerHTML = `<span>${ICON}</span>`
  entry.appendChild(labelSpan)
  entry.addEventListener('click', () => toggle())
  refreshEntryState(entry, isOpen)
  return { element: entry, refreshLabel }
}

/** Apply the entry row's active styling to match the current open state. */
function refreshEntryState(entry: HTMLElement, isOpen: () => boolean): void {
  if (isOpen()) entry.dataset.active = ''
  else delete entry.dataset.active
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement
        && el.matches('[data-dsh-taskboard-entry], [data-dsh-automation-entry], [data-dsh-ssh-entry]'),
    )
    // Entries keep sidebar order: each new entry lands after the last plugin row.
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/** Watch for the sidebar root and keep the entry placed across shell re-renders. */
/**
 * Watch for the sidebar root and keep the entry placed across shell re-renders.
 * @param label - resolves the entry label text (locale-aware at call time).
 */
function mountSidebarEntry(
  toggle: () => void,
  isOpen: () => boolean,
  label: () => string,
): { dispose(): void; refreshLabel(): void } {
  ensureStyle()
  const created = createEntry(toggle, isOpen, label)
  const entry = created.element
  let root: HTMLElement | undefined
  const place = (): void => {
    const candidate = sidebarRoot()
    if (candidate === undefined || candidate === root) return
    root = candidate
    if (!placeEntry(root, entry)) root = undefined
  }
  place()
  const observer = new MutationObserver(() => place())
  observer.observe(document.body, { childList: true, subtree: true })
  return {
    dispose: () => {
      observer.disconnect()
      entry.remove()
    },
    refreshLabel: created.refreshLabel,
  }
}

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  // The shell only emits data-pane attributes when the panel-capable official
  // plugins (dsh-ssh / task-board family) register; fall back to the shell's
  // own center-column class so a minimal profile (this plugin alone) mounts.
  return document.querySelector<HTMLElement>('[data-pane="conversation"]')
    ?? document.querySelector<HTMLElement>('[class*="centerCol"]')
    ?? undefined
}

/** dataset key for a data attribute (data-dsh-automation-view -> dshAutomationView). */
function datasetKeyFor(attr: string): string {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** Panel title per spec (the iframe's accessible name). */
function panelTitle(spec: PanelSpec): string {
  return spec.name === 'taskboard' ? '任务看板' : '自动化'
}

/**
 * Mount one panel's iframe container into the center column. The container is
 * hidden by CSS unless the html activation attribute is present, so the app
 * stays mounted and stateful across toggles. The GUI theme is pushed into the
 * iframe (initial via query, then live via postMessage), so the panel follows
 * the shell's light/dark switch.
 * @param spec - the panel definition (view attribute + app URL).
 * @param frameRef - holder for the live iframe (execution bridge targets it).
 * @returns ensure (create the container once the column exists) and dispose.
 */
function mountPanelView(spec: PanelSpec, frameRef: { current: HTMLIFrameElement | undefined }): { ensure(): void; dispose(): void } {
  ensureStyle()
  let container: HTMLDivElement | undefined
  let frame: HTMLIFrameElement | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  /** Push the current GUI theme into the panel once its window is ready. */
  const syncTheme = (): void => {
    if (frame === undefined || frame.contentWindow === null) return
    frame.contentWindow.postMessage({ type: THEME_MESSAGE, theme: currentGuiTheme() }, '*')
  }

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset[datasetKeyFor(spec.viewAttr)] = ''
    frame = document.createElement('iframe')
    frameRef.current = frame
    const initialUrl = new URL(spec.url, window.location.href)
    initialUrl.searchParams.set(THEME_QUERY, currentGuiTheme())
    initialUrl.searchParams.set(HOST_QUERY, HOST_VALUE)
    frame.src = initialUrl.href
    frame.title = panelTitle(spec)
    frame.addEventListener('load', () => {
      // The app registers its message listener after the React mount, which
      // can lag the load event; retry once shortly after to cover the gap.
      syncTheme()
      retryTimer = setTimeout(syncTheme, 800)
    })
    container.appendChild(frame)
    column.appendChild(container)
  }

  const observer = new MutationObserver(() => ensure())
  observer.observe(document.body, { childList: true, subtree: true })
  const themeObserver = new MutationObserver(syncTheme)
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: [GUI_THEME_ATTR],
  })
  ensure()

  return {
    ensure,
    dispose: () => {
      observer.disconnect()
      themeObserver.disconnect()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (frameRef.current === frame) frameRef.current = undefined
      container?.remove()
    },
  }
}

/** The taskboard app's execute command (iframe → shell), enabled by host=dsh. */
const DSH_EXECUTE_MESSAGE = 'taskboard:dsh-execute'

/** Taskboard route prefix proxied by the host half on the shared webserver. */
const BOARD_API_PREFIX = '/dsh-taskboard'

/** Message payload of the app's dsh-execute command. */
interface ExecutePayload {
  taskId: string
  identifier?: string
  prompt: string
  workspacePath?: string | null
  projectId?: string | null
}

/**
 * Minimal structural faces of the injected sessions/workspaces services.
 * Type-only shape contracts — no runtime import, so the bundle stays free of
 * harness dependencies; the injected service instances satisfy these at run
 * time (see @deepseek-ai/dsh-client-runtime/client: ISessions / IWorkspaces).
 */
interface SessionPromptFace {
  prompt(content: Array<{ type: string; text: string }>, mode: 'queue' | 'steer'): Promise<{ ok: boolean }>
}
interface SessionsService {
  list: { getSnapshot(): { current?: string | null; ids: string[] } }
  binding(id: string): { session: SessionPromptFace } | undefined
}
interface WorkspacesService {
  create(input: { path: string }): Promise<{ id: string }>
  startSession(workspaceId?: string): void
}

/** Minimal structural face of the injected locale service. */
interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

/** Minimal structural face of the injected slots service. */
interface SlotsService {
  inject(name: string, factory: () => unknown): () => void
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: () => unknown
  }, Component: unknown): () => void
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-taskboard'

/** zh/en dictionaries for the namespace (card copy + shell strings). */
const DICTIONARIES = {
  zh: {
    'entry.label': '任务看板',
    'entry.automation': '自动化',
    'execute.started': '已交给 DeepSeek Harness 执行：{prompt}',
    'execute.failed': '已打开 DSH 会话，但提示词未能入队，请查看会话状态。',
    'card.title': '任务看板（dsh-taskboard）',
    'card.open': '打开任务看板',
    'card.description': '完整 SQLite 任务板：看板/列表/甘特/工作流/仪表盘/AI 对话。卡片执行直接驱动 DSH 会话。',
    'card.storage': '数据存储于本机 SQLite（~/.dsh/storages/dsh-taskboard）。',
  },
  en: {
    'entry.label': 'Taskboard',
    'entry.automation': 'Automation',
    'execute.started': 'Handed off to DeepSeek Harness: {prompt}',
    'execute.failed': 'DSH session opened, but the prompt could not be queued. Check the session.',
    'card.title': 'Taskboard (dsh-taskboard)',
    'card.open': 'Open taskboard',
    'card.description': 'Full SQLite taskboard: board/list/gantt/workflow/dashboard/AI chat. Card execution drives real DSH sessions.',
    'card.storage': 'Data is stored in a local SQLite database (~/.dsh/storages/dsh-taskboard).',
  },
} as const

/** Append a progress note to the task; best-effort (the SSE broadcast updates the board). */
function appendTaskComment(taskId: string, body: string): void {
  void fetch(
    `${BOARD_API_PREFIX}/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  ).catch(() => {})
}

/**
 * Bridge for the app's dsh-execute command: create (or reuse) a real DSH
 * session in this GUI, queue the task prompt into it, and note the handoff on
 * the task. The shell opens the new session so the user sees the execution.
 * @param sessions - injected sessions service.
 * @param workspaces - injected workspaces service.
 * @param frame - current board iframe (messages must come from it).
 */
function mountExecutionBridge(
  sessions: SessionsService,
  workspaces: WorkspacesService,
  frame: () => HTMLIFrameElement | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): () => void {
  /** Wait until the freshly started session is current, then prompt into it. */
  const promptIntoCurrent = (prompt: string): Promise<boolean> =>
    new Promise((resolve) => {
      const startedAt = Date.now()
      const check = (): void => {
        const snapshot = sessions.list.getSnapshot()
        const current = snapshot?.current
        if (typeof current === 'string' && current !== '') {
          const binding = sessions.binding(current)
          if (binding !== undefined) {
            void Promise.race([
              binding.session.prompt([{ type: 'text', text: prompt }], 'queue').then((result) => result.ok),
              new Promise<boolean>((r) => setTimeout(() => r(false), 20000)),
            ]).then(resolve)
            return
          }
        }
        if (Date.now() - startedAt > 15000) {
          resolve(false)
          return
        }
        setTimeout(check, 250)
      }
      check()
    })

  const runExecution = async (payload: ExecutePayload): Promise<void> => {
    appendTaskComment(payload.taskId, t('execute.started', { prompt: payload.prompt.slice(0, 200) }))
    let workspaceId: string | undefined
    if (typeof payload.workspacePath === 'string' && payload.workspacePath !== '') {
      try {
        workspaceId = (await workspaces.create({ path: payload.workspacePath })).id
      } catch {
        workspaceId = undefined
      }
    }
    workspaces.startSession(workspaceId)
    const accepted = await promptIntoCurrent(payload.prompt)
    if (!accepted) appendTaskComment(payload.taskId, t('execute.failed'))
  }

  const onMessage = (event: MessageEvent): void => {
    const target = frame()
    if (target === undefined || event.source !== target.contentWindow) return
    const data = event.data as { type?: string; payload?: unknown }
    if (data.type !== DSH_EXECUTE_MESSAGE) return
    const payload = data.payload as ExecutePayload | undefined
    if (payload === undefined || typeof payload.prompt !== 'string' || typeof payload.taskId !== 'string') return
    void runExecution(payload)
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/**
 * Mount the taskboard shell (sidebar entry, board view, execution bridge,
 * locale dictionaries, and the settings card).
 * @param ctx - client root context with sessions/workspaces/locale/slots.
 */
export const inject = ['sessions', 'workspaces', 'locale', 'slots']

export function apply(ctx: {
  effect(fn: () => () => void, label: string): void
  on(event: string, listener: (snapshot: unknown) => void): void
  sessions: SessionsService
  workspaces: WorkspacesService
  locale: LocaleService
  slots: SlotsService
}): void {
  const open = new Map<string, boolean>(PANELS.map((panel) => [panel.name, false]))
  const frameRefs = new Map<string, { current: HTMLIFrameElement | undefined }>(
    PANELS.map((panel) => [panel.name, { current: undefined }]),
  )
  const ensures = new Map<string, () => void>()

  // i18n: register the owned namespace, then translate shell strings through
  // the bound function (re-bound on locale changes; the entry labels refresh).
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-taskboard: dictionaries')
  let t = ctx.locale.bind(NS)

  const setOpen = (panel: PanelSpec, value: boolean): void => {
    if (open.get(panel.name) === value) return
    open.set(panel.name, value)
    ensures.get(panel.name)?.()
    if (value) {
      // Single-occupant center column: opening this panel must evict every
      // sibling (ssh and our other panels), both their html attributes and
      // controller states, otherwise the visibility rules fight.
      document.documentElement.removeAttribute('data-dsh-ssh-active')
      for (const other of PANELS) document.documentElement.removeAttribute(other.activeAttr)
      document.documentElement.setAttribute(panel.activeAttr, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: panel.name }))
    } else {
      document.documentElement.removeAttribute(panel.activeAttr)
    }
    const entry = document.querySelector<HTMLElement>(panel.entrySelector)
    if (entry !== null) refreshEntryState(entry, () => open.get(panel.name) === true)
  }

  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail
    for (const panel of PANELS) {
      if (detail !== panel.name && open.get(panel.name) === true) setOpen(panel, false)
    }
  }
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  // The settings card asks to open the board.
  document.addEventListener('dsh-taskboard-request-open', () => setOpen(TASKBOARD_PANEL, true))

  ctx.effect(() => {
    const mounted = PANELS.map((panel) => mountSidebarEntry(
      () => setOpen(panel, !(open.get(panel.name) === true)),
      () => open.get(panel.name) === true,
      () => t(panel.entryLabelKey),
    ))
    const onLocaleChange = (): void => {
      t = ctx.locale.bind(NS)
      for (const entry of mounted) entry.refreshLabel()
    }
    ctx.on('locale/change', onLocaleChange)
    return () => {
      for (const entry of mounted) entry.dispose()
    }
  }, 'dsh-taskboard: sidebar entries')

  ctx.effect(() => {
    const panels = PANELS.map((panel) => {
      const view = mountPanelView(panel, frameRefs.get(panel.name)!)
      ensures.set(panel.name, () => view.ensure())
      return view
    })
    // Jump out on sidebar context clicks: clicking a session/workspace row
    // (including the already-current one, which produces no session-change
    // event) hands the center column back to the conversation. Capture phase,
    // so the panel closes before the shell processes the click.
    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
    const onClickSidebarRow = (event: Event): void => {
      if (!PANELS.some((panel) => open.get(panel.name) === true)) return
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) {
        for (const panel of PANELS) setOpen(panel, false)
      }
    }
    document.addEventListener('click', onClickSidebarRow, true)
    return () => {
      document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
      document.removeEventListener('dsh-taskboard-request-open', () => setOpen(TASKBOARD_PANEL, true))
      document.removeEventListener('click', onClickSidebarRow, true)
      for (const view of panels) view.dispose()
    }
  }, 'dsh-taskboard: panel views')

  ctx.effect(() => mountExecutionBridge(
    ctx.sessions,
    ctx.workspaces,
    () => frameRefs.get(TASKBOARD_PANEL.name)?.current,
    (key, params) => t(key, params),
  ), 'dsh-taskboard: dsh execution bridge')

  // Settings card: fill the plugin item hole in the settings panel.
  ctx.effect(() => {
    const disposeCard = ctx.slots.inject('web-ui.plugin.item', () => ctx.slots.register({
      name: 'web-ui.plugin.item',
      id: 'dsh-taskboard',
      order: 105,
      locale: NS,
    }, TaskboardSettingsCard))
    return disposeCard
  }, 'dsh-taskboard: settings card')
}
