/**
 * Assemble the dsh-taskboard plugin artifacts:
 *
 *   1. vendor/server  — the fork's server tree (node builtins only)
 *   2. vendor/shared  — the fork's shared modules (imported by the server)
 *   3. vendor/web     — the built SPA (dist/web from `vite build`)
 *   4. vendor/skills  — the manage-taskboard skill (ai-chat references it)
 *   5. lib/client.js  — the browser half, wrapped for window.__ModuleLoader__
 *
 * Run after a fresh `npm run build` at the repo root (which emits dist/web).
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(PLUGIN_ROOT, 'vendor')

const PLUGIN_ID = 'dsh-taskboard'

/** Copy one source tree into vendor/, replacing any previous copy. */
async function vendorTree(source, target, label) {
  const from = path.join(REPO_ROOT, source)
  if (!existsSync(from)) {
    console.warn(`[build] skip ${label}: ${source} does not exist`)
    return
  }
  await rm(target, { recursive: true, force: true })
  await mkdir(path.dirname(target), { recursive: true })
  await cp(from, target, { recursive: true })
  console.log(`[build] vendored ${label}: ${source} -> vendor/${path.basename(target)}`)
}

async function main() {
  // The built SPA is a precondition; the repo build (vite) owns it.
  const webBuild = path.join(REPO_ROOT, 'dist', 'web')
  if (!existsSync(path.join(webBuild, 'index.html'))) {
    console.error('[build] dist/web missing — run `npm run build` at the repo root first')
    process.exitCode = 1
    return
  }

  await vendorTree('server', path.join(VENDOR, 'server'), 'server')
  await vendorTree('shared', path.join(VENDOR, 'shared'), 'shared')
  await vendorTree('dist/web', path.join(VENDOR, 'web'), 'web')
  await vendorTree('skills/manage-taskboard', path.join(VENDOR, 'skills', 'manage-taskboard'), 'skill')

  // Browser half: CJS bundle wrapped in the loader handoff. React family is
  // external — the loader resolves it from the platform module table, so the
  // settings card renders on the shell's React copy (hooks stay valid).
  await build({
    entryPoints: [path.join(PLUGIN_ROOT, 'src', 'client', 'index.ts')],
    outfile: path.join(PLUGIN_ROOT, 'lib', 'client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    banner: {
      // The loader handoff wraps the whole CJS body; the module/exports vars
      // must exist before esbuild's own `module.exports = ...` assignments.
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: {
      js: 'return module.exports; } });',
    },
  })
  console.log('[build] wrote lib/client.js')

  console.log('[build] plugin artifacts ready')
}

await main()
