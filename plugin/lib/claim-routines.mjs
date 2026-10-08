/**
 * dsh-taskboard — claim routines manager (host half).
 *
 * $DSH_HOME/routines is the PLUGIN's own automation storage (confirmed by
 * the user 2026-10-07 — it is NOT official-host territory). Only projects
 * with the automation switch ON keep a claim routine YAML there — the YAML
 * IS the automation-page card, so switch-off projects get theirs removed to
 * keep the page clean. The board DB keeps every project's automation config,
 * so flipping the switch back on re-materializes the card on the next
 * reconcile tick. The switch — stored in the taskboard DB, toggled from the
 * project automation menu or from the routines page itself — is the only
 * on/off control; /api/routines reports paused == "switch off". The YAML file
 * itself is always written with `paused: true` so any external runner skips
 * it: execution happens in-process, gated on the switch by the board's claim
 * scheduler, so the GUI streams the session. No heartbeat files, no taskctl,
 * no daemon loop.
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
 * The selector — the board's "what's next" as a pure function (ADR-0002).
 * Eligible: status `todo`, not archived, and no incoming `blocks` edge from an
 * issue that has not finished. Order: priority first (urgent → none), then
 * creation time (oldest first) — "最早" survives only as the tiebreaker, the
 * meaning the old claim prompt left the model to guess at.
 * @param tasks - task records as served by GET /api/tasks (listTasks attaches
 *   each task's `relations.blockedBy` summaries).
 * @returns the next task record, or null when nothing is eligible.
 */
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export function selectNextTask(tasks) {
  const open = (status) => status !== 'done' && status !== 'canceled'
  const eligible = (tasks ?? []).filter((task) =>
    task.status === 'todo'
    && !task.archivedAt
    && !(task.relations?.blockedBy ?? []).some((blocker) => open(blocker.status)),
  )
  eligible.sort((left, right) =>
    (PRIORITY_RANK[left.priority] ?? PRIORITY_RANK.none) - (PRIORITY_RANK[right.priority] ?? PRIORITY_RANK.none)
    || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? '')),
  )
  return eligible[0] ?? null
}

/**
 * The routine card's prompt text. Never sent to an agent: claim rounds run
 * through the dispatch pipeline (the selector picks the issue in the host,
 * `buildDispatchPrompt` binds the round), and the YAML is always written
 * paused so external runners skip it. The text only describes the mechanism
 * on the automation page.
 */
export function claimRoutinePromptText(project) {
  return [
    `「${project.name}」项目的自动执行由看板驱动：到点后看板按优先级（同优先级按创建先后）挑出下一个无阻塞的 todo 议题，直接走派发管线开一轮；agent 收到的就是那一个议题，不再自己找活。`,
    '人类随时可以插话：评论即执行；任意议题上的「干一轮」按钮插队一轮。关掉项目开关即停。',
  ].join('\n')
}

/**
 * Build the dispatch prompt for ONE issue a human just dispatched. Two shapes:
 *
 *  - Resumed round (an existing conversation continues): the session history
 *    already holds the workflow precedent (claim → work → summary →
 *    in_review) and the manage-taskboard skill is in its catalog, so the
 *    prompt shrinks to an issue anchor line plus the human's raw text. The
 *    anchor stays even here because `fixed` sessionMode shares ONE
 *    conversation across every issue of the project — a bare「再测一下」
 *    would not say which issue it belongs to.
 *  - Fresh round (no conversation to resume): the session knows nothing, so
 *    the prompt carries the full thin binding — project, issue, comment, and
 *    the one skill line that names the exit contract.
 * @param project - board project record (name, id, workspacePath).
 * @param task - the issue being dispatched (identifier, title, status).
 * @param comment - the human comment that triggered the dispatch, or null for
 *   a zero-input dispatch.
 * @param resumed - true when the round continues an existing conversation.
 */
export function buildDispatchPrompt(project, task, comment, resumed = false) {
  const body = String(comment?.body ?? '').trim().slice(0, 4000)
  if (resumed) {
    return body !== ''
      ? `来自议题 ${task.identifier} 的评论：\n${body}`
      : `（干一轮）继续推进议题 ${task.identifier}。`
  }
  const briefed = body !== ''
  const head = `本轮议题：${task.identifier}「${task.title}」（议题 ID：${task.id}，status=${task.status}）。`
  // Exit contract includes an auto-commit step: when the round changed files
  // in a git workspace, the agent commits them with the issue identifier so
  // every completed round leaves a traceable commit (no push, no unrelated
  // files, silent skip when there is nothing to commit).
  const exit = briefed
    ? '按 manage-taskboard 技能的「评论即执行」流程继续：落实这条评论，回一条总结并把议题移回 in_review。'
    : '按 manage-taskboard 技能读取该议题的最新内容与全部评论（含附件），从上次停下的地方继续，完成后回一条总结并把议题移回 in_review。'
  return [
    `你是 dsh-taskboard 的自动承接例程，处理「${project.name}」项目（项目 ID：${project.id}，项目目录：${project.workspacePath}）。`,
    briefed ? `${head}人类刚在它下面评论：` : `${head}人类按了「干一轮」。`,
    ...(briefed ? ['---', body, '---'] : []),
    exit,
    '收尾时若本轮在项目目录产生了文件修改且该目录是 git 仓库：只把与议题相关的改动 git add 并 commit（提交信息以议题编号开头，如「<议题编号> <一句话改动>」），不要 push、不要提交无关文件；无修改或非 git 仓库则静默跳过。',
  ].join('\n')
}

/** Serialize one routine YAML via the shared writer (stable, human-diffable). */
export function buildRoutineYaml(project, automation, apiBase, paused = false) {
  return serializeRoutine({
    name: routineNameFor(project.id),
    schedule: cronFor(automation.intervalMinutes ?? 10),
    timezone: 'Asia/Shanghai',
    prompt: claimRoutinePromptText(project),
    cwd: project.workspacePath,
    profile: 'headless',
    overlap: 'skip',
    timeoutMin: 30,
    deliver: ['file'],
    paused,
  })
}

/**
 * Reconcile one project's claim routine. A routine YAML IS an automation-page
 * card, so only switch-on projects with a workspace path keep one; switch-off
 * or workspaceless projects get their file removed and the page stays clean.
 * The on/off switch state lives in the automation record (board DB), never in
 * this file. @returns 'written' | 'removed' | 'unchanged'.
 */
export async function reconcileClaimRoutine(project, automation, apiBase, log) {
  const file = routineFileFor(project.id)
  const remove = async (reason) => {
    try {
      await unlink(file)
      log(`routine ${routineNameFor(project.id)}: removed (${reason})`)
      return 'removed'
    } catch (error) {
      if (error.code !== 'ENOENT') log(`routine remove failed: ${String(error)}`)
      return 'unchanged'
    }
  }
  if (!project.workspacePath) return remove('no workspace path')
  // Keep the automation page free of inert cards: a switch-off project must
  // not keep a routine file. Nothing is lost — the DB retains the project's
  // automation config, and the next tick after switch-on rewrites the file.
  if (!automation.enabled) return remove('automation switch off')
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
