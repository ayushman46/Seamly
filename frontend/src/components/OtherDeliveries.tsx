import { useEffect, useState } from "react";
import { api } from "../api";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { fmt } from "../lib/format";
import { IInfo } from "./Icons";

/** A video with several deliveries (a nets session, a montage): say which one this analysis is, and analyse the others,
 * each as its own analysis (they share this one's stored video). */
export default function OtherDeliveries({ id, result, meta, go, flash }: {
  id: string; result: AnalysisResult; meta: AnalysisMeta; go: (to: string) => void; flash: (text: string, error?: boolean) => void;
}) {
  const n = result.candidates.length;
  const [family, setFamily] = useState<number | null>(null);   // analyses made from this video so far
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const src = meta.source_id ?? id;
  useEffect(() => {
    let live = true;
    api.list().then((ms) => live && setFamily(ms.filter((m) => (m.source_id ?? m.id) === src).length)).catch(() => undefined);
    return () => { live = false; };
  }, [src, queued]);
  if (n < 2 || /^Example( clip)?:/.test(meta.name ?? "")) return null;
  const sel = result.bowler.score;
  const order = result.candidates.map((c, i) => [c.first, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const me = result.candidates.findIndex((c) => c.track === sel.track && c.shot === sel.shot);
  const at = me >= 0 ? result.candidates[me].first / result.video.fps : null;
  const left = family === null ? null : Math.max(0, n - family);
  const go2 = async () => {
    setBusy(true);
    try {
      const ids = await api.analyseOthers(id);
      setQueued((q) => q + ids.length);
      flash(ids.length ? `Analysing ${ids.length} more ${ids.length === 1 ? "delivery" : "deliveries"} from this video` : "Every delivery in this video is already analysed");
    } catch (e) { flash((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="notice" style={{ marginBottom: 14 }}>
      <IInfo size={16} />
      <div>
        <b>This video has {n} deliveries.</b> This analysis is ball {order.indexOf(me) + 1}{at !== null ? ` (${fmt(at, 1)} s in)` : ""}.{" "}
        {left === 0
          ? <>All of them are analysed: they're in <button type="button" className="link-btn" onClick={() => go("/")}>your workspace</button>.</>
          : <>Seamly can analyse each of the others as its own delivery, for the same player, one after another.</>}
        {left !== 0 && (
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn sm primary" disabled={busy || left === null} onClick={go2}>
              Analyse the other {left ?? n - 1}
            </button>
            {queued > 0 && <button type="button" className="btn sm ghost" onClick={() => go("/")}>See them in your workspace</button>}
          </div>
        )}
      </div>
    </div>
  );
}
