import { useMemo, useRef } from "react";
import type { AnalysisResult } from "../types";
import { EVENTS, EVENT_HEX, SERIES_INFO, reliableForView } from "../lib/constants";
import { fmt, unitLabel } from "../lib/format";

const DEFAULT = ["bowling_arm_elevation", "trunk_lateral_flexion", "front_knee_2d", "knee_front", "trunk_forward_flexion", "hip_shoulder_separation", "shoulder_alignment", "elbow_flexion_bowling", "bowling_wrist_height_pct"];

export default function Charts({ result, frame, onSeek }: { result: AnalysisResult; frame: number; onSeek: (f: number) => void }) {
  const keys = DEFAULT.filter((k) => result.series[k]);
  return (
    <div className="charts-grid">
      {keys.map((k) => <Chart key={k} k={k} result={result} frame={frame} onSeek={onSeek} />)}
    </div>
  );
}

function Chart({ k, result, frame, onSeek }: { k: string; result: AnalysisResult; frame: number; onSeek: (f: number) => void }) {
  const info = SERIES_INFO[k] ?? { label: k, unit: "", plane: "any", help: "" };
  const data = result.series[k];
  const svg = useRef<SVGSVGElement>(null);
  const f0 = result.frames.start;
  const W = 600, H = 170, P = { l: 40, r: 10, t: 10, b: 22 };
  const reliable = reliableForView(info.plane, result.view.view);
  const { lo, hi, path } = useMemo(() => {
    const v = data.filter((x) => isFinite(x));
    let lo = Math.min(...v), hi = Math.max(...v);
    const pad = Math.max(2, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    const n = data.length;
    const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
    const y = (val: number) => P.t + (1 - (val - lo) / (hi - lo)) * (H - P.t - P.b);
    const path = data.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join("");
    return { lo, hi, path };
  }, [data]);
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
      <svg ref={svg} className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={click}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#1f2a3d" strokeDasharray="3 4" />
            <text x={P.l - 6} y={y(t) + 4} fill="#6f7d94" fontSize="11" textAnchor="end">{t.toFixed(0)}</text>
          </g>
        ))}
        {EVENTS.map((e) => {
          const ev = result.events[e.key];
          if (!ev) return null;
          const xi = x(ev.frame - f0);
          return (
            <g key={e.key}>
              <line x1={xi} x2={xi} y1={P.t} y2={H - P.b} stroke={EVENT_HEX[e.key]} strokeWidth="1.5" opacity="0.8" />
              <text x={xi} y={H - 6} fill={EVENT_HEX[e.key]} fontSize="10" fontWeight="700" textAnchor="middle">{e.short}</text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke={reliable ? "#34d399" : "#8b9bb4"} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeDasharray={reliable ? undefined : "5 4"} />
        <line x1={x(i)} x2={x(i)} y1={P.t} y2={H - P.b} stroke="#fff" strokeWidth="1.2" />
        <circle cx={x(i)} cy={y(data[i])} r="4" fill="#fff" />
      </svg>
    </div>
  );
}
