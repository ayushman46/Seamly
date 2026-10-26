/**
 * Plain-language coaching for non-professional bowlers (port of backend/bowlnet/insights.py): what the analysis
 * means, a lower-back screen and a two-week practice plan pitched at the player's age group.
 *
 * Workload limits follow Cricket Australia's junior pace bowling guidelines (match and training tables, pre-season
 * build-up, back-pain advice). Nothing here is a medical assessment; the back screen says so.
 */
import type { Insights } from "../types";
import { DRILLS } from "./coaching";
import { crc32 } from "./util";

// players.py
export const AGE_GROUPS = ["u11", "u13", "u15", "u17", "u19", "adult"] as const;
export const STYLES = ["fast", "medium", "spin"] as const;
export const ARMS = ["auto", "right", "left"] as const;
export const AGE_LABEL: Record<string, string> = {
  u11: "Under 11", u13: "11–12", u15: "13–14", u17: "15–16", u19: "17–18", adult: "Adult (19+)",
};

const JUNIOR = ["u11", "u13", "u15", "u17", "u19"];
const UNDER_17 = ["u11", "u13", "u15", "u17"];

interface Limits { spell: number; day: number | null; days_week: number; rule: string }
// Cricket Australia junior pace bowling guidelines: max overs per spell / per match day; training: max 3 bowling
// days a week with a day off after each (under 17), max 4 with no more than 2 in a row (17-19), spells of at
// most 5 (under 17) or 6 overs (17-19) and 20 minutes between spells.
const LIMITS: Record<string, Limits> = {
  u11: { spell: 2, day: 4, days_week: 3, rule: "At least one day off after every bowling day." },
  u13: { spell: 4, day: 8, days_week: 3, rule: "At least one day off after every bowling day." },
  u15: { spell: 5, day: 12, days_week: 3, rule: "At least one day off after every bowling day." },
  u17: { spell: 5, day: 16, days_week: 3, rule: "At least one day off after every bowling day." },
  u19: { spell: 6, day: 18, days_week: 4, rule: "No more than two bowling days in a row." },
};
const ADULT_LIMITS: Limits = { spell: 6, day: null, days_week: 4, rule: "No more than two bowling days in a row." };
const PRESEASON_WEEKS: Record<string, number> = { u11: 2, u13: 2, u15: 4, u17: 6, u19: 8 };
const CA_SOURCE = "Cricket Australia junior pace bowling guidelines";

// Why each focus matters, in plain words (same evidence as the metric references, without the jargon).
const WHY: Record<string, string> = {
  front_leg: "A firm front leg acts like a pole-vaulter's pole: it stops the run-up and catapults your upper "
    + "body and arm forward. Bowlers with a straighter front knee at release tend to bowl faster.",
  trunk_flexion: "Driving the chest forward over the front leg adds speed to the arm. It is one of the "
    + "biggest sources of pace in research on fast bowlers.",
  side_bend: "Leaning sideways at release loads one side of the lower back and tends to drag the ball off line.",
  mixed_action: "When the hips and shoulders point different ways at back-foot contact, the lower back has to "
    + "twist under load. This 'mixed action' is linked to back stress injuries, especially in juniors.",
  release_height: "A higher release point makes the most of your height and gives the ball more bounce.",
  stride: "A stride that is too long or too short makes it hard to stay tall and braced at release.",
  rhythm: "A pause between landing and letting go lets the energy from your run-up leak away.",
  elbow: "Only an accredited lab test can judge whether an action is legal; this is a screening estimate.",
};

// some priorities share a drill but not the reason (a folding back leg is a back-health issue, not a pace one)
const WHY_BY_METRIC: Record<string, string> = {
  back_knee_bfc: "A back leg that folds when it lands was linked to lower-back stress injuries in a study of "
    + "young fast bowlers. A firmer back leg spreads the landing load.",
  head_offset_br: "When the head falls away from the front foot at release, accuracy suffers and the lower back "
    + "takes extra sideways load.",
  elbow_extension: "Only an accredited lab test can judge whether an action is legal; this is a screening estimate.",
};

