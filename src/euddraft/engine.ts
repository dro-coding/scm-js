/**
 * The euddraft build, independent of where it runs: Pyodide with the eudplib wheel,
 * euddraft's own loader, config reader, plugins and libraries, the archive shim, the
 * epScript compiler (WebAssembly) behind eudplib's ctypes calls, and the driver — staged
 * into the interpreter's file system, then one build. The build worker (`worker.ts`) runs
 * it in the browser; `scripts/euddraft-smoke.ts` runs the same code under Node.
 *
 * One build per interpreter: eudplib keeps the map and the game loop in module state and a
 * second `LoadMap` fails ("Game loop start is already set"), so the caller starts a fresh
 * engine for every build.
 */

/** As much of Pyodide as the engine uses. */
export interface Pyodide {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, opts?: { encoding: "utf8" }): Uint8Array | string;
    mkdirTree(path: string): void;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
  };
  loadPackage(names: string | string[], opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  runPython(code: string): unknown;
  registerJsModule(name: string, module: object): void;
  globals: { get(name: string): unknown };
}

/** The Emscripten module `epscript.mjs` makes (`scripts/build-epscript.mjs`). */
export interface EpScriptModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _compileString(filename: number, code: number): number;
  _freeCompiledResult(p: number): void;
  _getErrorCount(): number;
  _setDebugMode(on: number): void;
  _registerPlibConstants(p: number): void;
  _registerPyKeywords(p: number): void;
  _registerPyBuiltins(p: number): void;
}

/** The Python the engine stages: ours (`python/`) and euddraft's (`vendor/euddraft/`). */
export interface EngineSources {
  driver: string;
  mpqshim: string;
  epsshim: string;
  pluginLoader: string;
  readconfig: string;
  /** euddraft's bundled plugins, module name → source. */
  plugins: Record<string, string>;
  /** euddraft's `lib/` (draw, sqc, soundlooper), module name → source. */
  lib: Record<string, string>;
}

export interface ProjectFile {
  /** Forward-slash path inside the project folder: `src/main.eps`. */
  path: string;
  data: Uint8Array;
}

export interface EngineBuildRequest {
  /** The input map's archive as it is: eudplib checks the input is a file before it reads it through the shim. */
  map: Uint8Array;
  /** The input map's scenario, and its listfile's names, for the archive shim. */
  chk: Uint8Array;
  names: string[];
  /** Every file of the project folder that was read. */
  project: ProjectFile[];
  /** The settings file, a path into `project` (`main.edd`, `src/main.eds`). */
  settings: string;
}

export interface BuiltMember { name: string; locale: number; data: Uint8Array }

export type EngineBuildResult =
  | { ok: true; members: BuiltMember[]; output: string; freezeSkipped: boolean }
  | { ok: false; message: string; detail: string };

export const SITE_PACKAGES = "/lib/python3.14/site-packages";
export const ED_DIR = "/ed";
const PY_DIR = "/py";
const WORK = "/work";
export const PROJECT_DIR = `${WORK}/project`;

/** A project path as it may be written into the interpreter's file system: relative, forward slashes, no `..`. */
export function safeProjectPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/**
 * The epScript compiler as the JS module `_epscript_wasm` that `epsshim.py` calls: byte
 * strings in, the compiled Python's bytes (or null on an error, which the compiler has
 * already printed) out. Every call copies into the module's memory and frees it again.
 */
export function epscriptBridge(eps: EpScriptModule) {
  const cString = (bytes: Uint8Array): number => {
    const p = eps._malloc(bytes.length + 1);
    eps.HEAPU8.set(bytes, p);
    eps.HEAPU8[p + bytes.length] = 0;
    return p;
  };
  const register = [eps._registerPlibConstants, eps._registerPyKeywords, eps._registerPyBuiltins];
  return {
    compile(filename: Uint8Array, code: Uint8Array): Uint8Array | null {
      const f = cString(filename);
      const c = cString(code);
      try {
        const out = eps._compileString(f, c);
        if (!out) return null;
        const heap = eps.HEAPU8;
        let end = out;
        while (heap[end] !== 0) end++;
        const result = heap.slice(out, end);
        eps._freeCompiledResult(out);
        return result;
      } finally {
        eps._free(f);
        eps._free(c);
      }
    },
    errorCount: (): number => eps._getErrorCount(),
    setDebugMode: (on: number): void => eps._setDebugMode(on),
    register(kind: number, names: Uint8Array): void {
      const fn = register[kind];
      if (!fn) throw new Error(`no epScript registration ${kind}`);
      // A zero-separated list: the C side reads names until it meets an empty one.
      const p = cString(names);
      try { fn(p); } finally { eps._free(p); }
    },
  };
}

