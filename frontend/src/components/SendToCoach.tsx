import { useState } from "react";
import { api } from "../api";
import type { Player } from "../types";
import { BACKUP_EXT } from "../lib/backup";
import { IAlert, IUpload } from "./Icons";

/** "Send to coach": one file with this player and their analyses (no videos, so it is small), shared from a phone or
 * saved. The coach adds it with "Restore a backup"; analyses already there are left as they are. */
export default function SendToCoach({ player }: { player: Player }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { blob, analyses } = await api.backup(false, player.id);
      const slug = player.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
      const name = `${slug}-seamly${BACKUP_EXT}`;
      const file = new File([blob], name, { type: "application/octet-stream" });
      let shared = false;
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `${player.name}: Seamly analyses` }); shared = true; }
        catch (e) { if ((e as Error).name === "AbortError") { setBusy(false); return; } }
      }
      if (!shared) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);   // a phone's save prompt can take a while
      }
      const what = `${analyses} ${analyses === 1 ? "analysis" : "analyses"}${blob.size < 1e6 ? ", under 1 MB" : `, ${Math.round(blob.size / 1e6)} MB`}`;
      setNote({ ok: true, text: `${shared ? "Shared" : "Saved"} ${name} (${what}). Your coach opens Seamly and chooses “Restore a backup” to add it.` });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" onClick={send} disabled={busy} title="A small file with this player's analyses (no videos) for a coach's Seamly">
        {busy ? <div className="spinner sm" /> : <IUpload size={15} />} Send to coach
      </button>
      {note && <div className={`send-note ${note.ok ? "faint" : "notice error"}`} role={note.ok ? "status" : "alert"}>{!note.ok && <IAlert size={14} />} {note.text}</div>}
    </>
  );
}