const STRENGTH: Record<string, string[]> = {
  front_leg: ["Single-leg step-downs from a low step, slow on the way down (3 × 8 each leg)", "Glute bridges (3 × 12)"],
  trunk_flexion: ["Dead bugs (3 × 10)", "Hip-hinge with a broomstick on your back (3 × 10)"],
  side_bend: ["Side planks (3 × 30 s each side)", "Bird dogs (3 × 10 each side)"],
  mixed_action: ["Anti-rotation hold with a band or partner (3 × 20 s each side)", "Side planks (3 × 30 s each side)"],
  release_height: ["Thoracic rotations on all fours (2 × 10 each side)", "Wall slides, arms overhead (3 × 10)"],
  stride: ["Split squats (3 × 8 each leg)", "Lateral bound and stick (3 × 6 each side)"],
  rhythm: ["Skipping or ankle hops (3 × 20)", "Fast-feet cone drill (3 × 20 s)"],
};
const GENERAL_STRENGTH = ["Plank (3 × 30 s)", "Bodyweight squats (3 × 12)", "Hip-flexor and hamstring stretches (2 × 30 s)"];

const GRADE_PHRASE: Record<string, string> = {
  Excellent: "Excellent action", Elite: "Excellent action", Strong: "Strong action", Developing: "A good base",
  "Needs work": "Plenty to gain",
};

// ---------------- inputs (the analysis result and an optional player profile) ----------------
interface PriorityIn {
  key?: string;
  drill_key?: string;
  headline: string;
  why?: string;
  rating?: string | null;
  event?: string | null;
  drill: { title: string; cue: string };
}
interface MetricIn { key: string; value?: number | null; rating?: string; confidence?: number; note?: string | null }
export interface InsightsResult {
  coaching: { score?: number | null; grade?: string | null; priorities?: PriorityIn[] | null; strengths?: string[] | null };
  view: { view: string; oblique?: boolean };
  fps_real?: number;
  metrics: MetricIn[];
}
export interface InsightsPlayer { id?: string; name?: string; age_group?: string | null; style?: string | null }

const has = (o: Record<string, unknown>, k: string | undefined | null): k is string =>
  k != null && Object.prototype.hasOwnProperty.call(o, k);
const get = <T>(o: Record<string, T>, k: string | undefined | null, dflt: T): T => (has(o, k) ? o[k] : dflt);

function level(player: InsightsPlayer | null | undefined): [string, string] {
  const p = player || {};
  return [p.age_group || "adult", p.style || "fast"];
}

function drillKey(priority: PriorityIn): string {
  if (priority.drill_key) return priority.drill_key;
  // analyses made before priorities carried their drill key
  return Object.keys(DRILLS).find((k) => DRILLS[k].title === priority.drill.title) ?? "";
}

/** The analysis in a few plain sentences: headline, what's working, what to fix first and why. */
export function summary(result: InsightsResult, player: InsightsPlayer | null = null): Insights["summary"] {
  const c = result.coaching;
  const [age, style] = level(player);
  const pr = c.priorities || [];
  let headline: string;
  if (c.score == null) {
    headline = "Not enough could be measured reliably in this clip for an overall verdict; here is what we could see.";
  } else if (!pr.length) {
    headline = `${get(GRADE_PHRASE, c.grade, "Good action")}: nothing stands out to fix in what this camera angle can see.`;
  } else {
    // "Excellent action" right above things to work on reads as a contradiction
    const phrase = c.grade === "Excellent" || c.grade === "Elite" ? "A sound action" : get(GRADE_PHRASE, c.grade, "Your action");
    headline = `${phrase}. Your next step: ${pr[0].drill.title.toLowerCase()}.`;
  }
  const fixes = pr.slice(0, 2).map((p) => ({
    title: p.drill.title, what: p.headline,
    why: get(WHY_BY_METRIC, p.key, get(WHY, drillKey(p), "why" in p ? p.why as string : "")),
    cue: p.drill.cue, event: p.event ?? null, rating: (p.rating ?? null) as string,
  }));
  const view = result.view.view;
  const unlock: string[] = [];
  if (result.view.oblique) {
    unlock.push("Film square to the pitch, side-on or straight from behind the stumps, to measure your action.");
  } else if (view === "behind" || view === "front_on") {
    unlock.push("Film side-on (10–15 m away, hip height) to also measure your front knee, trunk flexion and stride.");
  } else {
    unlock.push("Film from behind the stumps to also measure side-bend, alignment and whether you fall away.");
  }
  if ((result.fps_real ?? 30) < 90) {
    unlock.push("Use your phone's slow-motion mode (120–240 fps) to time release and foot contacts precisely.");
  }
  const notes: string[] = [];
  if (JUNIOR.includes(age) && style !== "spin") {
    notes.push("At your age, a safe action and sensible bowling loads matter more than pace; the pace comes later.");
  } else if (JUNIOR.includes(age)) {
    notes.push("At your age, a smooth, repeatable action and sensible bowling loads matter more than how much you spin it.");
  }
  if (style === "spin") {
    notes.push("Seamly's reference values come from studies of pace bowlers; for spin, treat the ratings as a rough guide.");
  }
  return { headline, working: (c.strengths || []).slice(0, 3), fixes, unlock, notes };
}

