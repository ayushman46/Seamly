import type { EventKey, Insights } from "../types";
import { EVENTS } from "../lib/constants";
import { fmt } from "../lib/format";
import { IAlert, ICalendar, IChat, IPlay, IShield } from "./Icons";

/** "Your delivery in plain words": headline, what's working, what to fix first and why, how to see more. */
export function SummaryCard({ ins, onJump, onPlan }: { ins: Insights; onJump: (k: EventKey) => void; onPlan: () => void }) {
  const s = ins.summary;
  return (
    <div className="card card-pad summary-card">
      <div className="row wrap" style={{ gap: 10, marginBottom: 8 }}>
        <div className="card-title" style={{ margin: 0 }}><IChat size={14} /> Your delivery in plain words</div>
        {ins.player && <span className="chip info">{ins.player.name}</span>}
        <div className="grow" />
        <button className="btn sm primary" onClick={onPlan}><ICalendar size={14} /> Your 2-week practice plan</button>
      </div>
      <div className="summary-headline">{s.headline}</div>
      <div className="summary-grid">
        {s.fixes.length > 0 && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="faint summary-label">Work on</div>
            {s.fixes.map((f, i) => {
              const ev = f.event?.split("-").pop() as EventKey | undefined;
              const label = ev ? EVENTS.find((e) => e.key === ev)?.label : null;
              return (
                <div key={f.title} className={`fix ${f.rating}`}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="fix-n">{i + 1}</span>
                    <b className="grow">{f.title}</b>
                    {ev && label && <button className="btn sm ghost" onClick={() => onJump(ev)} title={`Jump to ${label}`}><IPlay size={11} /> Show me</button>}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>{f.what}.</div>
                  <div style={{ fontSize: 13 }}>{f.why}</div>
                  <div className="cue">Cue: “{f.cue}”</div>
                </div>
              );
            })}
          </div>
        )}
        <div className="stack" style={{ gap: 10 }}>
          {s.working.length > 0 && (
            <div>
              <div className="faint summary-label">What's working</div>
              <ul className="ticks">{s.working.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {s.unlock.length > 0 && (
            <div>
              <div className="faint summary-label">See more next time</div>
              <ul className="plain">{s.unlock.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
          )}
          {s.notes.map((n) => <div key={n} className="notice" style={{ fontSize: 13 }}><IAlert size={16} /> <div>{n}</div></div>)}
        </div>
      </div>
    </div>
  );
}

const STATUS_TEXT = { ok: "No red flags", watch: "Worth watching", flag: "Discuss with a coach", unknown: "Not measurable" } as const;

/** Lower-back technique screen for pace bowlers (never a diagnosis). */
export function BackHealthCard({ ins }: { ins: Insights }) {
  const b = ins.back_health;
  if (!b) return null;
  const headline = b.overall === "ok" && b.measured < b.total
    ? `No red flags in what we could measure (${b.measured} of ${b.total} checks)`
    : b.overall === "unknown" ? "Couldn't check in this clip" : STATUS_TEXT[b.overall];
  return (
    <div className="card card-pad">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <div className="card-title grow" style={{ margin: 0 }}><IShield size={14} /> Back-health check</div>
        <span className={`chip multi ${b.overall === "ok" ? "good" : b.overall === "watch" ? "watch" : b.overall === "flag" ? "risk" : ""}`}>{headline}</span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        {b.checks.map((c) => (
          <div key={c.key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <span className={`dot ${c.status}`} style={{ marginTop: 6 }} />
            <div className="grow">
              <b style={{ fontSize: 13 }}>{c.label}</b>{c.value !== null && <span className="faint"> · {fmt(c.value)}°</span>}
              <div className="faint" style={{ fontSize: 12.5 }}>{c.text}</div>
            </div>
          </div>
        ))}
      </div>
      <ul className="plain" style={{ marginTop: 14 }}>{b.advice.map((a) => <li key={a}>{a}</li>)}</ul>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>{b.disclaimer}</div>
    </div>
  );
}
