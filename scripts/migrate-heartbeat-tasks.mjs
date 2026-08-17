/**
 * One-off migration: convert reasonix heartbeat tasks (unrelated to claim
 * automation) into taskboard issues.
 *
 * - Reads ~/.reasonix/heartbeat-tasks.json (the dead Reasonix heartbeat
 *   runner's config; all tasks are disabled).
 * - Skips taskboard_claim_* entries (those are the claim automation itself).
 * - Maps each task's workspaceRoot to a board project by workspace_path;
 *   unmatched roots fall back to the 'local' 全局 project.
 * - Creates one todo issue per task (idempotent: skips an existing issue
 *   with the same title in the target project).
 *
 * Usage: node scripts/migrate-heartbeat-tasks.mjs [apiBase]
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const API_BASE = process.argv[2] ?? 'http://127.0.0.1:47825'
const HEARTBEAT_FILE = path.join(os.homedir(), '.reasonix', 'heartbeat-tasks.json')

async function api(suffix, options) {
  const res = await fetch(`${API_BASE}${suffix}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${options?.method ?? 'GET'} ${suffix}: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

const main = async () => {
  const heartbeat = JSON.parse(await readFile(HEARTBEAT_FILE, 'utf8'))
  const tasks = Array.isArray(heartbeat.tasks) ? heartbeat.tasks : []
  const { projects } = await api('/api/projects')
  const projectByPath = new Map(
    projects.filter((p) => p.workspacePath).map((p) => [p.workspacePath, p]),
  )
  const localProject = projects.find((p) => p.id === 'local')

  let created = 0
  let skipped = 0
  let failed = 0
  for (const task of tasks) {
    if (String(task.id ?? '').startsWith('taskboard_claim_')) continue
    const title = String(task.title ?? '').trim()
    if (!title) continue
    const workspaceRoot = String(task.workspaceRoot ?? '').trim()
    const project = projectByPath.get(workspaceRoot) ?? localProject
    if (!project) {
      console.log(`  SKIP  ${title.slice(0, 40)}: no project for workspace ${workspaceRoot || '(none)'}`)
      failed++
      continue
    }
    // Idempotency: same title already exists in the target project.
    const existing = await api(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)
    if (existing.tasks.some((t) => t.title === title)) {
      console.log(`  SKIP  ${title.slice(0, 40)}: already in ${project.name}`)
      skipped++
      continue
    }
    const description = [
      `（由 Reasonix 心跳任务迁移而来）`,
      `- 心跳 id：${task.id}`,
      `- 原间隔：${task.interval ?? '?'}`,
      task.prompt ? `\n原始 prompt：\n${task.prompt}` : '',
    ].filter(Boolean).join('\n')
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          title,
          description,
          status: 'todo',
          labels: ['心跳迁移'],
        }),
      })
      console.log(`  CREATE ${title.slice(0, 40)} -> ${project.name}`)
      created++
    } catch (error) {
      console.log(`  FAIL  ${title.slice(0, 40)}: ${error.message}`)
      failed++
    }
  }
  console.log(`\n完成: ${created} created, ${skipped} skipped(已存在), ${failed} failed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
