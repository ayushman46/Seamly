import { useCallback, useEffect, useRef, useState } from "react";
import { MODE, api } from "../api";
import type { AnalysisMeta, Player } from "../types";
import { AGE_LABEL, STYLE_LABEL, getCurrentPlayer, setCurrentPlayer } from "../lib/player";
import PlayerForm from "./PlayerForm";
import { BackupPanel, RestoreLink } from "./Backup";
import { modelsCached } from "../lib/modelCache";
import { ago, fmt } from "../lib/format";
import { VIEW_LABEL, SLOWMO_OPTIONS } from "../lib/constants";
import Header, { scrollToId } from "./Header";
import { Faq, FilmingGuide, Hero, SiteFooter, WhatYouGet } from "./Landing";
import { IAlert, ICheck, IChevronRight, IColumns, ILock, IPlus, ITrash, IUsers, IVideo } from "./Icons";

const MAX_MB = 500;
// a typical height for each age group, as the example in the height field
const TYPICAL_CM: Record<string, number> = { u11: 138, u13: 149, u15: 161, u17: 170, u19: 175, adult: 180 };
const RETURNING_KEY = "seamly-returning";   // remembers whether this browser has data, so the first paint picks the right layout
type Health = { ok: boolean; device: string; missing_models: string[] };
type Sample = "club" | "synthetic";

function readReturning(): boolean {
  try { return localStorage.getItem(RETURNING_KEY) === "1"; } catch { return false; }
}
/** A new analysis exists: coming back to this page should open the workspace straight away. */
function markReturning() {
  try { localStorage.setItem(RETURNING_KEY, "1"); } catch { /* not remembered */ }
}

