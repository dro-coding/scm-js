/**
 * An euddraft project as the editor sees it: the files of a folder (the settings file, the
 * .eps and .py plugins beside it, whatever data they read), the settings file read the way
 * euddraft's `readconfig.py` reads it, and what each of its sections will load. The build
 * itself reads the settings again with euddraft's own code; this is what the panel shows.
 */
import type { ProjectFile } from "./engine";

/** euddraft's bundled plugins (`vendor/euddraft/plugins/`), which a bare section name loads. */
export const BUNDLED_PLUGINS = ["MSQC", "bgmplayer", "cammove", "chatEvent", "dataDumper", "eudTurbo", "noAirCollision", "unlimiter"] as const;

/** Sections pluginLoader handles itself rather than loading a file. */
const BUILTIN_SECTIONS = new Set(["main", "freeze", "SCBank"]);

export interface Settings {
  /** Section name → key → value, in the file's order; a key with no value is "". */
  sections: Map<string, Map<string, string>>;
  /** Lines readconfig would reject, with their line numbers (1-based). */
  errors: { line: number; message: string }[];
}

const HEADER = /^\[(.+)\]$/;
const KEY_VALUE = /^((?:[^\\:=]|\\.)+)\s*[:=]\s*(.+)$/;
const KEY_ONLY = /^((?:[^\\:=]|\\.)+)$/;
const UNESCAPE = /\\([\\:=])/g;

/** `readconfig.parse_config`: headers, `key : value` / `key = value`, bare keys, `::` comments. */
export function parseSettings(text: string): Settings {
  const sections = new Map<string, Map<string, string>>();
  const errors: Settings["errors"] = [];
  let current: Map<string, string> | null = null;
  let currentName = "";
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line) return;
    const header = HEADER.exec(line);
    if (header) {
      let name = header[1];
      if (sections.has(name)) errors.push({ line: n, message: `Duplicated header '${name}'` });
      while (sections.has(name)) name += "_dup";
      current = new Map();
      currentName = name;
      sections.set(name, current);
      return;
    }
    const kv = KEY_VALUE.exec(line) ?? KEY_ONLY.exec(line);
    if (kv) {
      const key = kv[1].replace(UNESCAPE, "$1").trim();
      if (!current) { errors.push({ line: n, message: `'${line}' should be below a [header]` }); return; }
      if (current.has(key)) { errors.push({ line: n, message: `Duplicated key '${key}' in [${currentName}]` }); return; }
      current.set(key, kv[2] ?? "");
      return;
    }
    if (line.startsWith("::")) return;
    errors.push({ line: n, message: `Invalid config ${line}` });
  });
  return { sections, errors };
}

/** Whether euddraft would freeze the map: unless [freeze] carries a `freeze` key (`freeze : 0`). */
export function wouldFreeze(settings: Settings): boolean {
  return !settings.sections.get("freeze")?.has("freeze");
}

export type SectionKind =
  | { kind: "main" }
  | { kind: "freeze" }
  | { kind: "builtin"; note: string }
  | { kind: "bundled" }
  | { kind: "project"; path: string }
  | { kind: "missing"; looked: string };

