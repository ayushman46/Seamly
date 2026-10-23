import type { AnalysisResult, EventKey } from "../types";
import { useState } from "react";
import { EVENTS, EVENT_HEX, SERIES_INFO, measuredForView, physical } from "../lib/constants";
import { fmt, realSec, unitLabel } from "../lib/format";

const ORDER = ["bowling_arm_elevation", "elbow_flexion_2d", "elbow_flexion_bowling", "elbow_flexion_front", "front_knee_2d", "knee_front", "knee_back", "trunk_angle_2d", "trunk_lateral_flexion", "trunk_forward_flexion", "shoulder_alignment", "hip_alignment", "hip_shoulder_separation", "bowling_wrist_height_pct"];

export default function Inspector({ result, frame, onSetEvent, busy }: { result: AnalysisResult; frame: number; onSetEvent: (k: EventKey, f: number) => void; busy: boolean }) {
  const t = Math.max(0, Math.min(result.frames.end - result.frames.start - 1, frame - result.frames.start));
  const time = realSec(result.frames.times[t] - (result.events.br?.time ?? result.frames.times[0]), result.options.slowmo_factor);
  const conf = result.keypoints2d.conf[t];
  const meanConf = conf.slice(5).reduce((a, b) => a + b, 0) / 12;
  const [showEst, setShowEst] = useState(false);
  const keys = ORDER.filter((k) => result.series[k]);
  const measured = keys.filter((k) => measuredForView(k, SERIES_INFO[k].plane, result.view.view));
  const estimates = keys.filter((k) => !measured.includes(k));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap">
        <span className="chip">Frame {frame}</span>
        <span className="chip">{time >= 0 ? "+" : ""}{(time * 1000).toFixed(0)} ms from release</span>
        <span className="chip">Tracking confidence {Math.round(meanConf * 100)}%</span>
        <div className="grow" />
        <span className="faint" style={{ fontSize: 12 }}>Set this frame as:</span>
        {EVENTS.map((e) => (
          <button key={e.key} className="btn sm" disabled={busy} onClick={() => onSetEvent(e.key, frame)} style={{ borderColor: EVENT_HEX[e.key] }} title={e.help}>
            <span className="dot" style={{ background: EVENT_HEX[e.key] }} /> {e.short}
          </button>
        ))}
      </div>
      {(["bfc", "ffc"] as EventKey[]).some((k) => result.events[k]?.method === "timing_prior") && (
        <div className="notice warn">
          {(["bfc", "ffc"] as EventKey[]).filter((k) => result.events[k]?.method === "timing_prior").map((k) => EVENTS.find((e) => e.key === k)!.label).join(" and ")} could not be
          seen clearly and {"were"} placed from typical delivery timing. Step to the frame where the foot lands and press the matching button above for exact measurements.
        </div>
      )}
      <div className="inspector-grid">
        {measured.map((k) => <Cell key={k} k={k} result={result} t={t} estimate={false} />)}
      </div>
      {estimates.length > 0 && (
        <div>
          <button type="button" className="btn sm ghost" onClick={() => setShowEst((v) => !v)} aria-expanded={showEst}>
            {showEst ? "Hide" : "Show"} 3D estimates ({estimates.length})
          </button>
          <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
            From the 3D model — this camera view can't measure them reliably, so they aren't used in your results.
          </span>
          {showEst && (
            <div className="inspector-grid" style={{ marginTop: 10 }}>
              {estimates.map((k) => <Cell key={k} k={k} result={result} t={t} estimate />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ k, result, t, estimate }: { k: string; result: AnalysisResult; t: number; estimate: boolean }) {
  const info = SERIES_INFO[k];
  return (
    <div className="ins" style={{ opacity: estimate ? 0.62 : 1 }}>
      <div className="l">{info.label}</div>
      <div className="v">{estimate ? "≈ " : ""}{fmt(physical(k, result.series[k][t]), 1)}<span className="faint" style={{ fontSize: 13, marginLeft: 3 }}>{unitLabel(info.unit)}</span></div>
      <div className="faint" style={{ fontSize: 11.5 }}>{info.help}{estimate ? " · 3D estimate" : ""}</div>
    </div>
  );
}
