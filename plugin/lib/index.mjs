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
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { createTaskboardServer } from '../vendor/server/app.mjs'
import { startClaimSweeper } from './claim-sweeper.mjs'

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

/** Default webserver route prefix proxying the taskboard. */
const DEFAULT_ROUTE_PREFIX = '/dsh-taskboard'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 205

/** Required services: webserver, system-prompt band, workspace registry, jobs, agents, sessions, the default-model service, and llm. */
export const inject = ['webServer', 'systemPrompt', 'workspaceRegistry', 'jobs', 'agents', 'sessions', 'agentDefaultModel', 'llm']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASKBOARD_GUIDANCE = '本机已安装 dsh-taskboard 插件（DSH Web GUI 的完整任务看板）：侧边栏「任务看板」入口；完整能力来自本地 SQLite 服务——多视图（看板/列表/Gantt/工作流/仪表盘）、任务详情（关系/附件/标签/过滤器）、AI 对话、项目自动认领（DSH 原生 claim-sweep 后台作业驱动，认领/执行/回写全部通过本机看板 HTTP API 完成，无 taskctl、无外部心跳文件）。数据存 ~/.dsh/storages/dsh-taskboard/taskboard.sqlite（本机回环端口 47825）。任务可通过看板内「在对话中打开」直接驱动 DSH 会话执行并回写评论。用户提到「任务看板 / 看板 / 任务管理」时即指本插件，请据此协作。'

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
  /** When true, the host half runs the DSH-native claim sweeper (auto-claim). */
  claimSweeperEnabled: z.boolean().default(true),
  /** Claim sweep poll interval in ms (clamped to >= 5000). */
  claimSweepPollMs: z.natural().max(3_600_000).default(60_000),
  /** When true, DSH workspaces are synced into board projects (workspace = project). */
  syncWorkspaces: z.boolean().default(true),
  /** Workspace → project sync interval in ms (0 disables periodic re-sync). */
  syncIntervalMs: z.natural().max(3_600_000).default(60_000),
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
  let sweeper = undefined
  let syncTimer = undefined
  let baseUrl = undefined

  const start = async () => {
    try {
      const dataDirectory = path.resolve(config.dataDirectory)
      await mkdir(dataDirectory, { recursive: true })
      app = createTaskboardServer({
        dataDirectory,
        staticDirectory: path.join(PLUGIN_ROOT, 'vendor', 'web'),
        skillPath: path.join(PLUGIN_ROOT, 'vendor', 'skills', 'manage-taskboard', 'SKILL.md'),
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
            })
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

  const startClaimSweep = async () => {
    if (config.claimSweeperEnabled === false) return
    try {
      sweeper = await startClaimSweeper({
        ctx,
        baseUrl,
        pollMs: Math.max(5000, config.claimSweepPollMs),
        log: (message) => {
          void pluginLog(message)
          ctx.logger.info(message)
        },
      })
      if (!sweeper.running) sweeper = undefined
    } catch (error) {
      const message = `claim sweeper start failed: ${error instanceof Error ? error.message : String(error)}`
      void pluginLog(message)
      ctx.logger.error(`dsh-taskboard: ${message}`)
    }
  }

  const stop = async () => {
    if (syncTimer !== undefined) {
      clearInterval(syncTimer)
      syncTimer = undefined
    }
    if (sweeper !== undefined) {
      await sweeper.stop()
      sweeper = undefined
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
    void startClaimSweep()
  })
  ctx.on('dispose', () => {
    void stop()
  })
}
