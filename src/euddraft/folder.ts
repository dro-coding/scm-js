/**
 * The project folder kept between visits: a File System Access directory handle (Chrome,
 * Edge) stored in IndexedDB, which the browser lets a page keep but not use until the user
 * grants access again — `permission()` says where that stands and `request()` asks, from a
 * click. Browsers without the API pick a folder through a file input each time instead
 * (`api.ui.pickFiles({ directory: true })`), which gives a snapshot and nothing to keep.
 */

type Mode = "read" | "readwrite";
type PermissionState = "granted" | "prompt" | "denied";

interface PermissionHandle {
  queryPermission(opts: { mode: Mode }): Promise<PermissionState>;
  requestPermission(opts: { mode: Mode }): Promise<PermissionState>;
}

type Picker = (opts: { id?: string; mode?: Mode }) => Promise<FileSystemDirectoryHandle>;

export const canKeepFolders = (): boolean => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** The browser's folder picker; null when the user cancels. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (globalThis as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  try {
    return await picker({ id: "scmjs-euddraft", mode: "read" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

export async function permission(handle: FileSystemDirectoryHandle, mode: Mode = "read"): Promise<PermissionState> {
  return (handle as unknown as PermissionHandle).queryPermission({ mode });
}

/** Ask for access; call it while handling a click, or the browser refuses without asking. */
export async function request(handle: FileSystemDirectoryHandle, mode: Mode = "read"): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission({ mode })) === "granted";
}

const DB = "scmjs-euddraft";
const STORE = "handles";
const KEY = "project";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  try { return ((await tx("readonly", (s) => s.get(KEY))) as FileSystemDirectoryHandle | undefined) ?? null; } catch { return null; }
}

export async function saveFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    if (handle) await tx("readwrite", (s) => s.put(handle, KEY));
    else await tx("readwrite", (s) => s.delete(KEY));
  } catch { /* private mode: not kept */ }
}
