/**
 * Regression tests for the workspace → project mirror.
 *
 * The board database lives in one shared data directory while the workspace
 * registry belongs to a single DSH home, so an unscoped mirror deletes the
 * projects of every other home that shares the database. These tests pin the
 * provenance-scoped behaviour that replaced it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  readSyncState,
  syncStatePath,
  syncWorkspacesFromRegistry,
  writeSyncState,
} from '../lib/index.mjs'

const BASE_URL = 'http://127.0.0.1:47825'
const originalFetch = globalThis.fetch

/**
 * Minimal in-memory stand-in for the board HTTP API.
 * @param initialProjects - projects the board already holds.
 * @returns the project map, request log, fetch implementation, and DELETE paths.
 */
function createFakeBoard(initialProjects = []) {
  const projects = new Map(initialProjects.map((project) => [project.id, { ...project }]))
  const calls = []
  const json = (body) => ({ ok: true, status: 200, json: async () => body })
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const { pathname } = new URL(url)
    const segments = pathname.split('/').filter(Boolean)
    calls.push({ method, path: pathname, body: init.body })
    if (segments[0] !== 'api' || segments[1] !== 'projects') return { ok: false, status: 404, json: async () => ({}) }
    if (segments.length === 2) {
      if (method === 'GET') return json({ projects: [...projects.values()] })
      if (method === 'POST') {
        const body = JSON.parse(init.body)
        projects.set(body.id, { id: body.id, name: body.name, workspacePath: body.workspacePath })
        return json({ project: projects.get(body.id) })
      }
    }
    if (segments.length === 3) {
      const id = decodeURIComponent(segments[2])
      if (method === 'PUT') {
        projects.set(id, { ...projects.get(id), ...JSON.parse(init.body) })
        return json({ project: projects.get(id) })
      }
      if (method === 'DELETE') {
        projects.delete(id)
        return json({ ok: true })
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return {
    projects,
    calls,
    fetchImpl,
    deletes: () => calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
  }
}

/** Run one sync against a fake board and always restore the global fetch. */
async function withBoard(board, dataDirectory, homeKey, registry, run) {
  globalThis.fetch = board.fetchImpl
  try {
    const logs = []
    const summary = await syncWorkspacesFromRegistry(
      { list: () => registry },
      BASE_URL,
      (message) => logs.push(message),
      { dataDirectory, homeKey },
    )
    return await run({ summary, logs })
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('keeps a project whose workspace belongs to another DSH home', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const board = createFakeBoard([{ id: 'foreign', name: 'foreign', workspacePath: '/Users/x/foreign' }])
    await withBoard(
      board,
      directory,
      '/home/a',
      [{ id: 'mine', title: 'mine', path: '/Users/x/mine' }],
      ({ summary }) => {
        assert.deepEqual(board.deletes(), [], 'a foreign project must never be deleted')
        assert.match(summary, /0 removed/)
        assert.match(summary, /1 other-home project\(s\) kept/)
        assert.equal(board.projects.get('foreign').workspacePath, '/Users/x/foreign')
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('still removes a project this home created when its workspace disappears', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const stateFile = syncStatePath(directory, '/home/a')
    await writeSyncState(stateFile, '/home/a', ['keep', 'gone'])
    const board = createFakeBoard([
      { id: 'keep', name: 'keep', workspacePath: '/Users/x/keep' },
      { id: 'gone', name: 'gone', workspacePath: '/Users/x/gone' },
    ])
    await withBoard(
      board,
      directory,
      '/home/a',
      [{ id: 'keep', title: 'keep', path: '/Users/x/keep' }],
      async ({ summary }) => {
        assert.deepEqual(board.deletes(), ['/api/projects/gone'])
        assert.match(summary, /1 removed/)
        assert.equal((await readSyncState(stateFile)).has('gone'), false, 'the deleted id leaves the provenance file')
        assert.equal((await readSyncState(stateFile)).has('keep'), true)
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('removes nothing when the provenance file is unreadable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const stateFile = syncStatePath(directory, '/home/a')
    await writeFile(stateFile, '{ this is not json', 'utf8')
    const board = createFakeBoard([{ id: 'unproven', name: 'unproven', workspacePath: '/Users/x/unproven' }])
    await withBoard(
      board,
      directory,
      '/home/a',
      [{ id: 'keep', title: 'keep', path: '/Users/x/keep' }],
      ({ logs }) => {
        assert.deepEqual(board.deletes(), [], 'unreadable provenance must fail safe')
        assert.ok(logs.some((message) => /cannot read/.test(message)), 'the unreadable file is reported')
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records per home: a second home neither adopts nor deletes the first home projects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const homeA = syncStatePath(directory, '/home/a')
    const homeB = syncStatePath(directory, '/home/b')
    const board = createFakeBoard()
    await withBoard(board, directory, '/home/a', [{ id: 'a1', title: 'a1', path: '/Users/x/a1' }], async () => {
      assert.equal((await readSyncState(homeA)).has('a1'), true)
    })
    await withBoard(board, directory, '/home/b', [{ id: 'b1', title: 'b1', path: '/Users/x/b1' }], async ({ summary }) => {
      const ownedByB = await readSyncState(homeB)
      assert.equal(ownedByB.has('b1'), true)
      assert.equal(ownedByB.has('a1'), false, 'home B never adopts home A projects')
      assert.equal((await readSyncState(homeA)).has('a1'), true, 'home A keeps its own record')
      assert.deepEqual(board.deletes(), [], 'home B must not delete home A projects')
      assert.match(summary, /1 other-home project\(s\) kept/)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('forgets ids that no longer exist on the board', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const stateFile = syncStatePath(directory, '/home/a')
    await writeSyncState(stateFile, '/home/a', ['ghost', 'keep'])
    const board = createFakeBoard([{ id: 'keep', name: 'keep', workspacePath: '/Users/x/keep' }])
    await withBoard(board, directory, '/home/a', [{ id: 'keep', title: 'keep', path: '/Users/x/keep' }], async () => {
      const state = await readSyncState(stateFile)
      assert.equal(state.has('ghost'), false)
      assert.equal(state.has('keep'), true)
      assert.deepEqual(board.deletes(), [])
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an empty registry stays inert', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskboard-sync-'))
  try {
    const board = createFakeBoard([{ id: 'foreign', name: 'foreign', workspacePath: '/Users/x/foreign' }])
    await withBoard(board, directory, '/home/a', [], ({ summary }) => {
      assert.equal(summary, 'workspace sync: no workspaces')
      assert.deepEqual(board.deletes(), [])
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
