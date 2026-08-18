/**
 * dsh-taskboard — host half.
 *
 * Runs the dsh-taskboard server (SQLite + HTTP API + SSE, from the
 * vendored server/ tree) inside the dsh web profile host process, listening
 * on loopback only, and proxies it on the shared webserver at
 * /dsh-taskboard/* so the browser half mounts the full app same-origin (no
 * CSP/CORS surface, API base URL resolves relative like the standalone app).
 *
 * The server is the fork's own code — zero npm dependencies (node builtins +
 * node:sqlite) — so vendoring server/ + shared/ + dist/web into vendor/ keeps
 * this package self-contained.
 *
 * Failure policy: a taskboard start failure is logged, never thrown — the
 * host must not take the GUI down; the announce section still registers so
 * agents know the plugin exists.
 */
import { request as httpRequest } from 'node:http'
import { appendFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { createTaskboardServer } from '../vendor/server/app.mjs'
import { buildClaimPrompt, cleanupStaleClaimRoutines, reconcileClaimRoutine } from './claim-routines.mjs'
import { activeClaimSessions, executeClaimInProcess, stopClaimSession, writeRunRecord } from './claim-executor.mjs'
import { defaultCheckCommand, runCheck } from './check-gate.mjs'

/** Plugin root: the directory holding lib/ (package.json sits one level up). */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Default data directory under the DSH home (mirrors ~/.dsh/storages layout). */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'storages', 'dsh-taskboard')

/** Plugin diagnostic log (the harness logger is not observable from files). */
const PLUGIN_LOG_FILE = path.join(DEFAULT_DATA_DIR, 'plugin.log')

