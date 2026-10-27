import type { AnalysisResult, EventKey, Insights, PaceRecord } from "../types";
import { fmt } from "../lib/format";
import { IArrowRight, ICalendar, IEye } from "./Icons";

export function ScoreRing({ score, grade }: { score: number | null | undefined; grade: string | null | undefined }) {
  const R = 50, C = 2 * Math.PI * R;
  const s = score ?? 0;
  const col = s >= 85 ? "#4ade80" : s >= 70 ? "#3ddc97" : s >= 55 ? "#fbbf24" : "#f87171";
  return (
    <div className="ring" role="img" aria-label={score === null || score === undefined ? "No action score for this clip" : `Action score ${score} out of 100, ${grade}`}>
      <svg viewBox="0 0 118 118" aria-hidden="true">
        <circle cx="59" cy="59" r={R} stroke="var(--c-line-2)" strokeWidth="9" fill="none" />
        {score !== null && score !== undefined && (
          <circle cx="59" cy="59" r={R} stroke={col} strokeWidth="9" fill="none" strokeLinecap="round" strokeDasharray={`${(C * s) / 100} ${C}`} />
        )}
      </svg>
      <div className="val" aria-hidden="true"><div><b>{score ?? "–"}</b><small>{grade ?? "No score"}</small></div></div>
    </div>
  );
}

const BACK_SHORT = { ok: "No red flags", watch: "Worth watching", flag: "Talk to a coach", unknown: "Not measurable from this view" } as const;

/** The back-health line in a few words: a partial screen is never presented as an all-clear. */
export function backHealthLine(b: NonNullable<Insights["back_health"]>): string {
  if (b.overall === "ok" && b.measured < b.total) return `${b.measured} of ${b.total} checks possible from this view: no red flags`;
  return BACK_SHORT[b.overall];
}

/**
 * The verdict at the top of an analysis: the score, the one-line summary, the one thing to work on (with its cue)
 * and the few facts that change how to read it (what's working, back health, camera limits).
 */
export function Verdict({ result, ins, pace, armPending = false, onJump, onPlan, onCoaching }: {
  result: AnalysisResult; ins: Insights | null; pace?: PaceRecord | null; armPending?: boolean;
  onJump: (k: EventKey) => void; onPlan: () => void; onCoaching: () => void;
}) {
  const c = result.coaching;
  const s = ins?.summary;
  const fix = s?.fixes[0];
  const p0 = c.priorities[0];
  // the grade is on the ring beside it, so the line leads with the next step itself
  const step = s?.headline.match(/Your next step: (.+?)\.?$/)?.[1];
  const headline = step ? `Next: ${step}.` : s?.headline ?? (p0 ? `Next: ${p0.headline}` : "No clear issues among what this view can measure.");
  const ev = (fix?.event ?? p0?.event)?.split("-").pop() as EventKey | undefined;
  const b = ins?.back_health ?? null;
  const working = s?.working ?? c.strengths;
  // repeated frames add nothing: with many of them the clip's precision is its distinct frame rate (as in Coaching)
  const rep = result.quality.repeated_frames ?? 0;
  const fps = rep >= 0.4 ? result.fps_real * (1 - rep) : result.fps_real;
  const slow = fps < 90;
  return (
    <section className="card verdict" aria-labelledby="verdict-title">
      <ScoreRing score={c.score} grade={c.grade} />
      <div className="verdict-main">
        <h2 id="verdict-title" className="verdict-headline">{armPending ? "First, confirm the bowling arm." : headline}</h2>
        {armPending ? (
          <div className="verdict-fix"><div className="muted">The fix depends on which arm bowls. Answer the question above and Seamly re-measures in about a second.</div></div>
        ) : fix ? (
          <div className="verdict-fix">
            <div className="muted">{fix.what}</div>
            <div className="cue">“{fix.cue}”</div>
          </div>
        ) : p0 ? (
          <div className="verdict-fix"><div className="cue">“{p0.drill.cue}”</div></div>
        ) : null}
        <div className="verdict-actions">
          <button type="button" className="btn primary sm" onClick={onPlan}><ICalendar size={14} /> 2-week practice plan</button>
          {ev && result.events[ev] && (
            <button type="button" className="btn sm" onClick={() => onJump(ev)} aria-label={`Show me in the video${fix ? `: ${fix.title}` : ""}`}><IEye size={12} /> Show me</button>
          )}
          {c.priorities.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={onCoaching}>All coaching <IArrowRight size={13} /></button>
          )}
        </div>
      </div>
      <dl className="verdict-facts">
        {pace && <div><dt>Pace</dt><dd><b>{Math.round(pace.kmh)} km/h</b> <span className="faint">({Math.round(pace.lo)}–{Math.round(pace.hi)})</span></dd></div>}
        {working.length > 0 && <div><dt>{working.length > 1 ? "Strengths" : "Strength"}</dt><dd>{working.slice(0, 2).join(" · ")}</dd></div>}
        {b && (
          <div><dt>Back health</dt><dd><span className={`dot ${b.overall}`} aria-hidden="true" /> {backHealthLine(b)}</dd></div>
        )}
        <div>
          <dt>Camera</dt>
          <dd title={slow ? c.capture_tips[0] : undefined}>
            {result.view.oblique && <>At an angle to the pitch, so most angles aren't rated: film side-on or from behind the stumps. </>}
            {fmt(fps, 0)} fps: timings ±{Math.round(1000 / fps)} ms.{slow ? " Slow motion (120–240 fps) is far more precise." : ""}
          </dd>
        </div>
        {s?.notes.map((n) => <div key={n}><dt>Note</dt><dd>{n}</dd></div>)}
      </dl>
    </section>
  );
}

/** Lower-back technique screen for pace bowlers (never a diagnosis), as a section of the Coaching tab. */
export function BackHealth({ ins }: { ins: Insights }) {
  const b = ins.back_health;
  if (!b) return null;
  return (
    <div>
      <div role="heading" aria-level={3} className="card-title">Back health</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{backHealthLine(b)}.</div>
      <div className="stack" style={{ gap: 8 }}>
        {/* checks that couldn't be made share a line per reason (the view, or an estimated contact frame) */}
        {(() => {
          const out = b.checks.filter((c) => c.status === "unknown");
          const reasons = [...new Set(out.map((c) => c.text))];
          return reasons.map((text) => {
            const names = out.filter((c) => c.text === text).map((c, i) => (i ? c.label.charAt(0).toLowerCase() + c.label.slice(1) : c.label));
            return (
              <div key={text} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <span className="dot unknown" style={{ marginTop: 6 }} aria-hidden="true" />
                <div className="faint" style={{ fontSize: 12.5 }}>
                  {names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}: {text.charAt(0).toLowerCase() + text.slice(1)}
                </div>
              </div>
            );
          });
        })()}
        {b.checks.filter((c) => c.status !== "unknown").map((c) => (
          <div key={c.key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <span className={`dot ${c.status}`} style={{ marginTop: 6 }} aria-hidden="true" />
            <span className="sr-only">{BACK_SHORT[c.status as keyof typeof BACK_SHORT]}: </span>
            <div className="grow">
              <span style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</span>{c.value !== null && <span className="faint"> · {fmt(c.value)}°</span>}
              <div className="faint" style={{ fontSize: 12.5 }}>{c.text}</div>
            </div>
          </div>
        ))}
      </div>
      {b.advice.map((a) => <p key={a} className="faint" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{a}</p>)}
      <p className="faint" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{b.disclaimer}</p>
    </div>
  );
}
