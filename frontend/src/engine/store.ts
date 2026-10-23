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
      req.onsuccess = () => {
        // another tab deleting or upgrading the database must not wait for this one: let go, reopen on next use
        req.result.onversionchange = () => { req.result.close(); dbP = null; blobsOk = null; };
        resolve(req.result);
      };
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

// WebKit's private browsing (Safari Private, some in-app browsers) refuses to keep a Blob in IndexedDB but takes an
// ArrayBuffer: there, Blobs are stored as { $blob: bytes, type } and turned back into Blobs when read.
type Packed = { $blob: ArrayBuffer; type: string };
const isPacked = (v: unknown): v is Packed => !!v && typeof v === "object" && (v as Packed).$blob instanceof ArrayBuffer;
const unpack = <T>(v: unknown): T => (isPacked(v) ? new Blob([v.$blob], { type: v.type }) : v) as T;

let blobsOk: Promise<boolean> | null = null;
function canStoreBlobs(d: IDBDatabase): Promise<boolean> {
  if (!blobsOk) {
    blobsOk = new Promise((resolve) => {
      try {
        const t = d.transaction("blob", "readwrite");
        t.objectStore("blob").put(new Blob([new Uint8Array([0])]), "\u0000probe");
        t.oncomplete = () => { d.transaction("blob", "readwrite").objectStore("blob").delete("\u0000probe"); resolve(true); };
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }
  return blobsOk;
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  return unpack<T | undefined>(await wrap((await tx(store)).get(key)));
}

const QUOTA = "Your browser storage is full. Delete some old analyses and try again.";

export interface Writer { put(value: unknown, key: string): void; delete(key: string | IDBKeyRange): void }
type Op = { store: StoreName; put: boolean; value?: unknown; key: string | IDBKeyRange };

/** Run one read-write transaction over several stores; resolves only once it has committed (quota errors abort the
 *  transaction after the individual requests have already "succeeded"). */
export async function write(stores: StoreName[], fn: (s: Record<StoreName, Writer>) => void): Promise<void> {
  const d = await db();
  // record the writes first: Blobs may need converting (async) before the transaction opens
  const ops: Op[] = [];
  const rec = {} as Record<StoreName, Writer>;
  for (const n of stores) rec[n] = { put: (value, key) => { ops.push({ store: n, put: true, value, key }); }, delete: (key) => { ops.push({ store: n, put: false, key }); } };
  fn(rec);
  if (ops.some((o) => o.value instanceof Blob) && !(await canStoreBlobs(d))) {
    for (const o of ops) if (o.value instanceof Blob) o.value = { $blob: await o.value.arrayBuffer(), type: o.value.type } satisfies Packed;
  }
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(stores, "readwrite");
    for (const o of ops) {
      if (o.put) t.objectStore(o.store).put(o.value, o.key as string);
      else t.objectStore(o.store).delete(o.key);
    }
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
  return ((await wrap((await tx(store)).getAll())) as unknown[]).map((v) => unpack<T>(v));
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
  return (keys as string[]).map((k, i) => [k, unpack<T>(values[i])]);
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
