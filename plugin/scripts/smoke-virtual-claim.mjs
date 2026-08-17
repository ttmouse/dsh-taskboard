/**
 * Smoke test: claim routines are virtual — the YAML card always exists for
 * workspace-mapped projects, and the automation switch (toggled from the
 * routines page PUT) drives the card's paused state.
 *
 * Run: node plugin/vendor/server/smoke-virtual-claim.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTaskboardServer } from '../../server/app.mjs'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tb-claim-smoke-'))
process.env.DSH_HOME = tmp // claim-routines.mjs reads routinesDir() from DSH_HOME
const dataDir = path.join(tmp, 'data')
const routinesDir = path.join(tmp, 'routines')
mkdirSync(dataDir, { recursive: true })
mkdirSync(routinesDir, { recursive: true })

const app = createTaskboardServer({
  dataDirectory: dataDir,
  routinesDirectory: routinesDir,
  staticDirectory: tmp,
})
const address = await app.listen({ host: '127.0.0.1', port: 0 })
const base = `http://127.0.0.1:${address.port}`

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok  ${label}`)
  else { failures++; console.log(`FAIL  ${label} ${detail}`) }
}

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

// 1. Create a workspace-mapped project.
const projectId = 'a1b2c3d4e5f6-0123456789abcdef-000000000000'
const created = await call('POST', '/api/projects', {
  id: projectId,
  name: 'smoke-project',
  workspacePath: tmp,
})
check('project created', created.status === 201, `got ${created.status}`)

const routineName = `taskboard-claim-${projectId.slice(0, 12)}`
const routineFile = path.join(routinesDir, `${routineName}.yaml`)
const project = { id: projectId, name: 'smoke-project', workspacePath: tmp }

// Host-half reconcile (what the sync timer runs after each switch change).
const { reconcileClaimRoutine, cleanupStaleClaimRoutines } = await import('../lib/claim-routines.mjs')
const reconcile = async (enabled) => {
  await reconcileClaimRoutine(project, { enabled, intervalMinutes: 10 }, base, () => {})
}

// 2. Enabled -> routine card exists, paused=false (switch ON), yaml paused=true.
let res = await call('POST', `/api/projects/${projectId}/automation`, { enabled: true, intervalMinutes: 10 })
check('automation enabled', res.status === 200 && res.json.automation.enabled === true, JSON.stringify(res.json))
await reconcile(true)

let list = await call('GET', '/api/routines')
let routine = list.json.routines.find((r) => r.name === routineName)
check('card exists when enabled', Boolean(routine))
check('card paused=false when enabled', routine?.paused === false, `got ${routine?.paused}`)
const yamlOn = existsSync(routineFile) ? readFileSync(routineFile, 'utf8') : ''
check('yaml always paused (external skip)', yamlOn.includes('paused: true'), yamlOn.slice(0, 80))

// 3. Switch off from the automation menu -> card STAYS, paused=true.
res = await call('POST', `/api/projects/${projectId}/automation`, { enabled: false })
check('automation disabled', res.status === 200 && res.json.automation.enabled === false, JSON.stringify(res.json))
await reconcile(false)
list = await call('GET', '/api/routines')
routine = list.json.routines.find((r) => r.name === routineName)
check('card still exists when disabled', Boolean(routine), 'card disappeared!')
check('card paused=true when disabled (认领已关闭)', routine?.paused === true, `got ${routine?.paused}`)

// 4. Toggle back ON from the routines page (PUT /api/routines/:name {paused:false}).
res = await call('PUT', `/api/routines/${routineName}`, { paused: false })
check('routines-page toggle -> 200', res.status === 200, `got ${res.status}`)
const automation = await call('GET', `/api/projects/${projectId}/automation`)
check('routines-page toggle flips automation switch', automation.json.automation.enabled === true)
list = await call('GET', '/api/routines')
routine = list.json.routines.find((r) => r.name === routineName)
check('card shows enabled after toggle', routine?.paused === false)

// 5. Toggle OFF from the routines page.
res = await call('PUT', `/api/routines/${routineName}`, { paused: true })
check('routines-page toggle off -> 200', res.status === 200, `got ${res.status}`)
const automation2 = await call('GET', `/api/projects/${projectId}/automation`)
check('automation switch off', automation2.json.automation.enabled === false)

// 6. Editing a claim routine (raw) is rejected.
res = await call('PUT', `/api/routines/${routineName}`, { raw: 'name: hacked\n' })
check('raw edit rejected (409)', res.status === 409, `got ${res.status}`)
// 7. Deleting a claim routine is rejected.
res = await call('DELETE', `/api/routines/${routineName}`)
check('delete rejected (409)', res.status === 409, `got ${res.status}`)
// 8. Creating a routine with reserved prefix is rejected.
res = await call('POST', '/api/routines', { name: 'taskboard-claim-zzz', schedule: '* * * * *', prompt: 'x' })
check('reserved name rejected (409)', res.status === 409, `got ${res.status}`)

// 9. Reconcile (host half) keeps the file while disabled.
await reconcile(false)
check('reconcile keeps file while disabled', existsSync(routineFile))
const yamlOff = readFileSync(routineFile, 'utf8')
check('reconcile yaml still paused', yamlOff.includes('paused: true'))

// 10. Reconcile removes only workspace-less projects; orphan cleanup removes dead ones.
const noWs = { id: 'deadbeefdead-000000000000-000000000000', name: 'no-ws', workspacePath: null }
const noWsName = `taskboard-claim-deadbeefdead`
writeFileSync(path.join(routinesDir, `${noWsName}.yaml`), 'name: ' + noWsName + '\nschedule: "* * * * *"\nprompt: "x"\n')
const orphanName = `taskboard-claim-0123456789ab`
const orphanFile = path.join(routinesDir, `${orphanName}.yaml`)
mkdirSync(routinesDir, { recursive: true })
writeFileSync(orphanFile, 'name: ' + orphanName + '\nschedule: "* * * * *"\nprompt: "x"\n')
const removedNoWs = await reconcileClaimRoutine(noWs, { enabled: false, intervalMinutes: 10 }, base, () => {})
check('workspace-less project file removed', removedNoWs === 'removed' && !existsSync(path.join(routinesDir, 'taskboard-claim-deadbeefdead.yaml')))
const cleaned = await cleanupStaleClaimRoutines([projectId], () => {})
check('orphan cleaned', cleaned === 1 && !existsSync(orphanFile))

await app.close()
rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
