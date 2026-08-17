/**
 * dsh-taskboard — claim routines manager (host half).
 *
 * Auto-claim is implemented with dsh-routines (the third-party cron bundle
 * installed in the ops profile): each workspace-mapped project owns a virtual
 * claim routine YAML under $DSH_HOME/routines. The routine file is *always*
 * present (the card in the automation panel stays visible), and the board's
 * automation switch — stored in the taskboard DB, toggled from the project
 * automation menu or from the routines page itself — is the only on/off
 * control. The YAML is always written with `paused: true` so the external
 * ops scheduler skips it: execution happens in-process, gated on the switch
 * by the board's claim scheduler, so the GUI streams the session. No
 * heartbeat files, no taskctl, no daemon loop.
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
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
 * Reconcile one project's claim routine. Claim routines are virtual: the file
 * is always written for projects mapped to a workspace, regardless of the
 * automation switch — the switch lives in the board DB and the routines page
 * reports it via /api/routines (paused == "switch off"). The YAML is always
 * paused so the external ops runner skips it; the in-process scheduler gates
 * on automation.enabled. Only a project without a workspace path gets its
 * file removed (nothing to claim in-process).
 * @returns 'written' | 'removed' | 'unchanged'.
 */
export async function reconcileClaimRoutine(project, automation, apiBase, log) {
  const file = routineFileFor(project.id)
  if (!project.workspacePath) {
    try {
      await unlink(file)
      log(`routine ${routineNameFor(project.id)}: removed (no workspace path)`)
      return 'removed'
    } catch (error) {
      if (error.code !== 'ENOENT') log(`routine remove failed: ${String(error)}`)
      return 'unchanged'
    }
  }
  const currentText = await readFile(file, 'utf8').catch(() => '')
  // Claim routines are always marked paused: the external ops runner must
  // skip them — execution happens in-process so the GUI streams the session.
  // The on/off switch state lives in the automation record, not in this file.
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

/**
 * Remove claim-routine YAMLs whose project no longer exists. Since routine
 * files are never deleted on switch-off, orphans would otherwise linger on
 * the automation page forever. Called by the host after reconciling every
 * current project.
 * @param projectIds - full ids of all current projects.
 * @returns number of stale files removed.
 */
export async function cleanupStaleClaimRoutines(projectIds, log) {
  const valid = new Set(projectIds.map((id) => routineNameFor(id)))
  let removed = 0
  let files
  try {
    files = await readdir(routinesDir())
  } catch {
    return 0
  }
  for (const file of files) {
    if (!file.startsWith('taskboard-claim-') || !file.endsWith('.yaml')) continue
    const stem = file.slice(0, -'.yaml'.length)
    if (valid.has(stem)) continue
    try {
      await unlink(path.join(routinesDir(), file))
      removed++
      log(`routine ${stem}: removed (project gone)`)
    } catch (error) {
      if (error.code !== 'ENOENT') log(`routine remove failed: ${String(error)}`)
    }
  }
  return removed
}
