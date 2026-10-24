import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult, EventKey, Metric, Rating } from "../types";
import { EVENTS, EVENT_HEX, RATING_LABEL, VIEW_LABEL } from "../lib/constants";
import { dateTime, fmt, unitLabel } from "../lib/format";
import { changeTolerance, improved } from "../engine/progress";
import Header from "./Header";
import FramePlayer from "./FramePlayer";
import OverlayCompare from "./OverlayCompare";
import ErrorBoundary from "./ErrorBoundary";
import { IAlert, IBack, IChevronRight } from "./Icons";
import { SiteFooter } from "./Landing";
import { usePageTitle } from "../lib/title";

const ORDER: Record<Rating, number> = { good: 0, watch: 1, risk: 2, info: 3, unrated: 4 };

type Loaded = { meta: AnalysisMeta; result: AnalysisResult };

export default function ComparePage({ a, b, go, overlay: startOverlay }: { a: string; b: string; go: (to: string) => void; overlay?: boolean }) {
  const [data, setData] = useState<[Loaded | null, Loaded | null]>([null, null]);
  const [error, setError] = useState<string | null>(null);
  const [ev, setEv] = useState<EventKey>("br");
  const [overlay, setOverlay] = useState({ skeleton: true, angles: true, trail: false });
  const [mode, setMode] = useState<"side" | "over">(startOverlay ? "over" : "side");
  usePageTitle(data[0] && data[1] ? `Compare: ${data[0].meta.name} vs ${data[1].meta.name}` : "Compare");

  useEffect(() => {
    Promise.all([api.get(a), api.get(b)])
      .then(([x, y]) => {
        if (!x.result || !y.result) throw new Error("Both analyses must be finished before they can be compared.");
        // A is always the earlier delivery, so "Improved" / "Worse" read as progress whichever was picked first
        const pair: [Loaded, Loaded] = [{ meta: x.meta, result: x.result }, { meta: y.meta, result: y.result }];
        if ((pair[0].meta.created ?? 0) > (pair[1].meta.created ?? 0)) pair.reverse();
        setData(pair);
      })
      .catch((e) => setError((e as Error).message));
  }, [a, b]);

  const rows = useMemo(() => {
    const [x, y] = data;
    if (!x || !y) return [];
    const mx = new Map(x.result.metrics.map((m) => [m.key, m]));
    const my = new Map(y.result.metrics.map((m) => [m.key, m]));
    const keys = [...new Set([...mx.keys(), ...my.keys()])];
    return keys.map((k) => ({ key: k, a: mx.get(k), b: my.get(k) }));
  }, [data]);
  // metrics neither clip could measure only get a mention under the table
  const has = (m?: Metric) => !!m && m.value !== null;
  const shownRows = rows.filter((r) => has(r.a) || has(r.b));
  const unseen = rows.filter((r) => !has(r.a) && !has(r.b)).map((r) => (r.a ?? r.b)!.label);

  if (error) {
    return (
      <>
        <Header go={go} title="Compare" />
        <main className="page narrow" id="main" tabIndex={-1}>
          <div className="card proc">
            <div className="notice error"><IAlert size={16} /> <div><b>Couldn't compare these deliveries.</b> {error}</div></div>
            <button className="btn" style={{ marginTop: 16 }} onClick={() => go("/")}><IBack size={16} /> Back to your analyses</button>
          </div>
        </main>
        <SiteFooter compact />
      </>
    );
  }
  const [x, y] = data;
  if (!x || !y) {
    return (
      <>
        <Header go={go} title="Compare" />
        <main className="page" id="main" tabIndex={-1} aria-busy="true">
          <div className="skel-page">
            <div className="skeleton-box" style={{ height: 48, maxWidth: 640 }} />
            <div className="skel-grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
              <div className="skeleton-box" style={{ aspectRatio: "16 / 10" }} />
              <div className="skeleton-box" style={{ aspectRatio: "16 / 10" }} />
            </div>
          </div>
        </main>
      </>
    );
  }
  // two different players' deliveries: differences, not progress
  const otherBowler = !!x.meta.player_id && !!y.meta.player_id && x.meta.player_id !== y.meta.player_id;
  const sameView = x.result.view.view === y.result.view.view;
  const side = (d: Loaded, label: string) => {
    const e = d.result.events[ev];
    return (
      <div className="card player">
        <div className="cmp-side-head">
          <span className={`cmp-tag ${label === "B" ? "b" : ""}`} aria-label={`Delivery ${label}`}>{label}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.meta.name}>{d.meta.name}</b>
            <span className="faint" style={{ fontSize: 12 }}>{dateTime(d.meta.created)}</span>
          </div>
          <span className="chip hide-sm">{VIEW_LABEL[d.result.view.view]}</span>
          {d.result.coaching.score !== null && <span className="score-pill static">{d.result.coaching.score}<small>/100</small></span>}
        </div>
        {e ? (
          <ErrorBoundary label="The player">
            <FramePlayer id={d.meta.id} result={d.result} frame={e.frame} overlay={overlay} selMetric={null} hud={EVENTS.find((x) => x.key === ev)!.short} />
          </ErrorBoundary>
        ) : (
          <div className="player-stage"><span className="faint">{EVENTS.find((x) => x.key === ev)!.label} not detected</span></div>
        )}
        <div className="row faint" style={{ padding: "8px 14px", fontSize: 12 }}>
          {e ? `frame ${e.frame} · ${e.method === "user" ? "set by you" : e.method === "timing_prior" ? "estimated timing" : `${Math.round(e.confidence * 100)}% confidence`}` : ""}
          <div className="grow" />
          <a href={`#/a/${d.meta.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} aria-label={`Open analysis ${label}: ${d.meta.name}`}>Open analysis <IChevronRight size={13} /></a>
        </div>
      </div>
    );
  };

  return (
    <>
      <Header go={go} title={`Compare · ${x.meta.name} vs ${y.meta.name}`} />
      <main className="page" id="main" tabIndex={-1}>
        <div className="an-head">
          <div className="an-head-main">
            <button type="button" className="back-link" onClick={() => go("/")}><IBack size={15} /> Your analyses</button>
            <h1 className="an-title">{mode === "over" ? "Overlay" : "Side by side"}</h1>
            <p className="muted" style={{ margin: 0 }}>Both deliveries at the same moment of the action. A is the earlier one, B the later one: "Improved" means B is better.</p>
          </div>
        </div>
        <div className="cmp-bar">
          <div className="seg" role="group" aria-label="Moment of the action">
            {EVENTS.map((e) => (
              <button key={e.key} className={ev === e.key ? "on" : ""} aria-pressed={ev === e.key} onClick={() => setEv(e.key)} title={e.help}>
                <span className="dot" style={{ background: EVENT_HEX[e.key], marginRight: 6 }} />{e.label}
              </button>
            ))}
          </div>
          <div className="grow" />
          {mode === "side" && (
            <div className="seg" role="group" aria-label="Overlays">
              <button className={overlay.skeleton ? "on" : ""} aria-pressed={overlay.skeleton} onClick={() => setOverlay((o) => ({ ...o, skeleton: !o.skeleton }))}>Skeleton</button>
              <button className={overlay.angles ? "on" : ""} aria-pressed={overlay.angles} onClick={() => setOverlay((o) => ({ ...o, angles: !o.angles }))}>Angles</button>
            </div>
          )}
          <div className="seg" role="group" aria-label="Layout">
            <button className={mode === "side" ? "on" : ""} aria-pressed={mode === "side"} onClick={() => setMode("side")}>Side by side</button>
            <button className={mode === "over" ? "on" : ""} aria-pressed={mode === "over"} onClick={() => setMode("over")} disabled={!sameView}
              title={sameView ? "Both bodies on top of each other" : "Overlay needs two clips filmed from the same angle"}>Overlay</button>
          </div>
        </div>
        {mode === "over" && sameView ? (
          <ErrorBoundary label="The overlay"><OverlayCompare a={x.result} b={y.result} ev={ev} onEvent={setEv} /></ErrorBoundary>
        ) : (
          <div className="an-grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
            {side(x, "A")}
            {side(y, "B")}
          </div>
        )}
        {x.result.view.view !== y.result.view.view && (
          <div className="notice warn" style={{ marginTop: 14 }}>
            <IAlert size={16} /> <div>The two clips were filmed from different angles ({VIEW_LABEL[x.result.view.view]} vs {VIEW_LABEL[y.result.view.view]}). Only metrics measured reliably in both are comparable.</div>
          </div>
        )}
        {otherBowler && (
          <div className="notice" style={{ marginTop: 14 }}>
            <IAlert size={16} /> <div>These are two different bowlers, so the table shows how they differ rather than whether anyone improved.</div>
          </div>
        )}
        <div className="card card-pad" style={{ marginTop: 18 }}>
          <div role="heading" aria-level={2} className="card-title">Metric by metric</div>
          <div className="table-scroll">
            <table className="cmp">
              <thead>
                <tr><th>Metric</th><th>A (earlier)</th><th>B (later)</th><th>Change (B − A)</th><th><span className="sr-only">Verdict</span></th></tr>
              </thead>
              <tbody>
                {shownRows.map(({ key, a: ma, b: mb }) => <Row key={key} a={ma} b={mb} fps={Math.min(data[0]!.result.fps_real, data[1]!.result.fps_real)} judge={!otherBowler} />)}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>
            Greyed values rest on an estimated moment and aren't compared. "Within error": the rating changed, but by less than one
            camera measures at this frame rate (a frame for timings; for angles a few degrees, more at 25–30 fps).
            {unseen.length > 0 && <> Neither clip's camera angle measures: {unseen.join(", ")}.</>}
          </p>
        </div>
      </main>
      <SiteFooter compact />
    </>
  );
}

function Row({ a, b, fps, judge = true }: { a?: Metric; b?: Metric; fps: number; judge?: boolean }) {
  const m = a ?? b!;
  const comparable = !!a && !!b && a.value !== null && b.value !== null && a.reliability === "measured" && b.reliability === "measured";
  const d = comparable ? (b!.value as number) - (a!.value as number) : null;
  // the same rule as the player page: a change is called only when it is bigger than one camera resolves at this
  // frame rate; a smaller one that still moved the rating is marked as within the error
  let verdict: "better" | "worse" | "noise" | null = null;
  const res = changeTolerance(m.key, m.unit, fps);
  // values with a target range only ("info" ones have none, as on the player page)
  const rated = (x?: Metric) => !!x && x.rating in ORDER && ORDER[x.rating] <= 2;
  if (judge && comparable && rated(a) && rated(b)) {
    const imp = improved(m.key, a!.value as number, b!.value as number, m.unit, fps);
    verdict = imp === true ? "better" : imp === false ? "worse"
      : a!.rating !== b!.rating && a!.rating in ORDER && b!.rating in ORDER && ORDER[a!.rating] <= 2 && ORDER[b!.rating] <= 2 ? "noise" : null;
  }
  const cell = (x: Metric | undefined, side: "A" | "B") => (
    <td className={!x || x.reliability === "estimate" ? "faint" : ""} data-label={side}>
      {x && x.value !== null ? `${fmt(x.value, x.unit === "ms" || x.unit === "cm" ? 0 : 1)}${unitLabel(x.unit)}` : "–"}
      {x && x.rating !== "unrated" && x.rating !== "info" && <span className={`chip ${x.rating}`} style={{ marginLeft: 8, height: 20, fontSize: 11 }}>{RATING_LABEL[x.rating]}</span>}
    </td>
  );
  return (
    <tr>
      <td className="muted cmp-name" style={{ fontWeight: 600 }}>{m.label}</td>
      {cell(a, "A")}
      {cell(b, "B")}
      <td className="mono" data-label="Change B − A">{d === null ? <span className="faint">not comparable</span> : `${d > 0 ? "+" : ""}${fmt(d, Math.abs(d) < 10 ? 1 : 0)}${unitLabel(m.unit)}`}</td>
      <td className="cmp-verdict">
        {(verdict === "better" || verdict === "worse") && <span className={`chip ${verdict === "better" ? "good" : "risk"}`}>{verdict === "better" ? "Improved" : "Worse"}</span>}
        {verdict === "noise" && <span className="chip" title={`One camera at ${fmt(fps, 0)} fps resolves about ±${fmt(res, 0)}${unitLabel(m.unit)} for this, so the change can't be called`}>Within error</span>}
      </td>
    </tr>
  );
}
