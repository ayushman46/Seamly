import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyPage } from "../lib/lazy";
import { MODE, api } from "../api";
import type { AnalysisMeta, AnalysisResult, EventKey, Insights } from "../types";
import { EVENTS, SLOWMO_OPTIONS, VIEW_LABEL } from "../lib/constants";
import { fmt, realSec } from "../lib/format";
import Header from "./Header";
import FramePlayer from "./FramePlayer";
import Timeline from "./Timeline";
import CoachingPanel from "./CoachingPanel";
import MetricsPanel from "./MetricsPanel";
import Charts from "./Charts";
import Inspector from "./Inspector";
import Settings from "./Settings";
import ErrorBoundary from "./ErrorBoundary";
import FrameCard from "./FrameCard";
import PlanPanel from "./PlanPanel";
import { BackHealthCard, SummaryCard } from "./InsightsCard";
import { setCurrentPlayer } from "../lib/player";
import { IAlert, IBack, ICheck, IChevronDown, IClock, ICube, IDownload, IFile, IFilm, IInfo, ILock, INext, IPause, IPlay, IPrev, IRefresh, IVideo } from "./Icons";
import { SiteFooter } from "./Landing";

// three.js is large: the 3D viewer loads as its own chunk so the player and metrics appear first
const Viewer3D = lazyPage(() => import("./Viewer3D"));

const STAGES = [
  ["probe", "Reading your video", "Checking the frame rate and looking for camera cuts."],
  ["detect", "Finding everyone in the frame", "Spotting each person — bowler, batter, umpire — and following them frame to frame."],
  ["select", "Picking out the bowler", "Choosing the person whose arm sweeps over in a bowling action."],
  ["pose2d", "Tracking the bowler's joints", "Locating 17 body points on every frame of the delivery."],
  ["lift", "Rebuilding the action in 3D", "Estimating the depth of each joint from how the body moves."],
  ["events", "Finding the key moments", "Back-foot contact, front-foot contact, release and follow-through."],
  ["metrics", "Measuring angles & writing your coaching", "Comparing your angles and timings with published ranges."],
  ["mesh", "Fitting the 3D body model", "Shaping a full-body model to your movement for the 3D viewer."],
  ["save", MODE === "browser" ? "Saving to this browser" : "Saving results", MODE === "browser" ? "Storing the result on this device so you can come back to it." : "Storing the result so you can come back to it."],
] as const;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function PageMessage({ go, children }: { go: (to: string) => void; children: React.ReactNode }) {
  return (
    <>
      <Header go={go} />
      <main className="page narrow" id="main" tabIndex={-1}>{children}</main>
      <SiteFooter compact />
    </>
  );
}

export default function AnalysisPage({ id, go, initialTab }: { id: string; go: (to: string) => void; initialTab?: string }) {
  const [meta, setMeta] = useState<AnalysisMeta | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(id);
      setMeta(r.meta);
      if (r.result) setResult(r.result);
      return r.meta;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  const active = meta?.status === "queued" || meta?.status === "running";
  useEffect(() => {
    // initial load, then poll while the analysis is queued/running (also after a re-run is started)
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      const m = await load();
      if (stop) return;
      if (m && (m.status === "queued" || m.status === "running")) timer = window.setTimeout(tick, 900);
    };
    if (meta === null || active) tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, active]);

  if (error) {
    return (
      <PageMessage go={go}>
        <div className="card proc">
          <div className="notice error"><IAlert size={16} /> <div><b>Couldn't open this analysis.</b> {error}</div></div>
          <button className="btn" style={{ marginTop: 16 }} onClick={() => go("/")}><IBack size={16} /> Back to your analyses</button>
        </div>
      </PageMessage>
    );
  }
  if (!meta) {
    return (
      <>
        <Header go={go} />
        <main className="page" id="main" tabIndex={-1} aria-busy="true"><AnalysisSkeleton /></main>
      </>
    );
  }
  if (meta.status === "queued" || meta.status === "running") return <Processing meta={meta} go={go} />;
  if (meta.status === "failed") return <Failed meta={meta} go={go} onRetry={async (slowmo) => { await api.rerun(id, slowmo ? { slowmo_factor: slowmo } : {}); setResult(null); await load(); }} />;
  if (!result) return null;
  return <Dashboard id={id} meta={meta} result={result} setResult={setResult} setMeta={setMeta} go={go} reload={load}
    initialTab={initialTab === "plan" ? ("plan" as const) : undefined} />;
}

