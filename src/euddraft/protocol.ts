/** What crosses between the main thread and the build worker (`worker.ts`). */
import type { EngineBuildRequest, EngineBuildResult } from "./engine";

export interface BootMessage {
  type: "boot";
  /** The runtime folder (`plugin-runtime/euddraft/<hash>/`) as an absolute URL: Pyodide's `indexURL`. */
  runtimeBase: string;
  /** The wheels in that folder, in install order. */
  wheels: string[];
}
export interface BuildMessage { type: "build"; request: EngineBuildRequest }
export type ToWorker = BootMessage | BuildMessage;

export type FromWorker =
  | { type: "stage"; text: string }
  | { type: "ready" }
  /** The runtime did not come up: nothing was built. */
  | { type: "fatal"; message: string }
  | { type: "log"; line: string }
  | { type: "result"; result: EngineBuildResult };
