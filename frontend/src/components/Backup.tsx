import { useRef, useState } from "react";
import { api } from "../api";
import { backupName } from "../lib/backup";
import { IAlert, ICheck, IDownload, IUpload } from "./Icons";

type Note = { kind: "ok" | "error"; text: string } | null;

const mb = (bytes: number) => (bytes < 1e6 ? "under 1 MB" : `${Math.round(bytes / 1e6)} MB`);

function restoredText(r: { analyses: number; players: number; skipped: number }): string {
  const parts = [];
  if (r.analyses) parts.push(`${r.analyses} ${r.analyses === 1 ? "analysis" : "analyses"}`);
  if (r.players) parts.push(`${r.players} ${r.players === 1 ? "player" : "players"}`);
  const added = parts.length ? `Restored ${parts.join(" and ")}.` : "Nothing new to restore.";
  return r.skipped ? `${added} ${r.skipped} already in this browser ${r.skipped === 1 ? "was" : "were"} left as ${r.skipped === 1 ? "it was" : "they were"}.` : added;
}

/** Restoring from a backup file: a hidden file input, its busy state and the outcome. */
function useRestore(onRestored: () => void, onStart?: () => void) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setNote(null);
    onStart?.();
    try {
      setNote({ kind: "ok", text: restoredText(await api.restore(f)) });
      onRestored();
    } catch (er) {
      setNote({ kind: "error", text: (er as Error).message });
    } finally {
      setBusy(false);
    }
  };
  // no `accept` filter: phones grey out a file type they don't know
  const el = <input ref={input} type="file" hidden onChange={onPick} aria-hidden="true" tabIndex={-1} />;
  return { el, busy, note, pick: () => input.current?.click(), clear: () => setNote(null) };
}

function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <div className={`notice ${note.kind === "error" ? "error" : "ok"}`} role={note.kind === "error" ? "alert" : "status"} style={{ marginTop: 12 }}>
      {note.kind === "error" ? <IAlert size={16} /> : <ICheck size={16} />} <div>{note.text}</div>
    </div>
  );
}

/** Workspace card: download every analysis and player as one file, or add those from a backup. */
export function BackupPanel({ onRestored }: { onRestored: () => void }) {
  const [videos, setVideos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const restore = useRestore(onRestored, () => setNote(null));
  const download = async () => {
    setBusy(true);
    setNote(null);
    restore.clear();
    try {
      const { blob, analyses, players } = await api.backup(videos);
      if (!analyses && !players) { setNote({ kind: "error", text: "There's nothing to back up yet: analyse a delivery or create a player first." }); return; }
      const name = backupName();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNote({ kind: "ok", text: `Saved ${name} (${mb(blob.size)}: ${analyses} ${analyses === 1 ? "analysis" : "analyses"}, ${players} ${players === 1 ? "player" : "players"}). Open Seamly on the other device and choose “Restore a backup”.` });
    } catch (er) {
      setNote({ kind: "error", text: (er as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby="backup-title">
      <div className="card card-pad backup-card">
        <div className="backup-text">
          <h2 id="backup-title" style={{ fontSize: 17, margin: 0 }}>Back up or move to another device</h2>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5 }}>
            Your analyses are stored only in this browser, and clearing its site data deletes them. Download a backup file to keep a
            copy, or to carry your players and progress to a new phone or computer.
          </p>
          <label className="pick" style={{ marginTop: 10, paddingLeft: 0 }}>
            <input type="checkbox" checked={videos} onChange={(e) => setVideos(e.target.checked)} /> Include the original videos (bigger file; lets you re-analyse them later)
          </label>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn primary sm" onClick={download} disabled={busy || restore.busy}>
            {busy ? <div className="spinner sm" /> : <IDownload size={15} />} Download backup
          </button>
          <button type="button" className="btn sm" onClick={restore.pick} disabled={busy || restore.busy}>
            {restore.busy ? <div className="spinner sm" /> : <IUpload size={15} />} Restore a backup
          </button>
          {restore.el}
        </div>
      </div>
      <NoteLine note={note} />
      <NoteLine note={restore.note} />
    </section>
  );
}

/** For a browser with nothing in it yet: bring analyses over from another device. */
export function RestoreLink({ onRestored }: { onRestored: () => void }) {
  const restore = useRestore(onRestored);
  return (
    <div style={{ textAlign: "center" }}>
      <span className="faint" style={{ fontSize: 12.5 }}>
        Used Seamly on another device?{" "}
        <button type="button" className="link-btn" onClick={restore.pick} disabled={restore.busy}>{restore.busy ? "Restoring…" : "Restore a backup"}</button>
      </span>
      {restore.el}
      <NoteLine note={restore.note} />
    </div>
  );
}
