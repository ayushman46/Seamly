import type { AnalysisResult, EventKey } from "../types";
import { EVENTS, EVENT_HEX, SERIES_INFO, measuredForView } from "../lib/constants";
import { fmt, realSec, unitLabel } from "../lib/format";
import { IChevronRight } from "./Icons";

const KEYS_SIDE = ["front_knee_2d", "elbow_flexion_2d", "trunk_angle_2d", "bowling_arm_elevation"];
const KEYS_REAR = ["trunk_angle_2d", "bowling_arm_elevation", "hip_shoulder_separation", "bowling_wrist_height_pct"];

export default function FrameCard({ result, frame, onOpen, onConfirm, busy }: {
  result: AnalysisResult; frame: number; onOpen: () => void; onConfirm: (k: EventKey, f: number) => void; busy: boolean;
}) {
  const t = Math.max(0, Math.min(result.frames.end - result.frames.start - 1, frame - result.frames.start));
  const rel = result.events.br ? realSec(result.frames.times[t] - result.events.br.time, result.options.slowmo_factor) : null;
  const keys = result.view.view === "side_on" ? KEYS_SIDE : KEYS_REAR;
  const atEvent = EVENTS.find((e) => result.events[e.key]?.frame === frame);
  // Foot contacts that were estimated (or are hard to see from this camera angle) can be confirmed on the frame
  // the foot really lands: offer it whenever the player is near one (~0.15 s), not only exactly on it.
  const near = Math.max(2, Math.round(0.15 * result.fps_real));   // 0.15 s of real time, in video frames
  const contact = EVENTS.filter((e) => e.key === "bfc" || e.key === "ffc").map((e) => ({ e, info: result.events[e.key] }))
    .filter(({ info }) => info && info.method !== "user"
      && (info.method === "timing_prior" || info.method === "constrained" || result.view.view !== "side_on")
      && Math.abs(info.frame - frame) <= near)
    .sort((a, b) => Math.abs(a.info!.frame - frame) - Math.abs(b.info!.frame - frame))[0];
  return (
    <div className="card card-pad">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <div role="heading" aria-level={2} className="card-title" style={{ margin: 0 }}>At this frame</div>
        <span className="chip mono">f {frame}</span>
        {rel !== null && Math.round(rel * 1000) !== 0 && <span className="chip mono">{`${rel > 0 ? "+" : "−"}${Math.abs(Math.round(rel * 1000))} ms vs release`}</span>}
        {atEvent && <span className="chip" style={{ borderColor: EVENT_HEX[atEvent.key], color: "#fff" }}><span className="dot" style={{ background: EVENT_HEX[atEvent.key] }} />{atEvent.label}</span>}
        {contact && (
          <button className="btn sm" disabled={busy} onClick={() => onConfirm(contact.e.key, frame)}
            title="Use this frame if the foot lands exactly here, so the stride timings are measured">
            {contact.info!.frame === frame ? `✓ Confirm ${contact.e.short} here` : `Set ${contact.e.short} here (estimate: f ${contact.info!.frame})`}
          </button>
        )}
        <div className="grow" />
        <button className="btn sm ghost" onClick={onOpen}>All values <IChevronRight size={13} /></button>
      </div>
      <div className="frame-mini">
        {keys.filter((k) => result.series[k]).map((k) => {
          const info = SERIES_INFO[k];
          const ok = measuredForView(k, info.plane, result.view.view);
          return (
            <div key={k} className="fm" style={{ opacity: ok ? 1 : 0.6 }} title={info.help + (ok ? "" : " (3D estimate for this camera view)")}>
              <div className="fm-v">{fmt(result.series[k][t], 0)}{info.unit === "deg" ? "°" : <small>{unitLabel(info.unit)}</small>}</div>
              <div className="fm-l">{info.label.replace(" (on video)", "")}{!ok && " · est."}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
