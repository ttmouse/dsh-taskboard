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
 * Build the claim prompt for one project — a skill-driven routine: the
 * workflow lives in the manage-taskboard skill (synced into the agents skill
 * root on plugin start), the prompt carries only the concrete project context.
 * This mirrors the original dashi-taskboard: the skill holds the process, the
 * prompt names the skill and the project.
 */
export function buildClaimPrompt(project, apiBase) {
  return [
    `你是 dsh-taskboard 的自动认领例程，处理「${project.name}」项目（项目 ID：${project.id}，项目目录：${project.workspacePath}）。`,
    `看板 HTTP API 基址：${apiBase}（本机回环，直接 curl）。`,
    '先加载 manage-taskboard 技能，按其流程处理该项目最早的 todo 议题（认领 in_progress → 实现自验 → 总结评论 → in_review；不要直接置 done，done 必须由用户在页面确认验收；无法继续的移到 blocked，不再做的移到 canceled）。所有写操作必须携带最新 version 做乐观并发控制。',
  ].join('\n')
}

/** Serialize one routine YAML via the shared writer (stable, human-diffable). */
export function buildRoutineYaml(project, automation, apiBase) {
  return serializeRoutine({
    name: routineNameFor(project.id),
    schedule: cronFor(automation.intervalMinutes ?? 10),
    timezone: 'Asia/Shanghai',
    prompt: buildClaimPrompt(project, apiBase),
    cwd: project.workspacePath,
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 30,
    deliver: ['file'],
  })
}

/**
 * Reconcile one project's claim routine: enabled + workspacePath -> write,
 * otherwise remove. The automation menu is the only writer of these files.
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
  const next = buildRoutineYaml(project, automation, apiBase)
  try {
    const current = await readFile(file, 'utf8').catch(() => '')
    if (current === next) return 'unchanged'
    await mkdir(routinesDir(), { recursive: true })
    await writeFile(file, next, 'utf8')
    log(`routine ${routineNameFor(project.id)}: written (${cronFor(automation.intervalMinutes ?? 10)})`)
    return 'written'
  } catch (error) {
    log(`routine write failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'unchanged'
  }
}
