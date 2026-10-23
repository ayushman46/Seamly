import type { AnalysisResult } from "../types";
import { RATING_LABEL } from "../lib/constants";
import { IAlert, IBolt, ICheck, IPlay, IShield, ITarget } from "./Icons";

const CAT: Record<string, { label: string; icon: JSX.Element; cls: string }> = {
  pace: { label: "Pace", icon: <IBolt size={13} />, cls: "info" },
  load: { label: "Back load", icon: <IShield size={13} />, cls: "watch" },
  accuracy: { label: "Accuracy", icon: <ITarget size={13} />, cls: "info" },
  legality: { label: "Elbow screen", icon: <IAlert size={13} />, cls: "risk" },
};

export default function CoachingPanel({ result, onJump }: { result: AnalysisResult; onJump: (eventKey: string) => void }) {
  const c = result.coaching;
  return (
    <div className="coach-grid">
      <div className="stack">
        <div className="card-title">Top priorities</div>
        {c.priorities.length === 0 && (
          <div className="notice ok"><ICheck size={16} /> <div>No clear technical issues among the metrics this camera angle can measure reliably. Add a clip from another angle for a fuller picture.</div></div>
        )}
        {c.priorities.map((p, i) => {
          const cat = CAT[p.category] ?? CAT.pace;
          const ev = p.event?.split("-").pop();
          return (
            <div key={p.key} className="prio">
              <div className="num">{i + 1}</div>
              <div>
                <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
                  <span className={`chip ${p.rating}`}>{RATING_LABEL[p.rating]}</span>
                  <span className={`chip ${cat.cls}`}>{cat.icon} {cat.label}</span>
                  <span className="chip unrated" title="Strength of the published evidence">{p.evidence}</span>
                  {ev && <button className="btn sm ghost" onClick={() => onJump(ev)}><IPlay size={11} /> Show in video</button>}
                </div>
                <h4>{p.headline}</h4>
                <div className="muted" style={{ fontSize: 13 }}>{p.why}</div>
                <div className="cue">“{p.drill.cue}”</div>
                <div style={{ marginTop: 10, fontWeight: 700, fontSize: 13 }}>{p.drill.title} — drills</div>
                <ul className="drills">{p.drill.drills.map((d) => <li key={d}>{d}</li>)}</ul>
              </div>
            </div>
          );
        })}
      </div>
      <div className="stack">
        <div className="card-title">What you do well</div>
        {c.strengths.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {c.strengths.map((s) => <div key={s} className="row" style={{ gap: 8 }}><span className="chip good"><ICheck size={13} /></span><span>{s}</span></div>)}
          </div>
        ) : <div className="faint">Strengths appear here once enough metrics are measured reliably.</div>}
        <div className="divider" />
        <div className="card-title">Get a better reading</div>
        <div className="stack" style={{ gap: 8 }}>
          <ul className="plain" style={{ margin: 0 }}>{c.capture_tips.map((t) => <li key={t} className="muted">{t}</li>)}</ul>
        </div>
        <div className="divider" />
        <div className="card-title">Score breakdown</div>
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
