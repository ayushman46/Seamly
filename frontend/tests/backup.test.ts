/** Seamly backup file format (lib/backup.ts): round trip, non-finite numbers, and files that must be refused. */
import { describe, expect, it } from "vitest";
import { BACKUP_VERSION, FILE_NAME, backupName, decodeBackup, encodeBackup, type BackupHeader } from "../src/lib/backup";

const header = (over: Partial<BackupHeader> = {}): BackupHeader => ({
  app: "seamly", version: BACKUP_VERSION, created: 1_790_000_000, players: [{ id: "p1", name: "Asha" }],
  analyses: [
    { meta: { id: "a1", name: "Nets" }, result: { frames: { start: 3, end: 5 } }, stagea: { bbox: [[NaN, 1, Infinity, -Infinity]] },
      files: [{ name: "f/3", size: 3, type: "image/jpeg" }, { name: "f/4", size: 0, type: "image/jpeg" }, { name: "pose.bin", size: 5, type: "" }] },
    { meta: { id: "a2", name: "Match" }, result: {}, stagea: {}, files: [{ name: "input", size: 4, type: "video/mp4" }] },
  ],
  ...over,
});
const files = () => [
  [new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), new Blob([]), new Blob([new Uint8Array([9, 8, 7, 6, 5])])],
  [new Blob([new Uint8Array([4, 4, 4, 4])], { type: "video/mp4" })],
];
const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

describe("backup files", () => {
  it("round-trips the header and every file, in order", async () => {
    const file = encodeBackup(header(), files());
    const { header: h, files: out } = await decodeBackup(file);
    expect(h.players).toEqual([{ id: "p1", name: "Asha" }]);
    expect(h.analyses.map((a) => a.meta.id)).toEqual(["a1", "a2"]);
    expect(await bytes(out[0][0])).toEqual([1, 2, 3]);
    expect(out[0][0].type).toBe("image/jpeg");
    expect(await bytes(out[0][1])).toEqual([]);
    expect(await bytes(out[0][2])).toEqual([9, 8, 7, 6, 5]);
    expect(await bytes(out[1][0])).toEqual([4, 4, 4, 4]);
  });

  it("keeps NaN and infinities, which JSON can't hold", async () => {
    const { header: h } = await decodeBackup(encodeBackup(header(), files()));
    const box = (h.analyses[0].stagea as { bbox: number[][] }).bbox[0];
    expect(Number.isNaN(box[0])).toBe(true);
    expect(box.slice(1)).toEqual([1, Infinity, -Infinity]);
  });

  it("refuses files that aren't backups", async () => {
    await expect(decodeBackup(new Blob(["not a backup at all"]))).rejects.toThrow(/isn't a Seamly backup/);
    await expect(decodeBackup(new Blob([]))).rejects.toThrow(/isn't a Seamly backup/);
    const wrongApp = encodeBackup({ ...header(), app: "other" as "seamly" }, files());
    await expect(decodeBackup(wrongApp)).rejects.toThrow(/isn't a Seamly backup/);
  });

  it("refuses a truncated download", async () => {
    const full = encodeBackup(header(), files());
    await expect(decodeBackup(full.slice(0, full.size - 2))).rejects.toThrow(/incomplete/);
    await expect(decodeBackup(full.slice(0, 20))).rejects.toThrow(/incomplete/);
  });

  it("refuses a backup from a newer version", async () => {
    await expect(decodeBackup(encodeBackup(header({ version: BACKUP_VERSION + 1 }), files()))).rejects.toThrow(/newer version/);
  });

  it("only accepts known file names on restore", () => {
    for (const ok of ["f/0", "f/123456", "mesh_rest.bin", "pose.bin", "input"]) expect(FILE_NAME.test(ok)).toBe(true);
    for (const bad of ["f/../x", "../input", "f/1/2", "input2", "", "f/"]) expect(FILE_NAME.test(bad)).toBe(false);
  });

  it("names the file by date", () => {
    expect(backupName(new Date(2026, 9, 4))).toBe("seamly-backup-2026-10-04.seamly");
  });
});
