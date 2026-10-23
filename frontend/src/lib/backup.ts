/**
 * Seamly backup files: every finished analysis and player in one file, to keep a copy or move them to another
 * browser or device (analyses otherwise live only in the browser that made them).
 *
 * Layout: the 8-byte magic "SEAMLYBK", the header length (uint32, little-endian), the UTF-8 JSON header, then the
 * bytes of every file listed in the header, back to back in header order.
 */
const MAGIC = "SEAMLYBK";
export const BACKUP_VERSION = 1;
export const BACKUP_EXT = ".seamly";

export interface BackupFile { name: string; size: number; type: string }
export interface BackupAnalysis { meta: Record<string, unknown>; result: unknown; stagea: unknown; files: BackupFile[] }
export interface BackupHeader {
  app: "seamly";
  version: number;
  created: number;
  players: Record<string, unknown>[];
  analyses: BackupAnalysis[];
}

// Stage A data holds NaN (frames without a detection) and JSON has no NaN or Infinity: keep them as markers.
const NONFINITE: Record<string, number> = { "\u0000NaN": NaN, "\u0000Inf": Infinity, "\u0000-Inf": -Infinity };
const replacer = (_k: string, v: unknown) =>
  typeof v === "number" && !Number.isFinite(v) ? (Number.isNaN(v) ? "\u0000NaN" : v > 0 ? "\u0000Inf" : "\u0000-Inf") : v;
const reviver = (_k: string, v: unknown) => (typeof v === "string" && v in NONFINITE ? NONFINITE[v] : v);

// names an analysis' files may have inside a backup (anything else is ignored on restore)
export const FILE_NAME = /^(f\/\d{1,6}|mesh_rest\.bin|pose\.bin|input)$/;

/** Build a backup file. `files[i]` holds the contents of `header.analyses[i].files`, in the same order. */
export function encodeBackup(header: BackupHeader, files: Blob[][]): Blob {
  const json = new TextEncoder().encode(JSON.stringify(header, replacer));
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(8, json.length, true);
  return new Blob([head, json, ...files.flat()], { type: "application/octet-stream" });
}

const INCOMPLETE = "This backup file is incomplete. It may not have finished downloading or copying: make the backup again.";
const NOT_BACKUP = "This isn't a Seamly backup file. Choose the .seamly file made with “Download backup”.";

/** Read a backup file. Returns the header and, per analysis, its files as slices of `file` (nothing is copied). */
export async function decodeBackup(file: Blob): Promise<{ header: BackupHeader; files: Blob[][] }> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12 || new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) throw new Error(NOT_BACKUP);
  const n = new DataView(head.buffer, head.byteOffset).getUint32(8, true);
  if (12 + n > file.size) throw new Error(INCOMPLETE);
  let header: BackupHeader;
  try {
    header = JSON.parse(await file.slice(12, 12 + n).text(), reviver);
  } catch {
    throw new Error("This backup file is damaged and can't be read.");
  }
  if (header?.app !== "seamly" || !Array.isArray(header.analyses) || !Array.isArray(header.players)) throw new Error(NOT_BACKUP);
  if (!(header.version <= BACKUP_VERSION)) throw new Error("This backup was made by a newer version of Seamly. Reload the page to update, then try again.");
  let off = 12 + n;
  const files = header.analyses.map((a) => (Array.isArray(a?.files) ? a.files : []).map((f) => {
    const size = Math.max(0, Math.floor(Number(f?.size) || 0));
    const part = file.slice(off, off + size, typeof f?.type === "string" ? f.type : "");
    off += size;
    return part;
  }));
  if (off > file.size) throw new Error(INCOMPLETE);
  return { header, files };
}

export const backupName = (d = new Date(), videos = false) =>
  `seamly-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}${videos ? "-with-videos" : ""}${BACKUP_EXT}`;
