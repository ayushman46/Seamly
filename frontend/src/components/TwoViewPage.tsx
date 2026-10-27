import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult, EventKey } from "../types";
import { alignFrame, sinceRelease, type Camera, type FusedRow, type SharedContacts, type TwoView } from "../lib/twoview";
import { EVENTS } from "../lib/constants";
import { fmt, unitLabel } from "../lib/format";
import { usePageTitle } from "../lib/title";
import { lazyPage } from "../lib/lazy";
import ErrorBoundary from "./ErrorBoundary";
import Header from "./Header";
import FramePlayer from "./FramePlayer";
import { ScoreRing } from "./InsightsCard";
import ClipMaker from "./ClipMaker";
import { IAlert, IBack, ICheck, IInfo, INext, IPause, IPlay, IPrev } from "./Icons";

const Viewer3D = lazyPage(() => import("./Viewer3D"));

type Clip = { id: string; meta: AnalysisMeta; result: AnalysisResult; stored: AnalysisResult };
type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "pending"; metas: AnalysisMeta[] }
  | { status: "failed"; metas: AnalysisMeta[] }
  | { status: "missing"; metas: AnalysisMeta[] }
  | { status: "unpaired"; metas: AnalysisMeta[] }
  | { status: "views"; metas: AnalysisMeta[]; message: string }
  | { status: "ok"; side: Clip; rear: Clip; view: TwoView; carried: SharedContacts; fallback: boolean };

/** How each camera is named: the second one is behind the bowler or in front of them. */
const camName = (cam: Camera | "both", frontOn: boolean) => (cam === "side" ? "side-on" : cam === "rear" ? (frontOn ? "from in front" : "from behind") : "both cameras");
const RATING_CLS: Record<string, string> = { good: "good", watch: "watch", risk: "risk" };
const BACK_TXT = { ok: "No red flags", watch: "Worth watching", flag: "Talk to a coach", unknown: "Not measured" } as const;
const OVERLAY = { skeleton: true, angles: true, trail: false };
const KEY_EVENTS: EventKey[] = ["bfc", "ffc", "br", "ft"];

/**
 * Two cameras, one ball: the side-on clip and the clip from behind (or in front) of the same delivery, played in
 * step at real time from release, with one set of measurements taken from the camera that sees each, one score and the
 * complete back-health screen.
 */
