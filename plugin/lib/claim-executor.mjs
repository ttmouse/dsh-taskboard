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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { routinesDir } from './claim-routines.mjs'

/** In-flight claim sessions: sessionId -> control record. */
const ACTIVE = new Map()

/**
 * Control record for one in-flight claim session. `requestStop` is invoked by
 * the stop path so the executor's poll loop can distinguish a deliberate user
 * stop (recorded `canceled`) from a 60-minute deadline or silent failure
 * (recorded `failed`); `disposed` makes dispose idempotent across the stop
 * path and the executor's own `finally`.
 */
function claimControl(handle, projectId, startedAt, shared = false) {
  let stopped = false
  return {
    handle,
    projectId,
    startedAt,
    /** True for a resumed conversation the human also uses: never dispose it. */
    shared,
    stopped: () => stopped,
    requestStop: () => {
      stopped = true
    },
    disposed: false,
  }
}

/** Short label for the run record's routine field (matches the yaml name). */
export function claimRoutineName(projectId) {
  return `taskboard-claim-${projectId.slice(0, 12)}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Attach a claim conversation to the board project's workspace so it is filed
 * under the project in the GUI sidebar instead of trailing in Ungrouped.
 *
 * The host only attaches a session to a workspace when `session.create`
 * carries `workspaceId` (packages/api/session-controller — commands.ts); the
 * `ctx.agents.create` path used here (agents registry, core/agent) writes the
 * session header cwd but performs no workspace attach, so every claim
 * conversation was born outside its project. Board projects mirror DSH
 * workspaces keyed by the workspace id (syncWorkspacesFromRegistry), so the
 * workspace id IS `project.id`; a path match covers non-mirrored projects.
 * `attachSession` validates the session's header cwd against the workspace
 * path and is idempotent, so a mismatch is refused, never misfiled. Failure
 * is logged and must not fail the claim round — the conversation still works,
 * it would merely land in Ungrouped again.
 */
export async function attachClaimSessionToWorkspace(ctx, project, sessionId, log) {
  try {
    const registry = ctx.workspaceRegistry
    if (registry === undefined || typeof registry.list !== 'function') return
    let workspace = typeof registry.get === 'function' ? registry.get(project.id) : undefined
    if (workspace === undefined) {
      workspace = registry.list().find((entry) => entry.path === project.workspacePath)
    }
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return
    await workspace.attachSession(sessionId)
    log(`[claim] ${project.id}: session ${sessionId} attached to workspace ${workspace.path}`)
  } catch (error) {
    log(`[claim] ${project.id}: workspace attach failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
export async function writeRunRecord(project, run) {
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
  return record
}

/** Claim runs write their final record to the same file they opened in
 *  `status: 'running'` (one run = one file, so no stale running files are
 *  left behind on a normal finish). */
export async function writeRunRecordFinal(runId, project, run) {
  const runsDir = path.join(project.workspacePath, '.dsh', 'routines', 'runs')
  await mkdir(runsDir, { recursive: true })
  await writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2), 'utf8')
}

/**
 * A claim run opens a `status: 'running'` record before it boots the agent,
 * and writes the terminal record when the turn ends. If the host process was
 * killed between those two writes, the running record is never finalized and
 * would render as a permanent "running" on the automation panel. Reclaim the
 * ones left by the claim executor (claim-* session ids) that predate this
 * boot: they are, by construction, orphans of a previous process — no live
 * session in the current host can belong to them.
 */
