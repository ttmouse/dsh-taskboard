/**
 * dsh-taskboard — claim executor (host half, in-process).
 *
 * Runs claim sessions INSIDE the GUI host process via ctx.agents, so the
 * conversation is a first-class GUI session: it appears in the sidebar, the
 * web client streams it live, the user can open it and keep talking, and it
 * can be stopped. Scheduling (the automation switch) and run records mirror
 * the dsh-routines format so the routines page keeps showing claim status —
 * but no external headless runner is involved, so there is no torn-log blind
 * spot and no "cannot monitor/intervene" gap.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { routinesDir } from './claim-routines.mjs'

/** In-flight claim sessions: sessionId -> control record. */
const ACTIVE = new Map()

/** Short label for the run record's routine field (matches the yaml name). */
export function claimRoutineName(projectId) {
  return `taskboard-claim-${projectId.slice(0, 12)}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extract a digest from the session's last assistant text (for run records). */
function digestFromEvents(events) {
  let text = ''
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && part.text) text = part.text
    }
  }
  return text.length > 0 ? text.slice(0, 600) : null
}

/** Write a run record in the dsh-routines schema under the routine's cwd runs dir. */
async function writeRunRecord(project, run) {
  const record = {
    runId: `run-${Date.now()}-${randomUUID().slice(0, 5)}`,
    routine: claimRoutineName(project.id),
    profile: 'headless',
    cwd: project.workspacePath,
    ...run,
  }
  // The runs dir for a routine lives under the routine's cwd; derive it the
  // same way dsh-routines does (<cwd>/.dsh/routines/runs).
  const runsDir = path.join(project.workspacePath, '.dsh', 'routines', 'runs')
  await mkdir(runsDir, { recursive: true })
  await writeFile(path.join(runsDir, `${record.runId}.json`), JSON.stringify(record, null, 2), 'utf8')
  return record.runId
}

/** Resolve agent options for the claim run (per-project model override). */
function resolveAgentOptions(ctx, model, log) {
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
    log(`[claim] default model unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (model) {
    const separator = model.indexOf('::')
    if (separator >= 0) {
      const provider = model.slice(0, separator)
      const modelId = model.slice(separator + 2)
      if (provider && modelId) agentOptions = { ...agentOptions, provider, model: modelId }
    } else {
      agentOptions = { ...agentOptions, model }
    }
  }
  return agentOptions
}

/**
 * Execute one claim in-process: create the agent (standard preset, project
 * cwd), followup with the skill-driven prompt, wait for the turn to end in
 * the durable log, then dispose. Run record written on start and finish.
 * @returns {Promise<boolean>} true when the turn ended (ok or error).
 */
export async function executeClaimInProcess({ ctx, project, model, prompt, log }) {
  const sessionId = `claim-${project.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  let handle
  const runId = await writeRunRecord(project, {
    status: 'running',
    startedAt,
    sessionId,
  }).catch(() => null)

  try {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: project.workspacePath, agentPreset: 'standard' },
      agentOptions: resolveAgentOptions(ctx, model, log),
    })
  } catch (error) {
    const message = `agent create failed: ${error instanceof Error ? error.message : String(error)}`
    log(`[claim] ${project.id}: ${message}`)
    if (runId) {
      await writeRunRecord(project, {
        status: 'failed',
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        error: message,
      }).catch(() => {})
    }
    return false
  }

  ACTIVE.set(sessionId, { handle, projectId: project.id, startedAt })
  try {
    handle.agent.followup({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    log(`[claim] ${project.id}: kicked in-process session ${sessionId} (${project.name})`)
    // Wait for the durable log to record a turn/end, then dispose.
    const deadline = Date.now() + 60 * 60 * 1000
    let finished = false
    let events = []
    while (Date.now() < deadline && ACTIVE.has(sessionId)) {
      try {
        const session = ctx.sessions.get(sessionId)
        events = session?.events ?? []
        if (events.some((event) => event.type === 'turn/end')) {
          finished = true
          break
        }
      } catch {
        break
      }
      await sleep(2000)
    }
    const digest = digestFromEvents(events)
    if (runId) {
      await writeRunRecord(project, {
        status: finished ? 'ok' : 'failed',
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        exitCode: finished ? 0 : 1,
        sessionId,
        ...(digest ? { digest } : {}),
        ...(finished ? {} : { error: 'claim turn did not end within 60min (stopped?)' }),
      }).catch(() => {})
    }
    return finished
  } finally {
    ACTIVE.delete(sessionId)
    try {
      await handle.dispose()
    } catch (error) {
      log(`[claim] ${project.id}: dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Stop a running in-process claim session (returns true when found). */
export async function stopClaimSession(sessionId, log) {
  const control = ACTIVE.get(sessionId)
  if (!control) return false
  ACTIVE.delete(sessionId)
  try {
    await control.handle.dispose()
    log(`[claim] stopped session ${sessionId}`)
  } catch (error) {
    log(`[claim] stop failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

/** Snapshot of active claim sessions (for the stop button UI). */
export function activeClaimSessions() {
  return [...ACTIVE.entries()].map(([sessionId, control]) => ({
    sessionId,
    projectId: control.projectId,
    startedAt: control.startedAt,
  }))
}