/** Append a line to the plugin diagnostic log; failures are swallowed. */
async function pluginLog(message) {
  try {
    await appendFile(PLUGIN_LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Never let diagnostics break the host.
  }
}

/** Shared agents skill root scanned by skill-filesystem in every profile. */
function agentsSkillRoot() {
  return process.env.DSH_AGENTS_HOME
    ? path.join(process.env.DSH_AGENTS_HOME, 'skills')
    : path.join(os.homedir(), '.agents', 'skills')
}

/**
 * Sync the vendored manage-taskboard skill into the shared agents skill root,
 * replacing any stale copy or symlink (e.g. the original dashi-taskboard
 * taskctl skill). Every profile (web / headless / ops) scans this root, so
 * routine sessions and GUI agents load the current HTTP-API skill by name.
 * Idempotent; failures are logged, never thrown.
 * @param log - logger callback.
 */
async function syncAgentSkill(log) {
  const source = path.join(PLUGIN_ROOT, 'vendor', 'skills', 'manage-taskboard')
  const target = path.join(agentsSkillRoot(), 'manage-taskboard')
  try {
    // fs.rm on a symlink removes the link itself, never the link target.
    await rm(target, { recursive: true, force: true })
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true })
    log(`agent skill: manage-taskboard synced -> ${target}`)
  } catch (error) {
    log(`agent skill sync failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Default webserver route prefix proxying the taskboard. */
const DEFAULT_ROUTE_PREFIX = '/dsh-taskboard'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 205

/** Required services: webserver, system-prompt band, workspace registry, and llm (model catalog). */
export const inject = ['webServer', 'systemPrompt', 'workspaceRegistry', 'sessionPersistence', 'agents', 'sessions', 'agentDefaultModel', 'llm']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASKBOARD_GUIDANCE = '本机已安装 dsh-taskboard 插件（DSH Web GUI 的完整任务看板）：侧边栏「任务看板」入口；完整能力来自本地 SQLite 服务——多视图（看板/列表/Gantt/工作流/仪表盘）、任务详情（关系/附件/标签/过滤器）、AI 对话、项目自动认领（dsh-routines 例程驱动：认领开关生成 ~/.dsh/routines/taskboard-claim-*.yaml，由 ops profile 的 routines-scheduler 定时执行 headless 会话，认领/执行/回写全部通过本机看板 HTTP API 完成，无 taskctl、无心跳文件、无长驻作业）。数据存 ~/.dsh/storages/dsh-taskboard/taskboard.sqlite（本机回环端口 47825）。任务可通过看板内「在对话中打开」直接驱动 DSH 会话执行并回写评论。用户提到「任务看板 / 看板 / 任务管理」时即指本插件，请据此协作。'

/** Plugin config, validated by the schemastery schema. */
export const Config = z.object({
  /** Master switch for the whole plugin (host server + browser half). */
  enabled: z.boolean().default(true),
  /** Directory holding taskboard.sqlite, attachments, and cloud config. */
  dataDirectory: z.string().default(DEFAULT_DATA_DIR),
  /** Webserver route prefix proxying the taskboard (browser half mounts here). */
  routePrefix: z.string().default(DEFAULT_ROUTE_PREFIX),
  /** Internal loopback listen port; 0 requests an OS-assigned port. */
  port: z.natural().max(65535).default(47825),
  /** When true, a system-prompt section announces the plugin to every agent. */
  announceToAgent: z.boolean().default(true),
  /** When true, DSH workspaces are synced into board projects (workspace = project). */
  syncWorkspaces: z.boolean().default(true),
  /** Workspace → project sync interval in ms (0 disables periodic re-sync). */
  syncIntervalMs: z.natural().max(3_600_000).default(60_000),
  /** Whether the host half reconciles claim routines in $DSH_HOME/routines. */
  routinesEnabled: z.boolean().default(true),
  /** In-process claim scheduler poll interval in ms (min 5000). */
  claimPollMs: z.natural().max(3_600_000).default(30_000),
})

/**
 * Build the /<prefix>/* forwarding handler. Strips the prefix, rewrites the
 * Host header, and pipes both directions so SSE, streaming AI chat, and
 * multipart uploads all pass through untouched.
 * @param port - the internal taskboard listen port.
 * @param prefix - the webserver route prefix to strip.
 * @returns the webserver route handler.
 */
function makeProxy(port, prefix) {
  return (req, res) => {
    const target = new URL(req.url, 'http://127.0.0.1')
    target.host = `127.0.0.1:${port}`
    if (target.pathname === prefix) {
      target.pathname = '/'
    } else if (target.pathname.startsWith(`${prefix}/`)) {
      target.pathname = target.pathname.slice(prefix.length)
    } else {
      res.writeHead(404)
      res.end()
      return
    }
    const proxyReq = httpRequest(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (error) => {
      res.destroy(error)
    })
    req.pipe(proxyReq)
  }
}

/**
 * Sync DSH workspaces into board projects: every workspace becomes (or
 * updates) a project keyed by the workspace id, with `workspace_path` set to
 * the workspace path. The workspace registry is the single source of truth —
 * the board's own independent project creation is removed from the UI, so
 * projects mirror the DSH workspace list (plus the legacy 'local' 全局 catch-all).
 * @param registry - the injected `workspaceRegistry` service.
 * @param baseUrl - internal taskboard loopback base URL.
 * @param log - logger callback.
 * @returns summary string, or null when the registry is unavailable.
 */
async function syncWorkspacesFromRegistry(registry, baseUrl, log) {
  let workspaces
  try {
    workspaces = registry.list().map((entity) => ({
      id: entity.id,
      name: (entity.title ?? '').trim() || path.basename(entity.path || ''),
      path: entity.path ?? null,
    })).filter((ws) => ws.id && ws.name)
  } catch (error) {
    log(`workspace sync: registry unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (workspaces.length === 0) return 'workspace sync: no workspaces'
  const listRes = await fetch(`${baseUrl}/api/projects`)
  if (!listRes.ok) throw new Error(`list projects: HTTP ${listRes.status}`)
  const { projects } = await listRes.json()
  const existing = new Map(projects.map((project) => [project.id, project]))
  let created = 0
  let updated = 0
  let removed = 0
  for (const ws of workspaces) {
    const current = existing.get(ws.id)
    if (current === undefined) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: ws.id, name: ws.name, workspacePath: ws.path }),
      })
      if (res.ok) created++
      else log(`workspace sync: create '${ws.id}' failed: HTTP ${res.status}`)
    } else if (current.name !== ws.name || current.workspacePath !== ws.path) {
      const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(ws.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ws.name, workspacePath: ws.path }),
      })
      if (res.ok) updated++
      else log(`workspace sync: update '${ws.id}' failed: HTTP ${res.status}`)
    }
  }
  // Mirror removals: workspace-managed projects whose workspace is gone are
  // deleted (the board route refuses 'local' and temp-* projects).
  const currentIds = new Set(workspaces.map((ws) => ws.id))
  for (const project of projects) {
    if (!project.workspacePath || currentIds.has(project.id)) continue
    const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
    if (res.ok) removed++
    else log(`workspace sync: remove '${project.id}' failed: HTTP ${res.status}`)
  }
  return `workspace sync: ${workspaces.length} workspaces, ${created} created, ${updated} updated, ${removed} removed`
}


