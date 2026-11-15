// From scm-js/plugin-eudplib v0.6.0 (src/archive.ts), MIT, copyright 2026 scmJS; `countTriggers` dropped.
/**
 * The archive half of a build, on the main thread with mopaq. eudplib never sees the
 * archive: the worker gets the scenario and the listfile's names (the shim answers
 * eudplib's archive calls from them), and what comes back — the built scenario and any
 * member a plugin added — is written into a new archive together with the input's other
 * members, the way the editor saves a map.
 */
import { Archive, Creator } from "mopaq";

export const SCENARIO = "staredit\\scenario.chk";
const LISTFILE = "(listfile)";
/** StarEdit's sector size; what the editor writes too. */
export const SECTOR_SIZE = 4096;

export interface SplitMap {
  chk: Uint8Array;
  /** The listfile's names, scenario.chk included; what the shim reports to eudplib. */
  names: string[];
  /** Every other member that could be read by name. */
  extras: Map<string, Uint8Array>;
  /** Members the hash table has that no name reached; they cannot be carried. */
  unnamed: number;
}

const key = (name: string) => name.replace(/\//g, "\\").toLowerCase();

/** Take a map apart: a bare .chk is accepted too (no archive, nothing to carry). */
export async function splitMap(bytes: Uint8Array): Promise<SplitMap> {
  if (!looksLikeMpq(bytes)) return { chk: bytes, names: [SCENARIO], extras: new Map(), unnamed: 0 };
  const archive = await Archive.openAsync(bytes);
  const chk = await archive.readFileAsync(SCENARIO);
  const listed = (await archive.filesAsync()) ?? [];
  const names = listed.length ? listed : [SCENARIO];
  const extras = new Map<string, Uint8Array>();
  const taken = new Set<number>();
  for (const n of [SCENARIO, LISTFILE]) { const s = archive.slotOf(n); if (s !== null) taken.add(s); }
  const seen = new Set<string>([key(SCENARIO), key(LISTFILE)]);
  for (const name of listed) {
    const k = key(name);
    if (seen.has(k)) continue;
    seen.add(k);
    const slot = archive.slotOf(name);
    if (slot === null || taken.has(slot)) continue;
    taken.add(slot);
    try { extras.set(name, await archive.readFileAsync(name)); } catch { /* unreadable: counted below */ }
  }
  const unnamed = archive.members().filter((m) => !taken.has(m.slot)).length;
  return { chk, names, extras, unnamed };
}

/** A member eudplib wrote: the shim records the name and locale it was added under. */
export interface BuiltMember { name: string; locale: number; data: Uint8Array }

/**
 * The built map: the scenario eudplib wrote under the English locale (it also writes an
 * empty one under the neutral locale as a decoy, which is left out), the input's other
 * members, and whatever the plugins added, PKWARE-compressed with a listfile — readable
 * by every StarCraft build.
 */
export async function assembleMap(members: BuiltMember[], extras: ReadonlyMap<string, Uint8Array>): Promise<{ map: Uint8Array; chk: Uint8Array }> {
  const scenario = members.filter((m) => key(m.name) === key(SCENARIO)).sort((a, b) => b.data.length - a.data.length)[0];
  if (!scenario || !scenario.data.length) throw new Error("The build produced no scenario.");
  const creator = new Creator({ sectorSize: SECTOR_SIZE, listfile: true, listfileCompress: "pkware" });
  creator.addFile(SCENARIO, scenario.data, { compress: "pkware" });
  const written = new Set<string>([key(SCENARIO), key(LISTFILE)]);
  for (const m of members) {
    const k = key(m.name);
    if (written.has(k)) continue;
    written.add(k);
    creator.addFile(m.name, m.data, { compress: "pkware" });
  }
  for (const [name, data] of extras) {
    const k = key(name);
    if (written.has(k)) continue;
    written.add(k);
    creator.addFile(name, data, { compress: "pkware" });
  }
  return { map: await creator.writeAsync(), chk: scenario.data };
}

export function looksLikeMpq(bytes: Uint8Array): boolean {
  for (let at = 0; at + 4 <= bytes.length && at <= 512 * 8; at += 512) {
    if (bytes[at] === 0x4d && bytes[at + 1] === 0x50 && bytes[at + 2] === 0x51 && (bytes[at + 3] === 0x1a || bytes[at + 3] === 0x1b)) return true;
  }
  return false;
}
