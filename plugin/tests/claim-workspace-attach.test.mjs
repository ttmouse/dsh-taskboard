/**
 * Regression tests for claim-conversation workspace attachment (issue
 * 09582F74F86A-42: 自动认领创建的对话没有创在同一个项目下面).
 *
 * The host attaches a session to a workspace only when `session.create`
 * carries `workspaceId`; the agents-registry path (`ctx.agents.create`) used
 * by the claim executor writes the header cwd but never attaches, so claim
 * conversations used to trail in the sidebar's Ungrouped bucket. The executor
 * must attach the conversation to the project's workspace right after
 * create/resume — by workspace id (board projects mirror DSH workspaces) with
 * a path fallback — without ever failing the claim round.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachClaimSessionToWorkspace, executeClaimInProcess } from '../lib/claim-executor.mjs'

const PROJECT_ID = '09582f74-f86a-44f6-b9d3-500fc168e291'
const WORKSPACE_PATH = '/Users/douba/Projects/dsh-taskboard'

/** Fake workspace registry mirroring the host surface: get(id) + list(). */
function createRegistry({ records, getMissesId = false } = {}) {
  const attached = []
  const list = (records ?? []).map((record) => ({
    ...record,
    attachSession: async (sessionId) => {
      attached.push({ id: record.id, path: record.path, sessionId })
      if (record.fail) throw new Error(record.fail)
    },
  }))
  return {
    attached,
    registry: {
      get: (id) => (getMissesId ? undefined : list.find((entry) => entry.id === id)),
      list: () => list,
    },
  }
}