/**
 * Resolve the project id behind a claim routine name (taskboard-claim-<12>).
 */
async function resolveClaimProject(name, baseUrl) {
  const res = await fetch(`${baseUrl}/api/projects`)
  if (!res.ok) return null
  const { projects } = await res.json()
  const project = projects.find((p) => name === `taskboard-claim-${p.id.slice(0, 12)}`)
  return project ?? null
}

/**
 * Kick an in-process claim session for one project (used by the scheduler
 * and by the 立即运行 button for claim routines). Gates, in order:
 *   ① built-in uniform check (all claim projects, zero tokens): the project
 *     must have a todo task in the board, otherwise the round is skipped.
 *   ② uniform convention-path check script (scripts/schedule-checks/check.mjs
 *     under the project workspace; every claim project shares the same
 *     path): exit 0 proceeds, exit 2 skips, anything else blocks and
 *     records a failed run. No script on disk → no gate.
 */
async function runInProcessClaim(ctx, project, baseUrl, log) {
  let automation = { enabled: false, intervalMinutes: 10, model: null }
  try {
    const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/automation`)
    if (res.ok) automation = (await res.json()).automation
  } catch {
    // keep defaults
  }

  // ① Built-in uniform check: only claim when the board has a todo task for
  // this project. No todo → skip the round (no session, no tokens). A failed
  // todo lookup is treated as a block (the claim flow itself depends on the
  // same API, so proceeding would only burn a session on a broken board).
  let todoCount = 0
  let todoCheckFailed = false
  try {
    const res = await fetch(`${baseUrl}/api/tasks?projectId=${encodeURIComponent(project.id)}&status=todo`)
    if (res.ok) {
      todoCount = ((await res.json()).tasks ?? []).length
    } else {
      todoCheckFailed = true
    }
  } catch (error) {
    todoCheckFailed = true
    log(`[claim] ${project.id}: todo check request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (todoCheckFailed || todoCount === 0) {
    log(`[claim] ${project.id}: ${todoCheckFailed ? 'todo check failed' : 'no todo tasks'}, skipping round`)
    await writeRunRecord(project, {
      status: todoCheckFailed ? 'failed' : 'skipped',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      durationMs: 0,
      exitCode: 2,
      check: { command: 'builtin:has-todo-tasks', todoCount },
      error: todoCheckFailed
        ? 'blocked by check gate: todo check request failed'
        : 'skipped: no todo tasks to claim',
    }).catch(() => {})
    return false
  }

  // ② Uniform convention-path check script (no per-project override).
  const gateCommand = await defaultCheckCommand(project.workspacePath)
  if (gateCommand) {
    const check = await runCheck({
      command: gateCommand,
      cwd: project.workspacePath,
      env: {
        TASKBOARD_PROJECT_ID: project.id,
        TASKBOARD_PROJECT_NAME: project.name,
        TASKBOARD_WORKSPACE: project.workspacePath,
        TASKBOARD_API_BASE: baseUrl,
      },
      log,
    })
    log(`[claim] ${project.id}: check gate → ${check.kind} (exit=${check.exitCode ?? '-'}, ${check.durationMs}ms${check.error ? `, ${check.error}` : ''})`)
    if (check.kind !== 'pass') {
      const skipped = check.kind === 'skip'
      await writeRunRecord(project, {
        status: skipped ? 'skipped' : 'failed',
        startedAt: Date.now() - check.durationMs,
        finishedAt: Date.now(),
        durationMs: check.durationMs,
        exitCode: check.exitCode,
        check: {
          command: gateCommand,
          ...(check.timedOut ? { timedOut: true } : {}),
        },
        ...(check.stdout ? { stdout: check.stdout.slice(0, 500) } : {}),
        ...(check.stderr ? { stderr: check.stderr.slice(0, 500) } : {}),
        error: skipped
          ? 'skipped by check gate (exit 2)'
          : `blocked by check gate${check.error ? `: ${check.error}` : ` (exit ${check.exitCode ?? '-'})`}`,
      }).catch(() => {})
      return false
    }
  }

  return executeClaimInProcess({
    ctx,
    project,
    model: automation.model ?? null,
    prompt: buildClaimPrompt(project),
    log,
  })
}

/**
 * Start the in-process claim scheduler: every claimPollMs, sweep projects
 * whose automation switch is enabled and due, and run them in-process so the
 * GUI streams the conversation live.
 */
function startClaimScheduler(ctx, baseUrl, pollMs, log) {
  const inFlight = new Set()
  const sweep = async () => {
    let projects = []
    try {
      const res = await fetch(`${baseUrl}/api/projects`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      projects = (await res.json()).projects ?? []
    } catch (error) {
      log(`[claim] sweep list failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const now = Date.now()
    for (const project of projects) {
      if (!project.workspacePath || inFlight.has(project.id)) continue
      let automation
      try {
        const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/automation`)
        if (!res.ok) continue
        automation = (await res.json()).automation
      } catch {
        continue
      }
      if (!automation?.enabled) continue
      const intervalMs = (automation.intervalMinutes ?? 10) * 60_000
      const last = typeof automation.lastClaimAt === 'number'
        ? automation.lastClaimAt
        : typeof automation.lastClaimAt === 'string'
          ? Date.parse(automation.lastClaimAt) || 0
          : 0
      if (now - last < intervalMs) continue
      inFlight.add(project.id)
      try {
        await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/claim-run`, { method: 'POST' })
          .catch(() => {})
        log(`[claim] scheduled: ${project.name}`)
        await runInProcessClaim(ctx, project, baseUrl, log)
      } finally {
        inFlight.delete(project.id)
      }
    }
  }
  const timer = setInterval(() => void sweep(), pollMs)
  void sweep()
  return () => clearInterval(timer)
}

/**
 * Refresh the claim model catalog: enumerate every registered provider's
 * models via ctx.llm and write them to models.json in the data directory,
 * where the board serves them to the automation menu. Entries are plain ids
 * (listModels returns adapter objects).
 * @param ctx - context carrying llm and agentDefaultModel.
 * @param dataDirectory - board data directory.
 * @param log - logger callback.
 */
async function refreshModelCatalog(ctx, dataDirectory, log) {
  try {
    const providers = await ctx.llm.listProviders()
    const catalog = { providers: [], updatedAt: new Date().toISOString() }
    for (const provider of providers) {
      const providerId = provider?.id
      if (!providerId) continue
      try {
        const models = await ctx.llm.listModels(providerId)
        catalog.providers.push({
          provider: providerId,
          // Human-readable provider name from the adapter (e.g. "DeepSeek",
          // or the settings.yaml displayName for configurable routes) — the
          // raw route key is machine-facing and confusing in selectors.
          label: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : providerId,
          models: models.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean),
        })
      } catch (error) {
        log(`model catalog: ${providerId} list failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await writeFile(path.join(dataDirectory, 'models.json'), JSON.stringify(catalog, null, 2), 'utf8')
    log(`model catalog: ${catalog.providers.length} providers, ${catalog.providers.reduce((sum, p) => sum + p.models.length, 0)} models`)
  } catch (error) {
    log(`model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Reindex workspace session accounting: sessions created by external headless
 * runs (dsh-routines) never pass through this GUI process, so they stay out
 * of the workspace registry and invisible in the sidebar. Enumerate every
 * persisted session header and attach it to the workspace matching its cwd —
 * attachSession validates the path and persists to workspace.json, so the
 * sidebar picks them up within one sync tick (and they are clickable).
 */
async function reindexWorkspaceSessions(ctx, log) {
  try {
    const headers = await ctx.sessionPersistence.list()
    const workspaces = ctx.workspaceRegistry.list()
    const wsByPath = new Map(workspaces.map((ws) => [ws.path, ws]))
    let attached = 0
    for (const header of headers) {
      if (!header?.id || typeof header.cwd !== 'string') continue
      const ws = wsByPath.get(header.cwd)
      if (!ws) continue
      if (ws.sessionIds.includes(header.id)) continue
      try {
        await ws.attachSession(header.id)
        attached++
      } catch {
        // cwd mismatch or unresolvable path: leave it unattached.
      }
    }
    // Consistency sweep: drop stale record entries — sessions recorded under a
    // workspace whose path no longer matches their cwd (e.g. a session first
    // created with the process cwd, then correctly re-attached elsewhere).
    // Without this, a session accounted twice fails the next boot's domain
    // validation. entity.sessionIds filters by path, so stale entries are only
    // visible through the raw record.
    let detached = 0
    for (const ws of workspaces) {
      const raw = ws.record?.sessionIds ?? []
      for (const sessionId of raw) {
        if (ws.sessionIds.includes(sessionId)) continue
        try {
          await ws.detachSession(sessionId)
          detached++
        } catch {
          // Already gone or not detachable.
        }
      }
    }
    if (attached > 0 || detached > 0) {
      log(`workspace sessions: ${attached} attached, ${detached} stale removed`)
    }
  } catch (error) {
    log(`workspace sessions failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Reconcile claim routines for every board project. Claim routines are
 * virtual: the YAML always exists for workspace-mapped projects (card stays
 * on the automation page), and the automation switch in the board DB — shown
 * on the routines page as the card's on/off state — is the only control.
 * @param baseUrl - internal taskboard loopback base URL.
 * @param log - logger callback.
 * @returns summary string.
 */
async function reconcileAllRoutines(baseUrl, log) {
  const listRes = await fetch(`${baseUrl}/api/projects`)
  if (!listRes.ok) throw new Error(`list projects: HTTP ${listRes.status}`)
  const { projects } = await listRes.json()
  let written = 0
  let removed = 0
  for (const project of projects) {
    let automation = { enabled: false, intervalMinutes: 10 }
    try {
      const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/automation`)
      if (res.ok) automation = (await res.json()).automation
    } catch {
      // keep defaults (disabled)
    }
    const result = await reconcileClaimRoutine(project, automation, baseUrl, log)
    if (result === 'written') written++
    else if (result === 'removed') removed++
  }
  const cleaned = await cleanupStaleClaimRoutines(projects.map((p) => p.id), log)
  return `claim routines: ${written} written, ${removed} removed, ${cleaned} stale cleaned (${projects.length} projects)`
}

/**
 * Start the taskboard server, register the proxy route, and announce the
 * plugin. Start failures are logged, never thrown.
 * @param ctx - context carrying webServer, systemPrompt, and workspaceRegistry.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
  if (config.enabled === false) return

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-taskboard',
    order: SECTION_ORDER,
    text: TASKBOARD_GUIDANCE,
  }), 'dsh-taskboard: prompt section')

  let routeDisposer = undefined
  let app = undefined
  let syncTimer = undefined
  let claimTimer = undefined
  let baseUrl = undefined

  const start = async () => {
    try {
      const dataDirectory = path.resolve(config.dataDirectory)
      await mkdir(dataDirectory, { recursive: true })
      await syncAgentSkill((message) => {
        void pluginLog(message)
        ctx.logger.info(message)
      })
      app = createTaskboardServer({
        dataDirectory,
        staticDirectory: path.join(PLUGIN_ROOT, 'vendor', 'web'),
        skillPath: path.join(PLUGIN_ROOT, 'vendor', 'skills', 'manage-taskboard', 'SKILL.md'),
        routinesDirectory: path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'routines'),
        routinesRunHandler: async (name) => {
          // Claim routines execute in-process (visible/interactive GUI session);
          // everything else falls back to the external ops runner.
          const project = name.startsWith('taskboard-claim-')
            ? (await resolveClaimProject(name, baseUrl))
            : null
          if (project) {
            return runInProcessClaim(ctx, project, baseUrl, (message) =>
              ctx.logger.info(`dsh-taskboard: ${message}`),
            )
          }
          return false
        },
        routinesStopHandler: async (name) => {
          // The stop button passes the routine name (taskboard-claim-<prefix>),
          // not the claim session id — map it to the live session for that
          // project before stopping.
          if (!name.startsWith('taskboard-claim-')) return false
          const project = await resolveClaimProject(name, baseUrl)
          if (!project) return false
          const active = activeClaimSessions().find((entry) => entry.projectId === project.id)
          if (!active) return false
          return stopClaimSession(active.sessionId, (message) => ctx.logger.info(`dsh-taskboard: ${message}`))
        },
      })
      const address = await app.listen({ host: '127.0.0.1', port: config.port })
      routeDisposer = ctx.webServer.register({
        kind: 'prefix',
        path: config.routePrefix,
        handler: makeProxy(address.port, config.routePrefix),
      })
      baseUrl = `http://127.0.0.1:${address.port}`
      void pluginLog(`dsh-taskboard: serving ${config.routePrefix} (internal loopback port ${address.port}, data ${dataDirectory})`)
      ctx.logger.info(`dsh-taskboard: serving ${config.routePrefix} (internal loopback port ${address.port}, data ${dataDirectory})`)
      void refreshModelCatalog(ctx, dataDirectory, (message) => {
        void pluginLog(message)
        ctx.logger.info(`dsh-taskboard: ${message}`)
      })
      if (config.syncWorkspaces) {
        const runSync = () => {
          void syncWorkspacesFromRegistry(ctx.workspaceRegistry, baseUrl, (message) => {
            void pluginLog(message)
            ctx.logger.info(message)
          })
            .then((summary) => {
              if (summary) {
                void pluginLog(summary)
                ctx.logger.info(`dsh-taskboard: ${summary}`)
              }
              if (config.routinesEnabled) {
                return reconcileAllRoutines(baseUrl, (message) => {
                  void pluginLog(message)
                  ctx.logger.info(message)
                })
              }
              return null
            })
            .then((routinesSummary) => {
              if (routinesSummary) {
                void pluginLog(routinesSummary)
                ctx.logger.info(`dsh-taskboard: ${routinesSummary}`)
              }
              return reindexWorkspaceSessions(ctx, (message) => {
                void pluginLog(message)
                ctx.logger.info(message)
              })
            })
            .then(() => {})
            .catch((error) => {
              const message = `workspace sync: ${error instanceof Error ? error.message : String(error)}`
              void pluginLog(message)
              ctx.logger.error(`dsh-taskboard: ${message}`)
            })
        }
        runSync()
        if (config.syncIntervalMs > 0) syncTimer = setInterval(runSync, config.syncIntervalMs)
      }
    } catch (error) {
      const message = `start failed: ${error instanceof Error ? error.message : String(error)}`
      void pluginLog(message)
      ctx.logger.error(`dsh-taskboard: ${message}`)
    }
  }

  const stop = async () => {
    if (claimTimer !== undefined) {
      claimTimer()
      claimTimer = undefined
    }
    if (syncTimer !== undefined) {
      clearInterval(syncTimer)
      syncTimer = undefined
    }
    if (routeDisposer !== undefined) {
      routeDisposer()
      routeDisposer = undefined
    }
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  }

  void start().then(() => {
    if (config.claimPollMs > 0) {
      claimTimer = startClaimScheduler(
        ctx,
        baseUrl,
        Math.max(5000, config.claimPollMs),
        (message) => {
          void pluginLog(message)
          ctx.logger.info(message)
        },
      )
      pluginLog(`claim scheduler started (poll=${Math.max(5000, config.claimPollMs)}ms)`)
    }
  })
  ctx.on('dispose', () => {
    void stop()
  })
}
