// Types for epscript.mjs, the Emscripten build of eudplib's epScript compiler
// (scripts/build-epscript.mjs).
import type { EpScriptModule } from "../engine";

export interface EpScriptOptions {
  locateFile?(path: string, prefix: string): string;
  print?(line: string): void;
  printErr?(line: string): void;
}

declare function createEpScript(options?: EpScriptOptions): Promise<EpScriptModule>;
export default createEpScript;