export default function TwoViewPage({ a, b, go }: { a: string; b: string; go: (to: string) => void }) {
  const [data, setData] = useState<Loaded>({ status: "loading" });
  const [tick, setTick] = useState(0);
  usePageTitle("Two cameras");
  useEffect(() => {
    let live = true;
    api.twoView(a, b).then((d) => live && setData(d as Loaded)).catch((e) => live && setData({ status: "error", message: (e as Error).message }));
    return () => { live = false; };
  }, [a, b, tick]);
  // still analysing: check again every two seconds
  useEffect(() => {
    if (data.status !== "pending") return;
    const t = window.setTimeout(() => setTick((n) => n + 1), 2000);
    return () => window.clearTimeout(t);
  }, [data]);

  const unpair = async () => {
    try {
      await api.pair(a, null);
      setTick((n) => n + 1);   // the page now says they're unpaired, with a way to pair them again
    } catch (e) { setData({ status: "error", message: (e as Error).message }); }
  };
  const repair = async () => {
    try { await api.pair(a, b); setTick((n) => n + 1); } catch (e) { setData({ status: "error", message: (e as Error).message }); }
  };
  // a camera view read wrongly: set it here, then the page tries again
  const setView = async (id: string, view: "behind" | "front_on") => {
    setData({ status: "loading" });
    try { await api.recompute(id, { view }); } catch (e) { setData({ status: "error", message: (e as Error).message }); return; }
    setTick((n) => n + 1);
  };
  // focus goes to the page's heading once the results are in (they replace the waiting card)
  useEffect(() => {
    if (data.status !== "ok") return;
    const h = document.querySelector<HTMLElement>("main h1");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }, [data.status]);

  return (
    <>
      <Header go={go} />
      <main className="page two-page" id="main" tabIndex={-1}>
        <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => go("/")}><IBack size={15} /> Your analyses</button>
        {data.status === "loading" ? (
          <>
            <h1 className="an-title">Two cameras</h1>
            <div className="card card-pad row" style={{ gap: 10 }} aria-live="polite"><div className="spinner" /> Lining up the two cameras…</div>
          </>
        ) : data.status === "error" ? (
          <>
            <h1 className="an-title">Two cameras</h1>
            <div className="notice error" role="alert"><IAlert size={16} /> <div>{data.message}</div></div>
          </>
        ) : data.status === "pending" ? (
          <>
            <h1 className="an-title">Two cameras</h1>
            <div className="card card-pad">
              <p className="muted" style={{ marginTop: 0 }}>Both clips are analysed first, one after the other; this page fills in when they're done.</p>
              <p className="sr-only" role="status">{data.metas.filter((m) => m.status === "done").length} of {data.metas.length} clips analysed.</p>
              {data.metas.map((m) => (
                <div key={m.id} className="row" style={{ gap: 10, marginTop: 8 }}>
                  {m.status === "done" ? <ICheck size={15} /> : <div className="spinner sm" />}
                  <span className="grow">{m.name}</span>
                  <span className="faint" aria-hidden="true">{m.status === "done" ? "Done" : m.status === "queued" ? "Waiting" : `${Math.round((m.progress ?? 0) * 100)}%`}</span>
                </div>
              ))}
            </div>
          </>
        ) : data.status === "failed" || data.status === "missing" || data.status === "unpaired" ? (
          <>
            <h1 className="an-title">Two cameras</h1>
            <div className={`notice ${data.status === "unpaired" ? "" : "warn"}`} role="status">
              {data.status === "unpaired" ? <IInfo size={16} /> : <IAlert size={16} />}
              <div>{data.status === "failed"
                ? "One of the clips couldn't be analysed, so the two can't be put together. Open it for the reason, then analyse it again or pair another clip."
                : data.status === "missing"
                  ? "One of these clips isn't in this browser any more (it was deleted, or the backup it came from didn't include it). The other clip is unpaired."
                  : "These two clips aren't paired."}</div>
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              {data.status === "unpaired" && <button className="btn sm primary" onClick={repair}>Pair them</button>}
              {data.metas.map((m) => <button key={m.id} className="btn sm" onClick={() => go(`/a/${m.id}`)}>Open {m.name}{m.status === "failed" ? " (couldn't be analysed)" : ""}</button>)}
              {data.status === "failed" && <button className="btn sm ghost" onClick={unpair}>Unpair</button>}
            </div>
          </>
        ) : data.status === "views" ? (
          <>
            <h1 className="an-title">Two cameras</h1>
            <div className="notice warn" role="alert"><IAlert size={16} /> <div>{data.message}</div></div>
            <div className="card card-pad" style={{ marginTop: 12 }}>
              {data.metas.map((m) => {
                const read = !m.view ? "not read yet" : `${({ side_on: "side-on", behind: "behind the bowler", front_on: "in front of the bowler" } as const)[m.view]}${m.angled ? ", at an angle" : ""}`;
                const fixable = !(m.view === "side_on" && !m.angled) && data.metas.some((o) => o.id !== m.id && o.view === "side_on" && !o.angled);
                return (
                  <div key={m.id} className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
                    <span className="grow"><b>{m.name}</b> <span className="faint">· read as {read}</span></span>
                    {fixable && <>
                      <button className="btn sm primary" onClick={() => setView(m.id, "behind")}>It was filmed from behind</button>
                      <button className="btn sm" onClick={() => setView(m.id, "front_on")}>From in front</button>
                    </>}
                    <button className="btn sm ghost" onClick={() => go(`/a/${m.id}`)}>Open</button>
                  </div>
                );
              })}
              <button className="btn sm ghost" onClick={unpair}>Unpair</button>
            </div>
          </>
        ) : (
          <Ready d={data} go={go} unpair={unpair} />
        )}
      </main>
    </>
  );
}

