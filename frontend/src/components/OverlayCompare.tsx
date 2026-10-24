import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult, EventKey } from "../types";
import { COCO_EDGES, EVENTS } from "../lib/constants";
import { IPause, IPlay } from "./Icons";

const W = 640, H = 500, AX = W / 2, AY = 290, TORSO = 100;
const COL = { a: "#d4d4d8", b: "#38bdf8" };

type Pt = [number, number] | null;
const mid = (p: [number, number], q: [number, number]): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

/** Median torso length (mid-shoulder to mid-hip) in video pixels: the body-size unit both skeletons are scaled to. */
export function torsoPx(r: AnalysisResult): number {
  const { xy, conf } = r.keypoints2d;
  const d: number[] = [];
  xy.forEach((p, t) => {
    if ([5, 6, 11, 12].every((j) => (conf[t]?.[j] ?? 0) > 0.3)) {
      const s = mid(p[5], p[6]), h = mid(p[11], p[12]);
      d.push(Math.hypot(s[0] - h[0], s[1] - h[1]));
    }
  });
  d.sort((x, y) => x - y);
  return d.length ? d[Math.floor(d.length / 2)] : 1;
}

/** Side-on clips are mirrored so both bowlers run left to right; other views stay as filmed. */
export function mirrored(r: AnalysisResult): boolean {
  if (r.view.view !== "side_on") return false;
  const { xy } = r.keypoints2d, f0 = r.frames.start;
  const at = (f: number) => { const p = xy[Math.max(0, Math.min(xy.length - 1, f - f0))]; return mid(p[11], p[12])[0]; };
  const a = r.events.bfc?.frame ?? f0, b = r.events.ft?.frame ?? r.frames.end - 1;
  return at(b) < at(a);
}

/** The frame at phase s (0 = first shared event, 1 = the next, ...), interpolated between the clip's own events. */
export function frameAt(r: AnalysisResult, keys: EventKey[], s: number): number {
  if (keys.length === 1) return r.events[keys[0]]!.frame;
  const i = Math.min(keys.length - 2, Math.max(0, Math.floor(s)));
  const t = Math.min(1, Math.max(0, s - i));
  const a = r.events[keys[i]]!.frame, b = r.events[keys[i + 1]]!.frame;
  return Math.round(a + (b - a) * t);
}

function pose(r: AnalysisResult, frame: number, flip: boolean, scale: number): Pt[] {
  const t = Math.max(0, Math.min(r.keypoints2d.xy.length - 1, frame - r.frames.start));
  const xy = r.keypoints2d.xy[t], cf = r.keypoints2d.conf[t];
  const h = mid(xy[11], xy[12]);
  return xy.map((p, j) => ((cf[j] ?? 0) < 0.25 ? null : [AX + (flip ? -1 : 1) * (p[0] - h[0]) * scale, AY + (p[1] - h[1]) * scale]));
}