type Status = "ok" | "watch" | "flag" | "unknown";

/** Lower-back technique screen for pace bowlers: side-bend, mixed action and back-knee collapse. */
export function backHealth(result: InsightsResult, player: InsightsPlayer | null = null): Insights["back_health"] {
  const [age, style] = level(player);
  if (style === "spin") return null;
  const by: Record<string, MetricIn> = {};
  for (const m of result.metrics) by[m.key] = m;

  const status = (key: string): [Status, MetricIn | null] => {
    const m = has(by, key) ? by[key] : null;
    // same reliability bar as the coaching priorities: a shaky reading is reported as unknown, not as a flag
    if (!m || m.value == null || !(m.rating === "good" || m.rating === "watch" || m.rating === "risk") || (m.confidence ?? 0) < 0.3)
      return ["unknown", m];
    return [({ good: "ok", watch: "watch", risk: "flag" } as const)[m.rating], m];
  };

  type Check = NonNullable<Insights["back_health"]>["checks"][number];
  const checks: Check[] = [];
  let [s, m] = status("trunk_lateral_br");
  checks.push({ key: "side_bend", label: "Side-bend at release", status: s, value: m && s !== "unknown" ? m.value ?? null : null, unit: "deg",
    text: {
      ok: "Within the range seen in uninjured junior bowlers.",
      watch: "Higher than typical; worth reducing with the 'stay tall' drills.",
      flag: "In the range linked to later back injury in junior fast bowlers.",
      unknown: m?.note || "Not measurable in this clip; film from behind.",
    }[s] });
  const [s1, m1] = status("hip_shoulder_sep_bfc");
  const [s2, m2] = status("shoulder_counter_rotation");
  const order: Record<Status, number> = { flag: 3, watch: 2, ok: 1, unknown: 0 };
  s = order[s2] > order[s1] ? s2 : s1;   // worst of the measured ones; unknown only if neither was measured
  checks.push({ key: "mixed_action", label: "Mixed action (hip-shoulder twist)", status: s, value: null, unit: null,
    text: {
      ok: "Hips and shoulders line up at back-foot contact.",
      watch: "Some twist between hips and shoulders; keep an eye on it.",
      flag: "A mixed action: hips and shoulders point different ways at back-foot contact.",
      unknown: m1?.note || m2?.note || "Not measurable in this clip; film from behind the stumps.",
    }[s] });
  [s, m] = status("back_knee_bfc");
  checks.push({ key: "back_knee", label: "Back leg at back-foot contact", status: s, value: m && s !== "unknown" ? m.value ?? null : null, unit: "deg",
    text: {
      ok: "The back leg stays firm when it lands.",
      watch: "The back leg bends a little more than ideal when it lands.",
      flag: "The back leg folds on landing, which was linked to back injuries in one study.",
      unknown: m?.note || "Not measurable in this clip; film side-on.",
    }[s] });
  const measured = checks.map((ch) => ch.status).filter((x) => x !== "unknown");
  const overall: Status = measured.includes("flag") ? "flag" : measured.includes("watch") ? "watch" : measured.length ? "ok" : "unknown";
  const advice: string[] = [];
  if (overall === "flag" || overall === "watch") advice.push("Show this to a coach and work on the drills in your practice plan.");
  if (JUNIOR.includes(age)) {
    advice.push("Lower-back stress injuries are most common in teenage pace bowlers (fast and medium), especially in the two to "
      + "three years after a growth spurt. Stick to the bowling limits in your plan.");
  }
  advice.push("If you get lower back pain while bowling (or any pain that changes how you bowl or lasts to the next day), stop and see a sports doctor or physiotherapist "
    + "before bowling again.");
  return { overall, checks, advice, measured: measured.length, total: checks.length,
    disclaimer: "A technique screen from one video, not a medical assessment." };
}

interface PlanLimits extends Limits {
  age_group: string; label: string; source: string; between_spells_min: number; preseason_weeks: number | null;
}

/**
 * Workload limits for the age group. Juniors always get them (for spinners the pace limits are a safe ceiling);
 * adult pace bowlers get the 17-19 pattern as general guidance; adult spinners have no fixed limits.
 */
