/**
 * dsh-taskboard — browser half.
 *
 * Contributes two global main panels through the shell's own slot contract,
 * exactly like the official Plugins and scheduled-task panels do:
 *
 *   - `sidebar.panellist` (list, id = panel id) — the sidebar row. The shell
 *     owns the row chrome (36px row, 4px gaps, hover/active fill, collapsed
 *     icon rail, tooltip, keyboard), so spacing and states cannot drift from
 *     the official entries.
 *   - `main` (keyed, key = panel id) — the center-column view. The shell
 *     renders the selected key and unmounts the rest, so panel exclusivity
 *     (conversation ⟷ ours ⟷ official panels) is the layout store's business,
 *     not ours to enforce with CSS.
 *
 * The view itself is still the fork's SPA in a same-origin iframe at
 * /dsh-taskboard/ (served by the host half through the shared webserver):
 * the iframe keeps the entire UI (board/list/gantt/workflow/dashboard/AI chat)
 * intact and lets the app's relative API base resolve without CORS.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactElement } from 'react'
import { TaskboardSettingsCard } from './settings-card'

/** Sidebar icon share supplied by the shell's panel row. */
interface PanelIconProps {
  /** Requested square edge in pixels (16 expanded, 18 in the collapsed rail). */
  size: number
  /** Whether this panel is the selected main panel (absent outside the panel row). */
  active?: boolean
}

/** Panel component props (the `t` seat of the registered locale namespace). */
interface PanelViewProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Live iframe holder, read by the execution/open-thread message bridges. */
interface FrameRef {
  current: HTMLIFrameElement | undefined
}

/** One global main panel: a sidebar row plus the center-column view it opens. */
interface PanelSpec {
  /** Panel id — the `sidebar.panellist` id AND the `main` slot key. */
  name: string
  /** Sidebar row order (official entries use 0 = Plugins, 10 = scheduled tasks). */
  order: number
  /** App URL (proxied by the host half on the shared webserver). */
  url: string
  /** Locale key for the row label and the iframe title. */
  entryLabelKey: string
  /** Glyph renderer, sized by the shell. */
  Icon: (props: PanelIconProps) => ReactElement
}

/**
 * Task glyph, shared by every taskboard entry point (the sidebar row and the
 * conversation-header button): the shell's own task-list artwork, inlined.
 * This is the geometry of `IconChecklistOutlineRegular` from
 * @deepseek-ai/dsh-client-ui-primitives (two bullets with rules, strokeWidth
 * 1, 16px box) — inlined rather than imported so this bundle keeps no
 * dependency on the primitives package, and used instead of a board mark
 * because both seats stand for the project's *tasks*.
 */
function TasksIcon({ size }: PanelIconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z" />
      <path d="M7.5 4.5H13.5" />
      <path d="M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z" />
      <path d="M7.5 11.5H13.5" />
    </svg>
  )
}

/** Automation row glyph: a lightning bolt (scheduled triggers). */
function AutomationIcon({ size }: PanelIconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 1.5 3 9.5h3.5L7 14.5 13 6.5H9.5z" />
    </svg>
  )
}

/** The taskboard panel: the full board app. */
const TASKBOARD_PANEL: PanelSpec = {
  name: 'taskboard',
  order: 20,
  url: '/dsh-taskboard/',
  entryLabelKey: 'entry.label',
  Icon: TasksIcon,
}

/** The automation panel: the global routines list page (standalone mode). */
const AUTOMATION_PANEL: PanelSpec = {
  name: 'automation',
  order: 30,
  url: '/dsh-taskboard/?view=routines&host=dsh',
  entryLabelKey: 'entry.automation',
  Icon: AutomationIcon,
}

/** All panels owned by this plugin, in sidebar order. */
const PANELS: PanelSpec[] = [TASKBOARD_PANEL, AUTOMATION_PANEL]

/** Right-sidebar tab: implementation id AND the body/title slot key. */
const SIDE_TAB_ID = '@ttmouse/dsh-taskboard/tasks'

/** Right-sidebar tab kind: a page type, opened from the guide page. */
const SIDE_TAB_KIND = 'taskboard-tasks'

/** Tab-chip glyph style, matching the official schedule tab title icon. */
const TAB_TITLE_ICON_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  flex: 'none',
} as const

/** Hint paragraph style (resolved/empty states; inline keeps style ownership trivial). */
const SIDE_HINT_STYLE = {
  margin: 0,
  padding: '24px 16px',
  color: 'var(--dsh-text-secondary, inherit)',
  opacity: 0.7,
  fontSize: 13,
  textAlign: 'center',
} as const

/** Full-height wrapper so the iframe fills the sidebar pane. */
const SIDE_FRAME_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
} as const

/**
 * Conversation-header glyph button. The shell's own header actions (the
 * scheduled-task catalog) are 28×28 round icon buttons in
 * `--dsw-alias-label-tertiary` that fill on hover, so this entry uses the same
 * measurements and tokens — inline styles, no owned stylesheet, so nothing
 * here can drift from (or survive) the module system's style ownership.
 */
const HEADER_BUTTON_STYLE = {
  width: 28,
  height: 28,
  padding: 0,
  border: 0,
  borderRadius: 28,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  cursor: 'pointer',
} as const

/** Hover state of the header button, matching the shell's icon-button fill. */
const HEADER_BUTTON_HOVER_STYLE = {
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
} as const

/** GUI theme attribute (ui-theme writes it on <body>); absence means light. */
const GUI_THEME_ATTR = 'data-ds-dark-theme'

/** Message the app accepts from its parent window to switch theme. */
const THEME_MESSAGE = 'taskboard:theme'

/** host=dsh turns on the app's parent-message protocol without host automation routing. */
const HOST_QUERY = 'host'
const HOST_VALUE = 'dsh'

/** The app's initial-theme query param (also honors its own storage fallback). */
const THEME_QUERY = 'theme'

/**
 * The app's language query param. The app resolves its UI language from
 * `?lang=` (falling back to the browser), so the shell's own locale — not the
 * browser's — decides whether the board opens in Chinese or English.
 */
const LANG_QUERY = 'lang'

/**
 * Current GUI theme: dark when the shell's dark-theme attribute is present.
 * @returns 'dark' or 'light'.
 */
