import { useEffect, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { cameraOf } from "../lib/twoview";
import { dateTime } from "../lib/format";
import { IAlert, IColumns } from "./Icons";

/**
 * "Two cameras": pair this clip with one of the same ball from the other side of the action (side-on with behind or in
 * front), or open the pair. A single camera sees half the action; two ordinary phones, never synchronised, see it all.
 */
export default function PairCard({ id, meta, result, go, onMeta, flash }: {
  id: string; meta: AnalysisMeta; result: AnalysisResult; go: (to: string) => void;
  onMeta: (m: AnalysisMeta) => void; flash: (text: string, error?: boolean) => void;
}) {
  const cam = cameraOf(result);
  const [cands, setCands] = useState<AnalysisMeta[] | null>(null);
  const [partner, setPartner] = useState<AnalysisMeta | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const example = /^Example( clip)?:/.test(meta.name ?? "");

  useEffect(() => {
    let live = true;
    api.list().then((ms) => {
      if (!live) return;
      setPartner(meta.pair ? ms.find((m) => m.id === meta.pair) ?? null : null);
      const want = cam === "side" ? ["behind", "front_on"] : cam === "rear" ? ["side_on"] : [];
      const list = ms.filter((m) => m.id !== id && m.status === "done" && m.view && want.includes(m.view) && !m.angled && !/^Example( clip)?:/.test(m.name ?? ""))
        // unpaired clips first, then the same player's, then the ones made closest in time
        .sort((x, y) => Number(!!x.pair) - Number(!!y.pair)
          || Number(y.player_id === meta.player_id && !!meta.player_id) - Number(x.player_id === meta.player_id && !!meta.player_id)
          || Math.abs(x.created - meta.created) - Math.abs(y.created - meta.created));
      setCands(list);
      setPick((p) => p || list[0]?.id || "");
    }).catch(() => live && setCands([]));
    return () => { live = false; };
  }, [id, meta.pair, meta.player_id, meta.created, cam]);

  if (example) return null;
  const pair = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      onMeta(await api.pair(id, pick));
      go(`/two/${id}/${pick}`);
    } catch (e) { flash((e as Error).message, true); setBusy(false); }
  };
  const unpair = async () => {
    try { onMeta(await api.pair(id, null)); flash("Unpaired"); } catch (e) { flash((e as Error).message, true); }
  };
  const other = cam === "side" ? "from behind (or in front of) the bowler" : "side-on";

  return (
    <section className="card card-pad pair-card" aria-labelledby="pair-title">
      <div role="heading" aria-level={2} id="pair-title" className="card-title"><IColumns size={14} /> Two cameras</div>
      {meta.pair ? (
        <>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Paired with {partner ? <b>{partner.name}</b> : "a clip that is no longer here"}: the same ball from the other camera.
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            {partner && <button type="button" className="btn sm primary" onClick={() => go(`/two/${id}/${partner.id}`)}>See both cameras together</button>}
            <button type="button" className="btn sm ghost" onClick={unpair}>Unpair</button>
          </div>
        </>
      ) : cam === null ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Two phones on one ball, one side-on and one behind the stumps, measure the whole action: knees, trunk and stride from the side,
          side-bend and alignment from behind, and the full back-health screen. This clip is filmed at an angle, so it can't be one of them.
        </p>
      ) : (
        <>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Filmed this ball {other} as well? Pair the two clips: Seamly lines them up at the release and measures each part of the action
            with the camera that sees it, including the full back-health screen. Any two phones, no syncing needed.
          </p>
          {cands === null ? <div className="spinner sm" /> : cands.length ? (
            <div className="row wrap" style={{ gap: 8 }}>
              <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`The clip filmed ${other}`} style={{ maxWidth: 320 }}>
                {cands.map((m) => <option key={m.id} value={m.id}>{m.name} · {dateTime(m.created, false)}{m.pair ? " · paired with another clip" : ""}</option>)}
              </select>
              <button type="button" className="btn sm primary" disabled={!pick || busy} onClick={pair}>Pair</button>
            </div>
          ) : (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              No clip filmed {other} yet: analyse it, then pair it here. Next time, choose both videos together and tick “The same ball from two
              cameras”, and they're paired for you.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The note at the top of a paired analysis: an invitation when the two clips fit together, or what to fix when they
 * don't (both read side-on, or one at an angle). */
export function PairNotice({ id, meta, result, go }: { id: string; meta: AnalysisMeta; result: AnalysisResult; go: (to: string) => void }) {
  const [partner, setPartner] = useState<AnalysisMeta | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!meta.pair) { setPartner(undefined); return; }
    api.list().then((ms) => live && setPartner(ms.find((m) => m.id === meta.pair) ?? null)).catch(() => live && setPartner(null));
    return () => { live = false; };
  }, [meta.pair]);
  if (!meta.pair || partner === undefined) return null;
  const mine = cameraOf(result);
  const theirs = !partner || partner.status !== "done" || !partner.view ? null : partner.angled ? null : partner.view === "side_on" ? "side" : "rear";
  const fits = !!partner && partner.status === "done" && mine !== null && theirs !== null && mine !== theirs;
  const waiting = !!partner && (partner.status === "queued" || partner.status === "running");
  return (
    <div className={`notice ${fits || waiting ? "" : "warn"}`} style={{ marginBottom: 14 }}>
      {fits || waiting ? <IColumns size={16} /> : <IAlert size={16} />}
      <div>
        {!partner ? <>This clip was paired with a second camera's clip that isn't in this browser any more.</>
          : waiting ? <>This ball was also filmed by a second camera ({partner.name}), still being analysed.{" "}
              <button type="button" className="link-btn" onClick={() => go(`/two/${id}/${partner.id}`)}>Open both cameras</button>: it fills in when both are done.</>
          : fits ? <>This ball was also filmed by a second camera.{" "}
              <button type="button" className="link-btn" onClick={() => go(`/two/${id}/${partner.id}`)}>See both cameras together</button>: the whole action and the full back-health screen.</>
          : <>This clip is paired with {partner.name}, but the two can't be put together yet: one must be side-on and the other behind or in front
              of the bowler, both square to the pitch.{" "}
              <button type="button" className="link-btn" onClick={() => go(`/two/${id}/${partner.id}`)}>See what to fix</button>.</>}
      </div>
    </div>
  );
}
