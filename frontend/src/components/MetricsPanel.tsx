import type { AnalysisResult, Metric } from "../types";
import { RATING_LABEL, TECHNIQUE_HELP } from "../lib/constants";
import { fmt, unitLabel } from "../lib/format";

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Rhythm & timing", keys: ["bfc_to_ffc_ms", "ffc_to_br_ms"] },
  { title: "Front leg", keys: ["front_knee_ffc", "front_knee_br", "front_knee_flexion", "back_knee_bfc", "stride_length_pct"] },
  { title: "Trunk & alignment", keys: ["trunk_lateral_br", "trunk_forward_br", "trunk_flexion_ffc_br", "shoulder_alignment_bfc", "hip_shoulder_sep_bfc", "shoulder_counter_rotation"] },
  { title: "Release", keys: ["release_height_pct", "arm_slot_br", "head_offset_br", "elbow_extension"] },
];

export default function MetricsPanel({ result, selected, onSelect }: { result: AnalysisResult; selected: string | null; onSelect: (key: string, eventKey: string | null) => void }) {
  const by = new Map(result.metrics.map((m) => [m.key, m]));
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 900 }}>
        Tap a metric to show it on the video. <b className="muted">Estimates</b> aren't rated. Reference ranges come from elite
        adult bowlers: for juniors they show the direction to grow in, not a target.
      </div>
      {GROUPS.map((g) => {
        const ms = (g.keys.map((k) => by.get(k)).filter(Boolean) as Metric[]).filter((m) => !withheld(m));
        if (!ms.length) return null;
        return (
          <div key={g.title}>
            <div role="heading" aria-level={3} className="card-title">{g.title}</div>
            <div className="metric-groups">
              {ms.map((m) => <MetricCard key={m.key} m={m} sel={selected === m.key} onClick={() => onSelect(m.key, m.event?.split("-").pop() ?? null)} />)}
            </div>
          </div>
        );
      })}
      {(() => {
        const out = GROUPS.flatMap((g) => g.keys.map((k) => by.get(k)).filter((m): m is Metric => !!m && withheld(m)));
        if (!out.length) return null;
        return (
          <div>
            <div role="heading" aria-level={3} className="card-title">Needs another camera angle or frame rate</div>
            <div className="stack" style={{ gap: 6 }}>
              {out.map((m) => (
                <div key={m.key} className="faint" style={{ fontSize: 12.5 }}>
                  <b className="muted">{m.label}</b> — {m.note || "Couldn't be measured in this clip."}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/** No value to show: the camera angle (or frame rate) can't measure it in this clip. */
const withheld = (m: Metric) => m.value === null || m.value === undefined;

function MetricCard({ m, sel, onClick }: { m: Metric; sel: boolean; onClick: () => void }) {
  const extra = m.technique ? `Technique: ${m.technique}${TECHNIQUE_HELP[m.technique] ? ` (${TECHNIQUE_HELP[m.technique]})` : ""}` : m.action_type ? `Action: ${m.action_type}` : m.metres ? `≈ ${m.metres.toFixed(2)} m` : null;
  return (
    <div className={`metric ${sel ? "sel" : ""} ${m.reliability === "estimate" ? "estimate" : ""}`} onClick={onClick}
      role="button" tabIndex={0} aria-pressed={sel}
      aria-label={`${m.label}: ${m.value === null ? "not measured" : `${fmt(m.value, m.unit === "ms" || m.unit === "cm" ? 0 : 1)}${unitLabel(m.unit)}`}, ${RATING_LABEL[m.rating]}. Show on the video`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick(); } }}>
      <div className="row">
        <span className="mlabel grow">{m.label}</span>
        <span className={`chip ${m.rating}`}>{RATING_LABEL[m.rating]}</span>
      </div>
      <div className="mv">{fmt(m.value, m.unit === "ms" || m.unit === "cm" ? 0 : 1)}<small>{unitLabel(m.unit)}</small></div>
      {extra && <div className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>{extra}</div>}
      {m.key === "elbow_extension" && m.flexion_at_br !== undefined && m.flexion_at_br !== null && (
        <div className="faint" style={{ fontSize: 12 }}>Flexion at UAH {fmt(m.flexion_at_uah)}° · max {fmt(m.max_flexion)}° · at release {fmt(m.flexion_at_br)}°</div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <span className="badge-conf" title="Measurement confidence">
          <span className="conf-bar"><i style={{ width: `${Math.round(m.confidence * 100)}%` }} /></span>
          {Math.round(m.confidence * 100)}% sure
        </span>
        <span className="chip" style={{ height: 20, fontSize: 11 }}>{m.source === "2d" ? "Measured on video" : m.source === "events" ? "From events" : m.source === "2d+3d" ? "Video + 3D" : "3D reconstruction"}</span>
      </div>
      {m.note && <div className="mnote">{m.note}</div>}
      {m.explain && <div className="muted" style={{ fontSize: 12.5 }}>{m.explain}</div>}
      {m.norm && <div className="mnorm">Reference: {m.norm}{m.ref ? ` — ${m.ref}` : ""}</div>}
    </div>
  );
}
