import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult, CreaseRecord } from "../types";
import { creaseCall, frontAnkle, staturePx, travel, VERDICT_TEXT, type CreaseCall, type CreaseLine, type Pt } from "../lib/crease";
import { IFlag, INext, IPrev } from "./Icons";

const CW = 640, CH = 400;   // the zoomed view's drawing size
const VERDICT_CLS = { legal: "good", no_ball: "risk", close: "watch" } as const;

/**
 * Front-foot no-ball check: a zoomed view of the front foot on its landing frame, where the user marks the back edge of
 * the crease (two taps, or a line placed and nudged with buttons); Seamly places the back of the heel and says
 * whether some of the foot landed behind the line, with how many centimetres and a too-close-to-call band.
 */
export default function CreaseCard({ id, result, meta, onSeek, onMeta, flash }: {
  id: string; result: AnalysisResult; meta: AnalysisMeta;
  onSeek: (f: number) => void; onMeta: (m: AnalysisMeta) => void; flash: (text: string, error?: boolean) => void;
}) {
  const saved = meta.crease ?? null;
  const ffc = result.events.ffc?.frame ?? null;
  const dir = useMemo(() => travel(result), [result]);
  const sideOn = result.view.view === "side_on" && !result.view.oblique;
  const usable = sideOn && ffc !== null && dir !== null;
  const [marking, setMarking] = useState(false);
  const [frame, setFrame] = useState(saved?.frame ?? ffc ?? result.frames.start);
  const [line, setLine] = useState<CreaseLine | null>(saved ? { a: saved.line.a, b: saved.line.b } : null);
  const [first, setFirst] = useState<Pt | null>(null);   // the first tap of a new line
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const f0 = result.frames.start, fEnd = result.frames.end - 1;

  // the zoomed region: around where the front foot lands, wide enough for the foot and the crease either side of it
  const region = useMemo(() => {
    if (!usable) return null;
    const at = saved?.frame ?? ffc!;
    const a = frontAnkle(result, at, dir!), H = staturePx(result, at);
    if (!a || !H) return null;
    const W = result.video.width * result.display_scale, Hh = result.video.height * result.display_scale;
    const w = Math.min(W, 1.0 * H), h = Math.min(Hh, w * CH / CW);
    const x = Math.max(0, Math.min(W - w, a[0] - w / 2)), y = Math.max(0, Math.min(Hh - h, a[1] + 0.04 * H - h * 0.6));
    return { x, y, w, h };
  }, [usable, result, dir, ffc, saved?.frame]);

  const call: CreaseCall | null = useMemo(() => (line && usable ? creaseCall(result, frame, line) : null), [line, usable, result, frame]);
  const live = marking ? call : saved && line ? creaseCall(result, saved.frame, line) : null;

  // draw the frame, the line, the band either side of it and the estimated foot
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const shown = marking ? frame : saved?.frame ?? frame;
  useEffect(() => {
    if (!region) return;
    let live2 = true;
    const im = new Image();
    im.onload = () => live2 && setImg(im);
    im.src = api.frameUrl(id, shown);
    return () => { live2 = false; };
  }, [id, shown, region]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !region) return;
    const ctx = c.getContext("2d")!;
    const s = CW / region.w;
    const P = (p: Pt): Pt => [(p[0] - region.x) * s, (p[1] - region.y) * s];
    ctx.fillStyle = "#0b0b0c"; ctx.fillRect(0, 0, CW, CH);
    if (img) ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, CW, CH);
    const c0 = live;
    if (line) {
      const A = P(line.a), B = P(line.b);
      const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
      const ext = (t: number): Pt => [A[0] + (dx / L) * t, A[1] + (dy / L) * t];
      const [e1, e2] = [ext(-2000), ext(2000)];
      if (c0) {
        // the too-close-to-call band, either side of the line along the direction of travel
        const b = (c0.bandCm / 100) * c0.pxPerM * s;
        ctx.fillStyle = "rgba(245,158,11,0.18)";
        ctx.beginPath();
        ctx.moveTo(e1[0] - c0.dir[0] * b, e1[1] - c0.dir[1] * b); ctx.lineTo(e2[0] - c0.dir[0] * b, e2[1] - c0.dir[1] * b);
        ctx.lineTo(e2[0] + c0.dir[0] * b, e2[1] + c0.dir[1] * b); ctx.lineTo(e1[0] + c0.dir[0] * b, e1[1] + c0.dir[1] * b);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]); ctx.stroke();
      for (const q of [A, B]) { ctx.fillStyle = "#facc15"; ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.fill(); }
    }
    if (first && !line) { const q = P(first); ctx.fillStyle = "#facc15"; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, Math.PI * 2); ctx.fill(); }
    if (c0) {
      const H = P(c0.heel), T = P(c0.toe), K = P(c0.ankle);
      ctx.strokeStyle = "rgba(56,189,248,0.9)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(H[0], H[1]); ctx.lineTo(T[0], T[1]); ctx.stroke();   // the foot, heel to toe
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(K[0], K[1]); ctx.lineTo(H[0], H[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = VERDICT_CLS[c0.verdict] === "good" ? "#22c55e" : VERDICT_CLS[c0.verdict] === "risk" ? "#ef4444" : "#f59e0b";
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(H[0], H[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }, [img, region, line, first, live]);

  const toImage = (e: React.PointerEvent<HTMLCanvasElement>): Pt | null => {
    if (!region) return null;
    const r = e.currentTarget.getBoundingClientRect();
    return [region.x + ((e.clientX - r.left) / r.width) * region.w, region.y + ((e.clientY - r.top) / r.height) * region.h];
  };
  const tap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!marking) return;
    const p = toImage(e);
    if (!p) return;
    if (!first || line) { setFirst(p); setLine(null); return; }
    setLine({ a: first, b: p });
    setFirst(null);
  };
  // keyboard and fine adjustment: a line placed through the foot, then moved and tilted a pixel at a time
  const place = () => {
    if (!region) return;
    const a = frontAnkle(result, frame, dir!) ?? [region.x + region.w / 2, region.y + region.h / 2];
    setFirst(null);
    setLine({ a: [a[0], region.y + region.h * 0.35], b: [a[0], region.y + region.h * 0.9] });
  };
  const nudge = (dx: number, tilt = 0) => setLine((l) => l && ({ a: [l.a[0] + dx - tilt, l.a[1]], b: [l.b[0] + dx + tilt, l.b[1]] }));

  const start = () => {
    setFrame(saved?.frame ?? ffc!); setLine(saved ? { a: saved.line.a, b: saved.line.b } : null); setFirst(null);
    setMarking(true); onSeek(saved?.frame ?? ffc!);
  };
  const step = (d: number) => { const f = Math.max(f0, Math.min(fEnd, frame + d)); setFrame(f); onSeek(f); };
  const save = async () => {
    if (!call || !line) return;
    setBusy(true);
    try {
      const rec: CreaseRecord = { line: { a: line.a, b: line.b }, frame, behind_cm: Math.round(call.behindCm * 10) / 10, band_cm: Math.round(call.bandCm * 10) / 10, verdict: call.verdict };
      onMeta(await api.patch(id, { crease: rec }));
      setMarking(false);
      flash(`Front foot: ${VERDICT_TEXT[call.verdict].toLowerCase()}`);
    } catch (e) { flash((e as Error).message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { onMeta(await api.patch(id, { crease: null })); setLine(null); } catch (e) { flash((e as Error).message, true); }
  };

  const gap = (c: CreaseCall) => {
    const d = Math.round(Math.abs(c.behindCm));
    return c.verdict === "close"
      ? `The back of the heel is about ${d} cm ${c.behindCm >= 0 ? "behind" : "past"} the line, inside the ±${Math.round(c.bandCm)} cm this check can tell apart.`
      : `The back of the heel is about ${d} cm ${c.behindCm >= 0 ? "behind" : "past"} the line (±${Math.round(c.bandCm)} cm).`;
  };
  const evLabel = frame === ffc ? " · front-foot contact" : ffc !== null ? ` · contact ${frame > ffc ? "+" : ""}${frame - ffc}` : "";

  return (
    <section className="card card-pad crease-card" aria-labelledby="crease-title">
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <div role="heading" aria-level={2} id="crease-title" className="card-title grow" style={{ margin: 0 }}><IFlag size={14} /> No-ball check</div>
        {saved && !marking && usable && <button type="button" className="btn ghost sm" onClick={start}>Check again</button>}
      </div>
      {!usable ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {!sideOn
            ? "Checks the front foot against the popping crease. It needs a side-on clip, filmed square to the crease, with the front foot and the crease line in the picture."
            : "The front-foot landing or the direction of travel couldn't be found on this clip, so the foot can't be checked."}
        </p>
      ) : !marking && !saved ? (
        <>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Did some of the front foot land behind the popping crease? Mark the crease on the landing frame and Seamly places the back of the
            heel and measures the gap. A practice check, not an umpire.
          </p>
          <button type="button" className="btn sm primary" onClick={start}>Check the front foot</button>
        </>
      ) : (
        <>
          {marking && (
            <ol className="crease-steps">
              <li>Step to the first frame the front foot touches the ground.</li>
              <li>Tap two points along the <b>back edge</b> of the crease line (the edge nearer the bowler), or place a line and move it.</li>
            </ol>
          )}
          <canvas ref={canvas} width={CW} height={CH} className={`crease-view ${marking ? "marking" : ""}`} onPointerUp={tap}
            role="img" aria-label={`Front foot at frame ${shown}${line ? ", crease line marked" : ""}${live ? `: ${VERDICT_TEXT[live.verdict]}, ${gap(live)}` : ""}`} />
          {marking && (
            <div className="crease-tools">
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm ghost icon" aria-label="Previous frame" disabled={frame <= f0} onClick={() => step(-1)}><IPrev size={15} /></button>
                <span className="mono" style={{ fontSize: 12.5 }}>f {frame}{evLabel}</span>
                <button type="button" className="btn sm ghost icon" aria-label="Next frame" disabled={frame >= fEnd} onClick={() => step(1)}><INext size={15} /></button>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {!line && <button type="button" className="btn sm" onClick={place}>Place a line</button>}
                {line && (
                  <div className="seg" role="group" aria-label="Move the crease line">
                    <button type="button" aria-label="Move the line left" onClick={() => nudge(-1)}>←</button>
                    <button type="button" aria-label="Move the line right" onClick={() => nudge(1)}>→</button>
                    <button type="button" aria-label="Tilt the line anticlockwise" onClick={() => nudge(0, -1)}>↺</button>
                    <button type="button" aria-label="Tilt the line clockwise" onClick={() => nudge(0, 1)}>↻</button>
                  </div>
                )}
                {line && <button type="button" className="btn sm ghost" onClick={() => { setLine(null); setFirst(null); }}>Clear line</button>}
              </div>
            </div>
          )}
          <div className="crease-out" aria-live="polite">
            {live ? (
              <><span className={`chip ${VERDICT_CLS[live.verdict]}`}>{VERDICT_TEXT[live.verdict]}</span> <span className="muted">{gap(live)}</span></>
            ) : line ? (
              <span className="faint">The line needs to cross the bowler's path (a crease seen side-on): mark it again.</span>
            ) : marking ? (
              <span className="faint">{first ? "Now tap a second point further along the same edge." : "No line yet."}</span>
            ) : null}
          </div>
          {marking ? (
            <div className="row" style={{ gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn sm ghost" onClick={() => { setMarking(false); setLine(saved ? { a: saved.line.a, b: saved.line.b } : null); setFirst(null); }}>Cancel</button>
              <button type="button" className="btn sm primary" disabled={!call || busy} onClick={save}>Save</button>
            </div>
          ) : (
            <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
              Checked on frame {saved!.frame}. <button type="button" className="link-btn" onClick={remove}>Remove</button>
            </p>
          )}
          <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
            The heel is placed from the ankle with body proportions (shoes vary by a couple of centimetres) and the frame matters: one frame early
            the foot hasn't landed yet. A practice check, not an umpire's decision.
          </p>
        </>
      )}
    </section>
  );
}
