/**
 * dsh-taskboard — claim routines manager (host half).
 *
 * Auto-claim is implemented with dsh-routines (the third-party cron bundle
 * installed in the ops profile) instead of a long-running job: the automation
 * switch writes/removes a routine YAML under $DSH_HOME/routines, and the ops
 * profile's routines-scheduler ticks every 30s and runs due routines as
 * headless one-shot sessions. No heartbeat files, no taskctl, no daemon loop.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serializeRoutine } from '../vendor/shared/routines-yaml.mjs'

/** Routine directory the ops scheduler watches. */
export function routinesDir() {
  return process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'routines')
    : path.join(os.homedir(), '.dsh', 'routines')
}

/** Routine name/file stem for a project. */
export function routineNameFor(projectId) {
  return `taskboard-claim-${projectId.slice(0, 12)}`
}

function routineFileFor(projectId) {
  return path.join(routinesDir(), `${routineNameFor(projectId)}.yaml`)
}

/** intervalMinutes -> 5-field cron (routines supports step-N and 0-based hours). */
function cronFor(intervalMinutes) {
  if (intervalMinutes >= 60) return '0 * * * *'
  return `*/${Math.max(1, Math.min(60, Math.round(intervalMinutes)))} * * * *`
}

/**
 * Build the claim prompt for one project. Kept short on purpose: the
 * manage-taskboard skill (registered in the harness skill catalog, synced
 * from this plugin's skills/) carries the API base URL, endpoint reference,
 * and the full claim workflow; the routine only binds the skill to this
 * project's concrete context. This mirrors the original dashi-taskboard
 * approach — the skill holds the process, the prompt names the skill.
 */
export function buildClaimPrompt(project) {
  return [
    `你是 dsh-taskboard 的自动认领例程，处理「${project.name}」项目（项目 ID：${project.id}，项目目录：${project.workspacePath}）。`,
    '使用 manage-taskboard 技能执行一次自动认领：找到该项目最早的 todo 议题，读取最新内容与全部评论后认领（移动到 in_progress），实现并自验后回写总结评论、移到 in_review。',
    '所有细节（API 基址、乐观并发、状态流转规则）以技能文档为准。',
  ].join('\n')
}

/** Serialize one routine YAML via the shared writer (stable, human-diffable). */
export function buildRoutineYaml(project, automation, apiBase, paused = false) {
  return serializeRoutine({
    name: routineNameFor(project.id),
    schedule: cronFor(automation.intervalMinutes ?? 10),
    timezone: 'Asia/Shanghai',
    prompt: buildClaimPrompt(project),
    cwd: project.workspacePath,
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 30,
    deliver: ['file'],
    paused,
  })
}

/**
 * Reconcile one project's claim routine: enabled + workspacePath -> write,
 * otherwise remove. The automation menu is the only writer of these files.
 * A user-set `paused` flag on the existing file is preserved across rewrites
 * (the automation page toggles it).
 * @returns 'written' | 'removed' | 'unchanged'.
 */
export async function reconcileClaimRoutine(project, automation, apiBase, log) {
  const file = routineFileFor(project.id)
  const enabled = automation.enabled && Boolean(project.workspacePath)
  if (!enabled) {
    try {
      await unlink(file)
      log(`routine ${routineNameFor(project.id)}: removed`)
      return 'removed'
    } catch (error) {
      if (error.code !== 'ENOENT') log(`routine remove failed: ${String(error)}`)
      return 'unchanged'
    }
  }
  const currentText = await readFile(file, 'utf8').catch(() => '')
  // Claim routines are always marked paused: the external ops runner must
  // skip them — execution happens in-process so the GUI streams the session.
  const next = buildRoutineYaml(project, automation, apiBase, true)
  try {
    if (currentText === next) return 'unchanged'
    await mkdir(routinesDir(), { recursive: true })
    await writeFile(file, next, 'utf8')
    log(`routine ${routineNameFor(project.id)}: written (${cronFor(automation.intervalMinutes ?? 10)})`)
    return 'written'
  } catch (error) {
    log(`routine write failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'unchanged'
  }
}
