import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult, EventKey, Insights } from "../types";
import { COCO_EDGES, EVENTS, EVENT_HEX, RATING_LABEL, TECHNIQUE_HELP, VIEW_LABEL } from "../lib/constants";
import { DATE_LOCALE, clamp, fmt, unitLabel } from "../lib/format";
import { LogoMark } from "./Brand";
import { AGE_LABEL, drillsForAge } from "../lib/player";
import { DISCLAIMER } from "./Landing";

export default function ReportPage({ id, go }: { id: string; go: (to: string) => void }) {
  const [data, setData] = useState<{ meta: AnalysisMeta; result: AnalysisResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ins, setIns] = useState<Insights | null>(null);
  useEffect(() => {
    api.get(id).then((r) => (r.result ? setData({ meta: r.meta, result: r.result }) : setError("This analysis isn't finished yet."))).catch((e) => setError(e.message));
    api.insights(id).then(setIns).catch(() => setIns(null));
  }, [id]);
  // the PDF a browser saves is named after the page title
  useEffect(() => {
    if (!data) return;
    const before = document.title;
    const who = ins?.player?.name;
    document.title = `Seamly report - ${who ? `${who} - ` : ""}${data.meta.name}`;
    return () => { document.title = before; };
  }, [data, ins]);
  if (error) {
    return (
      <main className="report" id="main" tabIndex={-1}>
        <div className="report-bar no-print"><button className="btn" onClick={() => go("/")}>← Back to Seamly</button></div>
        <p><b>Couldn't build this report.</b> {error}</p>
      </main>
    );
  }
  if (!data) return <main className="report" id="main" tabIndex={-1} aria-busy="true"><p className="rp-note">Preparing the report…</p></main>;
  const { meta, result: r } = data;
  const c = r.coaching;
  const measured = r.metrics.filter((m) => m.value !== null && m.reliability === "measured");
  const estimates = r.metrics.filter((m) => m.reliability === "estimate");
  return (
    <main className="report" id="main" tabIndex={-1}>
      <div className="report-bar no-print">
        <button className="btn" onClick={() => go(`/a/${id}`)}>← Back to analysis</button>
        <button className="btn primary" onClick={() => window.print()}>Print / save as PDF</button>
      </div>
      <header className="rp-head">
        <div>
          <div className="rp-brand"><LogoMark size={20} /> Seamly · Bowling action report</div>
          <h1>{meta.name}</h1>
          {ins?.player && <div className="rp-player">{ins.player.name} · {AGE_LABEL[ins.player.age_group] ?? ins.player.age_group}</div>}
          <div className="rp-sub">
            {new Date(meta.created * 1000).toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric" })} · {VIEW_LABEL[r.view.view]}{r.view.oblique ? " (at an angle)" : ""} · {r.bowling_arm.arm === "right" ? "Right-arm" : "Left-arm"}
            {r.bowling_arm.source !== "user" && r.bowling_arm.confidence < 0.7 ? " (detected, not certain)" : ""} ·{" "}
            {fmt(r.fps_real)} fps · stature {r.skeleton.stature_m.toFixed(2)} m ({r.skeleton.height_source === "user" ? "entered" : "assumed"})
          </div>
        </div>
        <div className="rp-score">
          <b>{c.score ?? "–"}</b>
          <span>{c.grade ?? "No score"}</span>
        </div>
      </header>

      <section>
        <h2>Top priorities</h2>
        {c.priorities.length === 0 && <p>No clear technical issues among the metrics this camera angle measures reliably.</p>}
        <ol className="rp-prio">
          {c.priorities.map((p) => (
            <li key={p.key}>
              <b>{p.headline}</b> <em>— {RATING_LABEL[p.rating]}{p.borderline ? " (borderline)" : ""}</em>
              <div>{p.why}</div>
              <div className="rp-cue">Cue: “{p.drill.cue}”</div>
              <ul>{drillsForAge(p.drill.drills, ins?.player?.age_group).map((d) => <li key={d}>{d}</li>)}</ul>
            </li>
          ))}
        </ol>
        {c.strengths.length > 0 && <p><b>Strengths:</b> {c.strengths.join(" · ")}</p>}
      </section>

      <section>
        <h2>Key positions</h2>
        <div className="rp-kino">
          {EVENTS.map((e) => (
            <figure key={e.key}>
              {r.events[e.key] ? <Still id={id} result={r} ev={e.key} /> : <div className="rp-missing">not detected</div>}
              <figcaption><span style={{ background: EVENT_HEX[e.key] }}>{e.short}</span> {e.label}{r.events[e.key] ? ` · f${r.events[e.key]!.frame}` : ""}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section>
        <h2>Measured metrics</h2>
        <div className="table-scroll"><table className="rp-table">
          <thead><tr><th>Metric</th><th>Value</th><th>Rating</th><th>Reference</th></tr></thead>
          <tbody>
            {measured.map((m) => (
              <tr key={m.key}>
                <td>{m.label}{m.technique ? ` (${m.technique}${TECHNIQUE_HELP[m.technique] ? `: ${TECHNIQUE_HELP[m.technique]}` : ""})` : m.action_type ? ` (${m.action_type})` : ""}</td>
                <td>{fmt(m.value, 0)}{unitLabel(m.unit)}</td>
                <td className={`rp-${m.rating}`}>{RATING_LABEL[m.rating]}</td>
                <td className="rp-ref">{m.norm}{m.ref ? ` — ${m.ref}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {estimates.length > 0 && (
          <p className="rp-note">
            Not rated (not measurable from this camera angle, or resting on an estimated event): {estimates.map((m) => m.label).join(", ")}.
          </p>
        )}
      </section>

      {ins?.back_health && (
        <section>
          <h2>Back-health check</h2>
          <ul className="rp-list">
            {ins.back_health.checks.map((ch) => (
              <li key={ch.key}>
                <b>{ch.label}</b>{ch.value !== null ? ` · ${fmt(ch.value, 0)}${unitLabel(ch.unit ?? "")}` : ""}
                {" — "}{ch.status === "unknown" ? ch.text : <>{ch.status === "ok" ? "no concern" : ch.status === "watch" ? "worth watching" : "flagged"}. {ch.text}</>}
              </li>
            ))}
          </ul>
          {ins.back_health.advice.length > 0 && <ul>{ins.back_health.advice.map((a) => <li key={a}>{a}</li>)}</ul>}
          <p className="rp-note">{ins.back_health.disclaimer}</p>
        </section>
      )}

      {ins?.plan?.notes && ins.plan.notes.length > 0 && (
        <section>
          <h2>Safe bowling{ins.player ? ` for ${AGE_LABEL[ins.player.age_group] ?? ""} bowlers` : ""}</h2>
          <ul>{[ins.plan.notes[0].split(". ")[0].replace(/\.$/, "") + ".", ...(ins.back_health?.advice.length ? [] : ins.plan.notes.slice(-1))].map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      )}

      <section>
        <h2>Get a better reading next time</h2>
        <ul>{c.capture_tips.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>
      <footer className="rp-foot">
        <span>{DISCLAIMER}</span>
        <span>Made with Seamly · github.com/ayushman46/Seamly</span>
      </footer>
    </main>
  );
}

function Still({ id, result, ev }: { id: string; result: AnalysisResult; ev: EventKey }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const e = result.events[ev];
    if (!e) return;
    const t = e.frame - result.frames.start;
    const pts = result.keypoints2d.xy[t];
    const cf = result.keypoints2d.conf[t];
    const im = new Image();
    im.onload = () => {
      const c = ref.current;
      if (!c) return;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      // centred on the bowler, kept inside the frame (no black band above a raised arm)
      const IW = im.naturalWidth, IH = im.naturalHeight;
      const h = Math.min(IH, Math.max(60, (Math.max(...ys) - Math.min(...ys)) * 1.3)), w = Math.min(IW, h * 0.8);
      const cx = clamp((Math.min(...xs) + Math.max(...xs)) / 2, w / 2, IW - w / 2);
      const cy = clamp((Math.min(...ys) + Math.max(...ys)) / 2, h / 2, IH - h / 2);
      c.width = 320; c.height = 400;
      const ctx = c.getContext("2d")!;
      const s = 400 / h, ox = -(cx - w / 2) * s, oy = -(cy - h / 2) * s;
      ctx.drawImage(im, ox, oy, im.naturalWidth * s, im.naturalHeight * s);
      ctx.lineCap = "round";
      ctx.lineWidth = 3;
      const right = result.bowling_arm.arm === "right";
      const bowl = new Set(right ? [6, 8, 10, 12, 14, 16] : [5, 7, 9, 11, 13, 15]);
      for (const [a, b] of COCO_EDGES) {
        if (Math.min(cf[a], cf[b]) < 0.15) continue;
        ctx.strokeStyle = bowl.has(a) && bowl.has(b) ? "#fb7185" : "#34d399";
        ctx.beginPath();
        ctx.moveTo(pts[a][0] * s + ox, pts[a][1] * s + oy);
        ctx.lineTo(pts[b][0] * s + ox, pts[b][1] * s + oy);
        ctx.stroke();
      }
    };
    im.src = api.frameUrl(id, e.frame);
  }, [id, result, ev]);
  return <canvas ref={ref} />;
}
