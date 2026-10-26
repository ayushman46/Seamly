import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { FAST_KMH, paceFrom, rangeText, realSeconds, type Pace, type PaceTarget } from "../lib/pace";
import type { Runup } from "../lib/runup";
import { fmt } from "../lib/format";
import { IBolt, INext, IPrev } from "./Icons";

// what the numbers mean against other bowlers (published values; see docs/RESEARCH.md)
export const PACE_BANDS = "Typical release speeds: club and under-15 bowlers about 100 km/h, state under-19 and first-class seamers 125–128, international fast bowlers 140 and up, the fastest 150 and up.";
const RUNUP_NORM = "Elite men average 5.8 m/s, and a squad of state juniors ran in just as fast; finger spinners about 2.5.";
// no bowled ball reaches the batter sooner than this after release; a ball can't pitch sooner than this either
const EARLIEST_ARRIVAL_S = 0.35, EARLIEST_PITCH_S = 0.18;

/**
 * Pace from the same clip as the action: ball speed from three marks (the release, found by the analysis; where the
 * ball pitched, optional; where it reaches the batter), timed over the pitch so no calibration is needed, plus the
 * run-up speed and the technique factors most linked to ball speed. While measuring, a bar fixed under the screen
 * holds the frame controls and the marks, so the video and the result are in view together on a phone.
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

  const f0 = result.frames.start, fEnd = result.frames.end - 1;
  const br = result.events.br?.frame ?? f0;
  const sideOn = result.view.view === "side_on";
  const [measuring, setMeasuring] = useState(false);
  const [release, setRelease] = useState(br);
  const [pitch, setPitch] = useState<number | null>(null);
  const [arrival, setArrival] = useState<number | null>(null);
  const [target, setTarget] = useState<PaceTarget>("crease");
  const [bounced, setBounced] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<AnalysisMeta["pace"] | null>(null);   // for Undo
  const barRef = useRef<HTMLDivElement>(null);
  const saved = meta.pace ?? null;

  const since = (f: number) => realSeconds(result, release, f) ?? 0;
  const paceAt = (a: number | null) => a !== null && a > release && (pitch === null || pitch < a)
    ? paceFrom(result, { release, arrival: a, target, bounced: bounced || pitch !== null, pitch }) : null;
  const pace: Pace | null = paceAt(arrival);
  const tooSoon = arrival !== null && !pace && since(arrival) < 0.6;   // faster than any bowled ball
  // how much one frame either way moves the answer: the honest size of a marking slip at this frame rate
  const perFrame = (() => {
    if (!pace || arrival === null) return null;
    const a = paceAt(arrival - 1), b = paceAt(arrival + 1);
    const d = [a, b].filter((x): x is Pace => !!x).map((x) => Math.abs(x.kmh - pace.kmh));
    return d.length ? Math.max(...d) : null;
  })();
  const example = /^Example( clip)?:/.test(meta.name ?? "");
  const coarse = result.fps_real < 50;
  const room = since(fEnd);   // the analysed part of the clip can end before the ball arrives (0.45–0.7 s)
  const canPitch = since(frame) >= EARLIEST_PITCH_S && (arrival === null || frame < arrival);
  const canArrive = frame > release && (pitch === null || frame > pitch);
  const skipTo = (() => { for (let f = release + 1; f <= fEnd; f++) if (since(f) >= EARLIEST_ARRIVAL_S) return f; return null; })();

  // the technique factors most linked to ball speed that this clip measured (Keily 2021: front-foot contact to release
  // r = -0.60; Ramachandran 2021: front knee at release r = 0.40)
  const factor = (key: string) => result.metrics.find((m) => m.key === key && m.value !== null && m.reliability === "measured" && m.rating !== "unrated") ?? null;
  const ffcBr = factor("ffc_to_br_ms"), kneeBr = factor("front_knee_br");

  const start = () => {
    setRemoved(null);
    setRelease(br); setPitch(null); setArrival(null); setMeasuring(true); onSeek(br);
    document.querySelector(".card.player")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => barRef.current?.querySelector<HTMLElement>("[data-next]")?.focus({ preventScroll: true }), 60);
  };
  const stop = () => {
    setMeasuring(false);
    window.setTimeout(() => document.getElementById("pace-title")?.closest("section")?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }), 0);
  };
  // Esc leaves measuring; the page gets room at the bottom so the bar covers nothing
  useEffect(() => {
    if (!measuring) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc that closes a menu, a dialog or the enlarged 3D view is theirs, not a cancel
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog], .menu, .card.viewer.big") || (e.target as HTMLElement | null)?.closest?.("[role=menu]")) return;
      stop();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("pace-measuring");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("pace-measuring"); };
  }, [measuring]);   // eslint-disable-line react-hooks/exhaustive-deps

  const nudgeRelease = (d: number) => {
    const f = Math.max(f0, Math.min(fEnd - 1, release + d));
    setRelease(f);
    if (pitch !== null && pitch <= f) setPitch(null);       // marks can't come before the release
    if (arrival !== null && arrival <= f) setArrival(null);
    onSeek(f);
  };
  const save = async () => {
    if (!pace || arrival === null) return;
    setBusy(true);
    try {
      onMeta(await api.patch(id, { pace: { release, arrival, target, bounced: bounced || pitch !== null, pitch, kmh: pace.kmh, lo: pace.lo, hi: pace.hi } }));
      stop();
      flash(`Ball speed saved: about ${Math.round(pace.kmh)} km/h`);
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const was = saved;
    try { onMeta(await api.patch(id, { pace: null })); setRemoved(was); } catch (e) { flash((e as Error).message, true); }
  };
  const undo = async () => {
    if (!removed) return;
    try { onMeta(await api.patch(id, { pace: removed })); setRemoved(null); } catch (e) { flash((e as Error).message, true); }
  };
  const skip = () => {
    if (skipTo === null) return;
    onSeek(skipTo);
    barRef.current?.querySelector<HTMLElement>("[data-next]")?.focus({ preventScroll: true });   // the Skip button goes away
  };

  const readout = pace
    ? <>
        <span className="pace-big sm">{Math.round(pace.kmh)}<small> km/h</small></span> <span className="faint">est. {rangeText(pace)}</span>
        {perFrame !== null && perFrame >= 1 && <span className="faint"> · one frame either way ≈ ±{Math.round(perFrame)}</span>}
        {pace.kmh > FAST_KMH && <span className="pace-warn"> Faster than all but the quickest international bowlers: check the release and arrival frames.</span>}
      </>
    : <span className="faint">{arrival !== null
      ? (tooSoon ? "Faster than any ball ever bowled: check the arrival frame." : "Longer than a bowled ball takes: check the frames.")
      : frame <= release ? "Step forward from the release."
      : frame >= fEnd ? "Last frame of the analysed clip: if the ball hasn't reached the batter yet, this clip can't time it."
      : `+${Math.round(since(frame) * 1000)} ms: step on until the ball reaches the batter.`}</span>;

  const bar = measuring && createPortal(
    <div className="pace-bar" ref={barRef} role="region" aria-label="Ball speed marks">
      <div className="pace-bar-in">
        <div className="pace-bar-step">
          <button type="button" className="btn sm ghost icon" aria-label="Step back one frame" disabled={frame <= f0} onClick={() => onSeek(Math.max(f0, frame - 1))}><IPrev size={16} /></button>
          <span className="mono pace-bar-f">f {frame}{frame > release ? ` · +${Math.round(since(frame) * 1000)} ms` : ""}</span>
          <button type="button" className="btn sm ghost icon" data-next aria-label="Step forward one frame" disabled={frame >= fEnd} onClick={() => onSeek(Math.min(fEnd, frame + 1))}><INext size={16} /></button>
          {skipTo !== null && frame < skipTo && <button type="button" className="btn sm ghost" onClick={skip} title="No bowled ball reaches the batter sooner than this">Skip to +{Math.round(EARLIEST_ARRIVAL_S * 1000)} ms</button>}
        </div>
        <div className="pace-bar-marks">
          <button type="button" className={`btn sm ${pitch !== null ? "on" : ""}`} disabled={pitch === null && !canPitch} onClick={() => canPitch && setPitch(frame)}
            title={canPitch ? "Mark the frame where the ball lands (optional)" : arrival !== null && frame >= arrival ? "The ball pitches before it arrives: step back before the arrival" : "Too soon after the release for the ball to have pitched"}>
            {pitch !== null ? `Pitched: f ${pitch}` : "Pitched here"}
          </button>
          <button type="button" className={`btn sm ${arrival !== null ? "on" : "primary"}`} disabled={arrival === null && !canArrive} onClick={() => canArrive && setArrival(frame)}
            title={arrival !== null ? "Press again on another frame to move the arrival" : undefined}>
            {arrival !== null ? `Arrives: f ${arrival}` : "Arrives here"}
          </button>
        </div>
        <div className="pace-bar-out" aria-live="polite">{readout}</div>
        <div className="pace-bar-act">
          {arrival !== null && !example && <button type="button" className="btn sm primary" disabled={!pace || busy} onClick={save}>Save</button>}
          {arrival !== null && example && <span className="faint" style={{ fontSize: 12 }}>Examples aren't saved: the ball doesn't arrive in them.</span>}
          <button type="button" className="btn sm ghost" onClick={stop}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );

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
            Ball speed from this clip, timed over the pitch. It needs the ball reaching the batter in the picture: film from behind the
            bowler's stumps, in slow motion if you can.
            {example ? " The examples don't show the ball arriving, so any speed measured on them is only a demonstration." : sideOn && " Side-on clips rarely show it."}
            {room < 0.42 && ` This clip's analysed part ends ${room.toFixed(2)} s after the release, before most balls arrive.`}
          </p>
          <div className="row" style={{ gap: 10 }}>
            <button type="button" className="btn sm primary" onClick={start}>Measure ball speed</button>
            {removed && <span className="faint" style={{ fontSize: 12.5 }}>Ball speed removed. <button type="button" className="link-btn" onClick={undo}>Undo</button></span>}
          </div>
        </div>
      ) : (
        <div className="pace-steps">
          <ol>
            <li>
              <b>Release</b>: frame {release}{release === br ? " (found automatically)" : ""}{" "}
              <span className="seg" role="group" aria-label="Move the release frame" style={{ marginLeft: 4, verticalAlign: "middle" }}>
                <button type="button" aria-label="Release one frame earlier" onClick={() => nudgeRelease(-1)}>−1</button>
                <button type="button" aria-label="Release one frame later" onClick={() => nudgeRelease(1)}>+1</button>
              </span>
            </li>
            <li>
              <b>Pitch</b> <span className="faint">(optional, narrows the range)</span>:{" "}
              {pitch !== null
                ? <>frame {pitch} <button type="button" className="link-btn" onClick={() => setPitch(null)}>Clear</button></>
                : "step to the frame where the ball lands and press Pitched here."}
            </li>
            <li>
              <b>Arrival</b>:{" "}
              {arrival !== null
                ? <>frame {arrival} <button type="button" className="link-btn" onClick={() => setArrival(null)}>Clear</button></>
                : "step on to the frame where the ball reaches the batter's"}
              <span className="seg" role="group" aria-label="Where the ball is timed to" style={{ margin: "0 6px", verticalAlign: "middle" }}>
                {(["crease", "stumps"] as const).map((t) => (
                  <button key={t} type="button" className={target === t ? "on" : ""} aria-pressed={target === t} onClick={() => setTarget(t)}>
                    {t === "crease" ? "crease" : "stumps"}
                  </button>
                ))}
              </span>
              {arrival === null && "and press Arrives here."}
              {pitch === null && (
                <label className="pick" style={{ display: "flex", paddingLeft: 0, marginTop: 6 }}>
                  <input type="checkbox" checked={bounced} onChange={(e) => setBounced(e.target.checked)} />
                  The ball pitched before reaching the batter (the bounce slows it, which the estimate allows for)
                </label>
              )}
            </li>
          </ol>
          <div className="pace-preview">{readout}</div>
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
        </div>
      )}

      <dl className="pace-facts">
        <div>
          <dt>Run-up</dt>
          <dd>
            {runup === undefined ? "…" : runup ? (
              <><b>{fmt(runup.ms, 1)} m/s</b> ({fmt(runup.kmh, 0)} km/h) at back-foot contact{runup.estimated ? " (contact frame estimated)" : ""}. <span className="faint">{RUNUP_NORM}</span></>
            ) : <span className="faint">{sideOn ? "Needs the last strides of the run-up in the picture: here the bowler comes into view too late." : "Needs a side-on clip showing the last strides of the run-up."}</span>}
          </dd>
        </div>
        {ffcBr && (
          <div><dt>Front-foot contact to release</dt><dd><b>{fmt(ffcBr.value, 0)} ms</b>. <span className="faint">Elite men take about 103 ms; the quicker this is, the faster the ball tends to be.</span></dd></div>
        )}
        {kneeBr && (
          <div><dt>Front knee</dt><dd><b>{fmt(kneeBr.value, 0)}°</b> at release. <span className="faint">A straighter front knee goes with faster balls.</span></dd></div>
        )}
      </dl>
      <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>{PACE_BANDS} Ball speed here is an estimate from the video, not a radar reading.</p>
      {bar}
    </section>
  );
}
