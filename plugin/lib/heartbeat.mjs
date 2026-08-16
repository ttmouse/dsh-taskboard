/**
 * dsh-taskboard — in-process heartbeat runner (host half).
 *
 * Port of the fork's scripts/heartbeat-runner.mjs into the plugin process:
 * polls $DSH_HOME/heartbeat-tasks.json, spawns `dsh --profile headless
 * "<prompt>"` per due enabled task (attribution env set), and writes back
 * lastRunAt/lastError/lastRunSessionId. Single-instance semantics reuse the
 * SAME lock file (~/.dsh/heartbeat-runner.lock) the vendored status API
 * probes, so the board's "Heartbeat service" indicator reflects this ticker
 * with zero vendored-code changes: lock pid = this host process.
 *
 * When the lock is held by a LIVE pid (an external launchd runner is already
 * consuming the file), the ticker goes dormant instead of fighting it.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** The DSH home the vendored server resolves too (heartbeat-automation.mjs). */
export function dshHomeDir() {
  return process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

/** Parse an interval label ("5m".."60m", "1h") to milliseconds; null if invalid. */
function parseIntervalMs(label) {
  const match = /^(\d+)(m|h)$/.exec(String(label ?? '').trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2]
  return value * (unit === 'h' ? 3_600_000 : 60_000)
}

/** Poll the heartbeat task file; any read failure yields an empty task list. */
async function readHeartbeatFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { tasks: [] }
  }
}

/** Atomically write back the heartbeat file (temp file + rename). */
async function writeHeartbeatFile(file, heartbeatFile) {
  await mkdir(path.dirname(heartbeatFile), { recursive: true })
  const tmp = `${heartbeatFile}.tmp`
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await rename(tmp, heartbeatFile)
}

/**
 * Run one heartbeat task as a headless dsh session. Attribution env mirrors
 * the fork: the unique session id also replaces the "dsh-heartbeat" thread
 * placeholder inside the prompt, so the board thread points at the real run.
 * @param task - the heartbeat task object.
 * @param dshBin - the dsh executable to spawn.
 * @param log - logger.
 * @returns {Promise<{ok: boolean, sessionId: string}>}
 */
function runTask(task, dshBin, log) {
  return new Promise((resolve) => {
    const sessionId = `dsh-${randomUUID()}`
    const prompt = task.prompt.replaceAll('dsh-heartbeat', sessionId)
    log(`[${task.id}] executing: ${task.title} (session=${sessionId})`)
    const child = spawn(dshBin, ['--profile', 'headless', prompt], {
      cwd: task.workspaceRoot,
      env: {
        ...process.env,
        TASKCTL_AGENT_ID: process.env.HEARTBEAT_AGENT_ID ?? 'dsh-agent',
        TASKCTL_AGENT_NAME: process.env.HEARTBEAT_AGENT_NAME ?? 'DeepSeek Harness',
        DSH_SESSION_ID: sessionId,
        DSH_SESSION_JSONL: '',
        DSH_SHELL: '',
        DSH_WEB_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      log(`[${task.id}] spawn failed: ${error.message}`)
      resolve({ ok: false, sessionId })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        log(`[${task.id}] exit code ${code}`)
        log(`[${task.id}] output tail: ${output.slice(-2000)}`)
      } else {
        log(`[${task.id}] finished`)
      }
      resolve({ ok: code === 0, sessionId })
    })
  })
}

/**
 * Start the in-process heartbeat ticker.
 * @param options - { dshHome, pollMs, dshBin, log }.
 * @returns {Promise<{running: boolean, pid: number|null, stop(): Promise<void>}>}
 *   running=false when another live runner holds the lock (dormant mode).
 */
export async function startHeartbeatTicker({ dshHome, pollMs = 30_000, dshBin = 'dsh', log = () => {} }) {
  const heartbeatFile = path.join(dshHome, 'heartbeat-tasks.json')
  const lockFile = path.join(dshHome, 'heartbeat-runner.lock')
  const inFlight = new Set()
  let timer = undefined
  let stopping = false
  let owned = false

  const acquireLock = async () => {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.close()
      owned = true
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const pid = Number((await readFile(lockFile, 'utf8')).trim())
        if (!Number.isInteger(pid) || pid <= 0) return false
        process.kill(pid, 0)
        return false
      } catch (probeError) {
        if (probeError.code === 'ESRCH') {
          await unlink(lockFile).catch(() => {})
          return acquireLock()
        }
        return false
      }
    }
  }

  const releaseLock = async () => {
    if (!owned) return
    try {
      if (Number((await readFile(lockFile, 'utf8')).trim()) === process.pid) {
        await unlink(lockFile).catch(() => {})
      }
    } catch {
      // Lock file gone or owned by another process: nothing to release.
    }
    owned = false
  }

  /** One poll pass: run every due enabled task, write back results. */
  const tick = async () => {
    const file = await readHeartbeatFile(heartbeatFile)
    const tasks = Array.isArray(file.tasks) ? file.tasks : []
    const now = Date.now()
    let changed = false

    for (const task of tasks) {
      if (!task.enabled || inFlight.has(task.id)) continue
      if (!task.prompt) {
        log(`[${task.id}] skipped: no prompt`)
        continue
      }
      if (!task.workspaceRoot || !existsSync(task.workspaceRoot)) {
        log(`[${task.id}] skipped: workspaceRoot missing (${task.workspaceRoot})`)
        continue
      }
      const intervalMs = parseIntervalMs(task.interval)
      if (!intervalMs) {
        log(`[${task.id}] skipped: unparsable interval "${task.interval}"`)
        continue
      }
      const lastRunAt = typeof task.lastRunAt === 'number' ? task.lastRunAt : 0
      if (now - lastRunAt < intervalMs) continue

      inFlight.add(task.id)
      const startedAt = Date.now()
      const result = await runTask(task, dshBin, log)
      // Record lastRunAt on success AND failure: failures retry next interval.
      task.lastRunAt = Date.now()
      task.lastRunDurationMs = Date.now() - startedAt
      task.lastError = result.ok ? undefined : 'dsh headless run exited non-zero'
      task.lastRunSessionId = result.sessionId
      inFlight.delete(task.id)
      changed = true
    }

    if (changed) {
      file.revision = (file.revision ?? 1) + 1
      await writeHeartbeatFile(file, heartbeatFile)
    }
  }

  /** Self-scheduling poll loop (never overlaps: next tick after this one). */
  const loop = async () => {
    if (stopping) return
    try {
      await tick()
    } catch (error) {
      log(`poll error: ${error instanceof Error ? error.message : String(error)}`)
    }
    timer = setTimeout(loop, pollMs)
  }

  let running = false
  try {
    running = await acquireLock()
  } catch (error) {
    log(`lock error: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (running) {
    log(`heartbeat ticker started: file=${heartbeatFile}, poll=${pollMs}ms, dsh=${dshBin}`)
    void loop()
  } else {
    log(`heartbeat ticker dormant: another runner holds ${lockFile}`)
  }

  return {
    running,
    pid: running ? process.pid : null,
    stop: async () => {
      stopping = true
      if (timer !== undefined) clearTimeout(timer)
      await releaseLock()
      log('heartbeat ticker stopped')
    },
  }
}