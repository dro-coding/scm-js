import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error - a plain .mjs module, shared with the tests.
import { buildNotices } from './scripts/lib/notices.mjs'

// The app's version is package.json's, injected as `__APP_VERSION__` (src/version.ts) so the
// splash, the About dialog and the packaged installers all say the same thing. CI rewrites
// package.json before building, so a nightly build carries its own prerelease string.
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/** src/version.ts#shortVersion, kept in step by hand. */
function shortVersion(v: string): string {
  const dash = v.indexOf('-')
  if (dash < 0) return v.split('+')[0]
  const channel = v.slice(dash + 1).split(/[.+]/)[0]
  return channel ? `${v.slice(0, dash)}-${channel}` : v.slice(0, dash)
}

/**
 * The euddraft compiler's runtime (`src/euddraft/`, this fork's): Pyodide's core files from
 * the `pyodide` package and the two wheels in `src/euddraft/runtime/`, served together from
 * `plugin-runtime/euddraft/<hash of their content>/`. Together, because Pyodide finds its
 * files beside `pyodide.mjs`; under their own names, because `loadPackage` reads a wheel's
 * name, version and tags out of its file name, which Vite's hashed asset names would break;
 * under a hash, because nginx serves `/plugin-runtime/` as immutable (docker/nginx.conf).
 * Nothing loads them until a map is compiled. The worker learns the folder from
 * `__EUDDRAFT_RUNTIME__`.
 */
function euddraftRuntime(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const pyodideDir = join(root, 'node_modules', 'pyodide')
  const runtimeDir = join(root, 'src', 'euddraft', 'runtime')
  const files = new Map<string, string>()
  for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
    files.set(name, join(pyodideDir, name))
  }
  for (const name of readdirSync(runtimeDir).filter((f) => f.endsWith('.whl'))) files.set(name, join(runtimeDir, name))
  const missing = [...files.values()].filter((p) => !existsSync(p))
  if (missing.length) throw new Error(`euddraft runtime: missing ${missing.join(', ')} (npm ci installs pyodide)`)
  const hash = createHash('sha256')
  for (const [name, path] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(readFileSync(path))
  const dir = `plugin-runtime/euddraft/${hash.digest('hex').slice(0, 12)}/`
  // typing_extensions before eudplib, which needs it.
  const wheels = [...files.keys()].filter((n) => n.endsWith('.whl')).sort((a, b) => Number(b.startsWith('typing_')) - Number(a.startsWith('typing_')))
  const pyodideVersion = JSON.parse(readFileSync(join(pyodideDir, 'package.json'), 'utf8')).version as string
  const types: Record<string, string> = { mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', zip: 'application/zip', whl: 'application/octet-stream' }
  return {
    name: 'scmjs-euddraft-runtime',
    config: () => ({ define: { __EUDDRAFT_RUNTIME__: JSON.stringify({ dir, pyodide: pyodideVersion, wheels }) } }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const at = path.indexOf(`/${dir}`)
        const source = at >= 0 ? files.get(path.slice(at + dir.length + 1)) : undefined
        if (!source) return next()
        res.setHeader('Content-Type', types[source.split('.').pop() ?? ''] ?? 'application/octet-stream')
        res.end(readFileSync(source))
      })
    },
    generateBundle() {
      for (const [name, path] of files) this.emitFile({ type: 'asset', fileName: `${dir}${name}`, source: readFileSync(path) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  // kascade is only imported inside the extraction worker, on the Remastered route, so the
  // dev server does not see it at startup. Left to find it then, it pre-bundles it mid-install
  // and reloads the page — which looks like the editor restarting and loses the install.
  optimizeDeps: { include: ['kascade'] },
  plugins: [
    react(),
    euddraftRuntime(),
    // `index.html` carries the boot splash (the markup that paints before the bundle
    // evaluates), and its version line has to say the same thing `src/version.ts` does.
    // Vite substitutes `%FOO%` in HTML only for env vars, so this does that one token.
    {
      name: 'scmjs-html-version',
      // The rule is `shortVersion` in src/version.ts (the release plus the channel it was
      // cut on, so a nightly does not read as a release nobody shipped) — copied rather
      // than imported, since this config is its own TypeScript project. Change both.
      transformIndexHtml: (html: string) =>
        html.replace(/%APP_VERSION_SHORT%/g, shortVersion(version)),
    },
    // The page again as `404.html`, which is what GitHub Pages answers a path it has no
    // file for. Links into the editor are paths — a shared map's invite is
    // `share/<invite>` — so the editor has to open at any of them. nginx (docker/) and the
    // dev server fall back to index.html themselves; the file is harmless there.
    {
      name: 'scmjs-404',
      apply: 'build' as const,
      writeBundle({ dir }: { dir?: string }) {
        if (dir) copyFileSync(join(dir, 'index.html'), join(dir, '404.html'))
      },
    },
    // The license texts of everything compiled in, at the root of the bundle so the web
    // zip, the installers and the container image all carry them (scripts/lib/notices.mjs).
    {
      name: 'scmjs-notices',
      apply: 'build' as const,
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD-PARTY-NOTICES.txt',
          source: buildNotices(fileURLToPath(new URL('.', import.meta.url))),
        })
      },
    },
  ],
  // Where the site is served from: GitHub Pages under a repository path needs `/scm-js/`,
  // a custom domain and the desktop app want `/`. The build workflow sets it.
  base: process.env.SCMJS_BASE || '/',
  // Three pages of one build: the editor, the Game Data page (`data.html`) — what a
  // browser holds of the game's files, without the editor around it — and the installer
  // (`install.html`), which another page of the site frames to have a folder installed.
  // They share chunks.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        data: fileURLToPath(new URL('./data.html', import.meta.url)),
        install: fileURLToPath(new URL('./install.html', import.meta.url)),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // "nightly" for the hosted nightly only, which shares scmjs.dev with the stable editor (`src/site.ts`).
    __SCMJS_SITE__: JSON.stringify(process.env.SCMJS_SITE ?? ''),
  },
}))
