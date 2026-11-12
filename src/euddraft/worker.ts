/**
 * The build worker: Pyodide from the runtime folder, the epScript compiler, eudplib and
 * euddraft (`engine.ts`), then one build. The main thread (`runner.ts`) starts a fresh
 * worker for every build and terminates it afterwards — eudplib cannot load a second map
 * into one interpreter, and terminating is also how a build is stopped.
 */
import createEpScript from "./runtime/epscript.mjs";
import epscriptWasm from "./runtime/epscript.wasm?url";
import driver from "./python/driver.py?raw";
import epsshim from "./python/epsshim.py?raw";
import mpqshim from "./python/mpqshim.py?raw";
import pluginLoader from "./vendor/euddraft/pluginLoader.py?raw";
import readconfig from "./vendor/euddraft/readconfig.py?raw";
import { bootEngine, type Engine, type EngineSources, type Pyodide } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";

const byModule = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, code]) => [path.slice(path.lastIndexOf("/") + 1, -".py".length), code]));

const SOURCES: EngineSources = {
  driver, epsshim, mpqshim, pluginLoader, readconfig,
  plugins: byModule(import.meta.glob("./vendor/euddraft/plugins/*.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  lib: byModule(import.meta.glob("./vendor/euddraft/lib/*.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
};

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const post = (m: FromWorker) => scope.postMessage(m);
const log = (line: string) => post({ type: "log", line });
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

let engine: Engine | null = null;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "boot") void boot(m.runtimeBase, m.wheels);
  else if (m.type === "build") {
    if (!engine) { post({ type: "fatal", message: "The build worker is not ready." }); return; }
    try {
      post({ type: "result", result: engine.build(m.request) });
    } catch (err) {
      post({ type: "result", result: { ok: false, message: describe(err), detail: err instanceof Error ? err.stack ?? "" : "" } });
    }
  }
};

async function boot(base: string, wheels: string[]): Promise<void> {
  try {
    post({ type: "stage", text: "Loading Python" });
    const { loadPyodide } = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as { loadPyodide(o: Record<string, unknown>): Promise<Pyodide> };
    const py = await loadPyodide({ indexURL: base, stdout: log, stderr: log });
    post({ type: "stage", text: "Loading the epScript compiler" });
    const eps = await createEpScript({ locateFile: () => epscriptWasm, print: log, printErr: log });
    engine = await bootEngine({ py, eps, sources: SOURCES, wheels: wheels.map((w) => `${base}${w}`), stage: (text) => post({ type: "stage", text }) });
    post({ type: "ready" });
  } catch (err) {
    post({ type: "fatal", message: describe(err) });
  }
}
