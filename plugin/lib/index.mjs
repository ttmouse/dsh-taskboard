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
 *
 * Isolation policy: the data directory is shared by every DSH home while the
 * workspace registry belongs to one home, so the mirror only ever deletes
 * projects the current home created (see the provenance file below) and its
 * teardown always releases the loopback port before a replacement mounts.
 */
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { createTaskboardServer } from '../vendor/server/app.mjs'
import { buildClaimPrompt, buildDispatchPrompt, cleanupStaleClaimRoutines, reconcileClaimRoutine } from './claim-routines.mjs'
import { activeClaimSessions, executeClaimInProcess, finalizeInterruptedRuns, stopClaimSession, writeRunRecord } from './claim-executor.mjs'
import { defaultCheckCommand, runCheck } from './check-gate.mjs'
import { createDshChatEngine } from './dsh-chat-engine.mjs'

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
export const TASKBOARD_GUIDANCE = '本机已安装 dsh-taskboard 插件（DSH Web GUI 的完整任务看板）：侧边栏「任务看板」与「自动化」入口、右栏「任务」侧栏；完整能力来自本地 SQLite 服务——多视图（看板/列表/Gantt/工作流/仪表盘）、任务详情（关系/附件/标签/过滤器）、AI 对话、项目自动认领（官方 host schedule 服务定时投递到每项目常驻认领会话执行，认领开关即自动化面板的项目开关）。数据存 ~/.dsh/storages/dsh-taskboard/taskboard.sqlite（本机回环端口 47825）。任务可通过看板内「在对话中打开」直接驱动 DSH 会话执行并回写评论。用户提到「任务看板 / 看板 / 任务管理 / 建任务 / 建议题」时即指本插件；对看板的任何读写（建任务、改状态、加评论、加关系）请先加载 manage-taskboard 技能并遵循其 API 纪律（version 并发、署名 headers、threadId 回链），不要绕过技能裸写 HTTP API。'

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
 * Identify the DSH home whose workspace registry this host mirrors. Two hosts
 * sharing one board database — for example the Desktop app on `~/.dsh-beta`
 * and `dsh web` on `~/.dsh` — have different registries but the same
 * `dataDirectory`, so the home is what tells their projects apart.
 * @param home - explicit `DSH_HOME` override (tests); defaults to the process.
 * @returns the absolute home directory.
 */
export function currentHomeKey(home = process.env.DSH_HOME) {
  return path.resolve(home ?? path.join(os.homedir(), '.dsh'))
}

/**
 * Per-home provenance file inside the (shared) board data directory. One file
 * per home keeps hosts from clobbering each other's bookkeeping.
 * @param dataDirectory - board data directory.
 * @param homeKey - owning DSH home.
 * @returns the absolute state file path.
 */
export function syncStatePath(dataDirectory, homeKey) {
  const digest = createHash('sha1').update(homeKey).digest('hex').slice(0, 12)
  return path.join(dataDirectory, `workspace-sync-${digest}.json`)
}

/**
 * Read the project ids this home created. A missing or unreadable file yields
 * an empty set, which disables removals: a project may only be deleted when
 * this home can prove it created it.
 * @param file - provenance file path.
 * @param log - logger callback.
 * @returns the owned project ids.
 */
export async function readSyncState(file, log = () => {}) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const ids = Array.isArray(parsed?.projects) ? parsed.projects.filter((id) => typeof id === 'string') : []
    return new Set(ids)
  } catch (error) {
    if (error instanceof Error && error.code !== 'ENOENT') {
      log(`workspace sync: cannot read ${path.basename(file)}: ${error.message} — treating no project as owned`)
    }
    return new Set()
  }
}

/**
 * Persist the project ids one home created.
 * @param file - provenance file path.
 * @param homeKey - owning DSH home.
 * @param ids - owned project ids.
 */
