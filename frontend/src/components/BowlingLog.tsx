import { useMemo, useState } from "react";
import { api } from "../api";
import type { BowlingLogEntry, Player } from "../types";
import { bowlingLimits } from "../engine/insights";
import { formatOvers, isoDate, weekCheck, workload } from "../lib/bowlingLog";
import { IAlert, ICheck, IPlus, ITrash } from "./Icons";

const KIND: Record<BowlingLogEntry["kind"], string> = { match: "Match", nets: "Club nets", training: "Training / drills" };

/** A player's bowling log (matches, club nets, practice), checked each week against their age group's limits. */
export default function BowlingLog({ player, onChange }: { player: Player; onChange: (p: Player) => void }) {
  const [date, setDate] = useState(isoDate(new Date()));
  const [overs, setOvers] = useState("");
  const [kind, setKind] = useState<BowlingLogEntry["kind"]>("nets");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const log = useMemo(() => player.log ?? [], [player.log]);
  const limits = bowlingLimits(player.age_group, player.style);
  const week = useMemo(() => weekCheck(log, new Date(), limits), [log, limits]);
  const load = useMemo(() => workload(log, new Date()), [log]);
  const recent = log.slice(0, 12);

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await api.addLog(player.id, { date, overs, kind }));
      setOvers("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (x: BowlingLogEntry) => {
    if (!window.confirm(`Remove ${formatOvers(x.balls)} overs of ${KIND[x.kind].toLowerCase()} on ${pretty(x.date)}?`)) return;
    setErr(null);
    try { onChange(await api.removeLog(player.id, x.id)); } catch (e) { setErr((e as Error).message); }
  };
  const pretty = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  };

  return (
    <section className="card card-pad" aria-labelledby="log-title">
      <div role="heading" aria-level={2} id="log-title" className="card-title">Bowling log</div>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
        Count every bowling session (matches, nets, the practice plan) to keep {player.name}'s week inside
        {limits ? ` the ${limits.label} limits: at most ${limits.days_week} bowling days a week${limits.day ? ` and ${limits.day} overs a day` : ""}.` : " a sensible load."}
      </p>
      <div className="log-form">
        <div className="field">
          <label htmlFor="log-date">Date</label>
          <input id="log-date" className="input" type="date" value={date} max={isoDate(new Date())} onChange={(e) => { setDate(e.target.value); setErr(null); }} />
        </div>
        <div className="field">
          <label htmlFor="log-overs">Overs</label>
          <input id="log-overs" className="input" inputMode="decimal" placeholder="e.g. 4 or 4.3" value={overs} aria-describedby="log-overs-hint"
            onChange={(e) => { setOvers(e.target.value.replace(/[^0-9.]/g, "")); setErr(null); }} />
        </div>
        <div className="field">
          <label htmlFor="log-kind">What</label>
          <select id="log-kind" className="input" value={kind} onChange={(e) => { setKind(e.target.value as BowlingLogEntry["kind"]); setErr(null); }}>
            {(Object.keys(KIND) as BowlingLogEntry["kind"][]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
          </select>
        </div>
        <button type="button" className="btn primary sm" onClick={add} disabled={busy || !overs}><IPlus size={14} /> Add</button>
      </div>
      <div id="log-overs-hint" className="faint" style={{ fontSize: 12, marginTop: 6 }}>Overs the cricket way: 4.3 is four overs and three balls.</div>
      {err && <div className="notice error" role="alert" style={{ marginTop: 10 }}><IAlert size={16} /> <div>{err}</div></div>}

      <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
        <span className="chip">This week: {week.days} bowling {week.days === 1 ? "day" : "days"}{limits ? ` (limit ${limits.days_week})` : ""}</span>
        <span className="chip">{formatOvers(week.balls)} overs</span>
        {load && (
          <span className={`chip ${load.zone === "ok" ? "good" : load.zone === "high" ? "watch" : load.zone === "spike" ? "risk" : ""}`}
            title="Balls in the last 7 days against the average week of the last 4 weeks (acute:chronic ratio). 0.8–1.3 is the usual range.">
            Load {load.ratio.toFixed(1)}× the 4-week average
          </span>
        )}
      </div>
      {load && (load.zone === "high" || load.zone === "spike") && (
        <div className="notice warn" role="status" style={{ marginTop: 10 }}>
          <IAlert size={16} />
          <div>This week is {load.ratio.toFixed(1)}× {player.name}'s usual week. Sudden jumps in bowling load went with more injuries in fast bowlers (Hulin et al. 2014): build up over a few weeks instead.</div>
        </div>
      )}
      {week.warnings.length > 0 ? (
        <div className="notice warn" role="status" style={{ marginTop: 10 }}>
          <IAlert size={16} />
          <div>{week.warnings.map((w) => <div key={w}>{w}</div>)}</div>
        </div>
      ) : week.days > 0 && limits ? (
        <div className="notice ok" role="status" style={{ marginTop: 10 }}><ICheck size={16} /> <div>Inside the {limits.label} guidelines this week.</div></div>
      ) : null}

      {recent.length > 0 && (
        <ul className="log-list">
          {recent.map((x) => (
            <li key={x.id}>
              <span className="grow">{pretty(x.date)} · {KIND[x.kind]}</span>
              <span className="mono">{formatOvers(x.balls)} ov</span>
              <button type="button" className="btn ghost sm icon" onClick={() => remove(x)} aria-label={`Remove ${KIND[x.kind]} on ${pretty(x.date)}`}><ITrash size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
