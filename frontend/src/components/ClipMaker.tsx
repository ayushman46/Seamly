import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisMeta, AnalysisResult, Insights } from "../types";
import { capture3D, clipExt, clipLayout, clipMime, clipPlan, drawClipFrame, type ClipStep } from "../lib/clip";
import { IAlert, IDownload, IFilm, IUpload, IX } from "./Icons";

// two paints, or 120 ms at most: a hidden tab fires no animation frames and must not hang the recording
const nextPaint = () => new Promise<void>((r) => {
  const t = window.setTimeout(r, 120);
  requestAnimationFrame(() => requestAnimationFrame(() => { window.clearTimeout(t); r(); }));
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, Math.max(0, ms)));

/**
 * "Save clip": records the delivery as a short video, the analysed footage beside the 3D body, in slow motion with the
 * key moments held and the measured numbers under it; optionally with the coach's voice recorded as it plays. The page
 * itself plays the clip while it records (the player and the 3D view follow), so what is saved is what is on screen.
 */
export default function ClipMaker({ meta, result, ins, fileBase, frame, onFrame, player }: {
  meta: AnalysisMeta; result: AnalysisResult; ins: Insights | null; fileBase: string; frame: number;
  onFrame: (f: number) => void; player: () => HTMLCanvasElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const [with3d, setWith3d] = useState(true);
  const [voice, setVoice] = useState(false);
  const [hideName, setHideName] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [clip, setClip] = useState<{ blob: Blob; url: string; mime: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cancel = useRef(false);
  const outRef = useRef<HTMLCanvasElement | null>(null);   // the clip as it records, shown in the dialog
  const micRef = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  // leaving the page mid-recording stops it and lets go of the microphone
  useEffect(() => () => {
    alive.current = false;
    cancel.current = true;
    micRef.current?.getTracks().forEach((t) => t.stop());
  }, []);
  const openRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const mime = useMemo(() => clipMime(voice), [voice]);
  const supported = useMemo(() => clipMime(false) !== null, []);
  const plan = useMemo(() => clipPlan(result, speed), [result, speed]);
  const seconds = Math.round(plan.reduce((a, s) => a + s.ms, 0) / 1000);
  const recording = progress !== null;
  const cue = ins?.summary.fixes[0]?.cue ?? result.coaching.priorities[0]?.drill.cue ?? null;
  const name = `${hideName ? "seamly" : fileBase}-clip.${mime ? clipExt(mime) : "mp4"}`;

  const close = () => {
    if (recording) { cancel.current = true; return; }
    setOpen(false);
    setClip((c) => { if (c) URL.revokeObjectURL(c.url); return null; });
    setErr(null);
    openRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href], video[controls]")];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recording]);

  // wait until the page shows this frame: the player's canvas names the frame it drew
  const showFrame = async (f: number) => {
    onFrame(f);
    const c = player();
    const t0 = performance.now();
    while (c && !c.getAttribute("aria-label")?.startsWith(`Video frame ${f} `) && performance.now() - t0 < 1500) await nextPaint();
    await nextPaint();
  };

  const make = async () => {
    const canvasEl = player();
    if (!mime || !canvasEl) { setErr("This browser can't record video. Try Chrome, Edge, Firefox or Safari 14.1 or later."); return; }
    setErr(null);
    setClip((c) => { if (c) URL.revokeObjectURL(c.url); return null; });
    let mic: MediaStream | null = null;
    if (voice) {
      try { mic = micRef.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { setErr(`Couldn't use the microphone (${(e as Error).message || (e as Error).name}). Untick “Record my voice” to make the clip without it.`); return; }
    }
    const start = frame;
    cancel.current = false;
    setProgress(0);
    const three = with3d && capture3D() !== null;
    const portrait = result.video.height > result.video.width;
    const L = clipLayout(portrait, three);
    const out = document.createElement("canvas");
    out.width = L.W; out.height = L.H;
    out.setAttribute("role", "img");
    out.setAttribute("aria-label", "The clip as it records");
    outRef.current = out;
    const ctx = out.getContext("2d")!;
    const title = hideName ? "" : meta.name;
    const draw = (s: ClipStep) => drawClipFrame(ctx, L, canvasEl, s, result, { title, cue, pace: meta.pace });
    let rec: MediaRecorder | null = null;
    try {
      // every frame is in memory before recording starts, so the clip never shows a frame still loading
      const t0 = performance.now();
      while (!cancel.current && document.querySelector(".player-hud")?.textContent?.includes("Loading frames") && performance.now() - t0 < 30000) await sleep(150);
      await showFrame(plan[0].frame);
      draw(plan[0]);
      const stream = out.captureStream(30);
      mic?.getAudioTracks().forEach((t) => stream.addTrack(t));
      const chunks: Blob[] = [];
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise<void>((r) => { rec!.onstop = () => r(); });
      // a hidden tab draws nothing: the recording pauses while the tab is hidden rather than record a frozen picture
      const r0 = rec;
      const onVis = () => {
        if (document.hidden && r0.state === "recording") r0.pause();
        else if (!document.hidden && r0.state === "paused") r0.resume();
      };
      document.addEventListener("visibilitychange", onVis);
      rec.start(250);
      try {
        // each step ends at its own deadline, so the time spent showing a frame doesn't slow the clip down
        let due = performance.now();
        for (let i = 0; i < plan.length && !cancel.current; i++) {
          const s = plan[i];
          if (document.hidden) {
            while (document.hidden && !cancel.current) await sleep(200);
            due = performance.now();
          }
          if (i === 0 || plan[i - 1].frame !== s.frame) await showFrame(s.frame);
          draw(s);
          due += s.ms;
          // held frames are drawn again every ~66 ms so every encoder keeps a steady picture
          while (performance.now() < due - 4 && !cancel.current) {
            await sleep(Math.min(66, due - performance.now()));
            if (performance.now() < due) draw(s);
          }
          setProgress((i + 1) / plan.length);
        }
      } finally {
        document.removeEventListener("visibilitychange", onVis);
      }
      rec.stop();
      await stopped;
      if (!cancel.current && alive.current) {
        const type = mime.split(";")[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) throw new Error("The recording came out empty.");
        setClip({ blob, url: URL.createObjectURL(blob), mime: type });
      }
    } catch (e) {
      if (rec && rec.state !== "inactive") rec.stop();
      setErr(`Couldn't make the clip: ${(e as Error).message}`);
    } finally {
      mic?.getTracks().forEach((t) => t.stop());
      micRef.current = null;
      capture3D()?.end();
      if (alive.current) {
        setProgress(null);
        onFrame(start);
      }
    }
  };

  const file = clip ? new File([clip.blob], name, { type: clip.mime }) : null;
  const canShare = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
  const share = async () => {
    if (!file) return;
    try { await navigator.share({ files: [file], title: "Bowling clip from Seamly" }); }
    catch (e) { if ((e as Error).name !== "AbortError") setErr("Sharing didn't work here. Use Save clip instead."); }
  };
  const save = () => {
    if (!clip) return;
    const a = document.createElement("a");
    a.href = clip.url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const mb = clip ? clip.blob.size / 1e6 : 0;

  if (!supported) return null;
  return (
    <>
      <button ref={openRef} className="btn" onClick={() => setOpen(true)} title="A slow-motion video of this delivery beside the 3D body, to send to a coach or parent" aria-label="Save clip">
        <IFilm size={15} /> <span className="btn-label">Save clip</span><span className="btn-label-sm" aria-hidden="true">Clip</span>
      </button>
      {open && (
        <div className="share-overlay clip-overlay" role="dialog" aria-modal="true" aria-labelledby="clip-title" ref={dialogRef}
          onClick={(e) => { if (e.target === e.currentTarget && !recording) close(); }}>
          <div className="share-sheet clip-sheet card">
            <div className="row" style={{ marginBottom: 10 }}>
              <b className="grow" id="clip-title">Side-by-side clip</b>
              <button ref={firstRef} className="btn ghost sm icon" onClick={close} aria-label={recording ? "Stop recording" : "Close"}><IX size={16} /></button>
            </div>
            {clip ? (
              <>
                <video className="clip-video" src={clip.url} controls playsInline aria-label="The clip" />
                <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                  {clipExt(clip.mime).toUpperCase()} · {mb < 1 ? `${Math.round(mb * 1000)} KB` : `${mb.toFixed(1)} MB`}
                  {clip.mime === "video/webm" && " · WebM: plays in Chrome, Firefox and on Android; iPhones may need a converter"}
                </div>
                <div className="row wrap" style={{ gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={() => setClip((c) => { if (c) URL.revokeObjectURL(c.url); return null; })}>Make another</button>
                  {canShare && <button className="btn primary" onClick={share}><IUpload size={15} /> Share</button>}
                  <button className={`btn ${canShare ? "" : "primary"}`} onClick={save}><IDownload size={15} /> Save clip</button>
                </div>
              </>
            ) : recording ? (
              <div aria-live="polite">
                <div className="clip-live" ref={(el) => { if (el && outRef.current && outRef.current.parentElement !== el) el.replaceChildren(outRef.current); }} />
                <p className="muted" style={{ margin: "10px 0", fontSize: 13.5 }}>
                  Recording{voice ? ": talk as it plays" : ""}. Keep this tab open until it finishes.
                </p>
                <div className="clip-progress" role="progressbar" aria-label="Recording" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
                  <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                </div>
                <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => { cancel.current = true; }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
                  The delivery in slow motion, the video with its skeleton beside the 3D body, pausing at back-foot contact, front-foot contact
                  and release with the numbers measured there, ending on the cue. It plays anywhere, without Seamly.
                </p>
                <div className="clip-opts">
                  <div className="row" style={{ gap: 10 }}>
                    <span id="clip-speed">Speed</span>
                    <div className="seg" role="group" aria-labelledby="clip-speed">
                      {[0.25, 0.5].map((v) => <button key={v} className={speed === v ? "on" : ""} aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v === 0.25 ? "¼×" : "½×"}</button>)}
                    </div>
                    <span className="faint" style={{ fontSize: 12.5 }}>about {seconds} s</span>
                  </div>
                  <label className="pick" style={{ paddingLeft: 0 }}>
                    <input type="checkbox" checked={with3d && capture3D() !== null} disabled={capture3D() === null} onChange={(e) => setWith3d(e.target.checked)} />
                    The 3D body beside the video{capture3D() === null ? " (the 3D view isn't available here)" : ""}
                  </label>
                  <label className="pick" style={{ paddingLeft: 0 }}>
                    <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Record my voice as it plays (a coach's voice-over)
                  </label>
                  <label className="pick" style={{ paddingLeft: 0 }}>
                    <input type="checkbox" checked={hideName} onChange={(e) => setHideName(e.target.checked)} /> Hide the name (to share a child's clip more privately)
                  </label>
                </div>
                <div className="row wrap" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                  <button className="btn primary" onClick={make} disabled={!mime}><IFilm size={15} /> Make clip</button>
                </div>
              </>
            )}
            {err && <div className="notice error" role="alert" style={{ marginTop: 10 }}><IAlert size={16} /> <div>{err}</div></div>}
          </div>
        </div>
      )}
    </>
  );
}