export async function writeSyncState(file, homeKey, ids) {
  const body = JSON.stringify({ version: 1, home: homeKey, projects: [...ids].sort() }, null, 2)
  await writeFile(file, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Sync DSH workspaces into board projects: every workspace becomes (or
 * updates) a project keyed by the workspace id, with `workspace_path` set to
 * the workspace path. The workspace registry is the single source of truth —
 * the board's own independent project creation is removed from the UI, so
 * projects mirror the DSH workspace list (plus the legacy 'local' 全局 catch-all).
 *
 * Removals are scoped to projects this home created: the registry only lists
 * the workspaces of the *current* DSH home while the data directory is shared
 * by every home, so an unscoped mirror would delete another home's projects.
 * @param registry - the injected `workspaceRegistry` service.
 * @param baseUrl - internal taskboard loopback base URL.
 * @param log - logger callback.
 * @param options - `dataDirectory` (defaults to the shared board directory) and
 *   an explicit `homeKey` for tests.
 * @returns summary string, or null when the registry is unavailable.
 */
export async function syncWorkspacesFromRegistry(registry, baseUrl, log, options = {}) {
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
  const dataDirectory = options.dataDirectory ?? DEFAULT_DATA_DIR
  const homeKey = options.homeKey ?? currentHomeKey()
  const stateFile = syncStatePath(dataDirectory, homeKey)
  const owned = await readSyncState(stateFile, log)
  const listRes = await fetch(`${baseUrl}/api/projects`)
  if (!listRes.ok) throw new Error(`list projects: HTTP ${listRes.status}`)
  const { projects } = await listRes.json()
  const existing = new Map(projects.map((project) => [project.id, project]))
  const known = new Set(existing.keys())
  let created = 0
  let updated = 0
  let removed = 0
  let kept = 0
  let dirty = false
  for (const ws of workspaces) {
    const current = existing.get(ws.id)
    if (current === undefined) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: ws.id, name: ws.name, workspacePath: ws.path }),
      })
      if (res.ok) {
        created++
        owned.add(ws.id)
        known.add(ws.id)
        dirty = true
      } else {
        log(`workspace sync: create '${ws.id}' failed: HTTP ${res.status}`)
      }
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
  // Mirror removals: a workspace-managed project this home created whose
  // workspace is gone is deleted (the board route refuses 'local' and temp-*
  // projects). Projects another DSH home created are never touched — their
  // workspaces simply are not in this home's registry.
  const currentIds = new Set(workspaces.map((ws) => ws.id))
  for (const project of projects) {
    if (!project.workspacePath || currentIds.has(project.id)) continue
    if (!owned.has(project.id)) {
      kept++
      continue
    }
    const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
    if (res.ok) {
      removed++
      owned.delete(project.id)
      dirty = true
    } else {
      log(`workspace sync: remove '${project.id}' failed: HTTP ${res.status}`)
    }
  }
  // Housekeeping: forget ids that no longer exist on the board at all.
  for (const id of [...owned]) {
    if (!known.has(id)) {
      owned.delete(id)
      dirty = true
    }
  }
  if (dirty) {
    try {
      await writeSyncState(stateFile, homeKey, owned)
    } catch (error) {
      log(`workspace sync: cannot write ${path.basename(stateFile)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const scope = kept > 0 ? `, ${kept} other-home project(s) kept` : ''
  return `workspace sync: ${workspaces.length} workspaces, ${created} created, ${updated} updated, ${removed} removed${scope}`
}

/**
 * Run one teardown step, reporting (never throwing) its failure so that a later
 * step — closing the listening server above all — always runs.
 * @param name - step label for the log.
 * @param action - teardown action, or undefined when there is nothing to release.
 * @param log - logger callback.
 * @returns whether the step completed.
 */
export async function releaseStep(name, action, log = () => {}) {
  if (action === undefined) return true
  try {
    await action()
    return true
  } catch (error) {
    log(`teardown ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Release every resource the host half owns, in order. Cordis disposes a
 * context before mounting its replacement, so one failing step (a route
 * unregister on an already inactive context, say) must not skip the rest and
 * leave the loopback port bound.
 * @param resources - teardown actions; each may be undefined.
 * @param log - logger callback.
 * @returns one result per step, in release order.
 */
export async function releaseHostResources(resources, log = () => {}) {
  return [
    await releaseStep('claim scheduler', resources.stopClaims, log),
    await releaseStep('sync timer', resources.clearSyncTimer, log),
    await releaseStep('route', resources.unregisterRoute, log),
    await releaseStep('chat engine', resources.disposeChatEngine, log),
    await releaseStep('server', resources.closeServer, log),
  ]
}

/**
 * Bind the board server, retrying briefly while the loopback port is still held
 * by a previous instance: a hot reload mounts the replacement before the
 * outgoing host half has finished closing.
 * @param app - board server returned by `createTaskboardServer`.
 * @param options - listen options (`host`, `port`) forwarded to the server.
 * @param retry - attempts, delay between them, and the logger.
 * @returns the bound address.
 */
export async function listenWithRetry(app, options, retry = {}) {
  const attempts = retry.attempts ?? 8
  const delayMs = retry.delayMs ?? 250
  const log = retry.log ?? (() => {})
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await app.listen(options)
    } catch (error) {
      lastError = error
      if (!(error instanceof Error) || error.code !== 'EADDRINUSE' || attempt === attempts) throw error
      log(`port ${options.port} is still busy (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
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

  // Conversation binding applies to scheduled rounds too: a project bound to
  // one conversation keeps appending to it (and rotates after N rounds).
  const binding = await resolveClaimSession(baseUrl, project, automation, log)
  const finished = await executeClaimInProcess({
    ctx,
    project,
    model: automation.model ?? null,
    prompt: buildClaimPrompt(project),
    sessionId: binding.resumeSessionId === null ? binding.sessionId : null,
    resumeSessionId: binding.resumeSessionId,
    log,
  })
  if (finished) await countFixedRound(baseUrl, project, binding)
  return finished
}

/** In-flight dispatch runs, keyed by task id (one live run per issue). */
const dispatchInFlight = new Set()

/**
 * Rounds delivered into one fixed conversation before the automation starts a
 * fresh one. Keeps a long-lived binding from growing without bound (cost and
 * context), while still giving continuity across many rounds.
 */
const FIXED_SESSION_MAX_TURNS = 20

/** Read a project's claim-automation record, tolerating a missing server. */
async function readProjectAutomation(baseUrl, projectId) {
  try {
    const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/automation`)
    if (res.ok) return (await res.json()).automation
  } catch {
    // fall through to the defaults
  }
  return { enabled: false, intervalMinutes: 10, model: null, sessionMode: 'new', sessionId: null, sessionTurns: 0 }
}

/** Persist one automation change without disturbing the switch or the model. */
async function patchProjectAutomation(baseUrl, projectId, changes) {
  const current = await readProjectAutomation(baseUrl, projectId)
  const body = {
    enabled: current.enabled === true,
    intervalMinutes: current.intervalMinutes ?? 10,
    ...(typeof current.model === 'string' && current.model !== '' ? { automationModel: current.model } : {}),
    ...changes,
  }
  try {
    await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/automation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // best effort: bookkeeping must never break a round
  }
}

/**
 * The most recent claim conversation that wrote on this issue, or null. Read
 * from the issue's comments (each carries the conversation it came from), so a
 * task-mode round continues where the issue was last actually worked on.
 */
async function newestClaimThreadForTask(baseUrl, taskId, prefix) {
  if (typeof taskId !== 'string' || taskId === '') return null
  try {
    const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/comments`)
    if (!res.ok) return null
    const comments = (await res.json()).comments ?? []
    const withThread = comments
      .filter((comment) => typeof comment.threadId === 'string' && comment.threadId.startsWith(prefix))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return withThread[0]?.threadId ?? null
  } catch {
    return null
  }
}

/**
 * Resolve which conversation this round runs in.
 *   • sessionMode 'new'   → a fresh claim session (the historical behaviour);
 *   • sessionMode 'fixed' → the chosen conversation, resumed/attached so its
 *     context survives across rounds. After FIXED_SESSION_MAX_TURNS rounds it
 *     rotates to a fresh conversation and remembers that instead.
 * @returns {{ resumeSessionId: string|null, sessionId: string }}
 */
async function resolveClaimSession(baseUrl, project, automation, log, task = null) {
  const prefix = `claim-${project.id.slice(0, 8)}-`
  const fresh = () => `claim-${project.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  // 'task': continue in the conversation that last handled THIS issue, so the
  // round picks up its own history instead of a project-wide thread. Falls back
  // to a fresh conversation when the issue has no (claim) conversation yet —
  // and to the same for scheduled sweeps, which have no single issue.
  if (automation?.sessionMode === 'task') {
    // Prefer the NEWEST claim conversation that touched this issue (the ack and
    // every summary comment carry their session as threadId). `task.threadId`
    // only remembers the first link, so it can point at a stale conversation.
    const newest = await newestClaimThreadForTask(baseUrl, task?.id, prefix)
    if (newest !== null) return { resumeSessionId: newest, sessionId: newest }
    const threadId = typeof task?.threadId === 'string' ? task.threadId : ''
    if (threadId.startsWith(prefix)) return { resumeSessionId: threadId, sessionId: threadId }
    const sessionId = fresh()
    return { resumeSessionId: null, sessionId }
  }
  const fixed = automation?.sessionMode === 'fixed' && typeof automation?.sessionId === 'string' && automation.sessionId !== ''
  if (!fixed) {
    return { resumeSessionId: null, sessionId: fresh() }
  }
  const turns = Number(automation.sessionTurns ?? 0)
  if (turns >= FIXED_SESSION_MAX_TURNS) {
    const sessionId = fresh()
    log(`[claim] ${project.id}: fixed conversation rotated after ${turns} rounds → ${sessionId}`)
    await patchProjectAutomation(baseUrl, project.id, { sessionMode: 'fixed', sessionId, sessionTurns: 0 })
    return { resumeSessionId: null, sessionId }
  }
  return { resumeSessionId: automation.sessionId, sessionId: automation.sessionId }
}

/** Count one delivered round against the bound conversation (rotation fuel). */
async function countFixedRound(baseUrl, project, binding) {
  if (binding.resumeSessionId === null) return
  if (binding.sessionId !== binding.resumeSessionId) return
  const current = await readProjectAutomation(baseUrl, project.id)
  if (current.sessionMode !== 'fixed' || current.sessionId !== binding.sessionId) return
  await patchProjectAutomation(baseUrl, project.id, {
    sessionMode: 'fixed',
    sessionId: binding.sessionId,
    sessionTurns: Number(current.sessionTurns ?? 0) + 1,
  })
}

/**
 * Read the comments a human wrote *after* the run started, as followup text.
 * The watermark advances per delivery, so a turn that ends with no new input
 * delivers nothing (and a delivered comment is never sent twice).
 */
function queuedCommentReader(baseUrl, taskId, sinceIso) {
  let watermark = sinceIso
  return async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/comments`)
    if (!res.ok) return []
    const list = (await res.json()).comments ?? []
    const pending = list
      .filter((comment) => comment.authorType === 'user'
        && typeof comment.createdAt === 'string'
        && comment.createdAt > watermark)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    if (pending.length > 0) watermark = pending[pending.length - 1].createdAt
    return pending.map((comment) => `【运行中追加的评论】\n${String(comment.body ?? '').slice(0, 2000)}`)
  }
}

/**
 * 评论即执行 — run exactly one round for the issue a human just commented on.
 * The board server lives in this process, so the comment arrives as an event
 * within milliseconds: no sweep latency, no polling. Deliberately independent
 * of the automation switch (a human asking is not a schedule) and of the
 * sweep's todo gate. Guards:
 *   • one live run per issue — a comment landing mid-run is picked up by that
 *     run's queue reader at its next turn;
 *   • the issue is moved to in_progress first, so every open board shows the
 *     handoff immediately (the server pushes task.moved over SSE).
 * @returns {Promise<boolean>} true when a round actually ran.
 */
async function runTaskDispatch(ctx, app, baseUrl, task, comment, log) {
  let project
  try {
    project = app.database.getProject(task.projectId)
  } catch {
    project = undefined
  }
  if (!project?.workspacePath) {
    log(`[dispatch] ${task.identifier}: project has no workspace, nothing to run`)
    return false
  }
  if (dispatchInFlight.has(task.id)) {
    log(`[dispatch] ${task.identifier}: a run is already live — the comment is queued for its next turn`)
    return false
  }
  dispatchInFlight.add(task.id)
  try {
    const automation = await readProjectAutomation(baseUrl, project.id)
    const binding = await resolveClaimSession(baseUrl, project, automation, log, task)
    let current = task
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: task.version, status: 'in_progress' }),
      })
      if (res.ok) current = (await res.json()).task ?? task
    } catch {
      // best effort: the round moves the issue itself as part of its workflow
    }
    // The half-second "it heard you": one agent-authored line with the live
    // session linked, so the issue itself shows that work started and can be
    // opened. Agent authorship keeps it out of the dispatch gate (no loop).
    await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}/comments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Taskboard-Client': 'taskctl',
        'X-Taskboard-Agent-Id': 'dsh-agent',
        'X-Taskboard-Agent-Name': 'DSH Agent',
      },
      body: JSON.stringify({
        body: `已按你的评论开始一轮：会话 ${binding.sessionId}。跑完会在这里回一条总结。`,
        threadId: binding.sessionId,
      }),
    }).catch(() => {})
    log(`[dispatch] ${current.identifier}: round started by a human comment`)
    const finished = await executeClaimInProcess({
      ctx,
      project,
      model: automation.model ?? null,
      prompt: buildDispatchPrompt(project, current, comment),
      fetchQueuedComments: queuedCommentReader(
        baseUrl,
        task.id,
        typeof comment.createdAt === 'string' ? comment.createdAt : new Date().toISOString(),
      ),
      sessionId: binding.resumeSessionId === null ? binding.sessionId : null,
      resumeSessionId: binding.resumeSessionId,
      log,
    })
    if (finished) await countFixedRound(baseUrl, project, binding)
    return finished
  } finally {
    dispatchInFlight.delete(task.id)
  }
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
  let dispatchDisposer = undefined
  let baseUrl = undefined
  let stopped = false
  /** AI chat turn engine: panel threads run on in-process DSH sessions. */
  const chatEngine = typeof ctx.agents?.create === 'function'
    ? createDshChatEngine({
        ctx,
        log: (message) => {
          void pluginLog(message)
          ctx.logger.info(message)
        },
        agentsSkillRoot: agentsSkillRoot(),
      })
    : undefined

  const start = async () => {
    try {
      const dataDirectory = path.resolve(config.dataDirectory)
      await mkdir(dataDirectory, { recursive: true })
      void pluginLog(chatEngine === undefined
        ? 'ai chat engine: codex (no live agent service in this host)'
        : 'ai chat engine: dsh (panel turns run on in-process DSH sessions)')
      await syncAgentSkill((message) => {
        void pluginLog(message)
        ctx.logger.info(message)
      })
      app = createTaskboardServer({
        dataDirectory,
        staticDirectory: path.join(PLUGIN_ROOT, 'vendor', 'web'),
        skillPath: path.join(PLUGIN_ROOT, 'vendor', 'skills', 'manage-taskboard', 'SKILL.md'),
        agentEngine: chatEngine,
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
      const address = await listenWithRetry(app, { host: '127.0.0.1', port: config.port }, {
        log: (message) => {
          void pluginLog(message)
          ctx.logger.info(`dsh-taskboard: ${message}`)
        },
      })
      if (stopped) {
        await app.close()
        app = undefined
        return
      }
      routeDisposer = ctx.webServer.register({
        kind: 'prefix',
        path: config.routePrefix,
        handler: makeProxy(address.port, config.routePrefix),
      })
      baseUrl = `http://127.0.0.1:${address.port}`
      void pluginLog(`dsh-taskboard: serving ${config.routePrefix} (internal loopback port ${address.port}, data ${dataDirectory})`)
      ctx.logger.info(`dsh-taskboard: serving ${config.routePrefix} (internal loopback port ${address.port}, data ${dataDirectory})`)
      // Reclaim claim-run records left `running` by a previous host boot.
      try {
        const projects = await (await fetch(`${baseUrl}/api/projects`)).json().then((r) => r.projects ?? [])
        const reclaimed = await finalizeInterruptedRuns(projects, (message) => {
          void pluginLog(message)
          ctx.logger.info(`dsh-taskboard: ${message}`)
        })
        if (reclaimed > 0) {
          void pluginLog(`dsh-taskboard: reclaimed ${reclaimed} interrupted claim run(s)`)
          ctx.logger.info(`dsh-taskboard: reclaimed ${reclaimed} interrupted claim run(s)`)
        }
      } catch (error) {
        void pluginLog(`dsh-taskboard: interrupted-run reclaim failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      void refreshModelCatalog(ctx, dataDirectory, (message) => {
        void pluginLog(message)
        ctx.logger.info(`dsh-taskboard: ${message}`)
      })
      if (config.syncWorkspaces) {
        const runSync = () => {
          if (stopped || !baseUrl) return
          let workspaceRegistry
          try {
            workspaceRegistry = ctx.workspaceRegistry
          } catch (error) {
            const message = `workspace sync: context unavailable: ${error instanceof Error ? error.message : String(error)}`
            void pluginLog(message)
            return
          }
          void syncWorkspacesFromRegistry(workspaceRegistry, baseUrl, (message) => {
            void pluginLog(message)
            ctx.logger.info(message)
          }, { dataDirectory })
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
        if (!stopped && config.syncIntervalMs > 0) syncTimer = setInterval(runSync, config.syncIntervalMs)
      }
    } catch (error) {
      const message = `start failed: ${error instanceof Error ? error.message : String(error)}`
      void pluginLog(message)
      ctx.logger.error(`dsh-taskboard: ${message}`)
    }
  }

  let stopping = false
  const reportTeardown = (message) => {
    void pluginLog(message)
    ctx.logger.warn(`dsh-taskboard: ${message}`)
  }
  const stop = async () => {
    if (stopping) return
    stopping = true
    stopped = true
    if (dispatchDisposer !== undefined) {
      const dispose = dispatchDisposer
      dispatchDisposer = undefined
      dispose()
    }
    await releaseHostResources({
      stopClaims: claimTimer === undefined ? undefined : () => {
        const disposer = claimTimer
        claimTimer = undefined
        disposer()
      },
      clearSyncTimer: syncTimer === undefined ? undefined : () => {
        const timer = syncTimer
        syncTimer = undefined
        clearInterval(timer)
      },
      unregisterRoute: routeDisposer === undefined ? undefined : () => {
        const disposer = routeDisposer
        routeDisposer = undefined
        disposer()
      },
      closeServer: app === undefined ? undefined : async () => {
        const instance = app
        app = undefined
        await instance.close()
      },
      disposeChatEngine: chatEngine === undefined ? undefined : async () => {
        await chatEngine.disposeAll()
      },
    }, reportTeardown)
  }

  void start().then(() => {
    if (!stopped && app !== undefined && baseUrl !== undefined) {
      // 评论即执行: the board server runs in this process, so a human comment
      // on an issue that is waiting for the human reaches us as an event and
      // starts a round right away — the sweep below stays as the fallback.
      const instance = app
      const log = (message) => {
        void pluginLog(message)
        ctx.logger.info(`dsh-taskboard: ${message}`)
      }
      dispatchDisposer = instance.events.subscribe((event) => {
        if (event?.type !== 'task.dispatch-requested' || !event.task || !event.comment) return
        void runTaskDispatch(ctx, instance, baseUrl, event.task, event.comment, log).catch((error) => {
          const message = `[dispatch] ${event.task?.identifier ?? event.task?.id}: ${error instanceof Error ? error.message : String(error)}`
          void pluginLog(message)
          ctx.logger.warn(`dsh-taskboard: ${message}`)
        })
      })
      pluginLog('comment dispatch bridge ready (event-driven, no polling)')
    }
    if (!stopped && app !== undefined && baseUrl !== undefined && config.claimPollMs > 0) {
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
  // Cordis awaits an effect's async disposer before mounting the replacement,
  // so the replacement never races this instance for the loopback port.
  if (typeof ctx.effect === 'function') ctx.effect(() => async () => { await stop() }, 'dsh-taskboard.close')
  else ctx.on('dispose', () => { void stop() })
}
