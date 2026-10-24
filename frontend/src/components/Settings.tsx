import { useEffect, useState } from "react";
import type { AnalysisResult, Player } from "../types";
import { api } from "../api";
import { SLOWMO_OPTIONS, VIEW_LABEL } from "../lib/constants";
import { fmt } from "../lib/format";

export default function Settings({ result, busy, onRecompute, onRerun, playerId, onAssign }: {
  id: string; result: AnalysisResult; busy: boolean; playerId: string | null; onAssign: (pid: string | null) => Promise<void>;
  onRecompute: (body: { bowling_arm?: string; height_m?: number; view?: string }, msg: string) => Promise<unknown>;
  onRerun: (body: { candidate?: number; slowmo_factor?: number }) => Promise<void>;
}) {
  const [players, setPlayers] = useState<Player[]>([]);
  useEffect(() => { api.players().then(setPlayers).catch(() => undefined); }, []);
  const stature = Math.round(result.skeleton.stature_m * 100);
  const entered = result.skeleton.height_source === "user";
  // an assumed height is shown as a hint, not as if someone had typed it
  const [height, setHeight] = useState(entered ? String(stature) : "");
  useEffect(() => setHeight(entered ? String(stature) : ""), [stature, entered]);   // follow resets / re-analyses
  const sel = result.bowler;
  return (
    <div className="settings-grid">
      <div className="stack">
        <div role="heading" aria-level={3} className="card-title">Corrections</div>
        <div className="field">
          <label htmlFor="set-player">Player (groups this delivery into their progress)</label>
          <select id="set-player" className="input" style={{ width: 260, maxWidth: "100%" }} value={playerId ?? ""} disabled={busy}
            onChange={(e) => onAssign(e.target.value || null)}>
            <option value="">No player</option>
            {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label id="set-arm">Bowling arm ({result.bowling_arm.source === "user" ? "set by you" : `detected: ${result.bowling_arm.arm}, ${armAgreement(result.bowling_arm)}`})</label>
          <div className="seg" role="group" aria-labelledby="set-arm">
            {["right", "left"].map((a) => (
              <button key={a} className={result.bowling_arm.arm === a ? "on" : ""} aria-pressed={result.bowling_arm.arm === a} disabled={busy} onClick={() => onRecompute({ bowling_arm: a }, `Bowling arm set to ${a}`)}>{a === "right" ? "Right-arm" : "Left-arm"}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label id="set-view">Camera view (detected: {VIEW_LABEL[result.view.view]})</label>
          <div className="seg" role="group" aria-labelledby="set-view">
            {(["side_on", "behind", "front_on"] as const).map((v) => (
              <button key={v} className={result.view.view === v ? "on" : ""} aria-pressed={result.view.view === v} disabled={busy} onClick={() => onRecompute({ view: v }, `View set to ${VIEW_LABEL[v]}`)}>{VIEW_LABEL[v]}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="set-speed">Slow-motion factor (re-analyses the video)</label>
          <select id="set-speed" className="input" style={{ width: 230, maxWidth: "100%" }} disabled={busy}
            value={String(Math.round(result.options.slowmo_factor || 1))}
            onChange={(e) => onRerun({ slowmo_factor: Number(e.target.value) })}>
            {SLOWMO_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="set-height">Height (cm) · {entered ? "entered" : `${stature} assumed`}</label>
          <div className="row">
            <input id="set-height" className="input" style={{ width: 120 }} inputMode="numeric" placeholder={entered ? undefined : `e.g. ${stature}`} value={height} onChange={(e) => setHeight(e.target.value.replace(/[^0-9]/g, ""))} />
            <button className="btn sm" disabled={busy || !height} onClick={() => {
              const h = Number(height);
              if (h >= 120 && h <= 230) onRecompute({ height_m: h / 100 }, `Height set to ${h} cm`);
            }}>Apply</button>
          </div>
        </div>
      </div>
      <div className="stack">
        <div role="heading" aria-level={3} className="card-title">Deliveries found in this video</div>
        {result.candidates.map((c, i) => {
          const isSel = c.track === sel.track && c.shot === sel.shot;
          return (
            <div key={`${c.shot}-${c.track}`} className={`row cand ${isSel ? "sel" : ""}`}>
              <div className="grow">
                <b>Delivery {i + 1}</b>{" "}
                <span className="faint" title={`Frames ${c.first}–${c.last}; bowling arm sweeps ${fmt(c.sweep?.sweep_deg)}° at up to ${fmt(c.sweep?.peak_speed_dps)}°/s`}>
                  · {fmt(c.first / result.video.fps, 1)}–{fmt(c.last / result.video.fps, 1)} s into the video
                </span>
              </div>
              {isSel ? <span className="chip good">Analysed</span> : <button className="btn sm" disabled={busy} onClick={() => onRerun({ candidate: i })}>Analyse this one</button>}
            </div>
          );
        })}
      </div>
      <div className="stack">
        <div role="heading" aria-level={3} className="card-title">Detection quality</div>
        <dl className="kv">
          <dt>Video</dt><dd>{result.video.width}×{result.video.height} · {fmt(result.video.fps, 1)} fps</dd>
          <dt>Scenes (shots) found</dt><dd>{result.video.shots.length}</dd>
          <dt>Frames analysed</dt><dd>{result.quality.frames_total}</dd>
          <dt>Frames with refined pose</dt><dd>{result.quality.frames_refined}</dd>
          <dt>Mean keypoint confidence</dt><dd>{Math.round(result.quality.mean_kp_conf * 100)}%</dd>
          <dt>Left/right swaps corrected</dt><dd>{result.quality.lr_swaps_fixed}</dd>
          {(result.quality.repeated_frames ?? 0) >= 0.05 && (
            <><dt>Repeated frames</dt><dd title="Frames identical to the previous one (frame-rate conversion or frame-repeat slow motion)">{Math.round((result.quality.repeated_frames ?? 0) * 100)}%</dd></>
          )}
          <dt>3D model</dt><dd>{result.pose3d === "sam3d" ? "SAM 3D Body (image-based)" : "MotionBERT (2D-to-3D lifter)"}</dd>
          <dt title="How far the fitted 3D body lands from the joints found on the video">3D fit error</dt><dd>{fmt(result.skeleton.reproj_err_px_median, 1)} px</dd>
          <dt>Body model</dt><dd>NAVER Anny ({result.mesh.vertices.toLocaleString()}-point mesh)</dd>
          <dt>Processing time</dt><dd>{fmt(result.timing_s)} s</dd>
        </dl>
      </div>
    </div>
  );
}

/** "3 of 4 cues agree" (falls back to a percentage when the individual cues aren't stored). */
function armAgreement(a: AnalysisResult["bowling_arm"] & { votes?: Record<string, number> }): string {
  const v = Object.values(a.votes ?? {});
  if (!v.length) return `${Math.round(a.confidence * 100)}% agreement`;
  const agree = v.filter((x) => (x > 0) === (a.arm === "right")).length;
  return `${agree} of ${v.length} cues agree`;
}
