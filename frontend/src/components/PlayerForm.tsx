import { useId, useState } from "react";
import type { AgeGroup, Player, Style } from "../types";
import { AGE_LABEL, STYLE_LABEL } from "../lib/player";

type Fields = { name: string; age_group: AgeGroup | ""; style: Style; arm: Player["arm"]; height: string };

/** Create or edit a player profile. Age group and style decide the coaching level and bowling-load limits. */
export default function PlayerForm({ initial, submitLabel, onSave, onCancel }: {
  initial?: Partial<Player>; submitLabel: string;
  onSave: (p: Partial<Player>) => Promise<void>; onCancel?: () => void;
}) {
  const [f, setF] = useState<Fields>({
    // no default age group: it decides the bowling-load limits, so a parent must choose it (adult loads are not safe for juniors)
    name: initial?.name ?? "", age_group: initial?.age_group ?? "", style: initial?.style ?? "fast",
    arm: initial?.arm ?? "auto", height: initial?.height_cm ? String(Math.round(initial.height_cm)) : "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const uid = useId();   // unique label ids (two forms can be on screen at once)
  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((o) => ({ ...o, [k]: v }));

  const save = async () => {
    if (busy) return;   // a double Enter must not create two players
    const h = f.height ? Number(f.height) : null;
    if (!f.name.trim()) return setErr("Give the player a name.");
    if (!f.age_group) return setErr("Choose the player's age group — it sets safe bowling loads in the practice plan.");
    if (h !== null && (!isFinite(h) || h < 120 || h > 230)) return setErr("Height should be between 120 and 230 cm.");
    setBusy(true);
    setErr(null);
    try {
      await onSave({ name: f.name.trim(), age_group: f.age_group as AgeGroup, style: f.style, arm: f.arm, height_cm: h });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} className="input" placeholder="e.g. Aarav" value={f.name} maxLength={60} autoFocus
          onChange={(e) => set("name", e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      </div>
      <div className="upload-opts" style={{ marginTop: 0 }}>
        <div className="field">
          <label htmlFor={`${uid}-age`}>Age group</label>
          <select id={`${uid}-age`} className="input" value={f.age_group} onChange={(e) => set("age_group", e.target.value as AgeGroup)}>
            {!f.age_group && <option value="" disabled>Choose…</option>}
            {Object.entries(AGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-style`}>Bowling style</label>
          <select id={`${uid}-style`} className="input" value={f.style} onChange={(e) => set("style", e.target.value as Style)}>
            {Object.entries(STYLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-height`}>Height (cm, optional)</label>
          <input id={`${uid}-height`} className="input" inputMode="numeric" placeholder="e.g. 175" value={f.height}
            onChange={(e) => set("height", e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
      </div>
      <div className="field">
        <span className="label" id={`${uid}-arm`}>Bowling arm</span>
        <div className="seg" role="group" aria-labelledby={`${uid}-arm`}>
          {(["auto", "right", "left"] as const).map((a) => (
            <button key={a} type="button" className={f.arm === a ? "on" : ""} aria-pressed={f.arm === a} onClick={() => set("arm", a)}>
              {a === "auto" ? "Auto" : a === "right" ? "Right-arm" : "Left-arm"}
            </button>
          ))}
        </div>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        Age group sets the bowling-load limits in practice plans (Cricket Australia junior guidelines). Height scales distances to metres.
      </div>
      {err && <div className="notice error" role="alert">{err}</div>}
      <div className="row">
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy} onClick={save}>{submitLabel}</button>
      </div>
    </div>
  );
}
