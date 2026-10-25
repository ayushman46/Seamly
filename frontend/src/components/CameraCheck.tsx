import { useEffect, useRef, useState } from "react";
import Header from "./Header";
import { usePageTitle } from "../lib/title";
import { COCO_EDGES } from "../lib/constants";
import { assess, mainPerson, ready, steady, type Check, type FilmView, type Person } from "../lib/framing";
import type { PoseModels } from "../engine/detector";
import { IAlert, ICamera, ICheck, IInfo, IRefresh } from "./Icons";

const VIEWS: [FilmView, string][] = [["side_on", "Side-on"], ["behind", "Behind the stumps"]];

/** Mean brightness of the picture (0–255), from a tiny copy of it. */
function meanLuma(src: HTMLVideoElement, c: HTMLCanvasElement): number {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 128;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}

function drawPose(c: HTMLCanvasElement | null, p: Person | null, w: number, h: number, ok: boolean) {
  if (!c) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!p) return;
  const lw = Math.max(2, h / 180);
  ctx.lineWidth = lw; ctx.lineCap = "round";
  ctx.strokeStyle = ok ? "rgba(61,220,151,0.95)" : "rgba(251,191,36,0.95)";
  for (const [a, b] of COCO_EDGES) {
    if (p.kcs[a] < 0.3 || p.kcs[b] < 0.3) continue;
    ctx.beginPath(); ctx.moveTo(p.kps[a][0], p.kps[a][1]); ctx.lineTo(p.kps[b][0], p.kps[b][1]); ctx.stroke();
  }
  ctx.setLineDash([lw * 3, lw * 3]); ctx.lineWidth = lw * 0.75; ctx.strokeStyle = "rgba(255,255,255,0.55)";
  const [x0, y0, x1, y1] = p.box;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
}

/**
 * Camera check: before filming, point the phone where it will film from, have the bowler stand at the crease, and
 * see live whether the angle, distance, framing and light will give a clip Seamly can measure. Nothing is recorded.
 */
export default function CameraCheck({ go }: { go: (to: string) => void }) {
  usePageTitle("Camera check");
  const [view, setView] = useState<FilmView>("side_on");
  const [state, setState] = useState<"idle" | "starting" | "live" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const lumaRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const models = useRef<PoseModels | null>(null);
  const history = useRef<Check[][]>([]);
  const viewRef = useRef(view);
  viewRef.current = view;

  const alive = useRef(true);
  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
      models.current?.release().catch(() => undefined);
      models.current = null;
    };
  }, []);
  useEffect(() => { history.current = []; }, [view]);

  const start = async (face = facing) => {
    setErr(null);
    setState("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't open the camera here. Use a recent Chrome or Safari.");
      stop();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: face }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      });
      // the page may have been left while the camera was opening: let go of it straight away
      if (!alive.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      if (!models.current) {
        const { PoseModels } = await import("../engine/detector");
        models.current = await PoseModels.scanOnly(setProgress);
      }
      if (!alive.current) { stop(); return; }
      history.current = [];
      setState("live");
    } catch (e) {
      const name = (e as DOMException).name;
      setErr(name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site in the browser's settings, then try again."
        : name === "NotFoundError" || name === "OverconstrainedError" ? "No camera was found on this device."
        : (e as Error).message);
      setState("error");
      stop();
    }
  };

  // check the picture a few times a second while the camera is live
  useEffect(() => {
    if (state !== "live") return;
    let alive = true, timer = 0;
    lumaRef.current ??= Object.assign(document.createElement("canvas"), { width: 32, height: 18 });
    const tick = async () => {
      const v = videoRef.current, m = models.current;
      if (!alive) return;
      if (!v || !m || v.readyState < 2 || !v.videoWidth) { timer = window.setTimeout(tick, 200); return; }
      try {
        const w = v.videoWidth, h = v.videoHeight;
        const p = mainPerson(await m.detect(v, w, h, 0.35));
        const fps = streamRef.current?.getVideoTracks()[0]?.getSettings().frameRate ?? null;
        const now = assess(p, w, h, viewRef.current, fps, meanLuma(v, lumaRef.current!));
        history.current = [...history.current.slice(-4), now];
        const shown = steady(history.current);
        if (!alive) return;
        setChecks(shown);
        drawPose(overlayRef.current, p, w, h, ready(shown));
      } catch (e) {
        setErr((e as Error).message);
      }
      if (alive) timer = window.setTimeout(tick, 120);
    };
    timer = window.setTimeout(tick, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [state]);

  const isReady = state === "live" && checks.length > 0 && ready(checks);
  const flip = () => { const f = facing === "environment" ? "user" : "environment"; setFacing(f); start(f); };
  const toUpload = () => {
    stop();
    go("/");
    window.setTimeout(() => document.getElementById("analyse")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  };

  return (
    <>
      <Header go={go} />
      <main className="page narrow cam-page" id="main" tabIndex={-1}>
        <h1 className="an-title">Camera check</h1>
        <p className="muted" style={{ marginTop: 6, maxWidth: 640 }}>
          Put the phone where you'll film from and have the bowler stand at the crease. Seamly checks the angle, distance, framing
          and light live, before you record. Nothing is recorded or sent anywhere.
        </p>
        <div className="row wrap" style={{ gap: 10, margin: "16px 0 12px" }}>
          <span className="seg" role="group" aria-label="Where you'll film from">
            {VIEWS.map(([k, label]) => (
              <button key={k} type="button" className={view === k ? "on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>
            ))}
          </span>
        </div>

        <div className={`cam-stage ${facing === "user" ? "mirror" : ""} ${isReady ? "ready" : ""}`}>
          <video ref={videoRef} playsInline muted aria-label="Live camera picture" />
          <canvas ref={overlayRef} aria-hidden="true" />
          {state !== "live" && (
            <div className="cam-cover">
              {state === "starting"
                ? <span className="faint">{progress > 0 && progress < 1 ? `Loading the pose model… ${Math.round(progress * 100)}%` : "Opening the camera…"}</span>
                : (
                  <>
                    {err && <p className="cam-err"><IAlert size={15} /> {err}</p>}
                    <button type="button" className="btn primary" onClick={() => start()}><ICamera size={16} /> {err ? "Try again" : "Start the camera"}</button>
                  </>
                )}
            </div>
          )}
          {isReady && <div className="cam-badge"><ICheck size={15} /> Good spot</div>}
        </div>

        {state === "live" && (
          <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn sm ghost" onClick={flip}><IRefresh size={14} /> Switch camera</button>
            <button type="button" className="btn sm ghost" onClick={() => { stop(); setState("idle"); setChecks([]); }}>Stop</button>
          </div>
        )}
        {state === "live" && (
          <section aria-label="Checks" aria-live="polite">
            <ul className="cam-checks">
              {checks.map((c) => (
                <li key={c.key} className={c.ok === true ? "ok" : c.ok === false ? "bad" : "info"}>
                  <span className="cam-ico" aria-hidden="true">{c.ok === true ? <ICheck size={14} /> : c.ok === false ? <IAlert size={14} /> : <IInfo size={14} />}</span>
                  <span><b>{c.label}</b>{c.tip && <span className="muted"> {c.tip}</span>}</span>
                </li>
              ))}
            </ul>
            {isReady && (
              <div className="cam-ready">
                <p>
                  Keep the phone exactly here. Record the delivery with your camera app (in slow motion if it has it, which makes timings
                  and ball speed far more precise), then analyse the clip.
                </p>
                <button type="button" className="btn primary sm" onClick={toUpload}>Analyse a clip</button>
              </div>
            )}
          </section>
        )}
      </main>
    </>
  );
}
