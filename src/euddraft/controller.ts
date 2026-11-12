/**
 * The euddraft panel's state and actions, outside React: the project folder, the settings
 * file, a compile of the open map, and what is done with the built map. One compile at a
 * time; every compile re-reads a kept folder, so editing the scripts elsewhere and pressing
 * Compile again is the loop — what euddraft's .edd watch mode does on the desktop.
 */
import { msg, t } from "../i18n";
import type { PluginApi } from "../plugins/api";
import type { ProjectFile } from "./engine";
import * as folder from "./folder";
import {
  decodeText, outputName, outputPath, parseSettings, ProjectTooLarge, readDirectory, readPicked,
  settingsFiles, type Settings, writeInto,
} from "./project";
import { compile, StoppedError } from "./runner";

export type Phase = "idle" | "reading" | "compiling" | "done" | "failed";

export interface Built {
  map: Uint8Array;
  name: string;
  chkBytes: number;
  ms: number;
  freezeSkipped: boolean;
  /** Where in the project folder it was written, if it was. */
  wrote: string | null;
}

export interface State {
  /** The folder: a kept handle (Chrome, Edge) or a one-off pick. */
  folder: { name: string; kept: boolean; access: "granted" | "prompt" | "denied" } | null;
  files: ProjectFile[] | null;
  settingsPaths: string[];
  settingsPath: string | null;
  settings: Settings | null;
  phase: Phase;
  stage: string;
  log: string[];
  built: Built | null;
  error: { message: string; detail: string } | null;
  /** Write the built map to [main] output inside the folder, as euddraft does. */
  writeIntoFolder: boolean;
}

const MAX_LOG_LINES = 2000;
const MAX_LINE = 600;

/**
 * The stages a compile reports, which the panel shows with `translate()`. Most are posted
 * by the worker and the engine, which stay free of the editor's i18n (the engine also runs
 * under Node), so they are listed here for the extractor.
 */
export const STAGES = [
  msg("Reading the project"), msg("Taking the map"), msg("Loading Python"), msg("Loading the epScript compiler"),
  msg("Installing eudplib"), msg("Starting eudplib"), msg("Building"),
];

export class EuddraftController {
  private state: State;
  private listeners = new Set<() => void>();
  private handle: FileSystemDirectoryHandle | null = null;
  private abort: AbortController | null = null;
  private readonly api: PluginApi;

  constructor(api: PluginApi) {
    this.api = api;
    this.state = {
      folder: null, files: null, settingsPaths: [], settingsPath: null, settings: null,
      phase: "idle", stage: "", log: [], built: null, error: null,
      writeIntoFolder: api.storage.get<boolean>("writeIntoFolder", true),
    };
    void this.restore();
  }

  get = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  canKeepFolders = folder.canKeepFolders;

  /** The folder kept from last time, if the browser still has it; read once access is granted. */
  private async restore(): Promise<void> {
    if (!folder.canKeepFolders()) return;
    const handle = await folder.loadFolder();
    if (!handle) return;
    this.handle = handle;
    const access = await folder.permission(handle).catch(() => "denied" as const);
    this.set({ folder: { name: handle.name, kept: true, access } });
    if (access === "granted") await this.read();
  }

  async chooseFolder(): Promise<void> {
    if (folder.canKeepFolders()) {
      const handle = await folder.pickFolder();
      if (!handle) return;
      this.handle = handle;
      await folder.saveFolder(handle);
      this.set({ folder: { name: handle.name, kept: true, access: "granted" }, settingsPath: null, built: null, error: null });
      await this.read();
      return;
    }
    const picked = await this.api.ui.pickFiles({ directory: true });
    if (!picked.length) return;
    this.handle = null;
    const name = picked[0].path.replace(/\\/g, "/").split("/")[0] || "folder";
    this.set({ folder: { name, kept: false, access: "granted" }, settingsPath: null, built: null, error: null, phase: "reading" });
    try {
      this.loaded(await readPicked(picked));
    } catch (err) {
      this.fail(err);
    }
  }

  /** From a click: grant access to the kept folder again. */
  async reconnect(): Promise<void> {
    if (!this.handle) return;
    const ok = await folder.request(this.handle);
    this.set({ folder: { name: this.handle.name, kept: true, access: ok ? "granted" : "denied" } });
    if (ok) await this.read();
  }

  async forget(): Promise<void> {
    this.handle = null;
    await folder.saveFolder(null);
    this.set({ folder: null, files: null, settingsPaths: [], settingsPath: null, settings: null, built: null, error: null, phase: "idle", log: [] });
  }