/** Normalise a path inside the project: forward slashes, `.` and `..` resolved; null when it leaves the project. */
export function joinProjectPath(dir: string, path: string): string | null {
  const out: string[] = [];
  for (const part of `${dir}/${path}`.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.length ? out.join("/") : null;
}

export const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** What a section loads, looked up as euddraft's `getPluginPath` does, from the settings file's folder. */
export function sectionKind(name: string, settingsPath: string, files: ReadonlySet<string>): SectionKind {
  if (name === "main") return { kind: "main" };
  if (name === "freeze") return { kind: "freeze" };
  if (BUILTIN_SECTIONS.has(name)) return { kind: "builtin", note: name };
  if (/\.(eps|py)$/i.test(name)) {
    const path = joinProjectPath(dirOf(settingsPath), name);
    if (path && hasFile(files, path)) return { kind: "project", path };
    return { kind: "missing", looked: path ?? name };
  }
  if ((BUNDLED_PLUGINS as readonly string[]).includes(name)) return { kind: "bundled" };
  return { kind: "missing", looked: `euddraft's plugins folder (${name}.eps / ${name}.py)` };
}

/** Case-insensitively, as Windows (where euddraft projects are written) finds files. */
function hasFile(files: ReadonlySet<string>, path: string): boolean {
  if (files.has(path)) return true;
  const lower = path.toLowerCase();
  for (const f of files) if (f.toLowerCase() === lower) return true;
  return false;
}

/** The settings files in a project: .eds and .edd, shallowest first. */
export function settingsFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((p) => /\.(eds|edd)$/i.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Where [main] `output` points inside the project, or null when it is outside it or absent. */
export function outputPath(settings: Settings, settingsPath: string): string | null {
  const output = settings.sections.get("main")?.get("output")?.trim();
  if (!output || /^[a-z]:|^\//i.test(output)) return null;
  return joinProjectPath(dirOf(settingsPath), output);
}

/** The file name to offer for the built map: [main] `output`'s, else the open map's with "_eud". */
export function outputName(settings: Settings | null, mapName: string | null): string {
  const output = settings?.sections.get("main")?.get("output")?.trim();
  if (output) return output.replace(/\\/g, "/").split("/").pop() || "output.scx";
  const base = (mapName ?? "map.scx").replace(/\.(scx|scm|chk)$/i, "");
  return `${base}_eud.scx`;
}

/* ── Reading a folder ─────────────────────────────────────── */

/** Folders euddraft or tools write into a project, never read as input. */
const SKIP_DIRS = new Set([".git", ".svn", ".vscode", ".idea", "__epspy__", "__pycache__", "node_modules"]);
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_FILES = 4000;

export class ProjectTooLarge extends Error {}

/** Every file under a directory handle, with its path from the handle. */
export async function readDirectory(dir: FileSystemDirectoryHandle): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  let bytes = 0;
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const entry of (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (entry.kind === "directory") {
        if (!SKIP_DIRS.has(entry.name)) await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
        continue;
      }
      const file = await (entry as FileSystemFileHandle).getFile();
      bytes += file.size;
      if (out.length >= MAX_PROJECT_FILES || bytes > MAX_PROJECT_BYTES) throw new ProjectTooLarge();
      out.push({ path: `${prefix}${entry.name}`, data: new Uint8Array(await file.arrayBuffer()) });
    }
  };
  await walk(dir, "");
  return out;
}

/** The files of a folder picked through a file input (`api.ui.pickFiles({ directory: true })`). */
export async function readPicked(files: { path: string; file: File }[]): Promise<ProjectFile[]> {
  // The input's paths start with the folder's own name; the project is what is inside it.
  const strip = (p: string) => { const s = p.replace(/\\/g, "/"); const i = s.indexOf("/"); return i >= 0 ? s.slice(i + 1) : s; };
  const kept = files.filter((f) => !strip(f.path).split("/").some((part) => SKIP_DIRS.has(part)));
  if (kept.length > MAX_PROJECT_FILES || kept.reduce((n, f) => n + f.file.size, 0) > MAX_PROJECT_BYTES) throw new ProjectTooLarge();
  return Promise.all(kept.map(async (f) => ({ path: strip(f.path), data: new Uint8Array(await f.file.arrayBuffer()) })));
}

/** Write `data` to `path` under a directory handle, making folders as needed. */
export async function writeInto(dir: FileSystemDirectoryHandle, path: string, data: Uint8Array): Promise<void> {
  const parts = path.split("/");
  let at = dir;
  for (const part of parts.slice(0, -1)) at = await at.getDirectoryHandle(part, { create: true });
  const handle = await at.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(data as unknown as BufferSource);
  await writable.close();
}

export const decodeText = (data: Uint8Array): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return new TextDecoder("latin1").decode(data); }
};