/** What the same-ball check compared, in plain words: it guards against pairing two different balls. */
function sameText(same: TwoView["same"], frontOn: boolean): string {
  const rearCam = frontOn ? "the camera in front" : "the camera behind";
  const parts: string[] = [];
  const arm = same.checks.find((c) => c.label === "Bowling arm");
  if (arm) parts.push(arm.ok ? `Both cameras see a ${arm.a}-arm bowler` : `The side-on camera sees a ${arm.a}-arm bowler and ${rearCam} a ${arm.b}-arm one`);
  for (const c of same.checks.filter((x) => x.label !== "Bowling arm")) {
    const what = c.label.charAt(0).toLowerCase() + c.label.slice(1);
    parts.push(`${what} takes ${c.a} ms side-on and ${c.b} ms on ${rearCam}${c.ok ? ", which agrees" : ", which doesn't agree"}`);
  }
  let text = parts.join("; ") + ".";
  if (same.verdict === "unsure") {
    const missed = (cam: "side" | "rear") => same.unseen[cam].map((k) => (k === "bfc" ? "back" : "front")).join(" and ");
    const who = [same.unseen.side.length ? `the side-on camera didn't see the ${missed("side")} foot land` : "",
      same.unseen.rear.length ? `${rearCam} didn't see the ${missed("rear")} foot land` : ""].filter(Boolean).join(" and ");
    text += ` To be sure it's the same ball (not two balls of the same spell) Seamly compares the stride's timing, but ${who || "the contacts weren't seen by both"}.`;
  }
  return text;
}

