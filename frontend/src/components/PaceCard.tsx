import { useEffect, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { paceFrom, rangeText, realSeconds, type PaceTarget } from "../lib/pace";
import type { Runup } from "../lib/runup";
import { fmt } from "../lib/format";
import { IBolt } from "./Icons";

// what the numbers mean against other bowlers (published values; see docs/RESEARCH.md)
export const PACE_BANDS = "Typical release speeds: under-15 and club bowlers about 100 km/h, state under-19s about 125, first-class seamers about 127, international quicks 140+, the fastest 150+.";
const RUNUP_NORM = "Elite men average 5.8 ± 0.6 m/s, juniors 5.8 ± 0.7; finger spinners about 2.5.";

/**
 * Pace from the same clip as the action: ball speed from the release frame and the frame the ball reaches the batter
 * (timed over the pitch, so no calibration), the run-up speed at back-foot contact, and the bowling arm's peak speed.
 */
export default function PaceCard({ id, result, meta, frame, onSeek, onMeta, flash }: {
  id: string; result: AnalysisResult; meta: AnalysisMeta; frame: number;
  onSeek: (f: number) => void; onMeta: (m: AnalysisMeta) => void; flash: (text: string, error?: boolean) => void;
}) {
  const [runup, setRunup] = useState<Runup | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.runup(id).then((r) => live && setRunup(r)).catch(() => live && setRunup(null));
    return () => { live = false; };
  }, [id, result]);

  const br = result.events.br?.frame ?? result.frames.start;
  const [measuring, setMeasuring] = useState(false);
  const [release, setRelease] = useState(br);
  const [target, setTarget] = useState<PaceTarget>("crease");
  const [bounced, setBounced] = useState(true);
  const [pitch, setPitch] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = meta.pace ?? null;
  const preview = measuring && frame > release && (pitch === null || frame > pitch)
    ? paceFrom(result, { release, arrival: frame, target, bounced, pitch }) : null;
  const coarse = result.fps_real < 50;
  // the analysed part of the clip can end before the ball reaches the batter (0.45–0.7 s after release)
  const room = realSeconds(result, release, result.frames.end - 1) ?? 0;
  const sel = result.candidates.find((c) => c.track === result.bowler.track && c.shot === result.bowler.shot) ?? result.candidates[0];
  // the arm's turning speed is only true to life when its circle faces the camera (side-on, square), and at 50 fps or
  // more: slower footage averages the peak over a tenth of a second and reads low
  const armDps = result.view.view === "side_on" && !result.view.oblique && result.fps_real >= 50
    ? (sel as unknown as { sweep?: { peak_speed_dps?: number } } | undefined)?.sweep?.peak_speed_dps ?? null : null;

  // the technique factors most linked to ball speed that this clip measured (Keily 2021: front-foot contact to release
  // r = -0.60; Ramachandran 2021: front knee at release r = 0.40)
  const factor = (key: string) => result.metrics.find((m) => m.key === key && m.value !== null && m.reliability === "measured" && m.rating !== "unrated") ?? null;
  const ffcBr = factor("ffc_to_br_ms"), kneeBr = factor("front_knee_br");

  // a ball between 100 and 150 km/h reaches the batter 0.45–0.7 s after release: start the search just before that
  const ahead = (from: number, sec: number) => {
    for (let f = from + 1; f < result.frames.end; f++) if ((realSeconds(result, from, f) ?? 0) >= sec) return f;
    return result.frames.end - 1;
  };
  const start = () => { setRelease(br); setPitch(null); setMeasuring(true); onSeek(br); };
  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      onMeta(await api.patch(id, { pace: { release, arrival: frame, target, bounced: bounced || pitch !== null, pitch, kmh: preview.kmh, lo: preview.lo, hi: preview.hi } }));
      setMeasuring(false);
      flash(`Ball speed saved: about ${Math.round(preview.kmh)} km/h`);
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try { onMeta(await api.patch(id, { pace: null })); } catch (e) { flash((e as Error).message, true); }
  };

  return (
    <section className="card card-pad pace-card" aria-labelledby="pace-title">
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <div role="heading" aria-level={2} id="pace-title" className="card-title grow" style={{ margin: 0 }}><IBolt size={14} /> Pace</div>
        {saved && !measuring && <button type="button" className="btn ghost sm" onClick={start}>Measure again</button>}
      </div>

      {saved && !measuring ? (
        <div className="pace-main">
          <div className="pace-big">{Math.round(saved.kmh)}<small> km/h</small></div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            Estimated release speed, {Math.round(saved.lo)}–{Math.round(saved.hi)} km/h · timed from frame {saved.release} to {saved.arrival}{" "}
            (ball reaching the batter's {saved.target}{saved.pitch != null ? `, pitching at frame ${saved.pitch}` : saved.bounced ? ", after pitching" : ""}).{" "}
            <button type="button" className="link-btn" onClick={remove}>Remove</button>
          </div>
        </div>
      ) : !measuring ? (
        <div>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Ball speed from this clip, timed over the pitch: it needs the ball reaching the batter in view (film from behind the
            bowler's stumps; slow motion makes it far more precise).
          </p>
          <button type="button" className="btn sm primary" onClick={start}>Measure ball speed</button>
        </div>
      ) : (
        <div className="pace-steps">
          <ol>
            <li>
              <b>Release</b>: frame {release}{release === br ? " (found automatically)" : ""}{" "}
              <span className="seg" role="group" aria-label="Move the release frame" style={{ marginLeft: 4, verticalAlign: "middle" }}>
                <button type="button" aria-label="Release one frame earlier" onClick={() => setRelease((f) => Math.max(result.frames.start, f - 1))}>−1</button>
                <button type="button" aria-label="Release one frame later" onClick={() => {
                  const f = Math.min(result.frames.end - 1, release + 1);
                  setRelease(f);
                  if (pitch !== null && pitch <= f) setPitch(null);   // a pitch can't come before the release
                }}>+1</button>
              </span>
            </li>
            <li>
              <b>Pitch</b> <span className="faint">(optional, narrows the range)</span>:{" "}
              {pitch !== null ? (
                <>frame {pitch} <button type="button" className="link-btn" onClick={() => setPitch(null)}>Clear</button></>
              ) : (
                <>step to the frame the ball lands, then{" "}
                  <button type="button" className="btn sm" disabled={frame <= release} onClick={() => setPitch(frame)}>Pitched here</button></>
              )}
            </li>
            <li>
              <b>Arrival</b>: step on to the frame where the ball reaches the batter's
              <span className="seg" role="group" aria-label="Where the ball is timed to" style={{ margin: "0 6px", verticalAlign: "middle" }}>
                {(["crease", "stumps"] as const).map((t) => (
                  <button key={t} type="button" className={target === t ? "on" : ""} aria-pressed={target === t} onClick={() => setTarget(t)}>
                    {t === "crease" ? "crease" : "stumps"}
                  </button>
                ))}
              </span>
              {frame < ahead(release, 0.4) && (
                <button type="button" className="btn sm ghost" style={{ marginLeft: 2 }} onClick={() => onSeek(ahead(release, 0.4))}>Skip to 0.4 s after release</button>
              )}
              {pitch === null && (
                <label className="pick" style={{ display: "inline-flex", paddingLeft: 0, marginTop: 6 }}>
                  <input type="checkbox" checked={bounced} onChange={(e) => setBounced(e.target.checked)} /> It pitched on the way (frame not marked)
                </label>
              )}
            </li>
          </ol>
          <div className="pace-preview" aria-live="polite">
            {preview
              ? <><span className="pace-big sm">{Math.round(preview.kmh)}<small> km/h</small></span> <span className="faint">({rangeText(preview)}) at frame {frame}</span></>
              : <span className="faint">{frame <= release ? "Step forward from the release: → one frame, Shift+→ five, or the timeline."
                : pitch !== null && frame <= pitch ? "Now step on to where the ball reaches the batter."
                : "That's too long or too short for a bowled ball: check the frames."}</span>}
          </div>
          {room < 0.42 && (
            <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>
              The analysed part of this clip ends {room.toFixed(2)} s after the release, before most balls reach the batter (0.45–0.7 s), so
              the arrival frame may not be in it.
            </p>
          )}
          {coarse && (
            <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>
              At {fmt(result.fps_real, 0)} fps each frame is {Math.round(1000 / result.fps_real)} ms, so this is a rough guide: 120 fps or more is
              several times tighter.
            </p>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn sm primary" disabled={!preview || busy} onClick={save}>Save this speed</button>
            <button type="button" className="btn sm ghost" onClick={() => setMeasuring(false)}>Cancel</button>
          </div>
        </div>
      )}

      <dl className="pace-facts">
        <div>
          <dt>Run-up</dt>
          <dd>
            {runup === undefined ? "…" : runup ? (
              <><b>{fmt(runup.kmh, 0)} km/h</b> ({fmt(runup.ms, 1)} m/s) at back-foot contact{runup.estimated ? " (contact frame estimated)" : ""}. <span className="faint">{RUNUP_NORM}</span></>
            ) : <span className="faint">Needs a side-on clip showing the last strides of the run-up.</span>}
          </dd>
        </div>
        {ffcBr && (
          <div><dt>Landing to release</dt><dd><b>{fmt(ffcBr.value, 0)} ms</b>. <span className="faint">Elite men about 103 ms; the quicker this is, the faster the ball tends to be.</span></dd></div>
        )}
        {kneeBr && (
          <div><dt>Front knee</dt><dd><b>{fmt(kneeBr.value, 0)}°</b> at release. <span className="faint">A straighter front knee goes with faster balls.</span></dd></div>
        )}
        {armDps !== null && armDps > 0 && (
          <div><dt>Bowling arm</dt><dd><b>{fmt(armDps, 0)}°/s</b> at its fastest.</dd></div>
        )}
      </dl>
      <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>{PACE_BANDS} An estimate from the video, not a radar reading.</p>
    </section>
  );
}
