/**
 * dsh-taskboard — claim sweeper (host half).
 *
 * DSH-native replacement for the old Reasonix heartbeat-file runner: a
 * background job (ctx.jobs, visible in the GUI jobs panel, killable) whose
 * loop periodically sweeps projects with claim automation enabled and kicks a
 * real in-process DSH agent session (`ctx.agents.create` + `followup`) per
 * due project. The agent drives the board through its HTTP API — no heartbeat
 * files, no taskctl, no external runner.
 *
 * Failure policy: sweep errors are logged, never thrown — the host must not
 * take the GUI down. A single instance is guaranteed by the plugin applying
 * once per host process and by the in-flight set.
 */
import { randomUUID } from 'node:crypto'

/** Job identity used by the GUI jobs panel. */
const JOB_KIND = 'claim-sweep'
const JOB_LABEL = '任务看板自动认领（dsh-taskboard）'

/**
 * Build the claim prompt for one project. Self-contained (no skill lookup):
 * the agent works the board via the loopback HTTP API with optimistic
 * concurrency (version) and the human-gate rule (done only after user
 * acceptance).
 * @param project - { id, name, workspacePath }.
 * @param baseUrl - internal taskboard loopback base URL.
 * @returns the agent prompt text.
 */
function buildClaimPrompt(project, baseUrl) {
  const api = (path) => `${baseUrl}${path}`
  return [
    `你是 dsh-taskboard 插件的自动认领作业，处理「${project.name}」项目（项目 ID：${project.id}，项目目录：${project.workspacePath}）。`,
    `看板 HTTP API 基址：${baseUrl}（本机回环端口，直接 curl 即可）。所有写操作必须携带最新 version 做乐观并发控制。`,
    '流程：',
    `1. GET ${api(`/api/tasks?projectId=${project.id}&status=todo`)} 找到最早的 todo 议题；`,
    `2. GET ${api('/api/tasks/<identifier>')} 读取议题最新内容；GET ${api('/api/tasks/<identifier>/comments')} 读取全部评论（评论是需求的一部分，含已完成后被打回的返工要求）；`,
    `3. 认领：POST ${api('/api/tasks/<identifier>/move')}，body {"version":<最新version>,"status":"in_progress"}；若 version 冲突或状态已变化，立即跳过该议题，避免多个 Agent 抢同一任务；`,
    `4. 在 ${project.workspacePath} 目录下执行实现并自验；`,
    `5. 完成并验证后，先 POST ${api('/api/tasks/<identifier>/comments')} 添加总结评论（关键改动/验证结果/剩余风险），再用最新 version 将议题 move 到 in_review；不要直接置 done（done 必须由用户在页面确认验收）；`,
    `6. 无法继续的议题 move 到 blocked；确定不再做的 move 到 canceled。`,
    '遇到 version 冲突：重新 GET 议题读取最新状态，用新 version 重试；若状态已非 todo，跳过。',
  ].join('\n')
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until the claim session's durable log records a turn/end (the claim
 * run actually finished). `agent.running` is a drain interval and can be
 * false between queued turns, so disposing on it alone aborts the fresh turn.
 * @returns {Promise<boolean>} true when a turn ended before the deadline.
 */
async function waitForClaimTurn({ ctx, sessionId, log }) {
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    try {
      const session = ctx.sessions.get(sessionId)
      const events = session?.events ?? []
      if (events.some((event) => event.type === 'turn/end')) return true
    } catch (error) {
      log(`[claim] ${sessionId}: session probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    await sleep(2000)
  }
  return false
}

/**
 * Kick one claim agent session for a project and wait for it to settle.
 * @returns {Promise<boolean>} true when the agent finished (or was skipped).
 */
async function kickClaimSession({ ctx, project, baseUrl, log }) {
  if (!project.workspacePath) return false
  const sessionId = `claim-${project.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  let handle
  try {
    // Programmatic agents get no automatic model: resolve the deployment
    // default (settings.yaml agent-default-model) and pass it explicitly.
    let agentOptions = {}
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.() ?? {}
      if (selection.provider && selection.model) {
        agentOptions = {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
    } catch (error) {
      log(`[claim] ${project.id}: default model unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: project.workspacePath, agentPreset: 'standard' },
      agentOptions,
    })
  } catch (error) {
    log(`[claim] ${project.id}: agent create failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  try {
    handle.agent.followup(buildClaimPrompt(project, baseUrl))
    log(`[claim] ${project.id}: kicked session ${sessionId} (${project.name})`)
    // Wait for the claim turn to actually end (durable log), then dispose.
    const finished = await waitForClaimTurn({ ctx, sessionId, log })
    if (!finished) log(`[claim] ${sessionId}: claim turn did not end within 30min (disposing anyway)`)
    return finished
  } catch (error) {
    log(`[claim] ${project.id}: run failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    try {
      await handle.dispose()
    } catch (error) {
      log(`[claim] ${project.id}: dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Start the claim sweeper as a native background job.
 * @param options - { ctx, baseUrl, pollMs, log }.
 * @returns {Promise<{running: boolean, stop(): Promise<void>}>}
 */
export async function startClaimSweeper({ ctx, baseUrl, pollMs = 60_000, log = () => {} }) {
  const controllerDisposer = ctx.jobs.attachController(JOB_KIND)
  const inFlight = new Set()
  let stopped = false

  /** One sweep pass: find due projects and kick their claim sessions. */
  const sweep = async () => {
    let projects = []
    try {
      const res = await fetch(`${baseUrl}/api/projects`)
      if (!res.ok) throw new Error(`list projects: HTTP ${res.status}`)
      const body = await res.json()
      projects = body.projects ?? []
    } catch (error) {
      log(`[claim] sweep: list failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const now = Date.now()
    for (const project of projects) {
      if (stopped) break
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
      // lastClaimAt is stored as an ISO string by the board DB (now() format).
      const last = typeof automation.lastClaimAt === 'number'
        ? automation.lastClaimAt
        : typeof automation.lastClaimAt === 'string'
          ? Date.parse(automation.lastClaimAt) || 0
          : 0
      if (now - last < intervalMs) continue

      inFlight.add(project.id)
      try {
        // Stamp first so a crash mid-run does not re-kick immediately.
        await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/claim-run`, { method: 'POST' })
          .catch(() => {})
        await kickClaimSession({ ctx, project, baseUrl, log })
      } finally {
        inFlight.delete(project.id)
      }
    }
  }

  const run = () => {
    const done = (async () => {
      try {
        while (!stopped) {
          await sweep()
          if (stopped) break
          await sleep(pollMs)
        }
      } finally {
        controllerDisposer()
      }
    })()
    return {
      done,
      cancel: () => {
        stopped = true
      },
    }
  }

  let started = false
  try {
    ctx.jobs.start({ kind: JOB_KIND, label: JOB_LABEL, run })
    started = true
    log(`[claim] sweeper job started: poll=${pollMs}ms, api=${baseUrl}`)
  } catch (error) {
    controllerDisposer()
    log(`[claim] sweeper start failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    running: started,
    stop: async () => {
      stopped = true
      log('[claim] sweeper stopped')
    },
  }
}
