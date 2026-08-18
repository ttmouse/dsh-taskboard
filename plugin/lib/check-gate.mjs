/**
 * dsh-taskboard — check gate (shared execution core).
 *
 * Runs a user-configured pre-check command in the task working directory
 * BEFORE an agent session is created. Exit-code semantics:
 *   - 0    → pass: proceed with this round.
 *   - 2    → skip: do NOT start the agent, zero tokens spent.
 *   - other exit code / spawn failure / timeout → fail: block this round.
 *
 * The module is deliberately decoupled from its callers (claim chain now,
 * migrated periodic routines in phase 2) — it takes a command + cwd + env
 * and returns a verdict. On Windows the configured command must name an
 * explicit interpreter (e.g. "node check.mjs"); the command runs through the
 * platform shell so quoted paths and pipes behave like a terminal.
 */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

export const CHECK_PASS = 'pass'
export const CHECK_SKIP = 'skip'
export const CHECK_FAIL = 'fail'

export const DEFAULT_CHECK_TIMEOUT_MS = 30_000

/** Convention path (relative to the task working directory) checked when no
 * explicit checkCommand is configured. */
export const DEFAULT_CHECK_RELATIVE = 'scripts/schedule-checks/check.mjs'

const MAX_OUTPUT_CHARS = 2000

function cap(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`
    : text
}

/** Kill the spawned process tree (detached group on POSIX, taskkill on Windows). */
function killTree(child, log) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch (error) {
      log?.(`[check-gate] taskkill failed: ${String(error)}`)
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve the convention-path check command, or null when the file is absent.
 * @param {string} cwd - task working directory.
 * @returns {Promise<string|null>} e.g. "node scripts/schedule-checks/check.mjs".
 */
export async function defaultCheckCommand(cwd) {
  try {
    await access(path.join(cwd, ...DEFAULT_CHECK_RELATIVE.split('/')))
  } catch {
    return null
  }
  return `node ${DEFAULT_CHECK_RELATIVE}`
}

/**
 * Run one pre-check command.
 * @param {object} opts
 * @param {string} opts.command - full command string (explicit interpreter).
 * @param {string} opts.cwd - working directory for the check.
 * @param {Record<string,string>} [opts.env] - extra env vars merged over process.env.
 * @param {number} [opts.timeoutMs] - kill the check after this long (default 30s).
 * @param {(msg: string) => void} [opts.log] - diagnostic logger.
 * @returns {Promise<{kind: 'pass'|'skip'|'fail', exitCode: number|null, timedOut: boolean,
 *   error: string|null, stdout: string, stderr: string, durationMs: number}>}
 */
export async function runCheck({ command, cwd, env = {}, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, log }) {
  const startedAt = Date.now()
  const base = { exitCode: null, timedOut: false, error: null, stdout: '', stderr: '', durationMs: 0 }

  if (typeof command !== 'string' || command.trim() === '') {
    return { kind: CHECK_FAIL, ...base, error: 'empty check command', durationMs: Date.now() - startedAt }
  }

  const child = spawn(command.trim(), {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    killTree(child, log)
  }, timeoutMs)

  let result
  try {
    const { code, signal, error } = await new Promise((resolve) => {
      child.on('error', (spawnError) => resolve({ code: null, signal: null, error: spawnError }))
      child.on('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal, error: null }))
    })
    const durationMs = Date.now() - startedAt
    if (timedOut) {
      result = { kind: CHECK_FAIL, exitCode: null, timedOut: true, error: `check timed out after ${timeoutMs}ms`, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    } else if (error) {
      result = { kind: CHECK_FAIL, exitCode: null, timedOut: false, error: `cannot spawn check: ${error.message}`, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    } else if (signal) {
      result = { kind: CHECK_FAIL, exitCode: null, timedOut: false, error: `check killed by signal ${signal}`, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    } else if (code === 0) {
      result = { kind: CHECK_PASS, exitCode: code, timedOut: false, error: null, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    } else if (code === 2) {
      result = { kind: CHECK_SKIP, exitCode: code, timedOut: false, error: null, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    } else {
      result = { kind: CHECK_FAIL, exitCode: code, timedOut: false, error: null, stdout: cap(stdout), stderr: cap(stderr), durationMs }
    }
  } finally {
    clearTimeout(timeout)
  }

  return result
}
