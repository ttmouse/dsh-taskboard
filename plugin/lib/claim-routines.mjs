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
 * Build the claim prompt for one project — the same HTTP-API workflow the
 * sweeper used, embedded in the routine (agents load manage-taskboard via the
 * system prompt; the prompt carries the concrete project context).
 */
export function buildClaimPrompt(project, apiBase) {
  const api = (suffix) => `${apiBase}${suffix}`
  return [
    `你是 dsh-taskboard 的自动认领例程，处理「${project.name}」项目（项目 ID：${project.id}，项目目录：${project.workspacePath}）。`,
    `看板 HTTP API 基址：${apiBase}（本机回环，直接 curl）。所有写操作必须携带最新 version 做乐观并发控制。`,
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

/** Serialize one routine YAML (stable field order, human-diffable). */
export function buildRoutineYaml(project, automation, apiBase) {
  const lines = [
    `name: ${routineNameFor(project.id)}`,
    `schedule: "${cronFor(automation.intervalMinutes ?? 10)}"`,
    'timezone: Asia/Shanghai',
    'prompt: |',
    ...buildClaimPrompt(project, apiBase).split('\n').map((line) => `  ${line}`),
    `cwd: ${project.workspacePath}`,
    'profile: headless',
    'overlap: skip',
    'timeoutMin: 30',
    'deliver:',
    '  - type: file',
    '',
  ]
  return lines.join('\n')
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
