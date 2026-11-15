# The euddraft compiler (`src/euddraft/`, this fork's)

**What.** Tools ▸ euddraft… builds the open map with euddraft from a project folder (the
`.eds`/`.edd`, the `.eps`/`.py` plugins, euddraft's eight bundled plugins), entirely in the
browser. A built-in plugin registered in `src/plugins/builtin.ts` beside `claude-agent`;
`defaults.ts` lists it on its own (a built-in that replaces no remote default).

**Why in the browser.** euddraft plugins are arbitrary Python and `[main]` options such as
`shufflePayload` go through `eval()`, so a compile server would run visitors' code on the
host. In a worker it runs in the visitor's own tab, and the site stays static. Upstream had
the same engine as a library plugin (`scm-js/plugin-eudplib`, archived 2026-10-26 when
TrigScript 4 dropped eudplib); this reuses its wheel and archive code and adds what it never
had: epScript and a project UI.

**Layers.**
- `engine.ts`: environment-free. `bootEngine` loads the two wheels into Pyodide, registers
  the epScript bridge as the JS module `_epscript_wasm`, writes euddraft's files to `/ed`
  and ours to `/py`, runs `driver.prepare`. `Engine.build` writes the project to
  `/work/project`, the input archive to `/work/in.scx` (eudplib's `LoadMap` checks it is a
  file before reading it through the shim) and runs `driver.build`, returning the members
  eudplib wrote or `{ ok: false, message, detail }`. **One build per engine**: eudplib keeps
  the map and game loop in module state ("Game loop start is already set" on a second
  `LoadMap`).
- `python/driver.py`: euddraft v0.11.0.1's `applyEUDDraft` minus freeze, message boxes, the
  `pause` prompt and the update check; every `[main]` option it knows is applied the same
  way, `readconfig` and `pluginLoader` are euddraft's own. `[main] input/output` are replaced
  by the editor's paths (the asked output name is returned). freeze: pluginLoader freezes
  unless `[freeze]` has a `freeze` key, so the driver sets `freeze: 0` itself and prints a
  warning when it had to. `describe()` is euddraft's `isEpExc` traceback filter plus the
  innermost cause in the headline (pluginLoader re-raises every failure as `Error loading
  plugin "x"`).
- `python/epsshim.py`: eudplib opens `libepScriptLib` with ctypes (`epscompile._load_lib`)
  and reads results with `c_char_p(addr).value`. The shim sets `epscompile._libeps` to an
  object with the same seven methods, answering `compileString` with the address of a
  ctypes buffer kept until `freeCompiledResult`, and replays the names eudplib registered at
  import (`_pending_*`). epScript **returns text even on errors**; the error count is the
  signal, as in eudplib's `epsCompile`.
- `python/mpqshim.py` (plugin-eudplib's, unchanged): the eight-method `mpqapi` the wasm
  wheel lacks (built without StormLib). `archive.ts` splits the archive with mopaq on the
  main thread and reassembles it (4096-byte sectors, PKWARE, listfile; the empty decoy
  scenario under locale 0 is dropped).
- `worker.ts` / `runner.ts` / `protocol.ts`: a fresh module worker per build, terminated
  after it (that is also Stop). Pyodide comes from `__EUDDRAFT_RUNTIME__.dir`.
- `controller.ts` + `ui/`: the floating panel. A kept folder is a File System Access handle in
  IndexedDB (`folder.ts`), re-read on every Compile (the `.edd` watch-mode loop); without the
  API, `api.ui.pickFiles({ directory: true })` gives a one-off snapshot. Writing into the
  folder needs `readwrite`, asked **before** the build while the click still counts as a
  user gesture. Input is `document.export({ format: "scx", built: false })`.

**Runtime serving** (`vite.config.ts`, `euddraftRuntime`): Pyodide's five core files (npm
`pyodide`, a devDependency pinned to 314.0.7, the wheel's ABI) and the wheels go to
`plugin-runtime/euddraft/<sha256 of all of them, 12>/` under their own names — Pyodide
finds its files beside `pyodide.mjs`, and `loadPackage` parses name/version/tags from a
wheel's file name (a Vite hash suffix breaks it). docker/nginx.conf's `/plugin-runtime/`
location already types `.mjs`/`.wasm`/`.json` and caches immutably. Dev: a middleware.

**epScript as WebAssembly.** `scripts/build-epscript.mjs` (Emscripten 5.0.3): lemon2 for
Node generates the parser (header checked against eudplib's, CRLF aside), the library is an
ES module (`MODULARIZE`, `EXPORT_ES6`, `ENVIRONMENT=worker,node`, JS-based C++ exceptions —
`compileString` catches `std::runtime_error`). `--test` builds and runs eudplib's Catch
tests: 278 assertions in 33 cases pass. `-DVERSION` is not needed (unused in the sources)
and was dropped to keep cmd quoting out of it on Windows.

**Not done: freeze.** Its in-game half is Python (euddraft's `freeze/`), but the archive
half is `freezeMpq` (C++ in euddraft's `mpqprt/`, pybind11) and depends on the archive's
sector layout (`sectorSize`, 512 << 15 by default), which `archive.ts` does not reproduce. A
follow-up: build `mpqprt` the same way as epScript and write the archive with eudplib's
sector size.

**Tests.** `tests/euddraft.test.ts`: the settings reader, paths, the bridge on the real wasm,
and two full builds under Node with the npm `pyodide` (about 9 s): an `.edd` in `src/` with
an `.eps` importing `lib/counter.eps`, a `.py` and `eudTurbo`; and a broken `.eps` whose
message and log lines are checked. Windows paths given to `loadPackage` need forward slashes.