/** Pyodide up, eudplib and euddraft staged, the epScript compiler in place. */
export async function bootEngine(opts: {
  py: Pyodide;
  /** typing_extensions and the eudplib wheel, in that order: URLs or (under Node) paths. */
  wheels: string[];
  eps: EpScriptModule;
  sources: EngineSources;
  stage?: (text: string) => void;
}): Promise<Engine> {
  const { py, sources } = opts;
  opts.stage?.("Installing eudplib");
  await py.loadPackage(opts.wheels);
  py.registerJsModule("_epscript_wasm", epscriptBridge(opts.eps));
  py.FS.mkdirTree(`${ED_DIR}/plugins`);
  py.FS.mkdirTree(`${ED_DIR}/lib`);
  py.FS.mkdirTree(PY_DIR);
  py.FS.mkdirTree(WORK);
  py.FS.writeFile(`${ED_DIR}/pluginLoader.py`, sources.pluginLoader);
  py.FS.writeFile(`${ED_DIR}/readconfig.py`, sources.readconfig);
  for (const [name, code] of Object.entries(sources.plugins)) py.FS.writeFile(`${ED_DIR}/plugins/${name}.py`, code);
  for (const [name, code] of Object.entries(sources.lib)) py.FS.writeFile(`${ED_DIR}/lib/${name}.py`, code);
  py.FS.writeFile(`${PY_DIR}/mpqshim.py`, sources.mpqshim);
  py.FS.writeFile(`${PY_DIR}/epsshim.py`, sources.epsshim);
  py.FS.writeFile(`${PY_DIR}/driver.py`, sources.driver);
  opts.stage?.("Starting eudplib");
  py.runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(PY_DIR)})\nimport driver\ndriver.prepare(${JSON.stringify(SITE_PACKAGES)})`);
  return new Engine(py);
}

export class Engine {
  private used = false;
  private readonly py: Pyodide;
  constructor(py: Pyodide) { this.py = py; }

  /** One build; the engine is spent afterwards. */
  build(req: EngineBuildRequest): EngineBuildResult {
    if (this.used) throw new Error("This engine has built a map already; start a new one.");
    this.used = true;
    const { py } = this;
    const settings = safeProjectPath(req.settings);
    if (!settings) return { ok: false, message: `Not a path inside the project: ${req.settings}`, detail: "" };
    py.FS.mkdirTree(PROJECT_DIR);
    for (const file of req.project) {
      const path = safeProjectPath(file.path);
      if (!path) continue;
      const slash = path.lastIndexOf("/");
      if (slash > 0) py.FS.mkdirTree(`${PROJECT_DIR}/${path.slice(0, slash)}`);
      py.FS.writeFile(`${PROJECT_DIR}/${path}`, file.data);
    }
    py.FS.mkdirTree(`${WORK}/out`);
    py.FS.writeFile(`${WORK}/in.scx`, req.map);
    py.FS.writeFile(`${WORK}/chk.bin`, req.chk);
    py.FS.writeFile(`${WORK}/request.json`, JSON.stringify({ names: req.names, settings }));
    py.runPython(`
import json, mpqshim, driver
with open("${WORK}/request.json") as f: _req = json.load(f)
with open("${WORK}/chk.bin", "rb") as f: _chk = f.read()
mpqshim.register("${WORK}/in.scx", {"staredit\\\\scenario.chk": _chk}, _req["names"])
try:
    _info = driver.build(ed_dir="${ED_DIR}", project_dir="${PROJECT_DIR}", settings=_req["settings"], in_path="${WORK}/in.scx", out_path="${WORK}/out.scx")
    _index = []
    for _i, (_name, _locale, _data) in enumerate(mpqshim.collect("${WORK}/out.scx")):
        with open(f"${WORK}/out/{_i}.bin", "wb") as f: f.write(_data)
        _index.append({"name": _name, "locale": _locale})
    _answer = {"ok": True, "members": _index, **_info}
except BaseException as _e:
    _msg, _detail = driver.describe(_e, "${PROJECT_DIR}", "${ED_DIR}")
    _answer = {"ok": False, "message": _msg, "detail": _detail}
with open("${WORK}/answer.json", "w") as f: json.dump(_answer, f)
`);
    const answer = JSON.parse(py.FS.readFile(`${WORK}/answer.json`, { encoding: "utf8" }) as string) as
      | { ok: true; members: { name: string; locale: number }[]; output: string; freezeSkipped: boolean }
      | { ok: false; message: string; detail: string };
    if (!answer.ok) return answer;
    const members = answer.members.map((m, i) => ({ ...m, data: py.FS.readFile(`${WORK}/out/${i}.bin`) as Uint8Array }));
    return { ok: true, members, output: answer.output, freezeSkipped: answer.freezeSkipped };
  }
}