function currentGuiTheme(): 'dark' | 'light' {
  return document.body.hasAttribute(GUI_THEME_ATTR) ? 'dark' : 'light'
}

/**
 * The shell's active locale id, re-read on every locale change. The embedded
 * app resolves its UI language from the id (Chinese only for `zh*`), so the
 * board follows the shell's language setting the same way it follows its theme.
 * @param locale - injected shell locale service.
 * @returns the active locale id (e.g. 'zh', 'en').
 */
function useShellLocale(locale: LocaleService): string {
  const subscribe = useCallback((onChange: () => void) => locale.subscribe(onChange), [locale])
  const read = useCallback(() => locale.getLocale().active, [locale])
  return useSyncExternalStore(subscribe, read, read)
}

/** Full-bleed frame: the keyed `main` entry renders under a `display: contents` anchor. */
const FRAME_STYLE = {
  display: 'block',
  flex: '1 1 auto',
  width: '100%',
  height: '100%',
  minHeight: 0,
  border: 0,
} as const

/**
 * The board SPA in an iframe. Mounted only while this panel is the selected
 * main panel (the shell unmounts the losing key), and the GUI theme is pushed
 * into the app — initial theme via query param, live theme via postMessage.
 * @param props - app URL, accessible title, and the shared frame holder.
 * @returns the panel's only element.
 */
function PanelFrame({ url, title, frameRef, locale }: {
  url: string
  title: string
  frameRef: FrameRef
  locale: LocaleService
}): JSX.Element {
  const localRef = useRef<HTMLIFrameElement | null>(null)
  const language = useShellLocale(locale)

  /** Push the current GUI theme into the app once its window is ready. */
  const syncTheme = useCallback((): void => {
    const frame = localRef.current
    if (frame === null || frame.contentWindow === null) return
    frame.contentWindow.postMessage({ type: THEME_MESSAGE, theme: currentGuiTheme() }, '*')
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.body, { attributes: true, attributeFilter: [GUI_THEME_ATTR] })
    return () => observer.disconnect()
  }, [syncTheme])

  // Resolved once per mount: the app reads its initial theme from the query,
  // and the live push below keeps it in step afterwards.
  const src = useMemo(() => {
    const initialUrl = new URL(url, window.location.href)
    initialUrl.searchParams.set(THEME_QUERY, currentGuiTheme())
    initialUrl.searchParams.set(HOST_QUERY, HOST_VALUE)
    initialUrl.searchParams.set(LANG_QUERY, language)
    return initialUrl.href
  }, [url, language])

  const attach = useCallback((element: HTMLIFrameElement | null): void => {
    localRef.current = element
    frameRef.current = element ?? undefined
  }, [frameRef])

  return (
    <iframe
      ref={attach}
      src={src}
      title={title}
      style={FRAME_STYLE}
      onLoad={() => {
        // The app registers its message listener after the React mount, which
        // can lag the load event; retry once shortly after to cover the gap.
        syncTheme()
        window.setTimeout(syncTheme, 800)
      }}
    />
  )
}

/** The taskboard app's execute command (iframe → shell), enabled by host=dsh. */
const DSH_EXECUTE_MESSAGE = 'taskboard:dsh-execute'

/** The taskboard app's open-conversation command (iframe → shell). */
const OPEN_THREAD_MESSAGE = 'taskboard:open-thread'

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
/**
 * A session summary entry in the sessions list snapshot. The runtime list
 * carries `blank` (fresh session with no messages) and `cwd` per session —
 * the same fields UiWorkspace.connectWorkspace reads to decide session
 * reuse. Kept optional so a host lacking the fields degrades to refusal
 * rather than an unsafe fallback.
 */
interface SessionListSummary {
  id: string
  blank?: boolean
  cwd?: string
}
interface SessionsService {
  list: {
    getSnapshot(): {
      current?: string | null
      ids: string[]
      byId?: Record<string, SessionListSummary>
    }
  }
  binding(id: string): { session: SessionPromptFace } | undefined
  /** Re-pull the persisted session baseline (single-flight in the shell). */
  refresh(): Promise<void>
}
interface WorkspacesService {
  create(input: { path: string }): Promise<{ id: string }>
  startSession(workspaceId?: string): void
}

/** Minimal structural face of the injected locale service. */
interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  /** Current locale snapshot; `active` is the shell's selected language id. */
  getLocale(): { active: string }
  /** Notified on every locale change (active switch or dictionary registration). */
  subscribe(onChange: () => void): () => void
}

/** Registration options of one slot entry (the fields this plugin uses). */
interface SlotRegisterOptions {
  name: string
  /** `list` slot id / `keyed` slot key. */
  id?: string
  key?: string
  order?: number
  locale?: string
  /** Row title for `sidebar.panellist`; re-resolved by the shell on locale change. */
  label?: () => string
  /** Per-scope injection; the return value becomes the component's props. */
  inject?: (...args: unknown[]) => unknown
}

/** Minimal structural face of the injected slots service. */
interface SlotsService {
  inject(name: string, factory: () => unknown): () => void
  register(options: SlotRegisterOptions, component: unknown): () => void
}

/** Minimal structural face of the injected layout service (main-panel selection). */
interface LayoutService {
  /**
   * Select a global main panel; null returns to the conversation.
   * @throws when the panel id has no registered `main` entry.
   */
  selectPanel(panelId: string | null): void
}

/**
 * One right-sidebar tab type registration (the fields this plugin uses of
 * the official `sidebarRightTabs.register` contract, see
 * @deepseek-ai/dsh-client-ui-sidebar-right README §Extension seats).
 */
interface SidebarRightTabDefinition {
  /** Unique implementation id; also the body/title slot key. */
  id: string
  /** Tab kind; a page type opens by kind (guide entry / openTab). */
  kind: string
  /** Tab chip text, re-resolved on locale change. */
  title: () => string
  /** Guide page entry boxes (the + page in the tab strip). */
  guide?: Array<{
    id: string
    order?: number
    title: () => string
    description: () => string
    /** Artwork component; the shell sizes it. */
    icon?: (props: { size?: number }) => ReactElement
  }>
  /** Keep the body mounted while the tab is not on screen. */
  keepMounted?: boolean
}

