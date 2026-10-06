/**
 * Regression tests for the host half lifecycle.
 *
 * Hot reload disposes the outgoing plugin instance and mounts the replacement.
 * A teardown step that throws (unregistering a route on an already inactive
 * context, for example) used to skip the server close, which left the loopback
 * port bound and made the replacement fail with EADDRINUSE.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { listenWithRetry, releaseHostResources, releaseStep } from '../lib/index.mjs'

const addressInUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })

test('a failing teardown step never skips closing the server', async () => {
  const order = []
  const logs = []
  const results = await releaseHostResources({
    stopClaims: () => {
      order.push('claims')
      throw new Error('cannot get required service in inactive context')
    },
    clearSyncTimer: () => order.push('timer'),
    unregisterRoute: () => {
      order.push('route')
      throw new Error('webserver is gone')
    },
    disposeChatEngine: async () => order.push('chat-engine'),
    closeServer: async () => order.push('server'),
  }, (message) => logs.push(message))

  assert.deepEqual(order, ['claims', 'timer', 'route', 'chat-engine', 'server'], 'the server is always closed last')
  assert.deepEqual(results, [false, true, false, true, true])
  assert.equal(logs.length, 2, 'both failures are reported')
})

test('releaseStep tolerates missing steps and reports failures', async () => {
  const logs = []
  assert.equal(await releaseStep('nothing', undefined, (message) => logs.push(message)), true)
  assert.equal(await releaseStep('server', async () => {}, (message) => logs.push(message)), true)
  assert.equal(await releaseStep('server', () => { throw new Error('boom') }, (message) => logs.push(message)), false)
  assert.deepEqual(logs, ['teardown server failed: boom'])
})

test('listenWithRetry retries a busy port, then succeeds', async () => {
  let attempts = 0
  const app = {
    listen: async () => {
      attempts += 1
      if (attempts < 3) throw addressInUse()
      return { port: 47825 }
    },
  }
  const address = await listenWithRetry(app, { host: '127.0.0.1', port: 47825 }, { attempts: 5, delayMs: 1 })
  assert.deepEqual(address, { port: 47825 })
  assert.equal(attempts, 3)
})

test('listenWithRetry gives up with the last error instead of looping', async () => {
  let attempts = 0
  const stuck = {
    listen: async () => {
      attempts += 1
      throw addressInUse()
    },
  }
  await assert.rejects(
    () => listenWithRetry(stuck, { host: '127.0.0.1', port: 47825 }, { attempts: 4, delayMs: 1 }),
    /EADDRINUSE/,
  )
  assert.equal(attempts, 4)
})

test('listenWithRetry does not retry non-EADDRINUSE failures', async () => {
  let attempts = 0
  const broken = {
    listen: async () => {
      attempts += 1
      throw new Error('board server exploded')
    },
  }
  await assert.rejects(
    () => listenWithRetry(broken, { host: '127.0.0.1', port: 47825 }, { attempts: 5, delayMs: 1 }),
    /board server exploded/,
  )
  assert.equal(attempts, 1)
})

test('listenWithRetry rebinds the same server object once the previous holder exits', async () => {
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const { port } = blocker.address()
  const server = createServer(() => {})
  const app = {
    listen: ({ host, port: target }) => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(server.address())
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(target, host)
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  const release = setTimeout(() => blocker.close(), 150)
  try {
    const address = await listenWithRetry(app, { host: '127.0.0.1', port }, { attempts: 40, delayMs: 50 })
    assert.equal(address.port, port)
  } finally {
    clearTimeout(release)
    await app.close()
  }
})
