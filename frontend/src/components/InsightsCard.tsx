import type { AnalysisResult, EventKey, Insights } from "../types";
import { fmt } from "../lib/format";
import { IArrowRight, ICalendar, IEye } from "./Icons";

function ScoreRing({ score, grade }: { score: number | null | undefined; grade: string | null | undefined }) {
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
  if (b.overall === "ok" && b.measured < b.total) return `No red flags in the ${b.measured} of ${b.total} checks this view allows`;
  return BACK_SHORT[b.overall];
}

/**
 * The verdict at the top of an analysis: the score, the one-line summary, the one thing to work on (with its cue)
 * and the few facts that change how to read it (what's working, back health, camera limits).
 */
export function Verdict({ result, ins, onJump, onPlan, onCoaching }: {
  result: AnalysisResult; ins: Insights | null; onJump: (k: EventKey) => void; onPlan: () => void; onCoaching: () => void;
}) {
  const c = result.coaching;
  const s = ins?.summary;
  const fix = s?.fixes[0];
  const p0 = c.priorities[0];
  const headline = s?.headline ?? (p0 ? `Next: ${p0.headline}` : "No clear issues among what this view can measure.");
  const ev = (fix?.event ?? p0?.event)?.split("-").pop() as EventKey | undefined;
  const b = ins?.back_health ?? null;
  const working = s?.working ?? c.strengths;
  const slow = result.fps_real < 90;
  return (
    <section className="card verdict" aria-labelledby="verdict-title">
      <ScoreRing score={c.score} grade={c.grade} />
      <div className="verdict-main">
        <h2 id="verdict-title" className="verdict-headline">{headline}</h2>
        {fix ? (
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
        {working.length > 0 && <div><dt>Working</dt><dd>{working.slice(0, 2).join(" · ")}</dd></div>}
        {b && (
          <div><dt>Back health</dt><dd><span className={`dot ${b.overall}`} aria-hidden="true" /> {backHealthLine(b)}</dd></div>
        )}
        <div>
          <dt>Camera</dt>
          <dd title={slow ? c.capture_tips[0] : undefined}>
            {result.view.oblique && <>At an angle to the pitch, so most angles aren't rated: film side-on or from behind the stumps. </>}
            {fmt(result.fps_real)} fps{slow ? ": timings are approximate. Slow motion (120–240 fps) is far more precise." : ", precise enough for timings."}
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
        {b.checks.map((c) => (
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