/** Minimal structural face of the injected right-sidebar tab registry. */
interface SidebarRightTabsService {
  register(definition: SidebarRightTabDefinition): () => void
}

/**
 * Minimal structural face of the injected right sidebar (the fields this
 * plugin uses of the official `sidebarRight` service, see
 * @deepseek-ai/dsh-client-ui-sidebar-right README §Extension seats). `openTab`
 * expands the column and opens — or reveals — the page type's tab in the
 * on-screen session.
 */
interface SidebarRightService {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-taskboard'

/** zh/en dictionaries for the namespace (card copy + shell strings). */
const DICTIONARIES = {
  zh: {
    'entry.label': '任务看板',
    'entry.automation': '自动化',
    'execute.started': '已交给 DeepSeek Harness 执行：{prompt}',
    'execute.failed': '未能将任务提示词送入目标 DSH 会话（找不到或无法打开对应工作区会话），未入队。请确认该任务的项目工作区已打开后重试。',
    'card.title': '任务看板（dsh-taskboard）',
    'card.open': '打开任务看板',
    'card.description': '完整 SQLite 任务板：看板/列表/甘特/工作流/仪表盘/AI 对话。卡片执行直接驱动 DSH 会话。',
    'card.storage': '数据存储于本机 SQLite（~/.dsh/storages/dsh-taskboard）。',
    'sidepanel.label': '任务',
    'header.open': '打开任务看板',
    'sidepanel.guide.title': '任务',
    'sidepanel.guide.description': '查看当前项目的任务列表',
    'sidepanel.empty': '当前会话不属于任何看板项目。',
    'sidepanel.resolving': '正在解析当前项目…',
    'turncard.open': '打开',
    'turncard.openAria': '打开看板任务 {title}',
    'turncard.loading': '正在读取任务…',
    'turncard.missing': '任务不存在或已删除',
    'status.backlog': '待办',
    'status.todo': '待认领',
    'status.in_progress': '推进中',
    'status.in_review': '等你验收',
    'status.blocked': '卡住等你',
    'status.done': '已完成',
    'status.canceled': '已取消',
  },
  en: {
    'entry.label': 'Taskboard',
    'entry.automation': 'Automation',
    'execute.started': 'Handed off to DeepSeek Harness: {prompt}',
    'execute.failed': 'Could not deliver the task prompt to the target DSH session (no reachable session for the project workspace), so it was not queued. Make sure the workspace is open, then retry.',
    'card.title': 'Taskboard (dsh-taskboard)',
    'card.open': 'Open taskboard',
    'card.description': 'Full SQLite taskboard: board/list/gantt/workflow/dashboard/AI chat. Card execution drives real DSH sessions.',
    'card.storage': 'Data is stored in a local SQLite database (~/.dsh/storages/dsh-taskboard).',
    'sidepanel.label': 'Tasks',
    'header.open': 'Open taskboard',
    'sidepanel.guide.title': 'Tasks',
    'sidepanel.guide.description': 'Browse the current project\'s task list',
    'sidepanel.empty': 'This session does not belong to any board project.',
    'sidepanel.resolving': 'Resolving the current project…',
    'turncard.open': 'Open',
    'turncard.openAria': 'Open board task {title}',
    'turncard.loading': 'Loading task…',
    'turncard.missing': 'Task missing or deleted',
    'status.backlog': 'Backlog',
    'status.todo': 'To claim',
    'status.in_progress': 'In progress',
    'status.in_review': 'Awaiting review',
    'status.blocked': 'Blocked',
    'status.done': 'Done',
    'status.canceled': 'Canceled',
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
 * the task. The shell opens the new session (and thereby leaves the board
 * panel) so the user sees the execution.
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
  /**
   * Wait until the session started by `workspaces.startSession` becomes
   * current, then prompt into it. `startSession` navigates asynchronously
   * (its workspace connect is fire-and-forget), so naively prompting into
   * "whatever is current" races ahead and queues the task prompt into the
   * conversation that happens to be selected — usually the one the user was
   * in with the board open. Track the pre-click session and only accept a
   * different one as the started session.
   *
   * After the timeout, only the one *provably safe* fallback is kept: when
   * the pre-click session is still current AND it is the target workspace's
   * untouched blank session (same reuse rule UiWorkspace.connectWorkspace
   * applies), it IS the intended target and receives the prompt. Any other
   * state — navigation never landed, the workspace could not be opened, the
   * pre-click session is an active conversation — refuses instead of silently
   * queuing the task prompt into a conversation the user did not ask to run
   * it in.
   */
  const promptIntoStarted = (
    prompt: string,
    before: string | null | undefined,
    target: { path: string } | null,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const startedAt = Date.now()
      const queueInto = (sessionId: string): Promise<boolean> => {
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return Promise.resolve(false)
        return Promise.race([
          binding.session.prompt([{ type: 'text', text: prompt }], 'queue').then((result) => result.ok),
          new Promise<boolean>((r) => setTimeout(() => r(false), 20000)),
        ])
      }
      /** True when `sessionId` is the target workspace's fresh blank session. */
      const isSafeBlankReuse = (sessionId: string): boolean => {
        if (target === null || target.path === '') return false
        const summary = sessions.list.getSnapshot().byId?.[sessionId]
        return summary?.blank === true && summary.cwd === target.path
      }
      const check = (): void => {
        const snapshot = sessions.list.getSnapshot()
        const current = snapshot?.current
        if (typeof current === 'string' && current !== '' && current !== before) {
          void queueInto(current).then(resolve)
          return
        }
        if (Date.now() - startedAt > 15000) {
          // Navigation never landed within the wait.
          if (
            typeof current === 'string'
            && current !== ''
            && current === before
            && isSafeBlankReuse(current)
          ) {
            void queueInto(current).then(resolve)
            return
          }
          resolve(false)
          return
        }
        setTimeout(check, 250)
      }
      check()
    })

  const runExecution = async (payload: ExecutePayload): Promise<void> => {
    appendTaskComment(payload.taskId, t('execute.started', { prompt: payload.prompt.slice(0, 200) }))
    const target = { path: typeof payload.workspacePath === 'string' ? payload.workspacePath : '' }
    let workspaceId: string | undefined
    if (target.path !== '') {
      try {
        workspaceId = (await workspaces.create({ path: target.path })).id
      } catch {
        // The workspace the task belongs to cannot be registered: no reliable
        // target session exists. Fail loud instead of falling back to whatever
        // conversation is current.
        appendTaskComment(payload.taskId, t('execute.failed'))
        return
      }
    }
    const before = sessions.list.getSnapshot().current ?? null
    if (workspaceId !== undefined) workspaces.startSession(workspaceId)
    else workspaces.startSession() // pathless task: inherit the GUI's current/recent workspace
    const accepted = await promptIntoStarted(payload.prompt, before, target)
    if (!accepted) appendTaskComment(payload.taskId, t('execute.failed'))
  }

  // Serialize executions: startSession navigations and prompt queues are
  // asynchronous, so without a queue two rapid dsh-execute clicks can both
  // observe the same first-arriving session and cross-queue their prompts.
  let executionTail: Promise<void> = Promise.resolve()
  const onMessage = (event: MessageEvent): void => {
    const target = frame()
    if (target === undefined || event.source !== target.contentWindow) return
    const data = event.data as { type?: string; payload?: unknown }
    if (data.type !== DSH_EXECUTE_MESSAGE) return
    const payload = data.payload as ExecutePayload | undefined
    if (payload === undefined || typeof payload.prompt !== 'string' || typeof payload.taskId !== 'string') return
    executionTail = executionTail
      .then(() => runExecution(payload))
      .catch((error: unknown) => {
        console.warn('taskboard dsh-execute failed:', error)
      })
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/**
 * Bridge for the app's open-conversation command: focus the requested session
 * in this GUI as a plain in-page navigation — the same action a sidebar row
 * click performs (`uiWorkspace.openSession`), so the conversation replaces the
 * board in the center column and nothing opens in another tab or another GUI
 * instance. A session the shell cannot address is logged and left alone.
 * @param uiWorkspace - injected shell UI-navigation service.
 * @param refreshSessions - re-pulls the client's session baseline; a claim
 *   session the executor disposed moments ago is still persisted on disk, but
 *   its `api-session/removed` frame already dropped it from this client's
 *   catalog, so without the re-pull `openSession` refuses with "unknown
 *   session" and the click silently does nothing.
 * @param frame - current board iframe (messages must come from it).
 * @param closePanels - returns the center column to the conversation.
 * @param extraFrames - right-sidebar frames that may also issue the command.
 */
function mountOpenThreadBridge(
  uiWorkspace: UiWorkspaceService,
  refreshSessions: () => Promise<void>,
  frame: () => HTMLIFrameElement | undefined,
  closePanels: () => void,
  extraFrames: () => Array<HTMLIFrameElement | undefined> = () => [],
  openSideTasks: (sessionId: string) => void = () => {},
): () => void {
  const onMessage = (event: MessageEvent): void => {
    const sources = [frame(), ...extraFrames()]
    if (!sources.some((candidate) => candidate !== undefined && event.source === candidate.contentWindow)) return
    const data = event.data as { type?: string; payload?: unknown }
    if (data.type !== OPEN_THREAD_MESSAGE) return
    const threadId = (data.payload as { threadId?: unknown } | undefined)?.threadId
    if (typeof threadId !== 'string' || threadId === '') return
    closePanels()
    void (async () => {
      try {
        // One baseline re-pull before the navigation; cheap (single-flight in
        // the session controller) and it re-admits sessions this client had
        // already dropped. Open with whatever baseline we got even if the
        // refresh failed.
        await refreshSessions().catch(() => {})
        uiWorkspace.openSession(threadId)
        // Reveal the taskboard tab in the right sidebar for the session we
        // just opened, so a freshly created conversation always shows the
        // board without a manual click.
        openSideTasks(threadId)
      } catch (error: unknown) {
        console.warn(`taskboard: cannot open conversation ${threadId}`, error)
      }
    })()
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/**
 * Minimal structural face of the injected conversation event registry (the
 * fields this plugin uses of the official `uiConversation` service, the same
 * registry the official schedule package uses for its `schedule_create`
 * transcript card). Definitions accumulate per-turn state from session-log
 * events; `buildLocationData` publishes that state onto the turn's data map,
 * where turn-tail list entries read it.
 */
interface UiConversationService {
  events: {
    register(definition: unknown): () => void
  }
}

/** Minimal structural face of the shell's UI navigation service ("uiWorkspace"). */
interface UiWorkspaceService {
  /**
   * Select a session and show its conversation — one navigation action, the
   * same the workspace sidebar performs, so the shell never leaves this page.
   * @param sessionId - target session id.
   */
  openSession(sessionId: string): void
}

/** Minimal board project face served by the host half's /api/projects. */
interface BoardProject {
  id: string
  name: string
  workspacePath?: string | null
}

/**
 * Resolve the board project behind a session id: the session's cwd (from the
 * sessions service snapshot) is matched against each project's workspacePath
 * (exact match first, then directory-prefix), mirroring the board's own
 * project attribution. Null when the session is unknown, pathless, or
 * outside every registered project.
 */
async function resolveProjectForSession(sessionId: string, sessions: SessionsService): Promise<BoardProject | null> {
  const cwd = sessions.list.getSnapshot().byId?.[sessionId]?.cwd ?? null
  if (cwd === null || cwd === '') return null
  const response = await fetch(`${BOARD_API_PREFIX}/api/projects`)
  if (!response.ok) return null
  const { projects } = await response.json() as { projects?: BoardProject[] }
  const candidates = (projects ?? []).filter((project) => typeof project.workspacePath === 'string' && project.workspacePath !== '')
  return candidates.find((project) => project.workspacePath === cwd)
    ?? candidates.find((project) => cwd.startsWith(`${project.workspacePath}/`))
    ?? null
}

/**
 * Conversation-header action: one icon button that reveals the right
 * sidebar's taskboard tab for the session it is drawn in, so the current
 * session's project tasks are one click away from anywhere in the chat —
 * the same entry point the official scheduled-task catalog uses for its own
 * panel.
 * @param props - the session the header belongs to, the open action, and the
 *   plugin locale binder the shell injects into slot components.
 */
function TaskboardHeaderAction({ sessionId, onOpen, t }: {
  sessionId: string
  onOpen: (sessionId: string) => void
  t: (key: string) => string
}): ReactElement {
  const [hover, setHover] = useState(false)
  const label = t('header.open')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onOpen(sessionId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={hover ? { ...HEADER_BUTTON_STYLE, ...HEADER_BUTTON_HOVER_STYLE } : HEADER_BUTTON_STYLE}
    >
      <TasksIcon size={16} />
    </button>
  )
}

/**
 * Guide artwork for the tasks entry. The guide renders every entry at 26px, so
 * a 16px-box monochrome stroke glyph reads thin and gray next to the official
 * fixed-palette artworks (36px box, ~2–3.5 stroke at that box). This draws the
 * same checklist subject in that family: two rows of a blue check plus rule,
 * round caps, palette taken from the shell's own blue artworks (#539CFA,
 * #679EFE, #B7D3FE).
 */
function TasksGuideIcon({ size }: { size?: number }): ReactElement {
  const edge = size ?? 28
  return (
    <svg
      viewBox="0 0 36 36"
      width={edge}
      height={edge}
      fill="none"
      aria-hidden="true"
    >
      <path d="M7.5 12.5 10.5 15.5 16 9.5" stroke="#539CFA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 12.5H28.5" stroke="#679EFE" strokeWidth="3" strokeLinecap="round" />
      <path d="M7.5 24.5 10.5 27.5 16 21.5" stroke="#539CFA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 24.5H28.5" stroke="#B7D3FE" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** Structural face of the pane-tab seat's injected tab information hook. */
interface TabInfo {
  tab?: {
    navigation?: {
      params?: Record<string, unknown>
      revision?: number
    }
  }
}

/**
 * Right-sidebar tab body: the current session's project task list, rendered
 * by the board SPA's own List view (`view=list` + `chrome=min`). The compact
 * chrome strips the left nav, project switcher, and view tabs — everything
 * else (create, drag-to-move, detail, automation menu, search) stays — and
 * `project` pins the view to the resolved session's project so the sidebar
 * can never drift away from it. A session outside every project shows a
 * hint instead of an empty board.
 *
 * Deep link: when the tab was navigated with a `taskId` param (a turn-tail
 * card click), the iframe mounts with the app's `issue=` param so the task's
 * detail opens over the list; the iframe is keyed by that target, so a later
 * navigation to another task remounts it with the new `issue=` value instead
 * of needing an app-side message protocol.
 * @param props - the session id the tab body was minted for, the seat's tab
 *   information hook, and the shared mount plumbing.
 */
function SideTasksBody({ sessionId, sessions, onFrame, t, locale, useTabInfo }: {
  sessionId: string
  sessions: SessionsService
  onFrame: (frame: FrameRef) => () => void
  t: (key: string) => string
  locale: LocaleService
  useTabInfo?: () => TabInfo
}): JSX.Element {
  const [project, setProject] = useState<BoardProject | null | 'loading'>('loading')

  // The seat injects this hook (same contract the official schedule tab uses);
  // optional so a host without it degrades to the plain project list.
  const navigation = useTabInfo?.().tab?.navigation
  const navTaskId = typeof navigation?.params?.taskId === 'string' && navigation.params.taskId !== ''
    ? navigation.params.taskId
    : null
  const deepTask = useTaskCached(navTaskId)

  // Register this iframe with the parent bridges (theme sync lives in
  // PanelFrame; the open-thread bridge discovers side frames here).
  const frame = useMemo<FrameRef>(() => ({ current: undefined }), [])
  useEffect(() => onFrame(frame), [frame, onFrame])

  useEffect(() => {
    let cancelled = false
    setProject('loading')
    void resolveProjectForSession(sessionId, sessions)
      .then((resolved) => {
        if (!cancelled) setProject(resolved)
      })
      .catch(() => {
        if (!cancelled) setProject(null)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, sessions])

  if (project === 'loading' || (navTaskId !== null && deepTask === undefined)) {
    return <p style={SIDE_HINT_STYLE}>{t('sidepanel.resolving')}</p>
  }
  if (project === null) {
    return <p style={SIDE_HINT_STYLE}>{t('sidepanel.empty')}</p>
  }
  // A resolved deep-link task adds the app's issue param (uppercase identifier,
  // as the app's route reader expects); a failed lookup falls back to the list.
  const issueParam = deepTask ? deepTask.identifier : null
  return (
    <div style={SIDE_FRAME_STYLE}>
      <PanelFrame
        key={`${issueParam ?? ''}`}
        frameRef={frame}
        locale={locale}
        url={`/dsh-taskboard/?project=${encodeURIComponent(project.id)}&view=list&chrome=min${issueParam === null ? '' : `&issue=${encodeURIComponent(issueParam)}`}`}
        title={project.name}
      />
    </div>
  )
}

/**
 * Mount the taskboard shell: two sidebar rows, their center-column views, the
 * execution/open-thread bridges, locale dictionaries, and the settings card.
 * @param ctx - client root context with sessions/workspaces/locale/slots/layout.
 */
/**
 * Conversation turn cards — the taskboard's copy of the official automation
 * transcript card (`schedule_create` renders a card beneath the closing text
 * of the turn that called it; ours renders one per board task the turn's
 * command-running tools addressed through the board HTTP API). The same two
 * official seats carry it:
 *
 *   - `uiConversation.events` accumulates per-turn state: every `tool/call`
 *     whose command text references `/api/tasks/<uuid>` (the only integration
 *     path — agents drive the board through curl against the local API)
 *     contributes that task id. No session-log format change: the state is
 *     derived from durable events and published onto the turn's data map.
 *   - `conversation.chat.turnTail` renders the cards after the turn's closing
 *     text, staying visible when the tool-call group is collapsed. Card copy
 *     (identifier/title/status) is fetched live from the board API, so the
 *     card always shows the task's current state.
 *
 * Clicking opens the right sidebar's task tab navigated to that task
 * (`sidebarRight.openTab` params), mirroring the official card's Open button.
 */

/** Session-log event face shared by the definition and its helpers. */
interface TurnEvent {
  type: string
  data?: Record<string, unknown>
}

/** Turn-scope data this definition publishes for one turn. */
interface TaskboardTurnState {
  /** The turn number the state accumulated under (stability for location reuse). */
  turn: unknown
  /** Board task uuids first addressed by this turn's commands, in seen order. */
  refs: string[]
}

/** Turn-data key this definition publishes under (read by the turn-tail card). */
const TASKBOARD_TURN_KEY = 'taskboard-issues'

/** Cards per turn cap — a turn that touched many tasks stays readable. */
const MAX_TURN_TASK_REFS = 6

/** Board task reference inside command text: any `/api/tasks/<uuid>` URL form. */
const BOARD_TASK_URL_RE = /\/api\/tasks\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g

/** Command-running tool names worth scanning for board references. */
function isCommandTool(name: string): boolean {
  return name === 'bash' || name === 'pwsh' || name === 'exec_command' || name === 'run_code' || name.startsWith('terminal_')
}

/** Flatten one tool call's arguments to scannable text (arguments is JSON text). */
function toolCallText(data: Record<string, unknown> | undefined): string {
  const raw = data?.arguments
  if (typeof raw === 'string') {
    try {
      return flattenToolArgs(JSON.parse(raw) as unknown)
    } catch {
      return raw
    }
  }
  return flattenToolArgs(raw)
}

function flattenToolArgs(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Merge newly seen task uuids into the turn's ref list (dedupe, cap, stable order). */
function appendTaskRefs(existing: string[], text: string): string[] {
  if (text === '' || existing.length >= MAX_TURN_TASK_REFS) return existing
  const found: string[] = []
  BOARD_TASK_URL_RE.lastIndex = 0
  for (let match = BOARD_TASK_URL_RE.exec(text); match !== null; match = BOARD_TASK_URL_RE.exec(text)) {
    const id = match[1].toLowerCase()
    if (!existing.includes(id) && !found.includes(id)) found.push(id)
    if (existing.length + found.length >= MAX_TURN_TASK_REFS) break
  }
  return found.length === 0 ? existing : [...existing, ...found]
}

/**
 * The turn accumulator — same contract shape as the official schedule one:
 * `turn/start` opens the state, `tool/call` updates it, and the state lands on
 * the turn's data map through `buildLocationData` for the turn tail to read.
 */
const taskboardTurnDefinition = {
  kind: TASKBOARD_TURN_KEY,
  match(event: TurnEvent): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'turn/start' && event.data?.turn !== undefined) return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' && event.data?.turn !== undefined) return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start(_context: unknown, match: { event: TurnEvent }): TaskboardTurnState {
    return { turn: match.event.data?.turn, refs: [] }
  },
  update(context: { state: TaskboardTurnState }, match: { event: TurnEvent }): TaskboardTurnState {
    if (match.event.type !== 'tool/call') return context.state
    const name = typeof match.event.data?.name === 'string' ? match.event.data.name : ''
    if (!isCommandTool(name)) return context.state
    const refs = appendTaskRefs(context.state.refs, toolCallText(match.event.data))
    return refs === context.state.refs ? context.state : { ...context.state, refs }
  },
  buildLocationData(context: { state?: TaskboardTurnState }, scope: string, previous: unknown): unknown {
    if (scope !== 'turn' || context.state === undefined) return null
    const previousLocation = previous as { kind?: string; turn?: unknown; key?: string; value?: { refs?: string[] } } | null
    if (
      previousLocation?.kind === 'turn'
      && previousLocation.turn === context.state.turn
      && previousLocation.key === TASKBOARD_TURN_KEY
      && previousLocation.value?.refs === context.state.refs
    ) return previous
    return { kind: 'turn', turn: context.state.turn, key: TASKBOARD_TURN_KEY, value: { refs: context.state.refs } }
  },
}

/** Structural read of the refs one turn published (absent/degraded → empty).
 * The host's turn data is a MutableLocationDataStore (a `.get(key)` object);
 * older hosts used a Map — read through `.get` when present, else the Map. */
function readTurnTaskRefs(turn: unknown): string[] {
  const data = (turn as { data?: unknown } | undefined)?.data
  if (data === null || data === undefined) return []
  let value: { refs?: unknown } | undefined
  if (typeof (data as { get?: unknown }).get === 'function') {
    value = (data as { get(key: string): unknown }).get(TASKBOARD_TURN_KEY) as { refs?: unknown } | undefined
  } else if (data instanceof Map) {
    value = (data as Map<string, { refs?: unknown }>).get(TASKBOARD_TURN_KEY)
  }
  const refs = value?.refs
  return Array.isArray(refs) ? refs.filter((id): id is string => typeof id === 'string') : []
}

/** Board task face the card and the deep link need (from GET /api/tasks/<id>). */
interface BoardTask {
  id: string
  identifier: string
  title: string
  status: string
  projectId: string
}

/** Card/deep-link fetch cache: one entry per task uuid, short TTL. */
const TASK_CACHE_TTL_MS = 30_000
const taskCache = new Map<string, { at: number; task: BoardTask | null }>()

function peekTaskCache(taskId: string): BoardTask | null | undefined {
  const entry = taskCache.get(taskId)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > TASK_CACHE_TTL_MS) {
    taskCache.delete(taskId)
    return undefined
  }
  return entry.task
}

/** Fetch one task for card/deep-link use; null = missing or unreachable board. */
async function fetchTaskCached(taskId: string): Promise<BoardTask | null> {
  const cached = peekTaskCache(taskId)
  if (cached !== undefined) return cached
  try {
    const response = await fetch(`${BOARD_API_PREFIX}/api/tasks/${encodeURIComponent(taskId)}`)
    if (!response.ok) {
      taskCache.set(taskId, { at: Date.now(), task: null })
      return null
    }
    const body = await response.json() as { task?: Partial<BoardTask> }
    const task = body.task
    if (!task || typeof task.id !== 'string' || typeof task.identifier !== 'string' || typeof task.title !== 'string') {
      taskCache.set(taskId, { at: Date.now(), task: null })
      return null
    }
    const resolved: BoardTask = {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: typeof task.status === 'string' ? task.status : 'todo',
      projectId: typeof task.projectId === 'string' ? task.projectId : '',
    }
    taskCache.set(taskId, { at: Date.now(), task: resolved })
    return resolved
  } catch {
    // Unreachable board: no negative caching — the next mount retries.
    return null
  }
}

/** React hook: resolve a task uuid through the cache (undefined = loading). */
function useTaskCached(taskId: string | null): BoardTask | null | undefined {
  const [task, setTask] = useState<BoardTask | null | undefined>(() => (taskId === null ? undefined : peekTaskCache(taskId)))
  useEffect(() => {
    if (taskId === null) {
      setTask(undefined)
      return
    }
    let cancelled = false
    const cached = peekTaskCache(taskId)
    setTask(cached)
    if (cached !== undefined) return
    void fetchTaskCached(taskId).then((resolved) => {
      if (!cancelled) setTask(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [taskId])
  return task
}

/**
 * Turn-tail card stylesheet, inlined and injected once — the same pattern the
 * official packages use (`style[data-plugin-css]`), with the official
 * schedule card's token values so both cards read identically.
 */
const TURN_CARD_CSS_TAG = '@ttmouse/dsh-taskboard/TurnTaskCard.module.css'
const TURN_CARD_CSS = `
.tbturn-list{flex-direction:column;gap:10px;margin:4px 0;display:flex}
.tbturn-card{--card-fill:var(--dsw-static-neutral-50);--card-hover:var(--dsw-static-neutral-100);box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);background:var(--card-fill);width:100%;color:var(--dsw-alias-label-primary);border-radius:18px;flex-direction:column;gap:6px;padding:8px 10px;transition:background-color .12s;display:flex;position:relative;overflow:hidden}
body[data-ds-dark-theme] .tbturn-card{--card-fill:var(--dsw-static-neutral-850);--card-hover:var(--dsw-static-neutral-800)}
.tbturn-card:has(.tbturn-cardOpen):hover{background:var(--card-hover)}
.tbturn-cardOpen{z-index:1;border-radius:inherit;cursor:pointer;background:0 0;border:0;width:100%;padding:0;position:absolute;inset:0}
.tbturn-cardOpen:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.tbturn-row{z-index:2;pointer-events:none;align-items:center;gap:10px;min-width:0;min-height:44px;display:flex;position:relative}
.tbturn-leading{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:var(--card-fill);width:40px;height:40px;color:var(--dsw-alias-label-secondary);border-radius:10px;flex:none;place-items:center;display:grid}
.tbturn-leading svg{flex:none}
.tbturn-body{flex-direction:column;flex:auto;gap:2px;min-width:0;display:flex}
.tbturn-title{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}
.tbturn-sub{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;overflow:hidden}
.tbturn-openButton{pointer-events:auto;flex:none;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,var(--card-fill));color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;padding:3px 12px;cursor:pointer}
.tbturn-openButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
`
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${TURN_CARD_CSS_TAG}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@ttmouse/dsh-taskboard'
  tag.dataset.pluginCss = TURN_CARD_CSS_TAG
  tag.textContent = TURN_CARD_CSS
  document.head.appendChild(tag)
}

/** One conversation card: live task facts plus the Open affordance. */
function TaskboardIssueCard({ taskId, openIssue, t }: {
  taskId: string
  openIssue: (taskId: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}): JSX.Element {
  const task = useTaskCached(taskId)
  const title = task?.title ?? ''
  const sub = task === undefined
    ? t('turncard.loading')
    : task === null
      ? t('turncard.missing')
      : `${task.identifier} · ${t(`status.${task.status}`)}`
  const open = (): void => openIssue(taskId)
  return (
    <div className="tbturn-card" data-source="dsh-taskboard">
      <button type="button" className="tbturn-cardOpen" aria-label={t('turncard.openAria', { title })} onClick={open} />
      <div className="tbturn-row">
        <span className="tbturn-leading"><TasksIcon size={18} /></span>
        <span className="tbturn-body">
          <span className="tbturn-title">{task === null ? t('turncard.missing') : title === '' ? '…' : title}</span>
          <span className="tbturn-sub">{sub}</span>
        </span>
        {task !== undefined && task !== null ? (
          <button type="button" className="tbturn-openButton" onClick={open}>{t('turncard.open')}</button>
        ) : null}
      </div>
    </div>
  )
}

/** Props the turn-tail seat hands this entry (structural, degrade to null). */
interface TurnTailProps {
  turn?: unknown
  openIssue?: (taskId: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * Render the turn's board-task cards beneath its closing text, or nothing when
 * the turn addressed no board task — every list entry renders for every turn,
 * so this one narrows its own turn here (official pattern).
 */
function TaskboardTurnCard(props: TurnTailProps): ReactElement | null {
  const refs = readTurnTaskRefs(props.turn)
  if (refs.length === 0 || props.openIssue === undefined) return null
  return (
    <div className="tbturn-list">
      {refs.map((taskId) => (
        <TaskboardIssueCard key={taskId} taskId={taskId} openIssue={props.openIssue!} t={props.t} />
      ))}
    </div>
  )
}

export const inject = ['sessions', 'workspaces', 'locale', 'slots', 'layout', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'uiConversation']

export function apply(ctx: {
  effect(fn: () => () => void, label: string): void
  sessions: SessionsService
  workspaces: WorkspacesService
  locale: LocaleService
  slots: SlotsService
  layout: LayoutService
  sidebarRightTabs: SidebarRightTabsService
  sidebarRight: SidebarRightService
  uiWorkspace: UiWorkspaceService
  uiConversation: UiConversationService
}): void {
  const frames = new Map<string, FrameRef>(PANELS.map((panel) => [panel.name, { current: undefined }]))

  // i18n: register the owned namespace, then translate shell strings through
  // the bound function (it resolves the active locale at call time, so the
  // shell re-reading `label()` after a locale change gets the new text).
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)

  /** Select one of our panels through the layout store (never throwing into the shell). */
  const openPanel = (panelId: string): void => {
    try {
      ctx.layout.selectPanel(panelId)
    } catch (error: unknown) {
      console.warn(`taskboard: main panel "${panelId}" is not registered yet`, error)
    }
  }

  // The center-column views: one `main` entry per panel, rendered by the shell
  // only while that key is selected. The shell's own layout store keeps the
  // conversation, the official panels, and these mutually exclusive.
  ctx.effect(() => {
    const disposers = PANELS.map((panel) => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: panel.name,
      locale: NS,
    }, (props: PanelViewProps) => (
      <PanelFrame
        frameRef={frames.get(panel.name)!}
        locale={ctx.locale}
        url={panel.url}
        title={props.t(panel.entryLabelKey)}
      />
    ))))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-taskboard: main panels')

  // The sidebar rows: the shell draws the row, resolves the label, tracks the
  // active panel, and folds the label away in the collapsed icon rail.
  ctx.effect(() => {
    const disposers = PANELS.map((panel) => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: panel.name,
      order: panel.order,
      locale: NS,
      label: () => t(panel.entryLabelKey),
    }, panel.Icon)))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-taskboard: sidebar entries')

  // The right-sidebar tab: one page type with a guide entry (the + page in
  // the tab strip), the pane body (the current session's project list), and
  // the tab chip title — the same three-part path the official browser tab
  // uses. Registration lives in ctx.effect, so the type follows the plugin's
  // lifetime exactly like the sidebar rows above. Live side iframes register
  // into sideFrames so the open-thread bridge hears them too.
  const sideFrames = new Set<FrameRef>()
  const registerSideFrame = (frame: FrameRef): (() => void) => {
    sideFrames.add(frame)
    return () => sideFrames.delete(frame)
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SIDE_TAB_ID,
    kind: SIDE_TAB_KIND,
    title: () => t('sidepanel.label'),
    guide: [{
      id: 'tasks',
      order: 40,
      title: () => t('sidepanel.guide.title'),
      description: () => t('sidepanel.guide.description'),
      icon: TasksGuideIcon,
    }],
  }), 'dsh-taskboard: right-sidebar tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SIDE_TAB_ID,
    locale: NS,
    inject: (...args: unknown[]) => ({ sessionId: args[0] as string }),
  }, (props: { sessionId: string; useTabInfo?: () => TabInfo }) => (
    <SideTasksBody
      sessionId={props.sessionId}
      sessions={ctx.sessions}
      onFrame={registerSideFrame}
      t={(key) => t(key)}
      locale={ctx.locale}
      useTabInfo={props.useTabInfo}
    />
  ))), 'dsh-taskboard: right-sidebar tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: SIDE_TAB_ID,
    locale: NS,
  }, () => (
    // Icon + label, the same chip shape the official schedule tab title uses
    // (glyph then text; dockkit owns the spacing and vertical alignment).
    <>
      <span style={TAB_TITLE_ICON_STYLE}><TasksIcon size={16} /></span>
      {t('sidepanel.label')}
    </>
  ))), 'dsh-taskboard: right-sidebar tab title')

  /**
   * Reveal this session's taskboard tab in the right sidebar (never throwing
   * into the shell). Right after `openSession` the conversation surface is not
   * mounted yet and the shell's controller refuses with "no session surface is
   * mounted", so retry briefly until it appears. An optional task id navigates
   * the tab to that task's detail (turn-tail card clicks).
   */
  const openSideTasks = (sessionId: string, taskId?: string, attempt = 0): void => {
    try {
      ctx.sidebarRight.openTab(SIDE_TAB_KIND, taskId === undefined ? { params: { sessionId } } : { params: { sessionId, taskId } })
    } catch (error: unknown) {
      if (attempt < 15) {
        window.setTimeout(() => openSideTasks(sessionId, taskId, attempt + 1), 300)
        return
      }
      console.warn('taskboard: cannot open the right-sidebar taskboard tab', error)
    }
  }

  // The conversation header's quick entry: the same icon row the official
  // scheduled-task catalog lives in, opening the right-sidebar tab registered
  // above. A session-scoped list slot, so the button is drawn per conversation
  // and knows which session it opens for. The slot orders entries ascending,
  // and the session-log "more actions" (···) menu registers at the default
  // order 0 — this sits just left of it, right of the open-in-app (-10) and
  // schedule (-5) entries.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'taskboard-open',
    order: -1,
    locale: NS,
    inject: (sessionId: unknown) => ({ sessionId: sessionId as string }),
  }, (props: { sessionId: string; t: (key: string) => string }) => (
    <TaskboardHeaderAction sessionId={props.sessionId} onOpen={openSideTasks} t={props.t} />
  ))), 'dsh-taskboard: conversation header entry')

  // The conversation turn cards: the accumulator derives each turn's board
  // task references from its own durable tool-call events (no session-log
  // format change), and the turn-tail list entry renders one card per task
  // after the turn's closing text — the same two-part path the official
  // schedule_create transcript card uses. Clicking a card opens the
  // right-sidebar task tab navigated to that task.
  ctx.effect(() => ctx.uiConversation.events.register(taskboardTurnDefinition), 'dsh-taskboard: turn task accumulator')

  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'taskboard-issues',
    order: 20,
    locale: NS,
    inject: (sessionId: unknown) => ({
      openIssue: (taskId: string) => openSideTasks(sessionId as string, taskId),
    }),
  }, (props: TurnTailProps) => (
    <TaskboardTurnCard
      turn={props.turn}
      openIssue={props.openIssue}
      t={(key, params) => t(key, params)}
    />
  ))), 'dsh-taskboard: turn-tail task cards')

  // The settings card asks to open the board.
  ctx.effect(() => {
    const onRequestOpen = (): void => openPanel(TASKBOARD_PANEL.name)
    document.addEventListener('dsh-taskboard-request-open', onRequestOpen)
    return () => document.removeEventListener('dsh-taskboard-request-open', onRequestOpen)
  }, 'dsh-taskboard: open request')

  ctx.effect(() => mountExecutionBridge(
    ctx.sessions,
    ctx.workspaces,
    () => frames.get(TASKBOARD_PANEL.name)?.current,
    (key, params) => t(key, params),
  ), 'dsh-taskboard: dsh execution bridge')

  ctx.effect(() => mountOpenThreadBridge(
    ctx.uiWorkspace,
    () => ctx.sessions.refresh(),
    () => frames.get(TASKBOARD_PANEL.name)?.current,
    () => ctx.layout.selectPanel(null),
    () => [...sideFrames].map((ref) => ref.current),
    openSideTasks,
  ), 'dsh-taskboard: open-thread bridge')

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
