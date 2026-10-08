/**
 * 排队的那一轮怎么被接上（issue 09582F74F86A-98）。
 *
 * 一轮结束时调 startQueuedRound：取走排队项 → 重读议题拿最新 version → 起一轮。
 *
 * 两件必须钉住的事：
 *   1. 取走只发生一次。若「没拿到租约的那次」也调用它，就会变成
 *      「排队 → 发现自己还是忙 → 再排队」的空转死循环。取走即消费是这道的闸门。
 *   2. 议题重读失败不能让收尾炸掉，也不能假装跑了一轮。
 *
 * 这里用一个「没有工作区的项目」当终点：runTaskDispatch 会立刻返回 skipped，
 * 所以测试不会真的拉起 agent 会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pendingDispatches, startQueuedRound } from '../lib/index.mjs'

const silent = () => {}

/** app 只被用到 database.getProject：没有工作区 -> 派发在起步前就结束。 */
const appWithoutWorkspace = {
  database: { getProject: () => ({ id: 'p1', name: 'proj', workspacePath: null }) },
}

/** 把全局 fetch 换成记账桩，测试结束恢复。 */
async function withFetchStub(handler, run) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return handler(String(url), init)
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const taskResponse = (task) => ({
  ok: true,
  status: 200,
  json: async () => ({ task }),
})

test('没有排队项时什么都不做，也不发请求', async () => {
  pendingDispatches.take('t-none')
  await withFetchStub(
    async () => { throw new Error('不该发请求') },
    async (calls) => {
      startQueuedRound({}, appWithoutWorkspace, 'http://127.0.0.1:1', 't-none', silent)
      await new Promise((r) => setTimeout(r, 30))
      assert.deepEqual(calls, [])
    },
  )
})

test('取走即消费：接一次之后队列里不再有它（防止空转死循环）', async () => {
  pendingDispatches.enqueue('t1', { reason: 'busy' })
  await withFetchStub(
    async () => taskResponse({ id: 't1', identifier: 'P-1', projectId: 'p1' }),
    async (calls) => {
      startQueuedRound({}, appWithoutWorkspace, 'http://127.0.0.1:1', 't1', silent)
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(pendingDispatches.has('t1'), false, '取走后队列里不该还留着')
      assert.equal(calls.length, 1, '应重读一次议题')
      assert.match(calls[0], /\/api\/tasks\/t1$/)
    },
  )
})

test('重读失败：消费掉排队项、不抛错、也不起轮', async () => {
  pendingDispatches.enqueue('t2', { reason: 'busy' })
  await withFetchStub(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async (calls) => {
      startQueuedRound({}, appWithoutWorkspace, 'http://127.0.0.1:1', 't2', silent)
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(calls.length, 1)
      assert.equal(pendingDispatches.has('t2'), false, '取走过就不该再排着（否则会反复重试）')
    },
  )
})

test('重读回来的是空任务：安静结束', async () => {
  pendingDispatches.enqueue('t3', { reason: 'busy' })
  await withFetchStub(
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
    async () => {
      startQueuedRound({}, appWithoutWorkspace, 'http://127.0.0.1:1', 't3', silent)
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(pendingDispatches.has('t3'), false)
    },
  )
})