function limitsFor(age: string, style: string): PlanLimits | null {
  if (has(LIMITS, age)) {
    const src = style !== "spin" ? CA_SOURCE : `${CA_SOURCE}; pace limits, used as a safe ceiling for young spinners`;
    return { ...LIMITS[age], age_group: age, label: AGE_LABEL[age], source: src, between_spells_min: 20,
      preseason_weeks: PRESEASON_WEEKS[age] };
  }
  if (style === "spin") return null;
  return { ...ADULT_LIMITS, age_group: "adult", label: AGE_LABEL.adult,
    source: "general guidance; the official limits are for juniors", between_spells_min: 20, preseason_weeks: null };
}

/** The bowling limits for a player's age group and style (null: no fixed limits, e.g. adult spinners). */
export const bowlingLimits = (ageGroup: string, style: string): PlanLimits | null => limitsFor(ageGroup, style);

interface PlanDrill { text: string; sets: number; reps: number; balls: boolean; adult_only: boolean }
const d = (text: string, sets: number, reps: number, balls: boolean, adultOnly = false): PlanDrill =>
  ({ text, sets, reps, balls, adult_only: adultOnly });

// Plan drills (same content as coaching.DRILLS) with the number of deliveries each one bowls, so every session can
// be kept inside the day's limit. "No ball" drills are movement rehearsals and don't count towards it.
const PLAN_DRILLS: Record<string, PlanDrill[]> = {
  front_leg: [
    d("Standing brace: front foot planted, bowl from a static delivery-stride position, keeping the knee firm", 3, 6, true),
    d("Walk-through then jog-through deliveries, adding speed only while the knee stays firm", 3, 6, true),
    d("Gather-and-bound onto a mat, freezing at front-foot contact to feel the brace (no ball)", 2, 8, false),
  ],
  trunk_flexion: [
    d("Kneeling throws: front knee down, pull the trunk down and through towards a target (light ball)", 3, 8, false),
    d("Med-ball slam from the delivery-stride position", 3, 6, false, true),
    d("Follow-through line: bowl and finish with the chest past the front knee on a chalk line", 2, 8, true),
  ],
  side_bend: [
    d("Chalk-line run-ups: bowl landing on a straight line so the body isn't forced to lean", 3, 6, true),
    d("Front-arm drive (no ball): the hand reaches towards the target and finishes near the chest", 2, 10, false),
    d("Wall drill: bowl alongside a wall or net on the non-bowling side to stop falling away", 2, 8, true),
  ],
  mixed_action: [
    d("Chalk the crease: mark back- and front-foot spots and bowl, matching the shoulders to the back-foot line", 3, 6, true),
    d("Mirror or phone check at back-foot contact from behind (no ball): fix the shoulders first", 2, 8, false),
    d("Slow-motion walk-throughs freezing at back-foot contact to rehearse alignment (no ball)", 2, 6, false),
  ],
  release_height: [
    d("High-target drill: release over a raised rope or bar 1 m in front of the crease", 3, 6, true),
    d("Standing-start deliveries, reaching up tall through the bowling arm", 3, 6, true),
  ],
  stride: [
    d("Stride markers: mark a front-foot spot about 75–80% of your height from the back foot and bowl to it", 3, 6, true),
    d("Bound and stick (no ball): bound into the delivery stride and hold your balance for two seconds", 2, 8, false),
  ],
  rhythm: [
    d("Short run-up (5 steps) deliveries, thinking only about landing and letting go straight away", 3, 6, true),
    d("Clap timing: a partner claps as your front foot lands and the release follows immediately", 2, 8, true),
  ],
  elbow: [
    d("Film side-on in slow motion (120–240 fps) from about 10 m; if the estimate stays high, talk to your coach", 1, 1, false),
  ],
};
const MAINTAIN_DRILLS = [
  d("Target bowling: deliveries at a cone on a good length, then at the top of off stump", 2, 6, true),
  d("Run-up check (no ball): mark your run-up and hit the same spot every time", 1, 6, false),
];

/** Stable checkbox id from the item's text, so ticks don't land on a different drill after a recompute. */
function itemId(w: number, day: string, text: string, taken: Set<string>): string {
  const base = `w${w}-${day.toLowerCase()}-${crc32(text).toString(16).padStart(8, "0")}`;
  let iid = base, n = 1;
  while (taken.has(iid)) {
    iid = `${base}-${n}`;
    n += 1;
  }
  taken.add(iid);
  return iid;
}

