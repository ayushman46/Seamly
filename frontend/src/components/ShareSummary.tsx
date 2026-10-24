import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult, Insights } from "../types";
import { renderShareCard } from "../lib/shareCard";
import { IAlert, IDownload, IUpload, IX } from "./Icons";

/** "Share summary": draws a one-image summary, previews it, then shares it (phones) or saves it as a PNG. */
export default function ShareSummary({ meta, result, ins, fileBase }: { meta: AnalysisMeta; result: AnalysisResult; ins: Insights | null; fileBase: string }) {
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hideName, setHideName] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const name = hideName ? "seamly-summary.png" : `${fileBase}-summary.png`;

  const make = async (hide = hideName) => {
    setBusy(true);
    setErr(null);
    try {
      const blob = await renderShareCard(meta, result, ins, (f) => api.frameUrl(meta.id, f), { hideName: hide });
      setCard((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setCard((c) => { if (c) URL.revokeObjectURL(c.url); return null; });
    openRef.current?.focus();
  };
  const open = !!card;
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); return; }
      // keep Tab inside the dialog: the page behind it stays out of reach until it closes
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href]")];
      if (!items.length) return;
      // moved by hand: Safari's Tab skips buttons by default, which would let focus out to the page behind
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const file = card ? new File([card.blob], name, { type: "image/png" }) : null;
  const canShare = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: "Seamly bowling summary", text: ins?.summary.headline ?? "" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr("Sharing didn't work here. Use Save image instead.");
    }
  };
  const save = () => {
    if (!card) return;
    const a = document.createElement("a");
    a.href = card.url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <>
      <button ref={openRef} className="btn" onClick={() => make()} disabled={busy} title="A one-image summary to send to a coach or parent" aria-label="Share summary">
        {busy ? <div className="spinner sm" /> : <IUpload size={15} />} <span className="btn-label">Share summary</span><span className="btn-label-sm" aria-hidden="true">Share</span>
      </button>
      {err && !card && <span className="faint" role="alert" style={{ fontSize: 12 }}><IAlert size={13} /> {err}</span>}
      {card && (
        <div className="share-overlay" role="dialog" aria-modal="true" aria-label="Summary image" onClick={(e) => { if (e.target === e.currentTarget) close(); }}
          ref={dialogRef}>
          <div className="share-sheet card">
            <div className="row" style={{ marginBottom: 10 }}>
              <b className="grow">Summary image</b>
              <button ref={closeRef} className="btn ghost sm icon" onClick={close} aria-label="Close"><IX size={16} /></button>
            </div>
            <img src={card.url} alt={`Summary: ${ins?.summary.headline ?? meta.name}`} />
            <label className="pick" style={{ marginTop: 10, paddingLeft: 0 }}>
              <input type="checkbox" checked={hideName}
                onChange={(e) => { if (busy) return; setHideName(e.target.checked); void make(e.target.checked); }} /> Hide the name (to share a child's clip more privately)
            </label>
            {err && <div className="notice error" role="alert" style={{ marginTop: 10 }}><IAlert size={16} /> <div>{err}</div></div>}
            <div className="row wrap" style={{ gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              {canShare && <button className="btn primary" onClick={share}><IUpload size={15} /> Share</button>}
              <button className={`btn ${canShare ? "" : "primary"}`} onClick={save}><IDownload size={15} /> Save image</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
