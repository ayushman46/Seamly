import { drillsForAge } from "../lib/player";
import type { AnalysisResult, Insights } from "../types";
import { RATING_LABEL } from "../lib/constants";
import { IAlert, IBolt, ICheck, IEye, IShield, ITarget } from "./Icons";
import { BackHealth } from "./InsightsCard";

const CAT: Record<string, { label: string; icon: JSX.Element; cls: string }> = {
  pace: { label: "Pace", icon: <IBolt size={13} />, cls: "info" },
  load: { label: "Back load", icon: <IShield size={13} />, cls: "watch" },
  accuracy: { label: "Accuracy", icon: <ITarget size={13} />, cls: "info" },
  legality: { label: "Elbow screen", icon: <IAlert size={13} />, cls: "risk" },
};

export default function CoachingPanel({ result, ins, onJump, age, style }: {
  result: AnalysisResult; ins?: Insights | null; onJump: (eventKey: string) => void; age?: string | null; style?: string | null;
}) {
  const c = result.coaching;
  return (
    <div className="coach-grid">
      <div className="stack">
        <div role="heading" aria-level={3} className="card-title">Top priorities</div>
        {c.priorities.length === 0 && (
          <div className="notice ok"><ICheck size={16} /> <div>No clear technical issues among the metrics this camera angle can measure reliably. Add a clip from another angle for a fuller picture.</div></div>
        )}
        {c.priorities.map((p, i) => {
          // the rules come from pace-bowling research: for a spinner, and for a junior (whose notes say a sound
          // action comes before pace), a "pace" point is about the action
          const cat0 = CAT[p.category] ?? CAT.pace;
          const junior = !!age && ["u11", "u13", "u15", "u17", "u19"].includes(age);
          const cat = (style === "spin" || junior) && p.category === "pace" ? { ...cat0, label: "Action" } : cat0;
          const ev = p.event?.split("-").pop();
          return (
            <div key={p.key} className="prio">
              <div className="num">{i + 1}</div>
              <div>
                <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
                  <span className={`chip ${p.rating}`} title={p.borderline ? "Just outside the target range, within what one camera can measure: worth a look, not a priority" : undefined}>
                    {RATING_LABEL[p.rating]}{p.borderline ? " · borderline" : ""}
                  </span>
                  <span className={`chip ${cat.cls}`} title={`Strength of the published evidence: ${p.evidence}`}>{cat.icon} {cat.label}</span>
                  <div className="grow" />
                  {ev && <button className="btn sm ghost" onClick={() => onJump(ev)} aria-label={`Show in video: ${p.headline}`}><IEye size={12} /> Show in video</button>}
                </div>
                <h4>{p.headline}</h4>
                <div className="muted" style={{ fontSize: 13 }}>{p.why}</div>
                <div className="cue">“{p.drill.cue}”</div>
                <details className="drills-more">
                  <summary>Drills: {p.drill.title.toLowerCase()}</summary>
                  <ul className="drills">{drillsForAge(p.drill.drills, age).map((d) => <li key={d}>{d}</li>)}</ul>
                </details>
              </div>
            </div>
          );
        })}
      </div>
      <div className="stack">
        {ins?.back_health && <><BackHealth ins={ins} /><div className="divider" /></>}
        <div role="heading" aria-level={3} className="card-title">Get a better reading</div>
        <div className="stack" style={{ gap: 8 }}>
          <ul className="plain" style={{ margin: 0 }}>{c.capture_tips.map((t) => <li key={t} className="muted">{t}</li>)}</ul>
        </div>
        <div className="divider" />
        <div role="heading" aria-level={3} className="card-title">Score breakdown</div>
        <p className="faint" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
          {c.score === null || c.score === undefined
            ? "Too few reliable measurements in this clip for a fair score. Check the event markers on the timeline, or film side-on."
            : `From the ${c.score_breakdown.length} checkpoints this view measures reliably. It rates the action, not playing level.`}
        </p>
        <div className="stack" style={{ gap: 6 }}>
          {c.score_breakdown.map((b) => (
            <div key={b.key} className="row" style={{ fontSize: 13 }}>
              <span className="dot" style={{ background: `var(--${b.rating})` }} />
              <span className="grow muted">{b.label}</span>
              <span className={`chip ${b.rating}`}>{RATING_LABEL[b.rating]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
