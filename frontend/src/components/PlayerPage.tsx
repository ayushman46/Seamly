import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Player, PlayerProgress } from "../types";
import { VIEW_LABEL } from "../lib/constants";
import { fmt, unitLabel } from "../lib/format";
import { AGE_LABEL, STYLE_LABEL, setCurrentPlayer } from "../lib/player";
import Header from "./Header";
import PlayerForm from "./PlayerForm";
import Trend from "./Trend";
import { IAlert, IBack, ICalendar, IChevronRight, ITrash, IUpload, IVideo } from "./Icons";
import { SiteFooter } from "./Landing";

const dateOf = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–");
const BETTER_TEXT: Record<string, string> = { higher: "higher is better", lower: "lower is better" };

/** One player's progress: score and key-metric trends, what changed since last time, bests and focus. */
export default function PlayerPage({ pid, go }: { pid: string; go: (to: string) => void }) {
  const [data, setData] = useState<PlayerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.progress(pid).then(setData).catch((e) => setError((e as Error).message));
  }, [pid]);
  useEffect(load, [load]);

  if (error) {
    return (
      <>
        <Header go={go} />
        <main className="page narrow" id="main" tabIndex={-1}>
          <div className="card proc">
            <div className="notice error"><IAlert size={16} /> <div><b>Couldn't open this player.</b> {error}</div></div>
            <button className="btn" style={{ marginTop: 16 }} onClick={() => go("/")}><IBack size={16} /> Back to your workspace</button>
          </div>
        </main>
        <SiteFooter compact />
      </>
    );
  }
  if (!data) {
    return (
      <>
        <Header go={go} />
        <main className="page" id="main" tabIndex={-1} aria-busy="true">
          <div className="skel-page">
            <div className="skeleton-box" style={{ height: 120 }} />
            <div className="stat-tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-box" style={{ height: 104 }} />)}</div>
            <div className="skeleton-box" style={{ height: 260 }} />
          </div>
        </main>
      </>
    );
  }
  const p = data.player;
  const s = data.stats;
  const upload = () => { setCurrentPlayer(p.id); go("/"); };
  const latest = data.sessions[data.sessions.length - 1];
  const scorePts = data.sessions.filter((x) => x.score !== null).map((x) => ({ value: x.score as number, label: `${dateOf(x.created)} · ${x.name}`, id: x.id }));

  const save = async (fields: Partial<Player>) => {
    await api.updatePlayer(p.id, fields);
    setEditing(false);
    load();
  };
  const remove = async () => {
    if (!confirm(`Delete ${p.name}'s profile? Their analyses are kept (just no longer grouped).`)) return;
    try {
      await api.removePlayer(p.id);
      setCurrentPlayer(null);
      go("/");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <>
      <Header go={go} title={p.name} />
      <main className="page" id="main" tabIndex={-1}>
        <button type="button" className="back-link" onClick={() => go("/")} style={{ marginBottom: 10 }}><IBack size={15} /> All players</button>
        <div className="card profile-card">
          {editing ? (
            <>
              <div className="card-title">Edit profile</div>
              <PlayerForm initial={p} submitLabel="Save profile" onSave={save} onCancel={() => setEditing(false)} />
            </>
          ) : (
            <div className="row wrap" style={{ gap: 16 }}>
              <div className="player-avatar">{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="grow" style={{ minWidth: 200 }}>
                <span className="eyebrow">Player</span>
                <h1 className="profile-name">{p.name}</h1>
                <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                  <span className="chip">{AGE_LABEL[p.age_group]}</span>
                  <span className="chip">{STYLE_LABEL[p.style]}</span>
                  {p.arm !== "auto" && <span className="chip">{p.arm === "right" ? "Right-arm" : "Left-arm"}</span>}
                  {p.height_cm && <span className="chip">{Math.round(p.height_cm)} cm</span>}
                </div>
              </div>
              <div className="profile-actions">
                <button className="btn ghost" onClick={remove} aria-label={`Delete ${p.name}'s profile`}><ITrash size={15} /> <span className="hide-sm">Delete</span></button>
                <button className="btn" onClick={() => setEditing(true)}>Edit profile</button>
                <button className="btn primary" onClick={upload}><IUpload size={16} /> Analyse a new delivery</button>
              </div>
            </div>
          )}
        </div>

        {s.count === 0 ? (
          <div className="empty">
            <span className="empty-icon"><IVideo size={22} /></span>
            <b>No deliveries yet</b>
            <span style={{ maxWidth: 520 }}>Analyse a clip of {p.name} bowling to start tracking progress. Film the same way each time (same angle, same distance) so sessions compare fairly.</span>
            <button className="btn primary" style={{ marginTop: 8 }} onClick={upload}><IUpload size={16} /> Analyse the first delivery</button>
          </div>
        ) : (
          <>
            <div className="stat-tiles">
              <div className="card stat"><small>Sessions analysed</small><b>{s.count}</b><span className="faint">{dateOf(s.first)} – {dateOf(s.last)}</span></div>
              <div className="card stat">
                <small>Latest score</small><b>{s.latest_score ?? "–"}</b>
                {s.count >= 2 && s.latest_score !== null && s.first_score !== null && (
                  <span className={s.latest_score >= s.first_score ? "up" : "down"}>
                    {s.latest_score >= s.first_score ? "▲" : "▼"} {Math.abs(s.latest_score - s.first_score)} since the first session
                  </span>
                )}
              </div>
              <div className="card stat"><small>Best score</small><b>{s.best_score ?? "–"}</b><span className="faint">out of 100</span></div>
              <div className="card stat">
                <small>Current focus</small>
                <b style={{ fontSize: 17 }}>{data.focus ? data.focus.title : "Keep it up"}</b>
                <span className="faint">{data.focus ? (data.focus.sessions > 1 ? `top priority for ${data.focus.sessions} sessions` : "from the latest session") : "no priority flagged"}</span>
              </div>
            </div>

            <div className="player-grid">
              <div className="card card-pad">
                <div className="card-title">Action score over time</div>
                {scorePts.length ? <Trend points={scorePts} band={[70, 100]} onPick={(id) => go(`/a/${id}`)} /> : <div className="faint">No scores yet (clips need a few reliable measurements for a score).</div>}
                <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Scores only compare fairly between clips filmed from the same angle.</div>
              </div>
              <div className="card card-pad">
                <div className="card-title">Since last time</div>
                {data.sessions.length < 2 ? (
                  <div className="faint">Analyse another delivery to see what changed.</div>
                ) : !data.compared_to ? (
                  <div className="faint">The latest clip is the first one filmed {VIEW_LABEL[latest.view].toLowerCase()}. Film from the same angle next time to compare like with like.</div>
                ) : data.since_last.length === 0 ? (
                  <div className="faint">No reliably measured metrics in common with the previous {VIEW_LABEL[data.compared_to.view].toLowerCase()} clip.</div>
                ) : (
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="faint" style={{ fontSize: 12 }}>Latest clip vs the previous one filmed from the same angle ({dateOf(data.compared_to.created)}).</div>
                    {data.since_last.map((d) => (
                      <div key={d.key} className="row" style={{ gap: 10 }}>
                        <span className={`delta ${d.improved === true ? "up" : d.improved === false ? "down" : "same"}`}>
                          {d.improved === true ? "▲ better" : d.improved === false ? "▼ worse" : "● same"}
                        </span>
                        <span className="grow">{d.label}</span>
                        <span className="mono faint">{fmt(d.before, d.unit === "ms" || d.unit === "cm" ? 0 : 1)} → <b className="muted">{fmt(d.after, d.unit === "ms" || d.unit === "cm" ? 0 : 1)}</b>{unitLabel(d.unit)}</span>
                      </div>
                    ))}
                    <div className="faint" style={{ fontSize: 12 }}>"Same" means the change is within what a single camera can resolve.</div>
                  </div>
                )}
              </div>
            </div>

            {data.focus && (
              <div className="card card-pad focus-card">
                <div className="card-title">Your focus right now</div>
                <div className="row wrap" style={{ gap: 14 }}>
                  <div className="grow">
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{data.focus.title}</div>
                    <div className="muted">{data.focus.headline}</div>
                    {data.focus.first_value !== null && data.focus.latest_value !== null && data.focus.sessions > 1 && (
                      <div className="faint" style={{ marginTop: 4 }}>When it became your focus: {fmt(data.focus.first_value)}. Latest: {fmt(data.focus.latest_value)}.</div>
                    )}
                  </div>
                  {latest && <button className="btn primary" onClick={() => go(`/a/${latest.id}/plan`)}><ICalendar size={15} /> Open the practice plan</button>}
                </div>
              </div>
            )}

            {Object.keys(data.trends).length > 0 && (
              <section>
                <div className="card-title section-label">Key measurements</div>
                <div className="trend-grid">
                  {Object.entries(data.trends).map(([k, t]) => {
                    const last = t.points[t.points.length - 1];
                    const best = data.best[k];
                    const d = t.unit === "ms" || t.unit === "cm" ? 0 : 1;
                    return (
                      <div key={k} className="card card-pad trend-card">
                        <div className="row">
                          <b className="grow">{t.label}</b>
                          <span className={`chip ${last.rating}`}>{fmt(last.value, d)}{unitLabel(t.unit)}</span>
                        </div>
                        <Trend points={t.points.map((pt) => ({ value: pt.value, label: dateOf(pt.created), id: pt.id, rating: pt.rating }))}
                          band={t.good} height={70} format={(v) => v.toFixed(d)} onPick={(id) => go(`/a/${id}`)} />
                        <div className="faint" style={{ fontSize: 12 }}>
                          {t.better && (BETTER_TEXT[t.better] ?? `best inside ${t.better}`)}
                          {best && t.points.length > 1 && <> · personal best {fmt(best.value, d)}{unitLabel(t.unit)} ({dateOf(best.created)})</>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Only values measured reliably for each clip's camera angle are plotted. The shaded band is the good range.</div>
              </section>
            )}

            <section>
              <div className="card-title section-label">Sessions</div>
              <div className="stack" style={{ gap: 8 }}>
                {[...data.sessions].reverse().map((x) => (
                  <div key={x.id} className="card session-row" role="link" tabIndex={0} aria-label={`Open ${x.name}`} onClick={() => go(`/a/${x.id}`)}
                    onKeyDown={(e) => e.key === "Enter" && go(`/a/${x.id}`)}>
                    <span className="mono faint" style={{ width: 64 }}>{dateOf(x.created)}</span>
                    <span className="grow" style={{ fontWeight: 600 }}>{x.name}</span>
                    <span className="chip">{VIEW_LABEL[x.view]}</span>
                    {x.top && <span className="faint hide-sm" style={{ fontSize: 12 }}>Focus: {x.top.title}</span>}
                    <span className="score-pill static">{x.score ?? "–"}<small>/100</small></span>
                    <IChevronRight size={16} className="faint" />
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
      <SiteFooter compact />
    </>
  );
}