  /** Read the kept folder again. */
  async read(): Promise<boolean> {
    if (!this.handle) return this.state.files !== null;
    this.set({ phase: "reading", error: null });
    try {
      this.loaded(await readDirectory(this.handle));
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private loaded(files: ProjectFile[]): void {
    const paths = settingsFiles(files.map((f) => f.path));
    const remembered = this.api.storage.get<Record<string, string>>("settingsByFolder", {})[this.state.folder?.name ?? ""];
    const current = this.state.settingsPath;
    const settingsPath = [current, remembered].find((p) => p && paths.includes(p)) ?? paths[0] ?? null;
    this.set({ files, settingsPaths: paths, phase: this.state.phase === "reading" ? "idle" : this.state.phase });
    this.useSettings(settingsPath);
  }

  selectSettings(path: string): void {
    const byFolder = { ...this.api.storage.get<Record<string, string>>("settingsByFolder", {}), [this.state.folder?.name ?? ""]: path };
    this.api.storage.set("settingsByFolder", byFolder);
    this.useSettings(path);
  }

  private useSettings(path: string | null): void {
    const file = path ? this.state.files?.find((f) => f.path === path) : undefined;
    this.set({ settingsPath: path, settings: file ? parseSettings(decodeText(file.data)) : null });
  }

  setWriteIntoFolder(on: boolean): void {
    this.api.storage.set("writeIntoFolder", on);
    this.set({ writeIntoFolder: on });
  }

  /** Where the built map goes in the folder, when it can go there at all. */
  target(): string | null {
    const { settings, settingsPath, folder: f } = this.state;
    if (!f?.kept || !settings || !settingsPath) return null;
    return outputPath(settings, settingsPath);
  }

  /** Compile the open map. Call it from a click: writing into the folder may need the browser to ask first. */
  async compile(): Promise<void> {
    if (this.state.phase === "compiling") return;
    const target = this.state.writeIntoFolder ? this.target() : null;
    // Asked now, while the click still counts as one: after the build the browser would refuse to ask.
    const canWrite = target && this.handle ? await folder.request(this.handle, "readwrite").catch(() => false) : false;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.set({ phase: "compiling", stage: STAGES[0], log: [], built: null, error: null });
    try {
      if (this.handle && !(await this.read())) return;
      const { files, settingsPath, settings } = this.state;
      if (!files || !settingsPath) throw new Error(t("The folder has no .eds or .edd settings file."));
      this.set({ phase: "compiling", stage: STAGES[1] });
      const file = await this.api.document.export({ format: "scx", built: false });
      if (!file) throw new Error(t("No map is open."));
      const result = await compile({ map: new Uint8Array(await file.arrayBuffer()), project: files, settings: settingsPath }, {
        signal,
        onStage: (stage) => this.set({ stage }),
        onLog: (line) => this.append(line),
      });
      if (!result.ok) {
        this.set({ phase: "failed", stage: "", error: { message: result.message, detail: result.detail } });
        return;
      }
      const info = this.api.document.info();
      const name = outputName(settings, info ? info.fileName ?? info.name : null);
      let wrote: string | null = null;
      if (target && canWrite && this.handle) {
        await writeInto(this.handle, target, result.map);
        wrote = target;
      }
      this.set({ phase: "done", stage: "", built: { map: result.map, name, chkBytes: result.chkBytes, ms: result.ms, freezeSkipped: result.freezeSkipped, wrote } });
    } catch (err) {
      if (err instanceof StoppedError) {
        this.set({ phase: "idle", stage: "", error: null });
        this.append(t("Stopped."));
      } else this.fail(err);
    } finally {
      this.abort = null;
    }
  }

  stop(): void { this.abort?.abort(); }

  async saveAs(): Promise<void> {
    const built = this.state.built;
    if (built) await this.api.ui.saveFile(built.map, built.name);
  }

  async test(): Promise<void> {
    const built = this.state.built;
    if (!built) return;
    const outcome = await this.api.document.test(built.map, built.name);
    if (outcome === null) this.api.ui.toast({ kind: "info", title: t("Pick a test folder first"), detail: t("Tools ▸ Test Map asks for one the first time.") });
  }

  private append(line: string): void {
    const clipped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} … (${line.length - MAX_LINE} more characters)` : line;
    const log = this.state.log.length >= MAX_LOG_LINES ? [...this.state.log.slice(-MAX_LOG_LINES + 1), clipped] : [...this.state.log, clipped];
    this.set({ log });
  }

  private fail(err: unknown): void {
    const message = err instanceof ProjectTooLarge
      ? t("The folder is too large to read: an euddraft project folder should hold the settings file, the scripts and their data.")
      : err instanceof Error ? err.message : String(err);
    this.set({ phase: "failed", stage: "", error: { message, detail: "" } });
  }

  dispose(): void { this.stop(); this.listeners.clear(); }
}
