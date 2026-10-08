/**
 * Regression tests for the dispatch session title (issue 832047A82866-3:
 * 我感觉自动触发的任务的这个标题，前面可以简化点，这个ID没有意义的。
 * 需要放一些用户看得懂的。).
 *
 * Two contracts, both user-visible in the conversation list:
 *
 *  1. No id noise. The 「议题 <IDENTIFIER>：」 prefix was dropped in issue
 *     09582F74F86A-78; this keeps it out.
 *  2. No mid-sentence truncation. The host's session-title service enforces an
 *     explicit rename through `normalizeSessionTitle(text, maxTitleBytes)` — a
 *     raw UTF-8 byte budget with no word boundary and no ellipsis (measured at
 *     80 bytes on 2026-10-09). Passing the issue title through unchanged made a
 *     46-character Chinese title render as 「…前面可以简化点，这个ID」, which
 *     reads as broken. The title is now derived in the plugin so it fits the
 *     budget and ends on a boundary a human recognises.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionTitle } from '../lib/claim-routines.mjs'

/** The host's budget, mirrored from the measured rename cap. */
const HOST_MAX_TITLE_BYTES = 80

/** The exact issue title that produced the user-visible fragment. */
const REPORTED_TITLE = '我感觉自动触发的任务的这个标题，前面可以简化点，这个ID没有意义的。需要放一些用户看得懂的。'

test('an issue title that already fits is used verbatim', () => {
  const title = '移除掉这个侧边栏的额外间距。'
  assert.equal(buildSessionTitle({ title }), title)
})

test('a long issue title is never cut mid-sentence by the host budget', () => {
  const result = buildSessionTitle({ title: REPORTED_TITLE })
  assert.ok(
    Buffer.byteLength(result, 'utf8') <= HOST_MAX_TITLE_BYTES,
    `title must fit the host budget, got ${Buffer.byteLength(result, 'utf8')} bytes`,
  )
  // The reported fragment ended on a dangling "这个ID" — the whole point.
  assert.ok(!result.endsWith('这个ID'), `title still ends on a dangling fragment: ${result}`)
  // An intentional shortening shows as an ellipsis, not a silent chop.
  assert.ok(result.endsWith('…'), `expected a visible ellipsis, got: ${result}`)
  assert.ok(result.startsWith('我感觉自动触发的任务的这个标题'), `lost the readable head: ${result}`)
})

test('the title carries no issue identifier or UUID noise', () => {
  const result = buildSessionTitle({
    title: '现在是会有一个脚本在持续的轮询吗？',
    identifier: '832047A82866-2',
    id: '520b3486-3946-4185-8e66-1f07395ba120',
  })
  assert.ok(!result.includes('832047A82866-2'), `identifier leaked into title: ${result}`)
  assert.ok(!result.includes('520b3486'), `uuid leaked into title: ${result}`)
  assert.equal(result, '现在是会有一个脚本在持续的轮询吗？')
})

test('an empty title falls back to the identifier rather than 未命名', () => {
  assert.equal(buildSessionTitle({ title: '   ', identifier: '832047A82866-9' }), '832047A82866-9')
  assert.equal(buildSessionTitle({ title: '' }), '')
})

test('truncation never exceeds the budget or splits a code point', () => {
  const alphabet = '我感标题前面可以简化点这个ID没有意义的需要放一些用户看得懂的abc ，。；：、🎉日本語한국어'
  for (let iteration = 0; iteration < 500; iteration++) {
    let source = ''
    const length = Math.floor(Math.random() * 60)
    for (let index = 0; index < length; index++) {
      source += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    const result = buildSessionTitle({ title: source })
    const bytes = Buffer.byteLength(result, 'utf8')
    assert.ok(bytes <= HOST_MAX_TITLE_BYTES, `over budget (${bytes}) for ${JSON.stringify(source)}`)
    assert.ok(!result.includes('\uFFFD'), `split a code point for ${JSON.stringify(source)}`)
  }
})

test('whitespace is collapsed to one line so the sidebar row stays one row', () => {
  assert.equal(buildSessionTitle({ title: '  多行\n标题\t要压平  ' }), '多行 标题 要压平')
})
