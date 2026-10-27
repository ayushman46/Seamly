import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, Player, PlayerProgress } from "../types";
import { AGE_LABEL, STYLE_LABEL } from "../lib/player";
import { isoDate, workload } from "../lib/bowlingLog";
import { DATE_LOCALE } from "../lib/format";
import { IBack, IDownload, IUsers } from "./Icons";
import Header from "./Header";
import { usePageTitle } from "../lib/title";

type Back = "ok" | "watch" | "flag" | "unknown";
interface Row {
  player: Player;
  clips: number;
  last: number | null;           // seconds
  score: number | null;
  speed: number | null;          // best measured ball speed, km/h
  speeds: number;
  knee: { value: number; rating: string } | null;      // front knee at release, latest measured
  trunk: { value: number; rating: string } | null;     // trunk lean at release (side-on) or side-bend (behind), latest
  trunkKey: "trunk_forward_br" | "trunk_lateral_br" | null;
  height: { value: number; rating: string } | null;    // release height, % of stature
  back: Back;
  week: number | null;           // balls in the last 7 days (bowling log)
  ratio: number | null;          // acute:chronic workload
  zone: string | null;
  checks: { legal: number; no_ball: number; close: number };
}

type SortKey = "name" | "clips" | "last" | "score" | "speed" | "knee" | "trunk" | "height" | "back" | "week" | "ratio" | "noballs";
const BACK_ORDER: Record<Back, number> = { flag: 3, watch: 2, ok: 1, unknown: 0 };
const BACK_TEXT: Record<Back, string> = { ok: "No red flags", watch: "Watch", flag: "Flag", unknown: "Not checked" };
const DOT: Record<string, string> = { good: "ok", watch: "watch", risk: "flag" };

/** Balls bowled in the last 7 days, today included (from the bowling log). */
function ballsLast7(log: { date: string; balls: number }[]): number {
  const d = new Date(); d.setDate(d.getDate() - 6);
  const from = isoDate(d);
  return log.filter((e) => e.date >= from).reduce((n, e) => n + e.balls, 0);
}

/** The latest measured value of a metric across a player's sessions (newest first). */
function latest(p: PlayerProgress, key: string): { value: number; rating: string } | null {
  const ss = [...p.sessions].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  for (const s of ss) {
    const m = s.metrics[key];
    if (m && m.reliability === "measured" && Number.isFinite(m.value)) return { value: m.value, rating: m.rating };
  }
  return null;
}

/**
 * Squad: every player's latest numbers side by side, for a coach or an analyst, sortable, with a CSV for spreadsheets.
 * Players send their own file from their player page ("Send to coach"); the coach adds it with "Restore a backup".
 */
