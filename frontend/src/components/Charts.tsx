import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "../types";
import { EVENTS, EVENT_HEX, SERIES_INFO, measuredForView, physical } from "../lib/constants";
import { fmt, unitLabel } from "../lib/format";

const DEFAULT = ["bowling_arm_elevation", "front_knee_2d", "trunk_angle_2d", "elbow_flexion_2d", "bowling_wrist_height_pct", "trunk_lateral_flexion", "knee_front",
  "trunk_forward_flexion", "hip_shoulder_separation", "shoulder_alignment", "elbow_flexion_bowling"];

export default function Charts({ result, frame, onSeek }: { result: AnalysisResult; frame: number; onSeek: (f: number) => void }) {
  // the elbow moves 25-80° between frames below ~90 fps: its curve would only join a few far-apart points
  const distinctFps = result.fps_real * (1 - (result.quality.repeated_frames ?? 0));
  const keys = DEFAULT.filter((k) => result.series[k] && (k !== "elbow_flexion_2d" || distinctFps >= 90));
  const measured = keys.filter((k) => measuredForView(k, (SERIES_INFO[k] ?? { plane: "any" }).plane, result.view.view));
  const estimates = keys.filter((k) => !measured.includes(k));
  const [showEst, setShowEst] = useState(false);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="charts-grid">
        {measured.map((k) => <Chart key={k} k={k} result={result} frame={frame} onSeek={onSeek} />)}
      </div>
      {estimates.length > 0 && (
        <div>
          <button type="button" className="btn sm ghost" onClick={() => setShowEst((v) => !v)} aria-expanded={showEst}>
            {showEst ? "Hide" : "Show"} 3D estimates ({estimates.length})
          </button>
          <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
            Angles this camera view can't measure reliably, from the 3D model. They aren't used in your results.
          </span>
          {showEst && (
            <div className="charts-grid" style={{ marginTop: 10 }}>
              {estimates.map((k) => <Chart key={k} k={k} result={result} frame={frame} onSeek={onSeek} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Chart({ k, result, frame, onSeek }: { k: string; result: AnalysisResult; frame: number; onSeek: (f: number) => void }) {
  const info = SERIES_INFO[k] ?? { label: k, unit: "", plane: "any", help: "" };
  const data = useMemo(() => result.series[k].map((v) => physical(k, v)), [result, k]);
  const svg = useRef<SVGSVGElement>(null);
  const f0 = result.frames.start;
  // drawn at the width it is shown at (a stretched viewBox squashed the labels sideways on phones)
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(el.clientWidth || 600))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 170, P = { l: 40, r: 10, t: 10, b: 22 };
  const reliable = measuredForView(k, info.plane, result.view.view);
  const { lo, hi, path } = useMemo(() => {
    const v = data.filter((x) => isFinite(x));
    let lo = Math.min(...v), hi = Math.max(...v);
    const pad = Math.max(2, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    // a straight knee can't pass 180° nor an elbow bend go below 0°: keep the axis labels possible too
    if (k.startsWith("knee_") || k === "front_knee_2d") hi = Math.min(hi, 180);
    if (k.startsWith("elbow_flexion")) lo = Math.max(lo, 0);
    if (hi - lo < 1) hi = lo + 1;
    const n = data.length;
    const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
    const y = (val: number) => P.t + (1 - (val - lo) / (hi - lo)) * (H - P.t - P.b);
    const path = data.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join("");
    return { lo, hi, path };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, k, W]);
  const n = data.length;
  const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
  const y = (val: number) => P.t + (1 - (val - lo) / (hi - lo)) * (H - P.t - P.b);
  const i = Math.max(0, Math.min(n - 1, frame - f0));
  const ticks = [lo, (lo + hi) / 2, hi];
  const click = (e: React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const idx = Math.round(((fx - P.l) / (W - P.l - P.r)) * (n - 1));
    onSeek(f0 + Math.max(0, Math.min(n - 1, idx)));
  };
  return (
    <div className="card chart-card" style={{ opacity: reliable ? 1 : 0.72 }}>
      <div className="chart-head">
        <div>
          <b>{info.label}</b>
          <div className="faint" style={{ fontSize: 11.5 }}>{info.help}{!reliable && " · 3D estimate for this camera view"}</div>
        </div>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{fmt(data[i], 1)}{unitLabel(info.unit)}</span>
      </div>
      <svg ref={svg} className="chart" viewBox={`0 0 ${W} ${H}`} onClick={click} role="img"
        aria-label={`${info.label} through the delivery, from ${fmt(Math.min(...data.filter(Number.isFinite)), 0)} to ${fmt(Math.max(...data.filter(Number.isFinite)), 0)}${unitLabel(info.unit)}; ${fmt(data[i], 1)}${unitLabel(info.unit)} at this frame`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#1f2a3d" strokeDasharray="3 4" />
            <text x={P.l - 6} y={y(t) + 4} fill="#6f7d94" fontSize="11" textAnchor="end">{fmt(t, 0)}</text>
          </g>
        ))}
        {(() => {
          // event labels a few frames apart would print on top of each other: lift every other close one
          // each label goes on the first of three rows with room for it (events 1-3 frames apart are common)
          const last = [-1e9, -1e9, -1e9];
          return EVENTS.filter((e) => result.events[e.key]).map((e) => ({ e, xi: x(result.events[e.key]!.frame - f0) }))
            .sort((a, b) => a.xi - b.xi).map(({ e, xi }) => {
              let row = last.findIndex((lx) => xi - lx >= 26);
              if (row < 0) row = last.indexOf(Math.min(...last));
              last[row] = xi;
              return (
                <g key={e.key}>
                  <line x1={xi} x2={xi} y1={P.t} y2={H - P.b} stroke={EVENT_HEX[e.key]} strokeWidth="1.5" opacity="0.8" />
                  <text x={xi} y={H - 6 - row * 11} fill={EVENT_HEX[e.key]} fontSize="10" fontWeight="700" textAnchor="middle">{e.short}</text>
                </g>
              );
            });
        })()}
        <path d={path} fill="none" stroke={reliable ? "#34d399" : "#8b9bb4"} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeDasharray={reliable ? undefined : "5 4"} />
        <line x1={x(i)} x2={x(i)} y1={P.t} y2={H - P.b} stroke="#fff" strokeWidth="1.2" />
        <circle cx={x(i)} cy={y(data[i])} r="4" fill="#fff" />
      </svg>
    </div>
  );
}
