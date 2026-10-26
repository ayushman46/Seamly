import { useCallback, useEffect, useState } from "react";
import { MODE, api } from "../api";
import type { Player, PlayerProgress } from "../types";
import { VIEW_LABEL } from "../lib/constants";
import { fmt, unitLabel, DATE_LOCALE } from "../lib/format";
import { consistency } from "../lib/consistency";
import { AGE_LABEL, STYLE_LABEL, setCurrentPlayer } from "../lib/player";
import Header from "./Header";
import PlayerForm from "./PlayerForm";
import Trend from "./Trend";
import BowlingLog from "./BowlingLog";
import SendToCoach from "./SendToCoach";
import { IAlert, IBack, ICalendar, IChevronRight, IColumns, ITrash, IUpload, IVideo } from "./Icons";
import { SiteFooter } from "./Landing";
import { usePageTitle } from "../lib/title";

const STEADY = { steady: "Steady", some: "Some variation", varies: "Varies a lot" } as const;

const dateOf = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short" }) : "–");
const BETTER_TEXT: Record<string, string> = { higher: "higher is better", lower: "lower is better" };

/** One player's progress: score and key-metric trends, what changed since last time, bests and focus. */
export default function PlayerPage({ pid, go }: { pid: string; go: (to: string) => void }) {
  const [data, setData] = useState<PlayerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  usePageTitle(data ? `${data.player.name}'s progress` : null);

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
  const cons = consistency(data.sessions);
  // the highest-scoring other delivery filmed from the latest one's angle: the overlay shows what changed
  const best = latest ? data.sessions.filter((x) => x.view === latest.view && x.id !== latest.id && x.score !== null)
    .reduce<typeof latest | null>((a, x) => (!a || (x.score ?? 0) > (a.score ?? 0) ? x : a), null) : null;
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
      <Header go={go} />
      <main className="page" id="main" tabIndex={-1}>
        <button type="button" className="back-link" onClick={() => go("/")} style={{ marginBottom: 10 }}><IBack size={15} /> Your analyses</button>
        <div className="card profile-card">
          {editing ? (
            <>
              <div role="heading" aria-level={2} className="card-title">Edit profile</div>
              <PlayerForm initial={p} submitLabel="Save profile" onSave={save} onCancel={() => setEditing(false)} />
              <div className="divider" />
              <button className="btn ghost sm" onClick={remove}><ITrash size={14} /> Delete {p.name}'s profile</button>
            </>
          ) : (
            <div className="row wrap" style={{ gap: 16 }}>
              <div className="player-avatar">{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="grow" style={{ minWidth: 200 }}>
                <h1 className="profile-name">{p.name}</h1>
                <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                  <span className="chip">{AGE_LABEL[p.age_group]}</span>
                  <span className="chip">{STYLE_LABEL[p.style]}</span>
                  {p.arm !== "auto" && <span className="chip">{p.arm === "right" ? "Right-arm" : "Left-arm"}</span>}
                  {p.height_cm && <span className="chip">{Math.round(p.height_cm)} cm</span>}
                </div>
              </div>
              <div className="profile-actions">
                <button className="btn" onClick={() => setEditing(true)}>Edit profile</button>
                {MODE === "browser" && s.count > 0 && <SendToCoach player={p} />}
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
        ) : null}
        {s.count === 0 && <div style={{ marginTop: 18 }}><BowlingLog player={data.player} onChange={(pl) => setData((d) => (d ? { ...d, player: { ...d.player, ...pl } } : d))} /></div>}
        {s.count === 0 ? null : (
          <>
            <div className="stat-tiles">
              <div className="card stat"><small>Sessions analysed</small><b>{s.count}</b><span className="faint">{dateOf(s.first) === dateOf(s.last) ? dateOf(s.first) : `${dateOf(s.first)} – ${dateOf(s.last)}`}</span></div>
              <div className="card stat">
                <small>Latest score</small><b>{s.latest_score ?? "–"}</b>
                {s.count >= 2 && s.latest_score !== null && s.first_score !== null && (
                  <span className={s.latest_score >= s.first_score ? "up" : "down"}>
                    {s.latest_score === s.first_score ? "Same as the first session" : `${s.latest_score > s.first_score ? "▲" : "▼"} ${Math.abs(s.latest_score - s.first_score)} since the first session`}
                  </span>
                )}
              </div>
              <div className="card stat"><small>Best score</small><b>{s.best_score ?? "–"}</b><span className="faint">{s.count > 1 && s.best_score !== null && s.best_score === s.latest_score ? "the latest is the best" : "out of 100"}</span></div>
            </div>

            <div className="player-grid">
              <div className="card card-pad">
                <div role="heading" aria-level={2} className="card-title">Action score over time</div>
                {scorePts.length ? <Trend points={scorePts} band={[70, 100]} onPick={(id) => go(`/a/${id}`)} /> : <div className="faint">No scores yet (clips need a few reliable measurements for a score).</div>}
                <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Scores only compare fairly between clips filmed from the same angle.</div>
              </div>
              <div className="card card-pad">
                <div role="heading" aria-level={2} className="card-title">Since last time</div>
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
                      <div key={d.key} className="row since-row" style={{ gap: 10 }}>
                        <span className={`delta ${d.improved === true ? "up" : d.improved === false ? "down" : "same"}`}>
                          {d.improved === true ? "▲ better" : d.improved === false ? "▼ worse" : d.rated === false ? "○ info" : "● no clear change"}
                        </span>
                        <span className="grow">{d.label}</span>
                        <span className="mono faint">{fmt(d.before, 0)} → <b className="muted">{fmt(d.after, 0)}</b>{unitLabel(d.unit)}</span>
                      </div>
                    ))}
                    <div className="faint" style={{ fontSize: 12 }}>"No clear change" means the difference is within what one camera can resolve at this frame rate (a value read one frame earlier or later can differ that much). "Info" values have no target range, so they aren't called better or worse.</div>
                  </div>
                )}
                {best && latest && (
                  <button type="button" className="btn sm" style={{ marginTop: 12 }} onClick={() => go(`/compare/${best.id}/${latest.id}/overlay`)}>
                    <IColumns size={14} /> Overlay the latest on your {latest.score !== null && latest.score >= (best.score ?? 0) ? "previous best" : "best"} ({best.score}/100)
                  </button>
                )}
              </div>
            </div>

            {data.pace && data.pace.length > 0 && (() => {
              const pts = data.pace!;
              const best = pts.reduce((m, x) => (x.kmh > m.kmh ? x : m), pts[0]), last = pts[pts.length - 1];
              // within a session: pace coaches end speed work once balls drop about 5% below the day's best
              const today = pts.filter((x) => new Date(x.created * 1000).toDateString() === new Date(last.created * 1000).toDateString());
              const dayBest = today.reduce((m, x) => (x.kmh > m.kmh ? x : m), today[0]);
              // from the speeds as shown, so the note agrees with the numbers on the card
              const drop = today.length > 1 && dayBest !== last ? (1 - Math.round(last.kmh) / Math.round(dayBest.kmh)) * 100 : 0;
              const sameDay = new Date(pts[0].created * 1000).toDateString() === new Date(last.created * 1000).toDateString();
              const when = (ts: number) => sameDay ? new Date(ts * 1000).toLocaleTimeString(DATE_LOCALE, { hour: "2-digit", minute: "2-digit" }) : dateOf(ts);
              return (
                <section className="card card-pad speed-card" aria-labelledby="speed-title">
                  <div role="heading" aria-level={2} id="speed-title" className="card-title">Ball speed</div>
                  <div className="speed-grid">
                    <dl className="speed-stats">
                      <div><dt>Latest</dt><dd><span className="pace-big sm">{Math.round(last.kmh)}<small> km/h</small></span><span className="faint">{Math.round(last.lo)}–{Math.round(last.hi)}</span></dd></div>
                      {pts.length > 1 && <div><dt>Best</dt><dd><span className="pace-big sm">{Math.round(best.kmh)}<small> km/h</small></span><span className="faint">{dateOf(best.created)}</span></dd></div>}
                    </dl>
                    {pts.length > 1
                      ? <div className="speed-chart"><Trend points={pts.map((x) => ({ value: x.kmh, range: [x.lo, x.hi] as [number, number], label: `${dateOf(x.created)}: ${Math.round(x.lo)}–${Math.round(x.hi)} km/h`, id: x.id }))} height={96} format={(v) => `${Math.round(v)}`} onPick={(i) => go(`/a/${i}`)} />
                          <div className="faint speed-dates"><span>{when(pts[0].created)}</span><span>{when(last.created)}</span></div></div>
                      : <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Measure the ball speed on another delivery to see the trend.</p>}
                  </div>
                  {drop >= 5 && (
                    <p className="speed-drop">
                      The latest ball is {Math.round(drop)}% below the best of that session ({Math.round(dayBest.kmh)} km/h). Pace coaches usually end
                      speed work at about 5% down: more balls then train a slower action.
                      {last.hi >= dayBest.lo && <span className="faint"> The two ranges overlap, so part of it may be the frame timing.</span>}
                    </p>
                  )}
                </section>
              );
            })()}

            {data.focus && (
              <div className="card card-pad focus-card">
                <div role="heading" aria-level={2} className="card-title">Your focus right now</div>
                <div className="row wrap" style={{ gap: 14 }}>
                  <div className="grow">
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{data.focus.title}</div>
                    <div className="muted">{data.focus.headline}</div>
                    {data.focus.first_value !== null && data.focus.latest_value !== null && data.focus.sessions > 1 && (
                      <div className="faint" style={{ marginTop: 4 }}>When it became your focus: {fmt(data.focus.first_value)}{unitLabel(data.trends[data.focus.key]?.unit ?? "")}. Latest: {fmt(data.focus.latest_value)}{unitLabel(data.trends[data.focus.key]?.unit ?? "")}.</div>
                    )}
                  </div>
                  {latest && <button className="btn primary" onClick={() => go(`/a/${latest.id}/plan`)}><ICalendar size={15} /> Open the practice plan</button>}
                </div>
              </div>
            )}

            {cons.rows.length > 0 && cons.view && (
              <section className="card card-pad" aria-labelledby="cons-title">
                <div className="row wrap" style={{ gap: 8 }}>
                  <div role="heading" aria-level={2} id="cons-title" className="card-title grow" style={{ margin: 0 }}>Consistency</div>
                  <span className="faint" style={{ fontSize: 12 }}>last {Math.max(...cons.rows.map((r) => r.n))} deliveries · {VIEW_LABEL[cons.view].toLowerCase()}</span>
                </div>
                <p className="faint" style={{ fontSize: 12.5, margin: "6px 0 12px" }}>How much each measurement moves from ball to ball. A repeatable action is the base for accuracy.</p>
                <div className="cons-list">
                  {cons.rows.map((r) => {
                    const d = r.unit === "ms" || r.unit === "cm" ? 0 : 1;   // the spread keeps a decimal; the mean is whole
                    return (
                      <div key={r.key} className="cons-row">
                        <span className="grow">{r.label}</span>
                        <span className="mono faint">{fmt(r.mean, 0)} ± {fmt(r.sd, d)}{unitLabel(r.unit)}</span>
                        <span className={`chip ${r.level === "steady" ? "good" : r.level === "some" ? "watch" : "risk"}`}
                          title={`One camera resolves about ±${fmt(r.noise, 0)}${unitLabel(r.unit)} here`}>{STEADY[r.level]}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {Object.keys(data.trends).length > 0 && (
              <section>
                <div role="heading" aria-level={2} className="card-title section-label">Key measurements</div>
                <div className="trend-grid">
                  {Object.entries(data.trends).map(([k, t]) => {
                    const last = t.points[t.points.length - 1];
                    const best = data.best[k];
                    const d = 0;
                    return (
                      <div key={k} className="card card-pad trend-card">
                        <div className="row">
                          <b className="grow">{t.label}</b>
                          <span className={`chip ${last.rating}`}>{fmt(last.value, d)}{unitLabel(t.unit)}</span>
                        </div>
                        <Trend points={t.points.map((pt) => ({ value: pt.value, label: dateOf(pt.created), id: pt.id, rating: pt.rating }))}
                          band={t.good} height={70} format={(v) => fmt(v, d)} onPick={(id) => go(`/a/${id}`)} />
                        <div className="faint" style={{ fontSize: 12 }}>
                          {/* the target range, not "higher is better" (which would invite a locked, hyperextended knee) */}
                          {t.good && (t.good[0] !== null || t.good[1] !== null)
                            ? (t.good[0] !== null && t.good[1] !== null ? `aim for ${fmt(t.good[0], 0)}–${fmt(t.good[1], 0)}${unitLabel(t.unit)}`
                              : t.good[0] !== null ? `aim for ${fmt(t.good[0], 0)}${unitLabel(t.unit)} or more` : `aim for ${fmt(t.good[1], 0)}${unitLabel(t.unit)} or less`)
                            : t.better && (BETTER_TEXT[t.better] ?? `best inside ${t.better}`)}
                          {best && t.points.length > 1 && <> · personal best {fmt(best.value, d)}{unitLabel(t.unit)} ({dateOf(best.created)})</>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Only values measured reliably for each clip's camera angle are plotted. Where a card has a shaded band, that is the good range.</div>
              </section>
            )}

            <BowlingLog player={data.player} onChange={(pl) => setData((d) => (d ? { ...d, player: { ...d.player, ...pl } } : d))} />

            <section>
              <div role="heading" aria-level={2} className="card-title section-label">Sessions</div>
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