function Ready({ d, go, unpair }: { d: Extract<Loaded, { status: "ok" }>; go: (to: string) => void; unpair: () => void }) {
  const { side, rear, view: tv, carried } = d;
  const s = side.result, r = rear.result;
  const sf0 = s.frames.start, sf1 = s.frames.end - 1;
  const [frame, setFrame] = useState(s.events.br?.frame ?? sf0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const aligned = useMemo(() => alignFrame(s, frame, r, tv.sync.offset), [s, r, frame, tv.sync.offset]);
  const evAt = (res: AnalysisResult, f: number) => EVENTS.find((e) => res.events[e.key]?.frame === f)?.label ?? "";

  // playback in real time (side-on clip's clock, scaled by speed); the other camera follows
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), acc = 0;
    const times = s.frames.times;
    const step = (now: number) => {
      acc += ((now - last) / 1000) * speed;
      last = now;
      let f = frameRef.current;
      while (true) {
        const i = f - sf0;
        const dt = i + 1 < times.length ? Math.max(1e-4, times[i + 1] - times[i]) : 1 / s.fps;
        if (acc < dt) break;
        acc -= dt;
        f = f >= sf1 ? sf0 : f + 1;
      }
      if (f !== frameRef.current) setFrame(f);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, s, sf0, sf1]);

  // keyboard: space plays and pauses, the arrows step a frame (shift: five), as on the analysis page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[aria-modal=true]")) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, select, textarea, [contenteditable], [role=menu]")) return;
      if (el?.closest?.("button, a") && (e.key === " " || e.key === "Enter")) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight" || e.key === "l") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.min(sf1, f + (e.shiftKey ? 5 : 1))); }
      else if (e.key === "ArrowLeft" || e.key === "j") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.max(sf0, f - (e.shiftKey ? 5 : 1))); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sf0, sf1]);

  const name = side.meta.name.replace(/ · ball \d+$/, "");
  const frontOn = r.view.view === "front_on";
  const rearLabel = frontOn ? "In front of the bowler" : "Behind the bowler";
  const same = tv.same;
  const top = tv.priorities[0];
  const groups: { title: string; cam: Camera | "both"; rows: FusedRow[] }[] = [
    { title: "From the side-on camera", cam: "side", rows: tv.rows.filter((x) => x.from === "side") },
    { title: frontOn ? "From the camera in front of the bowler" : "From the camera behind the bowler", cam: "rear", rows: tv.rows.filter((x) => x.from === "rear") },
    { title: "Measured by both cameras (averaged)", cam: "both", rows: tv.rows.filter((x) => x.from === "both") },
  ];
  const val = (m: { value: number | null; unit: string }) => (m.value === null ? "–" : `${fmt(m.value, 0)}${unitLabel(m.unit)}`);
  // both readings of a shared measurement: averaged when they agree, otherwise the one not used, for comparison
  const readings = (x: FusedRow) => {
    if (!x.other) return "";
    const sm = s.metrics.find((m) => m.key === x.key), rm = r.metrics.find((m) => m.key === x.key);
    if (x.from === "both" && sm && rm) return `side-on ${val(sm)}, ${camName("rear", frontOn)} ${val(rm)}`;
    const otherCam = x.from === "side" ? (frontOn ? "camera in front" : "camera behind") : "side-on camera";
    return x.unit === "ms"
      ? `the ${otherCam} read ${val(x.other)}; timings come from the camera with more frames a second`
      : `the ${otherCam} read ${val(x.other)}: too far apart to average, so the ${x.from === "rear" ? (frontOn ? "camera in front" : "camera behind") : "side-on camera"}, which measures this better, is used`;
  };
  const carriedText = (["bfc", "ffc"] as const).flatMap((k) => {
    const label = k === "bfc" ? "Back-foot contact" : "Front-foot contact";
    if (carried.side[k] !== undefined) return [`${label}: seen ${camName("rear", frontOn)}, carried to the side-on clip`];
    if (carried.rear[k] !== undefined) return [`${label}: seen side-on, carried to the clip ${camName("rear", frontOn)}`];
    return [];
  });

  return (
    <>
      <div className="an-head" style={{ marginBottom: 14 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 className="an-title">{name}: two cameras</h1>
          <div className="an-chips">
            <button type="button" className="chip accent" onClick={() => go(`/a/${side.id}`)}>Side-on · {fmt(s.fps_real)} fps ›</button>
            <button type="button" className="chip accent" onClick={() => go(`/a/${rear.id}`)}>{rearLabel} · {fmt(r.fps_real)} fps ›</button>
            <span className="chip">{s.bowling_arm.arm === "right" ? "Right-arm" : "Left-arm"}</span>
          </div>
        </div>
        <div className="an-actions">
          <ClipMaker meta={side.meta} result={s} ins={null} fileBase={`${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "delivery"}-two-cameras`}
            frame={frame} onFrame={(f) => { setPlaying(false); setFrame(f); }}
            players={() => [...document.querySelectorAll<HTMLCanvasElement>(".two-grid .player-stage canvas")]}
            labels={["Side-on", rearLabel]} facts={{ ...s, metrics: tv.rows.map((x) => x.metric) }}
            cueText={top?.drill.cue ?? null} title={`${name}: two cameras`} expect={(f) => [f, alignFrame(s, f, r, tv.sync.offset).frame]} />
          <button className="btn ghost sm" onClick={unpair}>Unpair</button>
        </div>
      </div>

      <div className={`notice ${same.verdict === "mismatch" ? "warn" : ""}`} style={{ marginBottom: 14 }} role={same.verdict === "mismatch" ? "alert" : undefined}>
        {same.verdict === "mismatch" ? <IAlert size={16} /> : same.verdict === "match" ? <ICheck size={16} /> : <IInfo size={16} />}
        <div>
          <b>{same.verdict === "match" ? "The same ball, as far as Seamly can tell." : same.verdict === "mismatch" ? "These may not be the same ball." : "Check these are the same ball."}</b>{" "}
          {sameText(same, frontOn)}
          {same.verdict === "mismatch" && " If it is the same ball, a key moment is off on one clip: check the release frame on each, and the camera view in Detection & settings. Until then the numbers below may mix two moments."}
          {tv.sync.score < 0.4 && ` The movement in the two clips doesn't line up well (${Math.round(Math.max(0, tv.sync.score) * 100)}% match): check both clips follow the same bowler through the same ball.`}
        </div>
      </div>

      <section className="card verdict" aria-labelledby="two-verdict">
        <ScoreRing score={tv.score} grade={tv.grade} />
        <div className="verdict-main">
          <h2 id="two-verdict" className="verdict-headline">{tv.summary.headline}</h2>
          {top && (
            <div className="verdict-fix">
              <div className="muted">{top.headline}</div>
              <div className="cue">“{top.drill.cue}”</div>
            </div>
          )}
          <p className="faint verdict-note" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
            One score over both cameras: {tv.rows.length} measurements, each from the camera that sees it{tv.score !== null ? "" : " (not enough rated ones for a score)"}.
          </p>
        </div>
      </section>

      <section className="card two-players" aria-label="Both cameras, in step">
        <div className="two-grid">
          <div>
            <div className="two-label">Side-on</div>
            <FramePlayer id={side.id} result={s} frame={frame} overlay={OVERLAY} selMetric={null} hud={evAt(s, frame)} camera="Side-on camera" />
          </div>
          <div className={aligned.inside ? "" : "two-outside"}>
            <div className="two-label">{rearLabel}{aligned.inside ? "" : " · outside this clip"}</div>
            <FramePlayer id={rear.id} result={r} frame={aligned.frame} overlay={OVERLAY} selMetric={null} hud={evAt(r, aligned.frame)} camera={`Camera ${frontOn ? "in front of" : "behind"} the bowler`} />
          </div>
        </div>
        <div className="controls">
          <div className="ctrl-group">
            <button className="btn icon play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>{playing ? <IPause size={16} /> : <IPlay size={16} />}</button>
            <button className="btn icon" onClick={() => { setPlaying(false); setFrame((f) => Math.max(sf0, f - 1)); }} aria-label="Previous frame"><IPrev size={17} /></button>
            <button className="btn icon" onClick={() => { setPlaying(false); setFrame((f) => Math.min(sf1, f + 1)); }} aria-label="Next frame"><INext size={17} /></button>
          </div>
          <div className="seg" role="group" aria-label="Playback speed">
            {[0.125, 0.25, 0.5, 1].map((v) => <button key={v} className={speed === v ? "on" : ""} aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v === 1 ? "1×" : `${v === 0.125 ? "⅛" : v === 0.25 ? "¼" : "½"}×`}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Jump to a key moment">
            {KEY_EVENTS.filter((k) => s.events[k]).map((k) => {
              const e = EVENTS.find((x) => x.key === k)!;
              const on = s.events[k]!.frame === frame;
              return <button key={k} title={e.label} aria-label={e.label} aria-pressed={on} className={on ? "on" : ""} onClick={() => { setPlaying(false); setFrame(s.events[k]!.frame); }}>{e.short}</button>;
            })}
          </div>
        </div>
        <input type="range" className="two-scrub" min={sf0} max={sf1} value={frame} aria-label="Frame"
          aria-valuetext={(() => { const t = sinceRelease(s, frame); const ev = evAt(s, frame); return `${ev ? `${ev}, ` : ""}${t === null ? `frame ${frame}` : t === 0 ? "release" : `${Math.abs(Math.round(t * 1000))} ms ${t < 0 ? "before" : "after"} release`}`; })()}
          onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)); }} />
        <p className="faint" style={{ fontSize: 12, margin: "6px 14px 12px" }}>
          <span className="sr-only">Space plays and pauses; the arrow keys step a frame. </span>
          {tv.sync.method === "motion"
            ? `Lined up by the movement in both clips (match ${Math.round(tv.sync.score * 100)}%), which put the releases ${Math.abs(Math.round(tv.sync.offset * 1000))} ms apart: one camera found its release a little ${tv.sync.offset < 0 ? "earlier" : "later"} than the other. They play in step at any frame rates.`
            : "Lined up at the release each camera found, in real time, so they play in step at any frame rates."}
        </p>
      </section>

      <div className="two-3d">
        <ErrorBoundary label="The 3D viewer">
          <Suspense fallback={<div className="card viewer"><div className="viewer-stage" style={{ display: "grid", placeItems: "center" }}><div className="spinner" /></div></div>}>
            <Viewer3D id={side.id} result={side.stored} frame={frame} playing={playing}
              onTogglePlay={() => setPlaying((p) => !p)} onSeek={(f) => { setPlaying(false); setFrame(f); }} />
          </Suspense>
        </ErrorBoundary>
        <p className="faint" style={{ fontSize: 12, margin: "6px 2px 0" }}>The 3D body from the side-on clip, in step with both videos: it shows the action; every number comes from the videos.</p>
      </div>

      <div className="two-cols">
        <section className="card card-pad" aria-labelledby="two-back">
          <div role="heading" aria-level={2} id="two-back" className="card-title">Back health: {tv.back ? `${tv.back.measured} of ${tv.back.total} checks` : "for pace bowlers"}</div>
          {tv.back ? (
            <>
              <div className="stack" style={{ gap: 10 }}>
                {tv.back.checks.map((c) => (
                  <div key={c.key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                    <span className={`dot ${c.status}`} style={{ marginTop: 6 }} aria-hidden="true" />
                    <div className="grow">
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</span>
                      <span className="faint"> · {BACK_TXT[c.status]}{c.value !== null ? `, ${fmt(c.value)}°` : ""}{tv.backFrom[c.key] ? ` · ${camName(tv.backFrom[c.key]!, frontOn)}` : ""}</span>
                      <div className="faint" style={{ fontSize: 12.5 }}>{c.text}</div>
                    </div>
                  </div>
                ))}
              </div>
              {tv.back.advice.map((x) => <p key={x} className="faint" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{x}</p>)}
              <p className="faint" style={{ fontSize: 11.5, margin: "8px 0 0" }}>A technique screen from two videos, not a medical assessment.</p>
            </>
          ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>The back-health screen is for pace bowlers; this player is a spinner.</p>}
        </section>

        <section className="card card-pad" aria-labelledby="two-fix">
          <div role="heading" aria-level={2} id="two-fix" className="card-title">What to work on</div>
          {tv.priorities.length ? (
            <ol className="two-fixes">
              {tv.priorities.map((p) => <li key={p.key}><b>{p.drill.title}</b><div className="muted" style={{ fontSize: 13 }}>{p.headline}</div><div className="cue" style={{ fontSize: 13 }}>“{p.drill.cue}”</div></li>)}
            </ol>
          ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing stands out to fix in what the two cameras measured.</p>}
          {tv.strengths.length > 0 && <p className="faint" style={{ fontSize: 12.5, marginBottom: 0 }}>Working well: {tv.strengths.join("; ")}.</p>}
        </section>
      </div>

      <section className="card card-pad" aria-labelledby="two-metrics" style={{ marginTop: 18 }}>
        <div role="heading" aria-level={2} id="two-metrics" className="card-title">Measurements</div>
        {groups.filter((g) => g.rows.length).map((g) => (
          <div key={g.cam} style={{ marginBottom: 14 }}>
            <div className="two-group">{g.title}</div>
            <table className="sq-table two-table">
              <tbody>
                {g.rows.map((x) => (
                  <tr key={x.key}>
                    <th scope="row">{x.label}{x.other && <div className="faint two-note">{readings(x)}</div>}</th>
                    <td><b>{val(x.metric)}</b></td>
                    <td><span className={`chip ${RATING_CLS[x.metric.rating] ?? ""}`}>{x.metric.rating === "info" ? "For reference" : x.metric.rating[0].toUpperCase() + x.metric.rating.slice(1)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {d.fallback && (
          <p className="faint" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            A foot contact one camera saw couldn't be used on the other clip (its key moments didn't allow it), so that clip's own contacts are used.
          </p>
        )}
        {carriedText.length > 0 && (
          <p className="faint" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            Foot contacts shared between the cameras: {carriedText.join("; ")}. Measurements at those moments use them.
          </p>
        )}
        <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Knees, trunk lean and stride are measured side-on; side-bend, hip–shoulder alignment and arm slot from behind; release
          height by both (averaged when they agree). Estimates from two videos, not a lab measurement.
        </p>
      </section>
    </>
  );
}
