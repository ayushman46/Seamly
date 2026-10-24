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
  const closeRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const name = `${fileBase}-summary.png`;

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      const blob = await renderShareCard(meta, result, ins, (f) => api.frameUrl(meta.id, f));
      setCard({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (card) URL.revokeObjectURL(card.url);
    setCard(null);
    openRef.current?.focus();
  };
  useEffect(() => {
    if (!card) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

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
      <button ref={openRef} className="btn" onClick={make} disabled={busy} title="A one-image summary to send to a coach or parent">
        {busy ? <div className="spinner sm" /> : <IUpload size={15} />} Share summary
      </button>
      {err && !card && <span className="faint" role="alert" style={{ fontSize: 12 }}><IAlert size={13} /> {err}</span>}
      {card && (
        <div className="share-overlay" role="dialog" aria-modal="true" aria-label="Summary image" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="share-sheet card">
            <div className="row" style={{ marginBottom: 10 }}>
              <b className="grow">Summary image</b>
              <button ref={closeRef} className="btn ghost sm icon" onClick={close} aria-label="Close"><IX size={16} /></button>
            </div>
            <img src={card.url} alt={`Summary: ${ins?.summary.headline ?? meta.name}`} />
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
