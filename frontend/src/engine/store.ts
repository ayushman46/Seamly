/**
 * Browser storage for analyses and players (IndexedDB). Everything stays on this device.
 *  meta     id -> analysis metadata (status, options, overrides, summary, ...)
 *  result   id -> analysis result JSON
 *  stagea   id -> Stage A data (what Stage B re-runs on)
 *  blob     "<id>/<name>" -> Blob (input video, display frames "f/<n>", mesh "mesh_rest.bin" / "pose.bin")
 *  player   id -> player profile
 */
const DB_NAME = "seamly";
const VERSION = 1;
const STORES = ["meta", "result", "stagea", "blob", "player"] as const;
type StoreName = (typeof STORES)[number];

let dbP: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("This browser has no storage for analyses (IndexedDB is unavailable, e.g. in some private windows).")); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Could not open the browser database."));
      req.onblocked = () => reject(new Error("Seamly is open in another tab that is blocking the database upgrade. Close other tabs and reload."));
    });
    dbP.catch(() => { dbP = null; });
  }
  return dbP;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store: StoreName, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  return (await db()).transaction(store, mode).objectStore(store);
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  return wrap((await tx(store)).get(key)) as Promise<T | undefined>;
}

const QUOTA = "Your browser storage is full. Delete some old analyses and try again.";

/** Run one read-write transaction over several stores; resolves only once it has committed (quota errors abort the
 *  transaction after the individual requests have already "succeeded"). */
export async function write(stores: StoreName[], fn: (s: Record<StoreName, IDBObjectStore>) => void): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(stores, "readwrite");
    const map = {} as Record<StoreName, IDBObjectStore>;
    for (const n of stores) map[n] = t.objectStore(n);
    fn(map);
    const fail = () => reject(t.error?.name === "QuotaExceededError" ? new Error(QUOTA) : (t.error ?? new Error("Saving to browser storage failed.")));
    t.oncomplete = () => resolve();
    t.onerror = fail;
    t.onabort = fail;
  });
}

export const put = (store: StoreName, key: string, value: unknown): Promise<void> =>
  write([store], (s) => { s[store].put(value, key); });

export const del = (store: StoreName, key: string): Promise<void> =>
  write([store], (s) => { s[store].delete(key); });

export async function all<T>(store: StoreName): Promise<T[]> {
  return wrap((await tx(store)).getAll()) as Promise<T[]>;
}

export async function keysWithPrefix(store: StoreName, prefix: string): Promise<string[]> {
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  return (await wrap((await tx(store)).getAllKeys(range))) as string[];
}

/** Every [key, value] whose key starts with `prefix`, in key order (one read transaction). */
export async function entriesWithPrefix<T>(store: StoreName, prefix: string): Promise<[string, T][]> {
  const s = await tx(store);
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const [keys, values] = await Promise.all([wrap(s.getAllKeys(range)), wrap(s.getAll(range))]);
  return (keys as string[]).map((k, i) => [k, values[i] as T]);
}

/** Write many entries in one transaction. */
export const putMany = (store: StoreName, entries: [string, unknown][]): Promise<void> =>
  write([store], (s) => { for (const [k, v] of entries) s[store].put(v, k); });

export const delPrefix = (store: StoreName, prefix: string): Promise<void> =>
  write([store], (s) => { s[store].delete(IDBKeyRange.bound(prefix, prefix + "\uffff")); });

/** Free space the browser will still give us (bytes), if it says. */
export async function freeSpace(): Promise<number | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.quota !== undefined && e.usage !== undefined ? e.quota - e.usage : null;
  } catch {
    return null;
  }
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function persist(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
}

export const newId = (): string => {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