function Skeleton({ pts, color, arm, dashed }: { pts: Pt[]; color: string; arm: "left" | "right"; dashed?: boolean }) {
  const bowl = arm === "right" ? new Set([6, 8, 10]) : new Set([5, 7, 9]);
  return (
    <g stroke={color} strokeLinecap="round" fill={color}>
      {COCO_EDGES.map(([i, j]) => {
        const p = pts[i], q = pts[j];
        if (!p || !q) return null;
        const arm = bowl.has(i) && bowl.has(j);
        return <line key={`${i}-${j}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} strokeWidth={arm ? 6 : 4} strokeDasharray={dashed ? "1 9" : undefined} opacity={dashed ? 0.95 : 1} />;
      })}
      {pts.map((p, j) => (p && j >= 5 ? <circle key={j} cx={p[0]} cy={p[1]} r={dashed ? 3 : 4} stroke="none" /> : null))}
      {pts[0] && <circle cx={pts[0][0]} cy={pts[0][1]} r={13} fill="none" strokeWidth={3} strokeDasharray={dashed ? "1 7" : undefined} />}
    </g>
  );
}

/**
 * Two deliveries drawn on top of each other: aligned at the hips, scaled to the same body size, both running the same
 * way, and matched phase by phase (each clip's own back-foot contact, front-foot contact, ... line up), so differences
 * in shape show directly.
 */
export default function OverlayCompare({ a, b, ev, onEvent }: { a: AnalysisResult; b: AnalysisResult; ev: EventKey; onEvent: (k: EventKey) => void }) {
  // key moments both clips have, in the order they happen in both (UAH can come before FFC in a clip)
  const keys = useMemo(() => {
    const out: EventKey[] = [];
    for (const k of EVENTS.map((e) => e.key)) {
      const fa = a.events[k]?.frame, fb = b.events[k]?.frame;
      if (fa === undefined || fb === undefined) continue;
      const prev = out[out.length - 1];
      if (prev && (fa <= a.events[prev]!.frame || fb <= b.events[prev]!.frame)) continue;
      out.push(k);
    }
    return out;
  }, [a, b]);
  const [s, setS] = useState(() => Math.max(0, keys.indexOf(ev)));
  const [playing, setPlaying] = useState(false);
  const fromChip = useRef(false);
  // an event chosen above moves the overlay there (unless the change came from the slider itself)
  useEffect(() => {
    if (fromChip.current) { fromChip.current = false; return; }
    const i = keys.indexOf(ev);
    if (i >= 0) { setPlaying(false); setS(i); }
  }, [ev, keys]);
  const geo = useMemo(() => ({
    a: { flip: mirrored(a), scale: TORSO / torsoPx(a) },
    b: { flip: mirrored(b), scale: TORSO / torsoPx(b) },
  }), [a, b]);
  useEffect(() => {
    if (!playing || keys.length < 2) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setS((x) => (x + dt * 0.9 > keys.length - 1 ? 0 : x + dt * 0.9));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, keys.length]);

  if (keys.length === 0) {
    return <div className="card card-pad faint">The two clips share no detected key moment to line up.</div>;
  }
  const fa = frameAt(a, keys, s), fb = frameAt(b, keys, s);
  const pa = pose(a, fa, geo.a.flip, geo.a.scale), pb = pose(b, fb, geo.b.flip, geo.b.scale);
  const near = keys[Math.round(s)];
  const onKey = Math.abs(s - Math.round(s)) < 0.02;
  const label = EVENTS.find((e) => e.key === near)!;
  return (
    <div className="card overlay-cmp">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Both deliveries overlaid ${onKey ? `at ${label.label.toLowerCase()}` : `near ${label.label.toLowerCase()}`}: A in grey, B in blue`}>
        <line x1={0} x2={W} y1={AY} y2={AY} stroke="var(--c-line)" strokeDasharray="2 6" />
        <Skeleton pts={pa} color={COL.a} arm={a.bowling_arm.arm} dashed />
        <Skeleton pts={pb} color={COL.b} arm={b.bowling_arm.arm} />
        <text x={16} y={28} fill="var(--c-text-3)" fontSize={13}>{onKey ? label.label : `Near ${label.label.toLowerCase()}`} · A f{fa} · B f{fb}</text>
      </svg>
      <div className="overlay-ctrl">
        <button type="button" className="btn icon sm" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play through the action"}>
          {playing ? <IPause size={14} /> : <IPlay size={14} />}
        </button>
        <div className="overlay-track">
          <input type="range" min={0} max={Math.max(0, keys.length - 1)} step={0.01} value={s} disabled={keys.length < 2} aria-label="Moment of the action"
            aria-valuetext={onKey ? label.label : `Between key moments, near ${label.label.toLowerCase()}`}
            onKeyDown={(e) => {
              // arrows step from one key moment to the next (with Shift: a small step between them)
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              e.preventDefault();
              setPlaying(false);
              const up = e.key === "ArrowRight" || e.key === "ArrowUp";
              const to = e.shiftKey ? Math.max(0, Math.min(keys.length - 1, s + (up ? 0.1 : -0.1)))
                : Math.max(0, Math.min(keys.length - 1, up ? Math.floor(s + 1e-6) + 1 : Math.ceil(s - 1e-6) - 1));
              setS(to);
              const r = Math.round(to);
              if (Math.abs(to - r) < 1e-6 && keys[r] !== ev) { fromChip.current = true; onEvent(keys[r]); }
            }}
            onChange={(e) => {
              setPlaying(false);
              const v = Number(e.target.value);
              const r = Math.round(v);
              const snapped = Math.abs(v - r) < 0.06 ? r : v;
              setS(snapped);
              if (snapped === r && keys[r] !== ev) { fromChip.current = true; onEvent(keys[r]); }
            }} />
          <div className="overlay-ticks" aria-hidden="true">
            {keys.map((k, i) => <span key={k} style={{ left: `${keys.length > 1 ? (i / (keys.length - 1)) * 100 : 0}%` }}>{EVENTS.find((e) => e.key === k)!.short}</span>)}
          </div>
        </div>
      </div>
      <div className="overlay-legend">
        <span><i style={{ borderColor: COL.a, borderStyle: "dotted" }} /> A · earlier</span>
        <span><i style={{ borderColor: COL.b }} /> B · later</span>
        <span className="faint">Lined up at the hips, scaled to body size, each key moment matched. Thicker line: bowling arm.</span>
      </div>
    </div>
  );
}