export default function SquadPage({ go }: { go: (to: string) => void }) {
  usePageTitle("Squad");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });

  useEffect(() => {
    let live = true;
    (async () => {
      const [players, metas] = await Promise.all([api.players(), api.list()]);
      const out: Row[] = [];
      for (const pl of players) {
        const prog = await api.progress(pl.id);
        const mine = metas.filter((m: AnalysisMeta) => m.player_id === pl.id && m.status === "done");
        const newest = [...mine].sort((a, b) => b.created - a.created)[0];
        let back: Back = "unknown";
        if (newest) {
          try {
            // a ball filmed by two cameras has the complete screen; one camera sees only part of it
            const two = newest.pair ? await api.twoView(newest.id, newest.pair).catch(() => null) : null;
            back = two && two.status === "ok" ? two.view.back?.overall ?? "unknown" : (await api.insights(newest.id)).back_health?.overall ?? "unknown";
          } catch { back = "unknown"; }
        }
        const fwd = latest(prog, "trunk_forward_br"), lat = latest(prog, "trunk_lateral_br");
        const wl = workload(pl.log ?? [], new Date());
        const speeds = prog.pace ?? [];
        const checks = { legal: 0, no_ball: 0, close: 0 };
        for (const m of mine) if (m.crease) checks[m.crease.verdict]++;
        out.push({
          player: pl, clips: prog.stats.count, last: prog.stats.last, score: prog.stats.latest_score,
          speed: speeds.length ? Math.max(...speeds.map((x) => x.kmh)) : null, speeds: speeds.length,
          knee: latest(prog, "front_knee_br"), trunk: fwd ?? lat, trunkKey: fwd ? "trunk_forward_br" : lat ? "trunk_lateral_br" : null,
          height: latest(prog, "release_height_pct"), back,
          week: pl.log?.length ? ballsLast7(pl.log) : null, ratio: wl?.ratio ?? null, zone: wl?.zone ?? null, checks,
        });
      }
      if (live) setRows(out);
    })().catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const val = (r: Row): number | string | null => {
      switch (sort.key) {
        case "name": return r.player.name.toLowerCase();
        case "clips": return r.clips;
        case "last": return r.last;
        case "score": return r.score;
        case "speed": return r.speed;
        case "knee": return r.knee?.value ?? null;
        case "trunk": return r.trunk?.value ?? null;
        case "height": return r.height?.value ?? null;
        case "back": return BACK_ORDER[r.back];
        case "week": return r.week;
        case "ratio": return r.ratio;
        case "noballs": return r.checks.no_ball;
      }
    };
    // rows without a value go last whichever way the column is sorted
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null || y === null) return x === null && y === null ? 0 : x === null ? 1 : -1;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [rows, sort]);

  const head = (key: SortKey, label: string, title?: string, firstDesc = true) => {
    const on = sort.key === key;
    return (
      <th scope="col" aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button type="button" className={`th-sort ${on ? "on" : ""}`} title={title}
          onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : firstDesc }))}>
          {label}{on ? (sort.desc ? " ↓" : " ↑") : ""}
        </button>
      </th>
    );
  };

  const csv = () => {
    if (!sorted) return;
    // a cell a spreadsheet would read as a formula (=, +, -, @) is kept as text
    const q = (v: unknown) => {
      let s = v === null || v === undefined ? "" : String(v);
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["player", "age_group", "style", "arm", "height_cm", "deliveries", "last_filmed", "latest_score", "best_ball_speed_kmh",
      "speeds_measured", "front_knee_release_deg", "trunk_metric", "trunk_deg", "release_height_pct", "back_health", "balls_last_7_days",
      "workload_ratio", "noball_checks_legal", "noball_checks_noball", "noball_checks_close"].join(",")];
    for (const r of sorted) {
      lines.push([r.player.name, r.player.age_group, r.player.style, r.player.arm, r.player.height_cm, r.clips, r.last ? isoDate(new Date(r.last * 1000)) : "",
        r.score, r.speed !== null ? Math.round(r.speed) : "", r.speeds, r.knee ? Math.round(r.knee.value) : "", r.trunkKey ?? "",
        r.trunk ? Math.round(r.trunk.value) : "", r.height ? Math.round(r.height.value) : "", r.back, r.week, r.ratio,
        r.checks.legal, r.checks.no_ball, r.checks.close].map(q).join(","));
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `seamly-squad-${isoDate(new Date())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);   // a phone's save prompt can take a while
  };

  const cell = (m: { value: number; rating: string } | null, unit: string) =>
    m ? <span className="sq-val"><i className={`dot ${DOT[m.rating] ?? ""}`} aria-hidden="true" />{Math.round(m.value)}{unit}</span> : <span className="faint">–</span>;

  return (
    <>
    <Header go={go} />
    <main className="page squad-page" id="main" tabIndex={-1}>
      <div>
        <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => go("/")}><IBack size={15} /> Workspace</button>
        <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
          <h1 className="grow" style={{ margin: 0, fontSize: 24 }}><IUsers size={20} /> Squad</h1>
          {sorted && sorted.length > 0 && <button className="btn" onClick={csv}><IDownload size={15} /> Download CSV</button>}
        </div>
        <p className="muted" style={{ margin: "0 0 16px", fontSize: 13.5, maxWidth: 760 }}>
          Every player's latest measured numbers side by side; sort by any column (ball speed for a trial day). Players can send you their
          own file from their player page with “Send to coach”, and you add it with “Restore a backup” in your workspace.
        </p>
        {err ? <div className="notice error" role="alert">{err}</div>
          : !sorted ? <div className="skeleton-box" style={{ height: 160 }} />
          : !sorted.length ? (
            <div className="card card-pad"><b>No players yet.</b> <span className="muted">Create a player in your workspace, or restore a player's file.</span></div>
          ) : (
            <div className="card sq-wrap" role="region" aria-label="Squad table" tabIndex={0}>
              <table className="sq-table">
                <thead>
                  <tr>
                    {head("name", "Player", undefined, false)}
                    {head("clips", "Clips")}
                    {head("last", "Last filmed")}
                    {head("score", "Score")}
                    {head("speed", "Best speed", "Fastest ball speed measured on a clip (Pace)")}
                    {head("knee", "Front knee at release", "Latest measured, side-on clips")}
                    {head("trunk", "Trunk at release", "Trunk lean (side-on) or side-bend (from behind), latest measured")}
                    {head("height", "Release height", "% of the bowler's height, latest measured")}
                    {head("back", "Back health", "From the latest clip (both cameras when it was filmed with two)")}
                    {head("week", "Balls, last 7 days", "From the bowling log")}
                    {head("ratio", "Workload", "Acute:chronic ratio from the bowling log (0.8–1.3 is the usual safe range)")}
                    {head("noballs", "No-ball checks", "Front-foot checks made on clips")}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.player.id}>
                      <th scope="row">
                        <button type="button" className="link-btn sq-name" onClick={() => go(`/p/${r.player.id}`)}>{r.player.name}</button>
                        <div className="faint sq-sub">{AGE_LABEL[r.player.age_group]} · {STYLE_LABEL[r.player.style]}{r.player.arm !== "auto" ? ` · ${r.player.arm === "right" ? "RA" : "LA"}` : ""}</div>
                      </th>
                      <td>{r.clips}</td>
                      <td>{r.last ? new Date(r.last * 1000).toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short" }) : <span className="faint">–</span>}</td>
                      <td>{r.score ?? <span className="faint">–</span>}</td>
                      <td>{r.speed !== null ? <><b>{Math.round(r.speed)}</b> km/h{r.speeds > 1 ? <span className="faint"> ({r.speeds})</span> : null}</> : <span className="faint">–</span>}</td>
                      <td>{cell(r.knee, "°")}</td>
                      <td>{r.trunk ? <>{cell(r.trunk, "°")}<span className="faint sq-sub"> {r.trunkKey === "trunk_forward_br" ? "lean" : "side-bend"}</span></> : <span className="faint">–</span>}</td>
                      <td>{cell(r.height, "%")}</td>
                      <td><span className={`chip ${r.back === "flag" ? "risk" : r.back === "watch" ? "watch" : r.back === "ok" ? "good" : ""}`}>{BACK_TEXT[r.back]}</span></td>
                      <td>{r.week ?? <span className="faint">–</span>}</td>
                      <td>{r.ratio !== null ? <span className={`chip ${r.zone === "ok" ? "good" : r.zone === "low" ? "" : r.zone === "high" ? "watch" : "risk"}`}>{r.ratio.toFixed(2)}</span> : <span className="faint">–</span>}</td>
                      <td>{r.checks.legal + r.checks.no_ball + r.checks.close
                        ? <>{r.checks.no_ball > 0 ? <b className="sq-nb">{r.checks.no_ball} no-ball{r.checks.no_ball > 1 ? "s" : ""}</b> : "0 no-balls"}
                          <span className="faint"> of {r.checks.legal + r.checks.no_ball + r.checks.close}{r.checks.close ? ` (${r.checks.close} too close to call)` : ""}</span></>
                        : <span className="faint">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </main>
    </>
  );
}
