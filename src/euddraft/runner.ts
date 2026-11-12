/**
 * A build, from the main thread: the open map taken apart, the build worker started fresh,
 * the request sent, the built map put together again. The worker is always terminated
 * afterwards, and terminating it is how `signal` stops a build.
 */
import { assembleMap, splitMap } from "./archive";
import type { EngineBuildResult, ProjectFile } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";

/** Where the build serves the runtime (`vite.config.ts`, `euddraftRuntime`). */
declare const __EUDDRAFT_RUNTIME__: { dir: string; pyodide: string; wheels: string[] };

export const RUNTIME = __EUDDRAFT_RUNTIME__;

export interface CompileRequest {
  /** The input map: an .scx / .scm archive. */
  map: Uint8Array;
  project: ProjectFile[];
  settings: string;
}

export type CompileResult =
  | { ok: true; map: Uint8Array; chkBytes: number; output: string; freezeSkipped: boolean; ms: number }
  | { ok: false; message: string; detail: string; ms: number };

export interface CompileOptions {
  signal?: AbortSignal;
  onLog?(line: string): void;
  onStage?(text: string): void;
}

export class StoppedError extends Error {
  constructor() { super("The build was stopped."); this.name = "AbortError"; }
}

export async function compile(request: CompileRequest, opts: CompileOptions = {}): Promise<CompileResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  if (opts.signal?.aborted) throw new StoppedError();
  const split = await splitMap(request.map);
  if (split.unnamed) opts.onLog?.(`${split.unnamed} member(s) of the map have no name in its listfile and are not carried into the built map.`);
  const result = await runWorker({ map: request.map, chk: split.chk, names: split.names, project: request.project, settings: request.settings }, opts);
  if (!result.ok) return { ...result, ms: ms() };
  const built = await assembleMap(result.members, split.extras);
  return { ok: true, map: built.map, chkBytes: built.chk.length, output: result.output, freezeSkipped: result.freezeSkipped, ms: ms() };
}

function runWorker(request: Extract<ToWorker, { type: "build" }>["request"], opts: CompileOptions): Promise<EngineBuildResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "euddraft" });
    const finish = (settle: () => void) => {
      worker.terminate();
      opts.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new StoppedError()));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (e) => finish(() => reject(new Error(e.message || "The build worker stopped.")));
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case "stage": opts.onStage?.(m.text); break;
        case "log": opts.onLog?.(m.line); break;
        case "ready": opts.onStage?.("Building"); worker.postMessage({ type: "build", request } satisfies ToWorker); break;
        case "fatal": finish(() => reject(new Error(m.message))); break;
        case "result": finish(() => resolve(m.result)); break;
      }
    };
    const base = new URL(RUNTIME.dir, document.baseURI).href;
    worker.postMessage({ type: "boot", runtimeBase: base, wheels: RUNTIME.wheels } satisfies ToWorker);
  });
}
