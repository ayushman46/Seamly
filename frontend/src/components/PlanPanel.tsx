import { useEffect, useMemo, useState } from "react";
import type { Insights } from "../types";

const KIND_LABEL = { bowling: "Bowling", strength: "Strength", rest: "Rest", film: "Film & compare" } as const;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** A one-event calendar file (all-day) for the re-test, which phones open straight in their calendar app. */
function retestIcs(day: Date, who: string | null, id: string): Blob {
  const next = new Date(day); next.setDate(day.getDate() + 1);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Seamly//Practice plan//EN", "BEGIN:VEVENT",
    `UID:seamly-retest-${id}-${ymd(day)}@seamly`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(next)}`,
    `SUMMARY:Seamly re-test${who ? `: ${who}` : ""}`,
    "DESCRIPTION:Film one delivery from the same spot as last time\\, analyse it in Seamly and compare the two.",
    "END:VEVENT", "END:VCALENDAR"];
  return new Blob([lines.join("\r\n") + "\r\n"], { type: "text/calendar" });
}

function loadDone(key: string): string[] {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}

/** Two-week practice plan built from the top priorities, with tick-off progress kept on this device. */
export default function PlanPanel({ id, ins, onUpload }: { id: string; ins: Insights; onUpload: () => void }) {
  const plan = ins.plan;
  const storeKey = `bowlnet-plan-${id}`;
  const [done, setDone] = useState<string[]>(() => loadDone(storeKey));
  useEffect(() => setDone(loadDone(storeKey)), [storeKey]);
  const toggle = (itemId: string) => {
    setDone((d) => {
      const next = d.includes(itemId) ? d.filter((x) => x !== itemId) : [...d, itemId];
      try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* not remembered */ }
      return next;
    });
  };
  // the plan starts on the coming Monday (today, if it is Monday)
  const start = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7;
    if (dow) d.setDate(d.getDate() + 7 - dow);
    return d;
  }, []);
  const dateOf = (week: number, day: string) => { const d = new Date(start); d.setDate(start.getDate() + 7 * week + Math.max(0, WEEKDAYS.indexOf(day))); return d; };
  const short = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const addToCalendar = (day: Date) => {
    const url = URL.createObjectURL(retestIcs(day, ins.player?.name ?? null, id));
    const a = document.createElement("a");
    a.href = url; a.download = "seamly-retest.ics";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const all = plan.weeks.flatMap((w) => w.days.filter((d) => d.kind !== "rest").flatMap((d) => d.items.map((i) => i.id)));
  const nDone = all.filter((x) => done.includes(x)).length;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="grow" style={{ minWidth: 240 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>
            {plan.focus.length ? `Focus: ${plan.focus.map((f) => f.title).join(" + ")}` : "Keep your action grooved"}
          </div>
          {plan.focus.map((f) => <div key={f.title} className="cue" style={{ marginTop: 6 }}>{f.title}: “{f.cue}”</div>)}
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            {ins.player ? `Built for ${ins.player.name}` : "Built for an adult pace bowler"}
            {plan.limits ? ` · ${plan.limits.label} bowling limits` : ""}. Three bowling sessions a week, two strength days, then re-film.
            {" "}Starts {start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}.
          </div>
        </div>
        <div className="plan-progress" title="Ticked items are remembered on this device">
          <div className="progress" style={{ width: 160 }} role="progressbar" aria-label="Plan items done" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={nDone}><i style={{ width: `${all.length ? (100 * nDone) / all.length : 0}%` }} /></div>
          <span className="mono faint">{nDone}/{all.length} done</span>
        </div>
      </div>

      {!ins.player && (
        <div className="notice">
          Add this delivery to a player (Detection &amp; settings tab) to get limits for their age group and track the re-test on their progress page.
        </div>
      )}

      {plan.weeks.map((w, wi) => (
        <div key={w.title}>
          <div role="heading" aria-level={3} className="card-title">{w.title}</div>
          <div className="plan-week">
            {w.days.map((d) => (
              <div key={d.day} className={`plan-day ${d.kind}`}>
                <div className="row" style={{ gap: 6 }}>
                  <b>{d.day} <span className="faint" style={{ fontWeight: 500 }}>{short(dateOf(wi, d.day))}</span></b>
                  <span className={`chip kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                </div>
                <div className="plan-title">{d.title}</div>
                {d.load && (
                  <div className="faint" style={{ fontSize: 11.5 }} title="Every delivery counts: warm-up, drills and spells">
                    ≈ {d.load.deliveries} deliveries{d.load.limit ? ` · limit ${d.load.limit} a day` : ""}
                  </div>
                )}
                <ul className="plan-items">
                  {d.items.map((it) => (
                    <li key={it.id}>
                      {d.kind === "rest" ? (
                        <span className="faint">{it.text}</span>
                      ) : (
                        <label className={done.includes(it.id) ? "done" : ""}>
                          <input type="checkbox" checked={done.includes(it.id)} onChange={() => toggle(it.id)} />
                          <span>{it.text}{it.detail && <small>{it.detail}</small>}</span>
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
                {d.kind === "film" && (
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className="btn sm primary" onClick={onUpload}>Analyse the re-test clip</button>
                    <button className="btn sm" onClick={() => addToCalendar(dateOf(wi, d.day))}>Add to calendar</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card card-pad" style={{ background: "var(--bg-2)" }}>
        <div role="heading" aria-level={3} className="card-title">Bowling load</div>
        <ul className="plain">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        {plan.limits && <div className="faint" style={{ fontSize: 12 }}>Source: {plan.limits.source}.</div>}
      </div>
    </div>
  );
}