function createCtx(registry, { liveAgent = true } = {}) {
  const handle = { agent: { followup() {} }, dispose: async () => {} }
  // The executor detects turn endings on the host event bus
  // (`ctx.on("session/event")` — the same surface the chat engine streams
  // from) and waits for one MORE than the pre-followup baseline, so the fake
  // bus must fire a turn/end for the executor's session when the followup
  // lands. `sessionId` is bound by whichever create/resume call runs, either
  // the defaults below or a test's override (via setSessionId).
  const handlers = new Set()
  let boundSessionId = null
  const emitTurnEnd = () => {
    for (const handler of handlers) handler({ id: boundSessionId }, { type: 'turn/end' })
  }
  handle.agent.followup = () => {
    emitTurnEnd()
  }
  const ctx = {
    workspaceRegistry: registry,
    get: () => undefined,
    on: (channel, handler) => {
      if (channel !== 'session/event') return () => {}
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    agents: {
      // The registry's get() yields the live Agent; the executor wraps it as
      // `{ agent: live, dispose }` on the shared/resume path. Binding the id
      // here too covers the attach-to-live path, where neither create nor
      // resume runs.
      get: (id) => {
        if (liveAgent && typeof id === 'string') boundSessionId = id
        return liveAgent ? handle.agent : undefined
      },
      create: async (options) => {
        boundSessionId = options?.sessionId ?? boundSessionId
        return handle
      },
      resume: async (options) => {
        boundSessionId = options?.resumeSessionId ?? boundSessionId
        return handle
      },
    },
  }
  return { ctx, handle, setSessionId: (id) => { boundSessionId = id } }
}

test('attachClaimSessionToWorkspace attaches by workspace id (mirrored project)', async () => {
  const { attached, registry } = createRegistry({
    records: [{ id: PROJECT_ID, path: WORKSPACE_PATH }],
  })
  const logs = []
  await attachClaimSessionToWorkspace({ workspaceRegistry: registry }, { id: PROJECT_ID, workspacePath: WORKSPACE_PATH }, 'claim-x-1', (m) => logs.push(m))
  assert.deepEqual(attached, [{ id: PROJECT_ID, path: WORKSPACE_PATH, sessionId: 'claim-x-1' }])
  assert.ok(logs.some((m) => m.includes('attached to workspace')))
})

test('attachClaimSessionToWorkspace falls back to a workspace path match', async () => {
  const { attached, registry } = createRegistry({
    records: [{ id: 'other-workspace-id', path: WORKSPACE_PATH }],
    getMissesId: true,
  })
  await attachClaimSessionToWorkspace({ workspaceRegistry: registry }, { id: PROJECT_ID, workspacePath: WORKSPACE_PATH }, 'claim-x-2', () => {})
  assert.deepEqual(attached, [{ id: 'other-workspace-id', path: WORKSPACE_PATH, sessionId: 'claim-x-2' }])
})

test('attachClaimSessionToWorkspace skips cleanly without a matching workspace', async () => {
  const { attached, registry } = createRegistry({
    records: [{ id: 'other', path: '/somewhere/else' }],
    getMissesId: true,
  })
  await attachClaimSessionToWorkspace({ workspaceRegistry: registry }, { id: PROJECT_ID, workspacePath: WORKSPACE_PATH }, 'claim-x-3', () => {})
  assert.equal(attached.length, 0)
  await attachClaimSessionToWorkspace({}, { id: PROJECT_ID, workspacePath: WORKSPACE_PATH }, 'claim-x-4', () => {})
  assert.equal(attached.length, 0)
})

test('attachClaimSessionToWorkspace logs but never throws on attach failure', async () => {
  const { registry } = createRegistry({
    records: [{ id: PROJECT_ID, path: WORKSPACE_PATH, fail: 'cwd mismatch' }],
  })
  const logs = []
  await attachClaimSessionToWorkspace({ workspaceRegistry: registry }, { id: PROJECT_ID, workspacePath: WORKSPACE_PATH }, 'claim-x-5', (m) => logs.push(m))
  assert.ok(logs.some((m) => m.includes('workspace attach failed') && m.includes('cwd mismatch')))
})

test('executeClaimInProcess attaches the fresh claim session to the project workspace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'claim-attach-'))
  try {
    const { attached, registry } = createRegistry({
      records: [{ id: PROJECT_ID, path: WORKSPACE_PATH }],
    })
    const { ctx, handle, setSessionId } = createCtx(registry)
    let createdSessionId
    ctx.agents.create = async (options) => {
      createdSessionId = options.sessionId
      setSessionId(options.sessionId)
      return handle
    }
    const logs = []
    const project = { id: PROJECT_ID, name: 'dsh-taskboard', workspacePath: workspace }
    const finished = await executeClaimInProcess({ ctx, project, model: null, prompt: 'p', log: (m) => logs.push(m), deadlineMs: 500 })
    assert.equal(finished, true)
    assert.ok(createdSessionId?.startsWith(`claim-${PROJECT_ID.slice(0, 8)}-`))
    assert.deepEqual(attached, [{ id: PROJECT_ID, path: WORKSPACE_PATH, sessionId: createdSessionId }])
    assert.ok(logs.some((m) => m.includes('attached to workspace')))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('executeClaimInProcess attaches resumed shared sessions too and survives attach errors', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'claim-attach-'))
  try {
    const { attached, registry } = createRegistry({
      records: [{ id: PROJECT_ID, path: WORKSPACE_PATH, fail: 'cwd mismatch' }],
    })
    const { ctx } = createCtx(registry, { liveAgent: true })
    const logs = []
    const resumed = 'claim-09582f74-deadbeef'
    const project = { id: PROJECT_ID, name: 'dsh-taskboard', workspacePath: workspace }
    const finished = await executeClaimInProcess({
      ctx,
      project,
      model: null,
      prompt: 'p',
      resumeSessionId: resumed,
      log: (m) => logs.push(m),
      deadlineMs: 500,
    })
    assert.equal(finished, true)
    assert.deepEqual(attached.map((entry) => entry.sessionId), [resumed])
    assert.ok(logs.some((m) => m.includes('workspace attach failed')))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
