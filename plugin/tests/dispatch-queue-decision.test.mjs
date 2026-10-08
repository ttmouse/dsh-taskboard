/**
 * 「议题已有活轮次时，这次派发去哪」的判定（issue 09582F74F86A-98）。
 *
 * 这是「不静默丢活」的核心分岔，也是唯一容易搞错的一处：
 *
 *   · 人类评论 —— 交给在跑那一轮（它的队列读会送达）。若在这里再排一轮，
 *     同一句话会被执行两遍。
 *   · 没有评论载体的请求（定时到点、自动化面板的播放按钮）—— 排队等它。
 *     以前这两者一起被丢掉，而且播放按钮还回报「已触发」。
 *
 * 排队本身要留痕（status:'queued' 运行记录），自动化面板才看得见；
 * 重复请求不叠加（每议题至多一条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { pendingDispatches, queueOrHandOff } from '../lib/index.mjs'

const silent = () => {}

/** 每个用例一个临时工作区，运行记录写在那里。 */
async function withWorkspace(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'taskboard-queue-'))
  try {
    return await run({ id: 'p1', name: 'proj', workspacePath: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runRecords(project) {
  const dir = path.join(project.workspacePath, '.dsh', 'routines', 'runs')
  const files = await readdir(dir).catch(() => [])
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'))))
}

function drainQueue() {
  for (const taskId of ['t1', 't2', 't3']) pendingDispatches.take(taskId)
}

test('人类评论不排队：交给在跑那一轮，避免同一句话执行两遍', async () => {
  drainQueue()
  await withWorkspace(async (project) => {
    const verdict = await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, { id: 'c1' }, 'busy', silent)
    assert.equal(verdict, 'skipped')
    assert.equal(pendingDispatches.has('t1'), false)
    assert.deepEqual(await runRecords(project), [], '评论交给在跑那轮时不该写排队记录')
  })
})

test('没有评论载体的请求排队，而不是丢掉', async () => {
  drainQueue()
  await withWorkspace(async (project) => {
    const verdict = await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, null, 'a live round holds the lease', silent)
    assert.equal(verdict, 'queued')
    assert.equal(pendingDispatches.has('t1'), true)
    assert.equal(pendingDispatches.take('t1').reason, 'a live round holds the lease')
  })
})

test('排队留痕：写一条 status=queued 的运行记录（自动化面板看得见）', async () => {
  drainQueue()
  await withWorkspace(async (project) => {
    await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, null, 'another round is live', silent)
    const records = await runRecords(project)
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'queued')
    assert.match(records[0].error, /another round is live/)
    pendingDispatches.take('t1')
  })
})

test('重复排队不叠加：每议题至多一条，且只写一条记录', async () => {
  drainQueue()
  await withWorkspace(async (project) => {
    await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, null, 'first', silent)
    const second = await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, null, 'second', silent)
    assert.equal(second, 'queued', '第二次仍然回 queued——这次请求确实被接住了')
    assert.equal(pendingDispatches.take('t1').reason, 'first', '保留先到的那条')
    assert.equal((await runRecords(project)).length, 1, '重复请求不该再写一条记录')
  })
})

test('不同议题各自排队，互不影响', async () => {
  drainQueue()
  await withWorkspace(async (project) => {
    await queueOrHandOff(project, { id: 't1', identifier: 'P-1' }, null, 'r1', silent)
    await queueOrHandOff(project, { id: 't2', identifier: 'P-2' }, null, 'r2', silent)
    assert.equal(pendingDispatches.take('t1').reason, 'r1')
    assert.equal(pendingDispatches.take('t2').reason, 'r2')
  })
})