interface Item { text: string; detail?: string | null; id?: string }
interface Day { day: string; kind: string; title: string; items: Item[]; load?: { deliveries: number; limit: number | null } | null }

/**
 * Two weeks: three bowling sessions a week built around the top priorities, two strength days, rest, and a
 * re-film at the end. Every bowling session is counted in deliveries (warm-up, drills and spells) and kept
 * inside the age group's daily limit; drill sets shrink to fit before the spell does.
 */
export function practicePlan(result: InsightsResult, player: InsightsPlayer | null = null): Insights["plan"] {
  const [age, style] = level(player);
  const lim = limitsFor(age, style);
  const pr = (result.coaching.priorities || []).slice(0, 2);
  const keys = pr.map(drillKey).filter((k) => has(PLAN_DRILLS, k));
  const young = UNDER_17.includes(age);
  const drillsFor = (k: string) => get(PLAN_DRILLS, k, []).filter((x) => !(x.adult_only && UNDER_17.includes(age)));

  // the cue is the priority's own: a short and a long stride share a drill key but not a cue
  const focus = pr.filter((p) => has(PLAN_DRILLS, drillKey(p))).map((p) => ({ title: p.drill.title, cue: p.drill.cue, key: drillKey(p) }));
  const dayLimit = lim && lim.day ? lim.day * 6 : null;   // deliveries per match day
  const spellOvers = lim ? lim.spell : 6;
  // a training session stays well under a match day: at most two spells' worth, and for juniors at most 75% of
  // the match-day limit (every warm-up and drill ball counts towards it)
  let budget = 2 * spellOvers * 6;
  if (dayLimit) budget = Math.min(budget, Math.trunc(0.75 * dayLimit));
  const warm = age === "u11" ? 4 : 6;
  // the focus cue heads the plan, so sessions just say "your cue"; with no focus the general one is quoted
  const cue = focus.length ? "your cue" : "“Smooth rhythm, hit your length”";

  const bowlingSession = (w: number, i: number): Day => {
    const items: Item[] = [{ text: `Warm-up (10 min), then ${warm} build-up deliveries off a short run.` }];
    // two drills: the first focus, then the second focus (or another drill for the first)
    let picks: [PlanDrill, string | null][] = [];
    if (keys.length) {
      const a = drillsFor(keys[0]);
      picks.push([a[(i + w) % a.length], focus[0].title]);
      const k2 = keys.length > 1 ? keys[1] : keys[0];
      const b = drillsFor(k2).filter((x) => x !== picks[0][0]);
      if (b.length) picks.push([b[(i + w) % b.length], DRILLS[k2].title]);
    } else {
      picks = MAINTAIN_DRILLS.map((x) => [x, null]);
    }
    const drillCap = Math.trunc((budget - warm) * (w === 1 ? 0.6 : 0.35));
    let drillBalls = 0;
    for (const [x, title] of picks) {
      let sets = x.sets;
      if (x.balls) {
        while (sets > 1 && drillBalls + sets * x.reps > drillCap) sets -= 1;
        if (drillBalls + sets * x.reps > drillCap) continue;   // not even one set fits today's load: leave it out
        drillBalls += sets * x.reps;
      }
      const reps = x.reps > 1 ? ` (${sets} × ${x.reps})` : "";
      items.push({ text: x.text + reps, detail: title ? `Focus: ${title}` : null });
    }
    const left = budget - warm - drillBalls;
    const overs = Math.min(spellOvers, Math.floor(left / 6));
    let second = w === 2 ? Math.min(spellOvers, Math.floor((left - overs * 6) / 6)) : 0;
    if (second < 2) second = 0;   // a one-over "second spell" isn't worth the rest and re-warm-up
    if (overs >= 1) {
      const ov = (n: number) => `${n} over${n > 1 ? "s" : ""}`;
      if (w === 1) {
        items.push({ text: `Short run-up (5–7 steps): ${ov(overs)} focusing only on ${cue}.` });
      } else {
        let txt = `Full run-up: ${ov(overs)} at about 80% effort, keeping ${cue}.`;
        if (second) txt += ` Rest at least 20 minutes, then an optional second spell of up to ${ov(second)}.`;
        items.push({ text: txt });
      }
    }
    items.push({ text: "Cool-down (5 min): walk and stretch." });
    const total = warm + drillBalls + 6 * (overs + second);
    return { day: ["Mon", "Wed", "Fri"][i], kind: "bowling", title: `Bowling session ${i + 1}`, items,
      load: { deliveries: total, limit: dayLimit } };
  };

  const weeks: Insights["plan"]["weeks"] = [];
  for (const w of [1, 2]) {
    const days: Day[] = [];
    for (let i = 0; i < 3; i++) {
      if (w === 2 && i === 2) {
        days.push({ day: "Fri", kind: "film", title: "Test day: film and compare", items: [
          { text: `Warm up as usual (including ${warm} build-up deliveries), then bowl 6 deliveries at match intensity.` },
          { text: "Film them from the same angle as before (side-on and/or from behind), steady and in slow motion if possible." },
          { text: "Analyse the best clip with your player profile selected and check 'Since last time' on your progress page." },
        ], load: { deliveries: warm + 6, limit: dayLimit } });
        continue;
      }
      days.push(bowlingSession(w, i));
    }
    let strength = keys.flatMap((k) => get(STRENGTH, k, [])).slice(0, 3);
    if (!strength.length) strength = GENERAL_STRENGTH;
    if (young) {
      strength = strength.filter((x) => !x.includes("band"));
      if (!strength.length) strength = GENERAL_STRENGTH;
    }
    for (const day of ["Tue", "Thu"]) {
      days.push({ day, kind: "strength", title: "Strength & mobility (no bowling)",
        items: [...strength.map((text) => ({ text })),
          ...(["u11", "u13", "u15"].includes(age) ? [{ text: "Bodyweight only at your age — no heavy weights needed." }] : [])] });
    }
    let sat: string;
    if (young) {
      sat = w === 1 ? "Playing a match? It counts as a bowling day: make Friday a rest day instead."
        : "Playing a match? Move Friday's test day to the Monday after, so you never bowl two days in a row.";
    } else {
      sat = w === 1 ? "Playing a match? It counts as a bowling day, so keep Friday light."
        : "Playing a match? Keep Friday's test to the warm-up and the 6 filmed deliveries.";
    }
    days.push({ day: "Sat", kind: "rest", title: "Match or rest", items: [{ text: sat }] });
    days.push({ day: "Sun", kind: "rest", title: "Rest", items: [{ text: "Full rest from bowling." }] });
    const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    days.sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));   // stable, like list.sort
    const taken = new Set<string>();
    for (const day of days) {
      if (!("load" in day)) day.load = null;
      for (const it of day.items) {
        it.id = itemId(w, day.day, it.text, taken);
        if (!("detail" in it)) it.detail = null;
      }
    }
    weeks.push({ title: w === 1 ? "Week 1: learn the movement" : style === "spin" ? "Week 2: build up to match intensity"
      : JUNIOR.includes(age) ? "Week 2: bowl off your full run-up" : "Week 2: build towards full pace",
      days: days as Insights["plan"]["weeks"][number]["days"] });
  }
  const notes: string[] = [];
  if (lim) {
    notes.push(`Limits for ${lim.label} bowlers: at most ${lim.spell} overs a spell`
      + (lim.day ? ` and ${lim.day} overs a day` : "")
      + `, ${lim.days_week} bowling days a week. ${lim.rule} `
      + `Rest at least ${lim.between_spells_min} minutes between spells. Warm-up and drill balls count `
      + "too; every session here stays inside the limits.");
    notes.push("Matches and club nets are bowling days too: swap a session for them rather than adding them on top.");
    if (lim.preseason_weeks) {
      notes.push(`Coming back after a break? Build up over about ${lim.preseason_weeks} weeks before bowling flat out.`);
    }
    if (JUNIOR.includes(age)) {
      notes.push("In a long net session, bowl for no more than about 30 minutes at a stretch, then rest for as long. Plan a lighter "
        + "week every 4–6 weeks, and after a growth spurt bowl shorter spells or less often for a while.");
    }
  } else {
    notes.push("Spin bowling loads are lower than pace; still keep at least one full rest day a week.");
  }
  notes.push("Stop bowling and see a physio or sports doctor if you get lower back pain, or any pain that changes how you bowl or is still there the next day.");
  return { focus, weeks, limits: lim, notes };
}

export function insights(result: InsightsResult, player: InsightsPlayer | null = null): Insights {
  const p = player && Object.keys(player).length ? player : null;   // Python: `if player` (an empty dict is falsy)
  return {
    summary: summary(result, player), back_health: backHealth(result, player), plan: practicePlan(result, player),
    player: p ? { id: p.id ?? null, name: p.name ?? null, age_group: p.age_group ?? null, style: p.style ?? null } as Insights["player"] : null,
  };
}