export async function finalizeInterruptedRuns(projects, log) {
  const claimId = new Set()
  for (const project of projects) {
    if (project.workspacePath) claimId.add(claimRoutineName(project.id))
  }
  if (claimId.size === 0) return 0
  let reclaimed = 0
  for (const project of projects) {
    if (!project.workspacePath) continue
    const runsDir = path.join(project.workspacePath, '.dsh', 'routines', 'runs')
    let files
    try {
      files = await readdir(runsDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.startsWith('run-') || !file.endsWith('.json')) continue
      const recordPath = path.join(runsDir, file)
      let record
      try {
        record = JSON.parse(await readFile(recordPath, 'utf8'))
      } catch {
        continue
      }
      if (record.status !== 'running') continue
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
      if (!sessionId.startsWith('claim-')) continue
      if (!claimId.has(record.routine)) continue
      const startedAt = typeof record.startedAt === 'number' ? record.startedAt : 0
      const finishedAt = Date.now()
      const final = {
        ...record,
        status: 'interrupted',
        finishedAt,
        durationMs: startedAt > 0 ? finishedAt - startedAt : null,
        error: 'interrupted: host restarted before the run finished',
      }
      try {
        await writeFile(recordPath, JSON.stringify(final, null, 2), 'utf8')
        reclaimed += 1
        log(`[claim] reclaimed interrupted run ${record.runId} (${record.routine})`)
      } catch {
        // keep going; the record simply stays running
      }
    }
  }
  return reclaimed
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
 *
 * Conversation binding (issue 09582F74F86A-13):
 *   • default — a fresh session per round, owned here, disposed at the end;
 *   • `resumeSessionId` — attach to an existing conversation (`agents.get`
 *     when it is already live, `agents.resume` otherwise). Such a session is
 *     SHARED with the human: this executor never disposes it, so the
 *     conversation (and whatever the user typed in it) survives the round.
 *
 * When `fetchQueuedComments` is supplied (dispatch runs for one issue), a
 * comment the human adds *while the run is working* is not lost: after each
 * turn ends the executor asks for comments written since the last turn and,
 * if there are any, delivers them as one more followup and keeps going — the
 * "排队，下一轮开始时送达" contract. Bounded so a chatty thread cannot loop
 * forever.
 * @param options - ctx, project, model, prompt, log, optional queue reader,
 *   optional sessionId / resumeSessionId.
 * @returns {Promise<boolean>} true when the turn ended (ok or error).
 */
export async function executeClaimInProcess({
  ctx,
  project,
  model,
  prompt,
  log,
  fetchQueuedComments = null,
  sessionId: requestedSessionId = null,
  resumeSessionId = null,
  deadlineMs = 60 * 60 * 1000,
}) {
  const sessionId = requestedSessionId ?? resumeSessionId ?? `claim-${project.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  /** A resumed/attached conversation belongs to the human: never dispose it. */
  const shared = resumeSessionId !== null
  const startedAt = Date.now()
  let handle
  const runRecord = await writeRunRecord(project, {
    status: 'running',
    startedAt,
    sessionId,
  }).catch(() => null)

  // Resolve the agent preset BEFORE the session exists (the session header
  // snapshots `meta`, so a preset discovered during setup could never reach
  // it), then mount it in the setup callback — mirroring dsh-host-apiproxy's
  // composeAgent(). Without the mount the claim session's tools resolve
  // against the empty global layer (browser-bridge tools only), so the
  // manage-taskboard skill's bash+curl workflow has no bash to run.
  let claimPreset = null
  try {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) claimPreset = await presets.resolve('standard')
  } catch (error) {
    log(`[claim] ${project.id}: preset resolve failed, falling back to unmounted agent: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (shared) {
      // Attach to the human's conversation: reuse the live agent when the
      // session is already open, otherwise resume it from its durable log.
      const live = ctx.agents.get(sessionId)
      handle = live !== undefined
        ? { agent: live, dispose: async () => {} }
        // Registry form: `resume(options)` — one argument. (The two-argument
        // `resume(ownerCtx, options)` belongs to the AgentFactory contract; the
        // registry reads the options object directly, so passing a context
        // first makes it read `resumeSessionId` off the proxied context and
        // fail with "cannot get property resumeSessionId without injection".)
        : await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: resolveAgentOptions(ctx, model, log),
            ...(claimPreset !== null
              ? {
                  setup: async (agentCtx) => {
                    await ctx.get('agentPresets').mount(agentCtx, claimPreset.id)
                  },
                }
              : {}),
          })
      log(`[claim] ${project.id}: attached to shared conversation ${sessionId}`)
    } else {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: project.workspacePath,
          ...(claimPreset !== null ? { agentPreset: claimPreset.id } : {}),
        },
        ...(claimPreset !== null
          ? {
              setup: async (agentCtx) => {
                await ctx.get('agentPresets').mount(agentCtx, claimPreset.id)
              },
            }
          : {}),
        agentOptions: resolveAgentOptions(ctx, model, log),
      })
    }
  } catch (error) {
    const message = `agent ${shared ? 'resume' : 'create'} failed: ${error instanceof Error ? error.message : String(error)}`
    log(`[claim] ${project.id}: ${message}`)
    if (runRecord) {
      await writeRunRecordFinal(runRecord.runId, project, {
        ...runRecord,
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
  // File the conversation under the project right away — both for fresh
  // sessions and for resumed/shared ones (attach is idempotent).
  await attachClaimSessionToWorkspace(ctx, project, sessionId, log)

  const control = claimControl(handle, project.id, startedAt, shared)
  ACTIVE.set(sessionId, control)
  let unsubscribeEvents = null
  try {
    // The prompt message MUST carry a stable id: dsh-session persists
    // user/message events with the message verbatim and validates on load
    // that every message event has an identified message (`Message.id` is
    // required). Omitting it writes a session that later fails history
    // replay with "session event at seq N lacks an identified message".
    log(`[claim] ${project.id}: kicked in-process session ${sessionId} (${project.name})`)
    // Wait for the turn to end, then dispose. A queued human comment (written
    // while this run works) starts one more turn. Turn endings reach plugins
    // on the ctx event bus — the same `session/event` surface the chat engine
    // streams from. `ctx.sessions.get(...).events` is the shell catalog's
    // snapshot face: for agents-registry sessions it never reflects the live
    // log, so polling it never saw a turn end — every round burned the whole
    // 60min deadline, its run record stayed 'running', and the dispatch gate
    // silently swallowed every human comment that landed in between.
    const deadline = Date.now() + deadlineMs
    let events = []
    let turnEndCount = 0
    try {
      unsubscribeEvents = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId || !event?.type) return
        events.push(event)
        if (event.type === 'turn/end') turnEndCount += 1
      })
    } catch (error) {
      log(`[claim] ${project.id}: session/event subscribe failed (${error instanceof Error ? error.message : String(error)}); rounds will end at the deadline`)
    }
    const countTurnEnds = () => turnEndCount
    const waitForTurnEnd = async (baseline) => {
      while (Date.now() < deadline && ACTIVE.has(sessionId)) {
        if (countTurnEnds() > baseline) return true
        await sleep(2000)
      }
      return false
    }

    let baseline = countTurnEnds()
    // The dispatch prompt carries source kind "schedule": the web GUI renders
    // non-user waking messages as the official compact trigger card (the
    // 「自动化任务」 clock pill, expandable) instead of a wall of prompt text —
    // the same conversation embedding official automation turns get. Queued
    // human comments below keep kind "user": they are human words and must
    // stay attributed to the user.
    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'schedule' },
    })
    let finished = await waitForTurnEnd(baseline)
    for (let queuedRounds = 0; finished && fetchQueuedComments !== null && queuedRounds < 3; queuedRounds += 1) {
      const queued = await fetchQueuedComments().catch(() => [])
      if (!Array.isArray(queued) || queued.length === 0) break
      log(`[claim] ${project.id}: delivering ${queued.length} queued comment(s) to ${sessionId}`)
      baseline = countTurnEnds()
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: queued.join('\n\n') }],
        source: { kind: 'user' },
      })
      finished = await waitForTurnEnd(baseline)
    }
    const stoppedByUser = control.stopped()
    const digest = digestFromEvents(events)
    if (runRecord) {
      await writeRunRecordFinal(runRecord.runId, project, {
        ...runRecord,
        status: finished ? 'ok' : stoppedByUser ? 'canceled' : 'failed',
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        exitCode: finished ? 0 : stoppedByUser ? null : 1,
        sessionId,
        ...(digest ? { digest } : {}),
        ...(finished
          ? {}
          : stoppedByUser
            ? { error: 'stopped by user' }
            : { error: 'claim turn did not end within 60min (stopped?)' }),
      }).catch(() => {})
    }
    return finished
  } finally {
    ACTIVE.delete(sessionId)
    if (typeof unsubscribeEvents === 'function') {
      try {
        unsubscribeEvents()
      } catch {
        // event bus already torn down — nothing to clean
      }
    }
    if (!control.disposed && !control.shared) {
      control.disposed = true
      try {
        await control.handle.dispose()
      } catch (error) {
        log(`[claim] ${project.id}: dispose failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/** Stop a running in-process claim session (returns true when found). */
export async function stopClaimSession(sessionId, log) {
  const control = ACTIVE.get(sessionId)
  if (!control) return false
  ACTIVE.delete(sessionId)
  control.requestStop()
  if (control.shared) {
    // The conversation belongs to the human: interrupt this round's turn but
    // leave the session live, so whatever they typed in it survives.
    log(`[claim] interrupted shared conversation ${sessionId} (session kept)`)
    return true
  }
  if (!control.disposed) {
    control.disposed = true
    try {
      await control.handle.dispose()
      log(`[claim] stopped session ${sessionId}`)
    } catch (error) {
      log(`[claim] stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
