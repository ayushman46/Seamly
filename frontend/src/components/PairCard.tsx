import { useEffect, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { cameraOf } from "../lib/twoview";
import { dateTime } from "../lib/format";
import { IColumns } from "./Icons";

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
      const list = ms.filter((m) => m.id !== id && m.status === "done" && m.view && want.includes(m.view) && !/^Example( clip)?:/.test(m.name ?? ""))
        // the same player's clips first, then the ones made closest in time
        .sort((x, y) => Number(y.player_id === meta.player_id && !!meta.player_id) - Number(x.player_id === meta.player_id && !!meta.player_id)
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
                {cands.map((m) => <option key={m.id} value={m.id}>{m.name} · {dateTime(m.created, false)}</option>)}
              </select>
              <button type="button" className="btn sm primary" disabled={!pick || busy} onClick={pair}>Pair</button>
            </div>
          ) : (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              No clip filmed {other} yet. Analyse it (choose both videos together and tick “The same ball from two cameras”), then pair them here.
            </p>
          )}
        </>
      )}
    </section>
  );
}
