import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisResult, EventKey } from "../types";
import { EVENTS, EVENT_HEX } from "../lib/constants";

interface Props {
  id: string;
  result: AnalysisResult;
  frame: number;
  onSeek: (f: number) => void;
  onSetEvent: (k: EventKey, f: number) => void;
  edited: EventKey[];
  busy?: boolean;   // an edit is being applied: flags can't be dragged until it lands
}

export default function Timeline({ id, result, frame, onSeek, onSetEvent, edited, busy }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const f0 = result.frames.start, f1 = result.frames.end;
  const n = Math.max(1, f1 - f0 - 1);
  const [drag, setDrag] = useState<{ key: EventKey; frame: number } | null>(null);
  const pct = (f: number) => ((f - f0) / n) * 100;

  // Events a few frames apart (FFC, UAH and release are often 1-4 frames apart) would draw their flags on top
  // of each other: lift a flag onto a second row when it would overlap the previous one.
  const [trackW, setTrackW] = useState(600);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || 600));
    ro.observe(el);
    setTrackW(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);
  const rows = useMemo(() => {
    const FLAG_PX = 38;
    const items = EVENTS.map((e) => ({ k: e.key, f: drag?.key === e.key ? drag.frame : result.events[e.key]?.frame }))
      .filter((x): x is { k: EventKey; f: number } => x.f !== undefined && x.f !== null)
      .sort((a, b) => a.f - b.f);
    const out: Partial<Record<EventKey, number>> = {};
    const last = [-Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const x = (pct(it.f) / 100) * trackW;
      let row = last.findIndex((lx) => x - lx >= FLAG_PX);
      if (row < 0) row = last.indexOf(Math.min(...last));   // no free row: the one with the most room
      out[it.k] = row;
      last[row] = x;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.events, drag, trackW, f0, n]);

  const frameAt = useCallback((clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(f0 + x * n);
  }, [f0, n]);

  const onTrackDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".tl-ev")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(frameAt(e.clientX));
  };
  const onTrackMove = (e: React.PointerEvent) => {
    if (drag) {
      const f = frameAt(e.clientX);
      setDrag({ ...drag, frame: f });
      onSeek(f);
    } else if (e.buttons === 1 && !(e.target as HTMLElement).closest(".tl-ev")) onSeek(frameAt(e.clientX));
  };
  const onUp = () => {
    if (drag) {
      const orig = result.events[drag.key]?.frame;
      if (orig !== drag.frame) onSetEvent(drag.key, drag.frame);
      setDrag(null);
    }
  };

  const ev = result.events;
  const phases: { a: EventKey; b: EventKey; color: string; label: string }[] = [
    { a: "bfc", b: "ffc", color: "#f59e0b", label: "Delivery stride" },
    { a: "ffc", b: "br", color: "#22c55e", label: "Front leg brace" },
    { a: "br", b: "ft", color: "#38bdf8", label: "Follow-through" },
  ];

  return (
    <div className="timeline">
      <div className="tl-track" style={{ marginTop: 6 + 17 * Math.max(0, ...Object.values(rows).map((r) => r ?? 0)) }} ref={track} onPointerDown={onTrackDown} onPointerMove={onTrackMove} onPointerUp={onUp} onPointerLeave={() => drag && onUp()}>
        <div className="tl-bar" />
        {phases.map((p) => ev[p.a] && ev[p.b] ? (
          <div key={p.label} className="tl-phase" title={p.label} style={{ left: `${pct(ev[p.a]!.frame)}%`, width: `${pct(ev[p.b]!.frame) - pct(ev[p.a]!.frame)}%`, background: p.color }} />
        ) : null)}
        <div className="tl-fill" style={{ width: `${pct(frame)}%`, opacity: 0.55 }} />
        {EVENTS.map((e) => {
          const info = ev[e.key];
          if (!info) return null;
          const f = drag?.key === e.key ? drag.frame : info.frame;
          // from behind / in front a foot moving along the camera axis looks planted: contacts need a check
          const rearContact = result.view.view !== "side_on" && (e.key === "bfc" || e.key === "ffc") && info.method !== "user";
          const how = info.method === "user" ? "set by you"
            : info.method === "timing_prior" ? "estimated from typical timing (no clear foot-strike) — drag it to the exact frame"
            : info.method === "constrained" ? "moved next to your marker to keep the delivery order"
            : rearContact ? `auto (${Math.round(info.confidence * 100)}% confidence) — foot strikes are hard to see from this camera angle, check the frame`
            : `auto (${Math.round(info.confidence * 100)}% confidence)`;
          return (
            <div
              key={e.key}
              className={`tl-ev ${drag?.key === e.key ? "dragging" : ""} ${edited.includes(e.key) ? "edited" : ""}`}
              style={{ left: `${pct(f)}%`, top: -17 * (rows[e.key] ?? 0) }}
              title={`${e.label} · frame ${f} · ${how} — drag to adjust`}
              onPointerDown={(pe) => {
                pe.stopPropagation();
                onSeek(info.frame);
                if (busy) return;
                (track.current as HTMLElement).setPointerCapture(pe.pointerId);
                setDrag({ key: e.key, frame: info.frame });
              }}
            >
              <span className="flag" style={{ background: EVENT_HEX[e.key], opacity: info.confidence < 0.4 && info.method !== "user" ? 0.65 : 1 }}>{e.short}{info.method === "timing_prior" || info.method === "constrained" || rearContact ? "?" : ""}</span>
              <span className="stem" style={{ background: EVENT_HEX[e.key], height: 30 + 17 * (rows[e.key] ?? 0) }} />
            </div>
          );
        })}
        <div className="tl-head" style={{ left: `${pct(frame)}%` }} />
      </div>
      <div className="row faint tl-help">
        <span>Tap or drag to scrub · drag a flag to correct it<span className="tl-keys"> · keys <kbd>←</kbd> <kbd>→</kbd> (shift ×5), <kbd>space</kbd>, <kbd>1</kbd>–<kbd>5</kbd> jump to events</span></span>
        <span className="mono">{f0}–{f1 - 1}</span>
      </div>
      <div className="filmstrip">
        {EVENTS.map((e) => {
          const info = ev[e.key];
          return (
            <div key={e.key} className={`kino ${info && info.frame === frame ? "cur" : ""}`} onClick={() => info && onSeek(info.frame)} title={e.help}
              role="button" tabIndex={info ? 0 : -1} aria-label={info ? `Jump to ${e.label} (frame ${info.frame})` : `${e.label} not detected`}
              onKeyDown={(ke) => { if (info && (ke.key === "Enter" || ke.key === " ")) { ke.preventDefault(); ke.stopPropagation(); onSeek(info.frame); } }}>
              {info ? <Thumb id={id} result={result} f={info.frame} /> : <div className="faint" style={{ display: "grid", placeItems: "center", height: "100%", fontSize: 11, textAlign: "center", padding: 4 }}>not detected</div>}
              <div className="lbl">
                <span style={{ background: EVENT_HEX[e.key] }}>{e.short}</span>
                {info && <span className="mono" style={{ color: "#fff", textShadow: "0 1px 3px #000" }}>{info.frame}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ id, result, f }: { id: string; result: AnalysisResult; f: number }) {
  // crop the thumbnail around the bowler using the 2D keypoints
  const t = f - result.frames.start;
  const pts = result.keypoints2d.xy[t] || [];
  const W = result.video.width * result.display_scale, H = result.video.height * result.display_scale;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const h = Math.max(40, (Math.max(...ys) - Math.min(...ys)) * 1.35);
  const w = h * 0.8;
  const scale = 100 / w; // percent of the tile width
  const style: React.CSSProperties = {
    position: "absolute", width: `${W * scale}%`, height: "auto", maxWidth: "none",
    left: `${-(cx - w / 2) * scale}%`, top: `${(-(cy - h / 2) / h) * 100}%`,
  };
  void H;
  return <img src={api.frameUrl(id, f)} alt="" style={style} draggable={false} />;
}