export default function Home({ go }: { go: (to: string) => void }) {
  const [items, setItems] = useState<AnalysisMeta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const [current, setCurrent] = useState<string | null>(getCurrentPlayer());
  const [filter, setFilter] = useState<string>("all");
  const [adding, setAdding] = useState(false);
  const [demoBusy, setDemoBusy] = useState<Sample | null>(null);
  const [demoErr, setDemoErr] = useState<string | null>(null);
  const [attention, setAttention] = useState(0);
  const [restored, setRestored] = useState<string | null>(null);   // outcome of a restore from the first-visit page
  const choosePlayer = (id: string | null) => { setCurrent(id); setCurrentPlayer(id); };
  const refreshPlayers = useCallback(() => {
    api.players().then((ps) => {
      setPlayers(ps);
      // forget a remembered player that no longer exists
      setCurrent((c) => (c && !ps.some((p) => p.id === c) ? (setCurrentPlayer(null), null) : c));
    }).catch(() => undefined).finally(() => setPlayersLoaded(true));
  }, []);
  useEffect(() => { refreshPlayers(); }, [refreshPlayers]);
  const createPlayer = async (fields: Partial<Player>) => {
    const p = await api.createPlayer(fields);
    choosePlayer(p.id);
    setAdding(false);
    refreshPlayers();
  };
  // made from the uploader: a first player turns the page into the workspace, whose uploader sits elsewhere
  const createFromUploader = async (fields: Partial<Player>) => {
    await createPlayer(fields);
    window.setTimeout(() => document.getElementById("analyse")?.scrollIntoView({ block: "center" }), 120);
  };
  const shown = items && (filter === "all" ? items : items.filter((m) => (filter === "none" ? !m.player_id : m.player_id === filter)));
  const nameOf = (pid?: string | null) => players.find((p) => p.id === pid)?.name;
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  const refresh = useCallback(() => {
    api.list().then((l) => { setItems(l); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    refresh();
    api.health().then(setHealth).catch(() => setHealth({ ok: false, device: "?", missing_models: [MODE === "server" ? "server offline" : "analysis engine failed to start"] }));
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // layout: first-time visitors get the full landing hero; people with analyses or players get their workspace first
  const known = (items !== null || err !== null) && playersLoaded;
  const hasData = (items?.length ?? 0) > 0 || players.length > 0;
  const [guess] = useState(readReturning);
  const returning = known ? hasData : guess;
  useEffect(() => {
    if (!known) return;
    try { if (hasData) localStorage.setItem(RETURNING_KEY, "1"); else localStorage.removeItem(RETURNING_KEY); } catch { /* not remembered */ }
  }, [known, hasData]);

  const disabled = health !== null && !health.ok;
  const demo = async (which: Sample = "club") => {
    setDemoBusy(which);
    setDemoErr(null);
    try {
      const { id } = await api.demo(which);
      markReturning();
      go(`/a/${id}`);
      // if this page is still showing later (the user came straight back), the links work again
      window.setTimeout(() => setDemoBusy(null), 1500);
    } catch (e) {
      setDemoErr((e as Error).message);
      setDemoBusy(null);
    }
  };
  const toUploader = () => {
    scrollToId("analyse");
    setAttention((n) => n + 1);
  };

  const uploader = (
    <Uploader go={go} disabled={disabled} health={health} players={players} current={current} onChoose={choosePlayer} onCreate={createFromUploader}
      onDemo={demo} demoBusy={demoBusy} demoError={demoErr} attention={attention} compact={returning} />
  );

  return (
    <>
      <Header go={go} nav={!returning}>
        <button type="button" className="btn primary sm" onClick={toUploader} aria-label="Analyse a delivery"><IVideo size={15} /> <span className="btn-label">Analyse a delivery</span><span className="btn-label-sm" aria-hidden="true">Analyse</span></button>
      </Header>
      <main id="main" tabIndex={-1}>
        {returning ? (
          <div className="container ws">
            <div className="ws-head">
              <div>
                <h1 className="ws-title">{items && items.length === 0 ? "Analyse your first delivery" : "Ready for the next delivery?"}</h1>
                <p className="muted" style={{ margin: 0 }}>
                  {MODE === "browser" ? "Everything here is saved in this browser, on this device." : "Analyses and players saved on your Seamly server."}
                </p>
              </div>
            </div>
            {restored && <div className="notice ok" role="status" style={{ marginBottom: 16 }}><ICheck size={16} /> <div>{restored}</div></div>}
            <div className="ws-grid">
              {uploader}
              <aside className="ws-side" id="ws-players" aria-labelledby="players-title">
                <PlayersPanel players={players} current={current} adding={adding} setAdding={setAdding} onCreate={createPlayer} go={go} />
              </aside>
            </div>
            <section className="ws-section" id="ws-analyses" aria-labelledby="analyses-title">
              <div className="ws-section-head">
                <h2 id="analyses-title">Your analyses</h2>
                {shown && <span className="count">{shown.length}</span>}
                {players.length > 0 && (
                  <select className="input" style={{ height: 34, width: 180, fontSize: 13 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show analyses for">
                    <option value="all">All players</option>
                    {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    <option value="none">No player</option>
                  </select>
                )}
                <div className="grow" />
                {picked.length === 2 ? (
                  <button className="btn primary sm" onClick={() => go(`/compare/${picked[0]}/${picked[1]}`)}><IColumns size={15} /> Compare selected</button>
                ) : items && items.filter((m) => m.status === "done").length >= 2 ? (
                  <span className="faint hide-sm" style={{ fontSize: 12.5 }}>Tick two analyses to compare them side by side</span>
                ) : null}
              </div>
              {err && <div className="notice warn" style={{ marginBottom: 12 }}><IAlert size={16} /> <div>Couldn't load your analyses: {err}</div></div>}
              {!items && !err && (
                <div className="history-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton-box" style={{ height: 230 }} />)}</div>
              )}
              {shown && shown.length === 0 && (
                <div className="empty">
                  <span className="empty-icon"><IVideo size={22} /></span>
                  <b>{filter === "all" ? "No analyses yet" : "Nothing for this filter yet"}</b>
                  <span>{filter === "all" ? "Add a clip above, or try a sample delivery to see what you get." : "Pick another player, or analyse a delivery for this one."}</span>
                </div>
              )}
              {shown && shown.length > 0 && (
                <div className="history-grid">
                  {shown.map((m) => <HistoryCard key={m.id} m={m} go={go} onDeleted={refresh} picked={picked.includes(m.id)} onPick={() => togglePick(m.id)} player={nameOf(m.player_id)} />)}
                </div>
              )}
            </section>
            {/* on a phone the header button is far above the ticked cards: keep one in reach */}
            {picked.length === 2 && (
              <div className="compare-fab">
                <button className="btn primary" onClick={() => go(`/compare/${picked[0]}/${picked[1]}`)}><IColumns size={15} /> Compare the 2 selected</button>
              </div>
            )}
            {MODE === "browser" && <BackupPanel restored={restored} onRestored={() => { refresh(); refreshPlayers(); }} />}
          </div>
        ) : (
          <>
            <Hero onAnalyse={toUploader} onDemo={() => demo("club")} demoBusy={demoBusy !== null} demoError={demoErr} disabled={disabled} />
            <section className="section" id="analyse-section" style={{ paddingTop: 24, paddingBottom: 72 }} aria-labelledby="start-title">
              <div className="container">
                <div className="start-solo">
                  <h2 className="section-title start-title" id="start-title">Analyse your first delivery</h2>
                  {uploader}
                  {MODE === "browser" && <RestoreLink onRestored={(text) => { setRestored(text); refresh(); refreshPlayers(); }} />}
                </div>
              </div>
            </section>
          </>
        )}
        {!returning && <WhatYouGet />}
        {!returning && <FilmingGuide />}
        {!returning && <Faq />}
      </main>
      <SiteFooter />
    </>
  );
}

function PlayersPanel({ players, current, adding, setAdding, onCreate, go }: {
  players: Player[]; current: string | null; adding: boolean; setAdding: (b: boolean) => void;
  onCreate: (p: Partial<Player>) => Promise<void>; go: (to: string) => void;
}) {
  return (
    <>
      <div className="ws-section-head" style={{ marginBottom: 4 }}>
        <h2 id="players-title" style={{ fontSize: 17 }}>Players</h2>
        {players.length > 0 && <span className="count">{players.length}</span>}
        <div className="grow" />
        {!adding && players.length > 0 && <button className="btn sm" onClick={() => setAdding(true)}><IPlus size={14} /> Add player</button>}
      </div>
      {adding && (
        <div className="card card-pad">
          <div role="heading" aria-level={2} className="card-title">New player</div>
          <PlayerForm submitLabel="Create player" onSave={onCreate} onCancel={() => setAdding(false)} />
        </div>
      )}
      {players.length === 0 && !adding ? (
        <div className="card card-pad players-empty">
          <span className="empty-icon" style={{ width: 40, height: 40, borderRadius: 12 }}><IUsers size={19} /></span>
          <b>Track a bowler's progress</b>
          <span className="muted">One profile per bowler: progress, personal bests and a practice plan for their age.</span>
          <button className="btn primary sm" style={{ marginTop: 4 }} onClick={() => setAdding(true)}><IPlus size={14} /> Create a player</button>
        </div>
      ) : (
        <div className="player-cards">
          {players.map((p) => (
            <div key={p.id} className={`card player-card ${p.id === current ? "on" : ""}`} role="link" tabIndex={0} aria-label={`${p.name}'s progress`}
              onClick={() => go(`/p/${p.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/p/${p.id}`)}>
              <div className="player-avatar sm">{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="grow">
                <div className="pc-name">{p.name}</div>
                <div className="pc-sub">{AGE_LABEL[p.age_group]} · {STYLE_LABEL[p.style]} · {p.analyses} {p.analyses === 1 ? "delivery" : "deliveries"}</div>
              </div>
              {p.latest_score !== null && <span className="score-pill static">{p.latest_score}<small>/100</small></span>}
              <IChevronRight size={16} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function HistoryCard({ m, go, onDeleted, picked, onPick, player }: { m: AnalysisMeta; go: (to: string) => void; onDeleted: () => void; picked: boolean; onPick: () => void; player?: string }) {
  const thumb = m.status === "done" && m.thumb_frame !== null ? `url(${api.frameUrl(m.id, m.thumb_frame)})` : undefined;
  const del = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete "${m.name}"? This removes the video and results.`)) return;
    try {
      await api.remove(m.id);
      onDeleted();
    } catch (er) {
      alert((er as Error).message);
    }
  };
  return (
    <div className={`card hcard ${picked ? "picked" : ""}`}>
      <div className="hthumb" style={{ backgroundImage: thumb }}>
        {m.status === "done" && m.score !== null && (
          <span className="score-pill">{m.score}<small>/100</small></span>
        )}
        {m.status === "done" && m.grade && <span className="chip good grade">{m.grade}</span>}
        {m.status !== "done" && (
          <div className="hthumb-state">
            {m.status === "failed" ? <span className="chip risk"><IAlert size={13} /> Couldn't analyse</span> : (
              <div className="stack" style={{ alignItems: "center", gap: 10 }}>
                <div className="spinner" />
                <span className="faint" style={{ fontSize: 12.5 }}>{m.stage_label || "Queued"} · {Math.round((m.progress || 0) * 100)}%</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="hbody">
        <a className="hname hcard-link" href={`#/a/${m.id}`} title={m.name}
          aria-label={`Open ${m.name}, ${ago(m.created)}${m.score !== null ? `, score ${m.score}` : ""}`}
          onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(`/a/${m.id}`); } }}>{m.name}</a>
        <div className="hmeta">
          {player && <span className="chip info">{player}</span>}
          {m.view && <span className="chip">{VIEW_LABEL[m.view]}</span>}
          {m.arm && <span className="chip" title={m.arm_conf != null && m.arm_conf < 0.7 ? "Detected bowling arm, not certain: check it in Detection & settings" : undefined}>
            {m.arm === "right" ? "Right-arm" : "Left-arm"}{m.arm_conf != null && m.arm_conf < 0.7 ? "?" : ""}</span>}
        </div>
      </div>
      <div className="hfoot">
        <span className="faint" title={m.timing_s ? `Analysed in ${fmt(m.timing_s)} s` : undefined}>{ago(m.created)}</span>
        <div className="grow" />
        {m.status === "done" && (
          <label className="pick" title="Select to compare" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={picked} onChange={onPick} /> Compare
          </label>
        )}
        <button className="btn ghost sm icon" onClick={del} title="Delete" aria-label={`Delete ${m.name}`}><ITrash size={15} /></button>
      </div>
    </div>
  );
}

function Uploader({ go, disabled, health, players, current, onChoose, onCreate, onDemo, demoBusy, demoError, attention, compact }: {
  go: (to: string) => void; disabled: boolean; health: Health | null; players: Player[]; current: string | null;
  onChoose: (id: string | null) => void; onCreate: (p: Partial<Player>) => Promise<void>;
  onDemo: (which: Sample) => void; demoBusy: Sample | null; demoError: string | null; attention: number; compact: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [arm, setArm] = useState("auto");
  const [height, setHeight] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const player = players.find((p) => p.id === current) ?? null;
  // the selected player's profile fills in arm and height (still editable for this clip)
  useEffect(() => {
    setArm(player && player.arm !== "auto" ? player.arm : "auto");
    setHeight(player?.height_cm ? String(Math.round(player.height_cm)) : "");
  }, [player?.id, player?.arm, player?.height_cm]);
  const [slowmo, setSlowmo] = useState("1");
  const [moreOpen, setMoreOpen] = useState(false);
  const optionsSummary = [arm !== "auto" ? `${arm === "right" ? "Right" : "Left"}-arm` : "", height ? `${height} cm` : "",
    slowmo !== "1" ? `${slowmo}× slow motion` : ""].filter(Boolean).join(" · ") || "arm, height, slow motion";
  // the "big first download" note only matters until the models are in this browser
  const [cached, setCached] = useState(false);
  useEffect(() => { if (MODE === "browser") void modelsCached().then(setCached); }, []);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  // a "start here" button elsewhere on the page points people at the drop zone
  useEffect(() => {
    if (!attention) return;
    setFlash(true);
    const t = window.setTimeout(() => { zone.current?.focus({ preventScroll: true }); }, 450);
    const u = window.setTimeout(() => setFlash(false), 1400);
    return () => { clearTimeout(t); clearTimeout(u); };
  }, [attention]);

  const pick = (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    if (!/\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(f.name)) {
      setError("Please choose a video file (MP4, MOV, AVI, MKV or WEBM).");
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`That file is ${(f.size / 1e6).toFixed(0)} MB — please trim it under ${MAX_MB} MB.`);
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    const h = height ? Number(height) : undefined;
    if (h !== undefined && (!isFinite(h) || h < 120 || h > 230)) {
      setError("Height should be between 120 and 230 cm.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.upload(file, { bowling_arm: arm, height_cm: h, slowmo_factor: Number(slowmo), player_id: player?.id ?? null }, setProg);
      markReturning();
      go(`/a/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const browse = () => !busy && input.current?.click();
  const shownError = error ?? demoError;

  return (
    <div className={`card uploader ${compact ? "compact" : ""}`} id="analyse">
      <div className="uploader-head">
        {compact && <h2>Analyse a delivery</h2>}
        <div className="grow" />
        {health === null ? (
          <span className="engine-status"><div className="spinner sm" /> Starting the analysis engine…</span>
        ) : health.ok ? (
          <span className="engine-status" title={`Analysis engine: ${health.device}`}><span className="dot pulse" style={{ background: "var(--c-accent)" }} />
            Ready</span>
        ) : (
          <span className="engine-status" style={{ color: "#fecaca" }}><span className="dot" style={{ background: "var(--c-risk)" }} /> Engine unavailable</span>
        )}
      </div>
      {health && !health.ok && (
        <div className="notice error" style={{ marginBottom: 14 }}><IAlert size={16} /> <div>The analysis engine isn't available right now ({health.missing_models.join(", ")}). Try reloading the page, or use a recent version of Chrome, Edge, Safari or Firefox.</div></div>
      )}
      <div
        ref={zone}
        className={`dropzone ${over ? "over" : ""} ${file ? "has-file" : ""} ${flash ? "attention" : ""}`}
        role="button" tabIndex={0} aria-label={file ? `Selected video ${file.name}. Press to choose a different file.` : "Choose a bowling video"}
        onClick={browse}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
      >
        <input ref={input} type="file" accept="video/*,.mp4,.mov,.m4v,.avi,.mkv,.webm" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <span className="dz-icon"><IVideo size={24} /></span>
        <h3>{file ? file.name : "Choose or drop a bowling video"}</h3>
        <div className="dz-sub">{file ? `${(file.size / 1e6).toFixed(1)} MB · choose again to change` : "MP4, MOV, AVI, MKV or WEBM · one delivery works best"}</div>
        {MODE === "browser" && <div className="dz-local"><ILock size={13} /> Stays on your device</div>}
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="who-bowling">Who's bowling?</label>
        {creating ? (
          <div className="card card-pad sunken">
            <PlayerForm submitLabel="Create & select" onSave={async (p) => { await onCreate(p); setCreating(false); }} onCancel={() => setCreating(false)} />
          </div>
        ) : (
          <select id="who-bowling" className="input" value={current ?? ""}
            onChange={(e) => (e.target.value === "__new" ? (setCreating(true), setError(null)) : onChoose(e.target.value || null))}>
            <option value="">Just this clip (no player)</option>
            {players.map((p) => <option key={p.id} value={p.id}>{p.name} · {AGE_LABEL[p.age_group]} · {STYLE_LABEL[p.style]}</option>)}
            <option value="__new">+ New player…</option>
          </select>
        )}
      </div>
      <details className="upload-more" open={moreOpen} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Options <span className="faint">{optionsSummary}</span></summary>
        <div className="upload-opts">
          {/* while a new player is being created, their form asks for arm and height itself */}
          {!creating && <>
          <div className="field">
            <span className="label" id="arm-label">Bowling arm</span>
            <div className="seg" role="group" aria-labelledby="arm-label">
              {["auto", "right", "left"].map((a) => (
                <button key={a} type="button" className={arm === a ? "on" : ""} aria-pressed={arm === a} onClick={() => setArm(a)}>{a === "auto" ? "Auto" : a[0].toUpperCase() + a.slice(1)}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="up-height">Height (cm, optional)</label>
            <input id="up-height" className="input" inputMode="numeric" placeholder={`e.g. ${TYPICAL_CM[player?.age_group ?? "adult"] ?? 180}`} value={height} onChange={(e) => setHeight(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          </>}
          <div className="field">
            <label htmlFor="up-speed">Clip speed (slow motion?)</label>
            <select id="up-speed" className="input" value={slowmo} onChange={(e) => setSlowmo(e.target.value)}>
              {SLOWMO_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="hint faint" style={{ fontSize: 12, marginTop: 10 }}>
          Clip speed: only if the video plays back in slow motion when you watch it (phone slo-mo is usually 4× or 8×).
        </div>
      </details>
      {shownError && <div className="notice error" role="alert" style={{ marginTop: 14 }}><IAlert size={16} /> <div>{shownError}</div></div>}
      <div style={{ flex: 1 }} />
      <div className="upload-foot">
        {busy ? (
          <div>
            <div className="busy-line"><div className="spinner" /><span>{MODE === "browser" ? "Preparing your video…" : "Uploading…"} {Math.round(prog * 100)}%</span></div>
            <div className="progress"><i style={{ width: `${prog * 100}%` }} /></div>
          </div>
        ) : (
          <>
            <button type="button" className="btn primary lg block" disabled={!file || disabled} onClick={submit}>
              Analyse delivery
            </button>
            {MODE === "browser" && !cached && (
              <span className="faint" style={{ fontSize: 12, textAlign: "center" }}>
                The first analysis downloads the analysis models (about 70 MB, once) — Wi-Fi is best.
              </span>
            )}
            <div className="demo-link">
              <span className="faint">No video? Try an example:</span>{" "}
              <button type="button" className="link-btn" disabled={disabled || demoBusy !== null} onClick={() => onDemo("club")}>
                {demoBusy === "club" ? "Opening…" : "club match"}</button>
              <span className="faint"> · </span>
              <button type="button" className="link-btn" disabled={disabled || demoBusy !== null} onClick={() => onDemo("synthetic")}>
                {demoBusy === "synthetic" ? "Opening…" : "3D test bowler"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