export function AnalysisSkeleton() {
  return (
    <div className="skel-page">
      <div className="skeleton-box" style={{ height: 64, maxWidth: 520 }} />
      <div className="skeleton-box" style={{ height: 150 }} />
      <div className="skel-grid">
        <div className="skeleton-box" style={{ aspectRatio: "16 / 10" }} />
        <div className="stack" style={{ gap: 18 }}>
          <div className="skeleton-box" style={{ height: 300 }} />
          <div className="skeleton-box" style={{ height: 120 }} />
        </div>
      </div>
    </div>
  );
}

function ProcRing({ value }: { value: number }) {
  const R = 33, C = 2 * Math.PI * R;
  return (
    <div className="proc-ring" aria-hidden="true">
      <svg width="78" height="78" viewBox="0 0 78 78">
        <circle cx="39" cy="39" r={R} stroke="var(--c-line-2)" strokeWidth="7" fill="none" />
        <circle cx="39" cy="39" r={R} stroke="var(--c-accent)" strokeWidth="7" fill="none" strokeLinecap="round"
          strokeDasharray={`${Math.max(0.01, C * value)} ${C}`} style={{ transition: "stroke-dasharray .4s" }} />
      </svg>
      <b>{Math.round(value * 100)}%</b>
    </div>
  );
}

