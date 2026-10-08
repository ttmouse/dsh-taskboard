/**
 * 派发排队的语义（issue 09582F74F86A-98: 忙碌时排队而不是静默丢活）。
 *
 * 背景：定时到点和自动化面板的 ▶ 都走同一条派发管线，而管线在议题已有活轮次时
 * 直接返回——对定时来说那次触发白费，对 ▶ 来说更糟：HTTP 早回了 202「已触发」，
 * 界面显示成功，实际什么都没跑。
 *
 * 这个队列是「不静默丢活」的全部依据，所以它必须能被直接测，而不是靠读代码相信。
 * 三条硬性质：每议题至多排一条、取走即消费（一次排队只换一轮）、绝不因为忙碌消失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDispatchQueue } from '../lib/dispatch-queue.mjs'

test('空队列：取走是 null，不是 undefined', () => {
  const queue = createDispatchQueue()
  assert.equal(queue.take('t1'), null)
  assert.equal(queue.has('t1'), false)
  assert.equal(queue.size(), 0)
})

test('排一条、取走、再取就没有了（一次排队只换一轮）', () => {
  const queue = createDispatchQueue()
  assert.equal(queue.enqueue('t1', { reason: 'busy' }), true)
  assert.equal(queue.size(), 1)
  assert.equal(queue.take('t1').reason, 'busy')
  assert.equal(queue.size(), 0)
  assert.equal(queue.take('t1'), null)
})

test('同一议题重复排队被拒，先到的那条保留', () => {
  const queue = createDispatchQueue()
  assert.equal(queue.enqueue('t1', { reason: 'first' }), true)
  assert.equal(queue.enqueue('t1', { reason: 'second' }), false)
  assert.equal(queue.size(), 1)
  assert.equal(queue.take('t1').reason, 'first')
})

test('取走之后可以重新排（下一轮再收到请求仍然接得住）', () => {
  const queue = createDispatchQueue()
  queue.enqueue('t1', { reason: 'first' })
  queue.take('t1')
  assert.equal(queue.enqueue('t1', { reason: 'second' }), true)
  assert.equal(queue.take('t1').reason, 'second')
})

test('不同议题互不影响', () => {
  const queue = createDispatchQueue()
  queue.enqueue('t1', { reason: 'a' })
  queue.enqueue('t2', { reason: 'b' })
  assert.equal(queue.size(), 2)
  assert.equal(queue.take('t2').reason, 'b')
  assert.equal(queue.has('t1'), true)
  assert.equal(queue.take('t1').reason, 'a')
  assert.equal(queue.size(), 0)
})

test('排队项带上时间戳；缺省评论是 null（自动化请求没有评论载体）', () => {
  const queue = createDispatchQueue()
  queue.enqueue('t1', {})
  const entry = queue.take('t1')
  assert.equal(entry.comment, null)
  assert.equal(typeof entry.queuedAt, 'number')
  assert.equal(entry.reason, 'busy')
})

test('评论载体被保留（用于诊断是哪次派发排的队）', () => {
  const queue = createDispatchQueue()
  queue.enqueue('t1', { comment: { id: 'c1' }, reason: 'r' })
  assert.deepEqual(queue.take('t1').comment, { id: 'c1' })
})