function Processing({ meta, go }: { meta: AnalysisMeta; go: (to: string) => void }) {
  const cur = STAGES.findIndex(([k]) => k === meta.stage);
  const p = meta.progress || 0;
  const queued = meta.status === "queued";
  // the engine's live note for the current step: the one-time model download, or a pause while the tab is hidden
  const live = meta.stage_label && /^(Loading the analysis models|Paused)/.test(meta.stage_label) ? meta.stage_label : null;
  const paused = !!live && live.startsWith("Paused");
  const left = meta.elapsed && meta.progress && meta.progress > 0.15 && meta.progress < 0.99
    ? Math.max(5, Math.round((meta.elapsed * (1 - meta.progress)) / meta.progress / 5) * 5) : null;
  return (
    <>
      <Header go={go} title={meta.name} />
      <main className="page narrow" id="main" tabIndex={-1}>
        <div className="card proc">
          <div className="proc-head">
            <ProcRing value={p} />
            <div className="grow">
              <span className="eyebrow">{queued ? "Waiting to start" : MODE === "browser" ? "Analysing on this device" : "Analysing"}</span>
              <h1 className="proc-title">
                {queued
                  ? meta.queue_position ? `In the queue — ${meta.queue_position} ahead of you` : "Starting…"
                  : "Analysing your delivery"}
              </h1>
              <div className="proc-name" title={meta.name}>{meta.name}</div>
            </div>
          </div>
          <div className="progress lg" style={{ marginTop: 20 }} role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
            <i style={{ width: `${p * 100}%` }} />
          </div>
          <div className="proc-meta">
            {cur >= 0 && <span>Step {cur + 1} of {STAGES.length}</span>}
            {meta.elapsed ? <span><IClock size={14} /> {mmss(meta.elapsed)} elapsed</span> : null}
            {left !== null && <span>About {left < 60 ? `${left} s` : `${Math.round(left / 60)} min`} left</span>}
          </div>
          <div className="sr-only" aria-live="polite">{cur >= 0 ? `Step ${cur + 1} of ${STAGES.length}: ${STAGES[cur][1]}` : ""}</div>
          <ol className="stages">
            {STAGES.map(([k, label, detail], i) => {
              const state = cur < 0 ? "" : i < cur ? "done" : i === cur ? "on" : "";
              return (
                <li key={k} className={`stage ${state}`} aria-current={state === "on" ? "step" : undefined}>
                  <span className="ic">{state === "done" ? <ICheck size={13} /> : state === "on" ? <div className="spinner sm" /> : i + 1}</span>
                  <div>
                    <b>{label}</b>
                    {state === "on" && <small>{live && !paused ? live : detail}</small>}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="proc-foot">
            {paused && (
              <div className="notice warn" role="status"><IAlert size={16} /> <div><b>Paused.</b> Seamly only analyses while this tab is visible (browsers slow down or stop video decoding in background tabs). Come back to this tab and it carries on.</div></div>
            )}
            {MODE === "browser" ? (
              <div className="notice ok"><ILock size={16} /> <div><b>Your video isn't being uploaded.</b> Everything happens on this device, so keep this tab open until it finishes.</div></div>
            ) : (
              <div className="notice"><IInfo size={16} /> <div>You can leave this page — the analysis keeps running on your Seamly server and will appear in your history.</div></div>
            )}
            <p>
              {MODE === "browser"
                ? "A short clip of one delivery usually takes 15–40 seconds on a recent laptop; phones, older devices and long or high-speed (240 fps) clips take longer. The first analysis also downloads the analysis models (about 70 MB, once). The estimate above updates as it goes."
                : "A short clip of one delivery takes about 30–60 seconds; long or high-speed (240 fps) clips up to about two minutes."}
            </p>
          </div>
        </div>
      </main>
    </>
  );
}

function Failed({ meta, go, onRetry }: { meta: AnalysisMeta; go: (to: string) => void; onRetry: (slowmo?: number) => Promise<void> }) {
  const cur = Math.round(meta.options?.slowmo_factor || 1);
  const [slowmo, setSlowmo] = useState(String(meta.suggest?.slowmo_factor ?? cur));   // preselect the suggested fix
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // what went wrong decides what is worth offering: filming tips, a clip-speed retry, or just another clip
  const err = meta.error || "";
  const kind: "fps" | "file" | "detect" | "other" =
    meta.suggest || /frames per second|repeats|clip speed/i.test(err) ? "fps"
    : /decode|look like a video|too short|long; please trim|no decodable|no duration|couldn't open|took too long to load|no longer stored/i.test(err) ? "file"
    : /couldn't find a bowling delivery/i.test(err) ? "detect" : "other";
  const remove = async () => {
    if (!window.confirm("Delete this analysis?")) return;
    setBusy(true);
    try { await api.remove(meta.id); go("/"); }
    catch (e) { setRetryError((e as Error).message); setBusy(false); }
  };
  const retry = async () => {
    setBusy(true);
    setRetryError(null);
    try { await onRetry(Number(slowmo) !== cur ? Number(slowmo) : undefined); }
    catch (e) { setRetryError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Header go={go} title={meta.name} />
      <main className="page narrow" id="main" tabIndex={-1}>
        <div className="card proc">
          <div className="proc-head">
            <span className="empty-icon" style={{ width: 56, height: 56, borderRadius: 16, color: "var(--c-watch)" }}><IAlert size={26} /></span>
            <div className="grow">
              <span className="eyebrow brand">Analysis stopped</span>
              <h1 className="proc-title">We couldn't analyse this clip</h1>
              <div className="proc-name" title={meta.name}>{meta.name}</div>
            </div>
          </div>
          <div className="notice warn" style={{ marginTop: 20 }}><IAlert size={16} /> <div>{meta.error || "Unknown error"}</div></div>
          {kind === "detect" && (
            <ul className="fail-tips">
              <li>Make sure the bowler's whole body (including feet) is visible from run-up to follow-through.</li>
              <li>Film side-on or from behind the bowler; avoid heavy zoom and fast panning.</li>
              <li>Trim long videos to the delivery (under {MODE === "browser" ? "a minute" : "2 minutes"}).</li>
            </ul>
          )}
          <div className="row wrap" style={{ gap: 10, marginTop: 16 }}>
            <button className="btn" onClick={() => go("/")}><IBack size={16} /> Choose another clip</button>
            <button className="btn ghost" disabled={busy} onClick={remove}>Delete</button>
            <div className="grow" />
            {kind === "fps" && (
              <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <span className="label">Clip speed</span>
                <select className="input" style={{ width: 210 }} value={slowmo} onChange={(e) => setSlowmo(e.target.value)}>
                  {SLOWMO_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
                </select>
              </label>
            )}
            {kind !== "file" && (
              <button className="btn primary" disabled={busy} onClick={retry}>{busy ? <div className="spinner sm" /> : <IRefresh size={16} />} {Number(slowmo) !== cur ? "Retry at this clip speed" : "Retry"}</button>
            )}
          </div>
          {retryError && <div className="notice error" style={{ marginTop: 12 }}><IAlert size={16} /> <div>{retryError}</div></div>}
        </div>
      </main>
      <SiteFooter compact />
    </>
  );
}

type Tab = "coach" | "plan" | "metrics" | "charts" | "frame" | "settings";

/** Smooth-scroll to an element; jump if the browser ignores smooth scrolling (some do, e.g. with reduced motion). */
function scrollToEl(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => { if (Math.abs(el.getBoundingClientRect().top) > 60) el.scrollIntoView({ block: "start" }); }, 700);
}

function Dashboard({ id, meta, result, setResult, setMeta, go, reload, initialTab }: {
  id: string; meta: AnalysisMeta; result: AnalysisResult; setResult: (r: AnalysisResult) => void;
  setMeta: (m: AnalysisMeta) => void; go: (to: string) => void; reload: () => Promise<AnalysisMeta | null>;
  initialTab?: Tab;
}) {
  const f0 = result.frames.start;
  const f1 = result.frames.end;

  const [frame, setFrame] = useState(result.events.br?.frame ?? f0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const [loop, setLoop] = useState(true);
  const [tab, setTab] = useState<Tab>(initialTab ?? "coach");
  const tabsRef = useRef<HTMLDivElement>(null);
  // plain-language summary, back-health screen and practice plan (they follow every edit of the result)
  const [ins, setIns] = useState<Insights | null>(null);
  const [insErr, setInsErr] = useState<string | null>(null);
  const [insTry, setInsTry] = useState(0);
  useEffect(() => {
    let live = true;
    setInsErr(null);
    api.insights(id).then((x) => live && setIns(x)).catch((e) => { if (live) { setIns(null); setInsErr((e as Error).message); } });
    return () => { live = false; };
  }, [id, result, meta.player_id, insTry]);
  // opened from a link to the plan: scroll to it once the summary above it has loaded (it shifts the layout)
  const scrolled = useRef(false);
  useEffect(() => {
    if (!initialTab || !ins || scrolled.current) return;
    scrolled.current = true;
    const jump = () => tabsRef.current?.scrollIntoView({ block: "start" });
    window.setTimeout(jump, 150);
    // the lazily loaded 3D viewer can still shift the layout: correct once, unless the user has scrolled since
    window.setTimeout(() => {
      const top = tabsRef.current?.getBoundingClientRect().top ?? 0;
      if (Math.abs(top - 70) > 40 && window.scrollY > 100) jump();
    }, 900);
  }, [initialTab, ins]);
  // a plan link followed while this analysis is already open (back/forward, a pasted link) only changes the hash
  useEffect(() => {
    if (!initialTab) return;
    setTab(initialTab);
    if (scrolled.current) tabsRef.current?.scrollIntoView({ block: "start" });
  }, [initialTab]);
  const openPlan = () => {
    setTab("plan");
    scrollToEl(tabsRef.current);
  };
  // "Show me": go to the moment and bring the video into view (it can be far down the page, especially on a phone)
  const playerRef = useRef<HTMLDivElement>(null);
  const jumpTo = (k: EventKey) => {
    const e = result.events[k];
    if (!e) return;
    setPlaying(false);
    setFrame(e.frame);
    scrollToEl(playerRef.current);
  };
  const openSettings = () => {
    setTab("settings");
    scrollToEl(tabsRef.current);
  };
  const armLabel = result.bowling_arm.arm === "right" ? "Right-arm" : "Left-arm";
  const armUnsure = result.bowling_arm.source !== "user" && result.bowling_arm.confidence < 0.7;
  const fileBase = `seamly-${(meta.name || "delivery").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "delivery"}`;
  const videoName = `${fileBase}-original.mp4`;
  const uploadRetest = () => {
    if (ins?.player) setCurrentPlayer(ins.player.id);
    go("/");
  };
  const assignPlayer = async (pid: string | null) => {
    try {
      setMeta(await api.patch(id, { player_id: pid }));
      flash(pid ? "Added to the player's progress" : "Removed from the player");
    } catch (e) {
      flash((e as Error).message, true);
    }
  };
  const [selMetric, setSelMetric] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menu]);
  const [overlay, setOverlay] = useState({ skeleton: true, angles: true, trail: true });
  const [others, setOthers] = useState<AnalysisMeta[]>([]);
  useEffect(() => {
    api.list().then((l) => setOthers(l.filter((m) => m.status === "done" && m.id !== id))).catch(() => undefined);
  }, [id]);

  const flash = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // playback (uses the video's timestamps, scaled by speed). The frame is advanced here, outside React's
  // state updater, so StrictMode's double-invoked updaters can't double-step it.
  const playRef = useRef({ last: 0, acc: 0 });
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    playRef.current = { last: performance.now(), acc: 0 };
    const times = result.frames.times;
    const loopLo = loop ? (result.events.bfc?.frame ?? f0) - Math.round(result.fps * 0.35) : f0;
    const loopHi = loop ? (result.events.ft?.frame ?? f1 - 1) + Math.round(result.fps * 0.15) : f1 - 1;
    const lo = Math.max(f0, loopLo), hi = Math.min(f1 - 1, loopHi);
    const step = (now: number) => {
      const dt = (now - playRef.current.last) / 1000;
      playRef.current.last = now;
      playRef.current.acc += dt * speed;
      let f = frameRef.current;
      while (true) {
        const i = f - f0;
        const nextDt = i + 1 < times.length ? Math.max(1e-4, times[i + 1] - times[i]) : 1 / result.fps;
        if (playRef.current.acc < nextDt) break;
        playRef.current.acc -= nextDt;
        f += 1;
        if (f > hi) f = lo;
      }
      if (f < lo || f > hi) f = lo;
      if (f !== frameRef.current) { frameRef.current = f; setFrame(f); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, loop, result, f0, f1]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;            // browser / OS shortcuts
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, select, textarea, [contenteditable]")) return;
      if (el?.closest?.("button, a") && (e.key === " " || e.key === "Enter")) return;   // native activation
      if (e.key === " " || e.key === "k") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight" || e.key === "l") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.min(f1 - 1, f + (e.shiftKey ? 5 : 1))); }
      else if (e.key === "ArrowLeft" || e.key === "j") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.max(f0, f - (e.shiftKey ? 5 : 1))); }
      else {
        const idx = ["1", "2", "3", "4", "5"].indexOf(e.key);
        if (idx >= 0) {
          const ev = result.events[EVENTS[idx].key];
          if (ev) { setPlaying(false); setFrame(ev.frame); }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [f0, f1, result.events]);

  const recompute = useCallback(async (body: Parameters<typeof api.recompute>[1], message: string) => {
    setBusy(true);
    try {
      const r = await api.recompute(id, body);
      setResult(r.result);
      setMeta(r.meta);
      flash(message);
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }, [id, setResult, setMeta, flash]);

  const setEvent = useCallback((k: EventKey, fr: number) => recompute({ events: { [k]: fr } }, `${EVENTS.find((e) => e.key === k)!.label} set to frame ${fr} — metrics updated`), [recompute]);

  const resetEdits = async () => {
    setBusy(true);
    try {
      const r = await api.reset(id, true);
      setResult(r.result);
      setMeta(r.meta);
      flash("Event markers restored to automatic detection");
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const rerun = async (body: Parameters<typeof api.rerun>[1]) => {
    try {
      await api.rerun(id, body);
      await reload();
    } catch (e) {
      flash((e as Error).message, true);
    }
  };

  const ev = result.events;
  const i = frame - f0;
  const edited = result.events_edited || [];
  const cur = useMemo(() => {
    const near = EVENTS.filter((e) => ev[e.key] && Math.abs(ev[e.key]!.frame - frame) === 0);
    return near.map((e) => e.short).join(" · ");
  }, [ev, frame]);

  const created = new Date(meta.created * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const TABS: [Tab, string][] = [["coach", "Coaching"], ["plan", "Practice plan"], ["metrics", "Metrics"], ["charts", "Charts"], ["frame", `Frame ${frame}`], ["settings", "Detection & settings"]];

  return (
    <>
      <Header go={go} title={meta.name}>
        {busy && <span className="engine-status"><div className="spinner sm" /> <span className="hide-sm">Updating…</span></span>}
      </Header>
      <main className="page" id="main" tabIndex={-1}>
        <div className="an-head">
          <div className="an-head-main">
            <button type="button" className="back-link" onClick={() => go("/")}><IBack size={15} /> Your analyses</button>
            <h1 className="an-title">{meta.name}</h1>
            <div className="an-chips">
              {ins?.player && (
                <button type="button" className="chip accent" onClick={() => go(`/p/${ins.player!.id}`)} title="Open this player's progress">
                  {ins.player.name} ›
                </button>
              )}
              <span className="chip">{created}</span>
              <span className="chip">{VIEW_LABEL[result.view.view]}</span>
              {armUnsure ? (
                <button type="button" className="chip warn" onClick={openSettings}
                  title={`Detected from the video with ${Math.round(result.bowling_arm.confidence * 100)}% agreement between cues. Click to check or set it.`}>
                  {armLabel}?
                </button>
              ) : (
                <span className="chip" title={result.bowling_arm.source === "user" ? "Set by you" : "Detected from the video"}>{armLabel}</span>
              )}
              <span className="chip">{fmt(result.fps_real)} fps</span>
              <span className="chip" title={result.pose3d === "sam3d" ? "3D body from SAM 3D Body (image-based)" : "3D body from MotionBERT (2D-to-3D lifter); install SAM 3D Body for a more accurate 3D view"}>
                <ICube size={13} /> {result.pose3d === "sam3d" ? "SAM 3D Body" : "MotionBERT"}
              </span>
            </div>
          </div>
          <div className="an-actions">
            {others.length > 0 && (
              <select className="input" value="" onChange={(e) => e.target.value && go(`/compare/${id}/${e.target.value}`)} aria-label="Compare this delivery with another analysis" title="Compare this delivery with another analysis">
                <option value="">Compare with…</option>
                {others.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <button className="btn" onClick={() => go(`/r/${id}`)}><IFile size={15} /> Report</button>
            <div className="rel" ref={menuRef}>
              <button className="btn" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}><IDownload size={15} /> Export <IChevronDown size={14} /></button>
              {menu && (
                <div className="menu" role="menu">
                  <a role="menuitem" href={api.objUrl(id, frame)} download={`${fileBase}-frame-${frame}.obj`} onClick={() => setMenu(false)}><ICube size={15} /> 3D mesh of this frame (.obj)</a>
                  <a role="menuitem" href={api.exportUrl(id, "csv")} download={`${fileBase}-angles.csv`} onClick={() => setMenu(false)}><IFile size={15} /> Joint-angle time series (.csv)</a>
                  <a role="menuitem" href={api.exportUrl(id, "json")} download={`${fileBase}-analysis.json`} onClick={() => setMenu(false)}><IFile size={15} /> Full analysis (.json)</a>
                  <a role="menuitem" href={api.videoUrl(id)} download={videoName} onClick={() => setMenu(false)}><IVideo size={15} /> Original video</a>
                  <div className="menu-sep" />
                  <button role="menuitem" onClick={() => { setMenu(false); go(`/r/${id}`); }}><IFilm size={15} /> Coaching report (print / PDF)</button>
                </div>
              )}
            </div>
          </div>
        </div>
        {meta.notice && (
          <div className="notice warn" style={{ marginBottom: 14 }}>
            <IAlert size={16} /> <div>{meta.notice}</div>
          </div>
        )}
        {result.bowling_arm.source !== "user" && result.bowling_arm.confidence < 0.5 && (
          <div className="notice warn" style={{ marginBottom: 14 }}>
            <IAlert size={16} />
            <div>
              <b>Is this a {armLabel.toLowerCase()} bowler?</b> The video doesn't make the bowling arm clear, and everything else
              (release, angles, coaching) depends on it. If it's wrong, <button type="button" className="link-btn" onClick={openSettings}>set the bowling arm</button>.
            </div>
          </div>
        )}
        {result.coaching.capture_tips.length > 0 && result.fps_real < 90 && (
          <div className="notice" style={{ marginBottom: 14 }}>
            <IInfo size={16} /> <div>{result.coaching.capture_tips[0]}</div>
          </div>
        )}
        {ins && <SummaryCard ins={ins} onPlan={openPlan} onJump={(k) => jumpTo(k as EventKey)} />}
        <div className="an-grid">
          <div className="stack">
            <div className="card player" ref={playerRef}>
              <ErrorBoundary label="The video player"><FramePlayer id={id} result={result} frame={frame} overlay={overlay} selMetric={selMetric} hud={cur} /></ErrorBoundary>
              <div className="controls">
                <div className="ctrl-group">
                  <button className="btn icon play" onClick={() => setPlaying((p) => !p)} title="Play / pause (space)" aria-label={playing ? "Pause" : "Play"}>{playing ? <IPause size={16} /> : <IPlay size={16} />}</button>
                  <button className="btn icon" onClick={() => { setPlaying(false); setFrame((f) => Math.max(f0, f - 1)); }} title="Previous frame (←)" aria-label="Previous frame"><IPrev size={17} /></button>
                  <button className="btn icon" onClick={() => { setPlaying(false); setFrame((f) => Math.min(f1 - 1, f + 1)); }} title="Next frame (→)" aria-label="Next frame"><INext size={17} /></button>
                </div>
                <div className="ctrl-group">
                  <div className="seg" title="Playback speed" role="group" aria-label="Playback speed">
                    {[0.125, 0.25, 0.5, 1].map((s) => (
                      <button key={s} className={speed === s ? "on" : ""} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s === 1 ? "1×" : `${s === 0.125 ? "⅛" : s === 0.25 ? "¼" : "½"}×`}</button>
                    ))}
                  </div>
                  <button className={`btn sm ${loop ? "active" : ""}`} aria-pressed={loop} onClick={() => setLoop((l) => !l)} title="Loop the delivery stride">Loop</button>
                </div>
                <div className="ctrl-group ctrl-view">
                  <div className="seg" role="group" aria-label="Overlays">
                    <button className={overlay.skeleton ? "on" : ""} aria-pressed={overlay.skeleton} onClick={() => setOverlay((o) => ({ ...o, skeleton: !o.skeleton }))}>Skeleton</button>
                    <button className={overlay.angles ? "on" : ""} aria-pressed={overlay.angles} onClick={() => setOverlay((o) => ({ ...o, angles: !o.angles }))}>Angles</button>
                    <button className={overlay.trail ? "on" : ""} aria-pressed={overlay.trail} onClick={() => setOverlay((o) => ({ ...o, trail: !o.trail }))}>Wrist trail</button>
                  </div>
                  <span className="frame-readout" title={(result.options.slowmo_factor || 1) > 1 ? "Real (filmed) time" : undefined}>f {frame} · {fmt(realSec(result.frames.times[i] - (result.frames.times[0] ?? 0), result.options.slowmo_factor), 3)} s</span>
                </div>
              </div>
              <Timeline result={result} frame={frame} onSeek={(f) => { setPlaying(false); setFrame(f); }} onSetEvent={setEvent} edited={edited} id={id} busy={busy} />
            </div>
          </div>
          <div className="stack">
            <ErrorBoundary label="The 3D viewer">
              <Suspense fallback={<div className="card viewer"><div className="viewer-stage" style={{ display: "grid", placeItems: "center" }}><div className="spinner" /></div></div>}>
                <Viewer3D id={id} result={result} frame={frame} />
              </Suspense>
            </ErrorBoundary>
            <FrameCard result={result} frame={frame} onOpen={() => setTab("frame")} onConfirm={setEvent} busy={busy} />
            <ScoreCard result={result} edited={edited} busy={busy} onReset={resetEdits} />
            {ins && <BackHealthCard ins={ins} />}
          </div>
        </div>

        <div className="card card-pad" style={{ marginTop: 18, scrollMarginTop: 70 }} ref={tabsRef}>
          <div className="tabs" role="tablist" aria-label="Analysis details">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="tab-panel" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab}`}>
          <ErrorBoundary label="This tab">
          {tab === "coach" && <CoachingPanel result={result} onJump={(k) => jumpTo(k as EventKey)} />}
          {tab === "metrics" && <MetricsPanel result={result} selected={selMetric} onSelect={(k, evKey) => { setSelMetric(k === selMetric ? null : k); const e = evKey ? result.events[evKey as EventKey] : null; if (e) { setPlaying(false); setFrame(e.frame); } }} />}
          {tab === "charts" && <Charts result={result} frame={frame} onSeek={(f) => { setPlaying(false); setFrame(f); }} />}
          {tab === "frame" && <Inspector result={result} frame={frame} onSetEvent={setEvent} busy={busy} />}
          {tab === "plan" && (ins ? <PlanPanel id={id} ins={ins} onUpload={uploadRetest} />
            : insErr ? (
              <div className="notice warn"><IAlert size={16} /> <div>Couldn't build the practice plan ({insErr}). <button className="btn sm" onClick={() => setInsTry((n) => n + 1)}>Try again</button></div></div>
            ) : <div className="skeleton-box" style={{ height: 240 }} />)}
          {tab === "settings" && <Settings id={id} result={result} busy={busy} onRecompute={recompute} onRerun={rerun}
            playerId={meta.player_id ?? null} onAssign={assignPlayer} />}
          </ErrorBoundary>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>{result.coaching.disclaimer}</p>
      </main>
      <SiteFooter compact />
      {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.text}</div>}
    </>
  );
}

function ScoreCard({ result, edited, busy, onReset }: { result: AnalysisResult; edited: EventKey[]; busy: boolean; onReset: () => void }) {
  const c = result.coaching;
  const score = c.score ?? 0;
  const R = 50, C = 2 * Math.PI * R;
  const col = score >= 85 ? "#4ade80" : score >= 70 ? "#3ddc97" : score >= 55 ? "#fbbf24" : "#f87171";
  return (
    <div className="card card-pad">
      <div className="score-wrap">
        <div className="ring">
          <svg width="118" height="118" viewBox="0 0 118 118">
            <circle cx="59" cy="59" r={R} stroke="var(--c-line-2)" strokeWidth="10" fill="none" />
            {c.score !== null && c.score !== undefined && (
              <circle cx="59" cy="59" r={R} stroke={col} strokeWidth="10" fill="none" strokeLinecap="round" strokeDasharray={`${(C * score) / 100} ${C}`} />
            )}
          </svg>
          <div className="val"><div><b>{c.score ?? "–"}</b><small>{c.grade ?? "No score"}</small></div></div>
        </div>
        <div>
          <div className="card-title" style={{ marginBottom: 6 }}>Action score</div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
            {c.score === null || c.score === undefined
              ? "Not enough reliably measured metrics in this clip for a fair score. Confirm the event markers on the timeline, or add a side-on clip."
              : `Based on the ${c.score_breakdown.length} checkpoints this camera view measures reliably: one in the target range counts in full, a "watch" about half, a "risk" very little (weighted by how sure each measurement is). It rates the action, not playing level.`}
          </div>
          {c.priorities[0] && (
            <div style={{ marginTop: 8 }}>
              <span className="faint" style={{ fontSize: 12 }}>Top priority</span>
              <div style={{ fontWeight: 700 }}>{c.priorities[0].headline}</div>
            </div>
          )}
          {edited.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="chip watch">Events edited: {edited.map((k) => EVENTS.find((e) => e.key === k)?.short).join(", ")}</span>
              <button className="btn sm ghost" disabled={busy} onClick={onReset}>Reset to auto</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
