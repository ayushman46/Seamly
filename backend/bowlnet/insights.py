"""Plain-language coaching for non-professional bowlers: what the analysis means, a lower-back screen and a
two-week practice plan pitched at the player's age group.

Workload limits follow Cricket Australia's junior pace bowling guidelines (match and training tables, pre-season
build-up, back-pain advice). Nothing here is a medical assessment; the back screen says so.
"""
from __future__ import annotations

import zlib

from .players import AGE_LABEL

JUNIOR = ("u11", "u13", "u15", "u17", "u19")
UNDER_17 = ("u11", "u13", "u15", "u17")

# Cricket Australia junior pace bowling guidelines: max overs per spell / per match day; training: max 3 bowling
# days a week with a day off after each (under 17), max 4 with no more than 2 in a row (17-19), spells of at
# most 5 (under 17) or 6 overs (17-19) and 20 minutes between spells.
LIMITS = {
    "u11": dict(spell=2, day=4, days_week=3, rule="At least one day off after every bowling day."),
    "u13": dict(spell=4, day=8, days_week=3, rule="At least one day off after every bowling day."),
    "u15": dict(spell=5, day=12, days_week=3, rule="At least one day off after every bowling day."),
    "u17": dict(spell=5, day=16, days_week=3, rule="At least one day off after every bowling day."),
    "u19": dict(spell=6, day=18, days_week=4, rule="No more than two bowling days in a row."),
}
ADULT_LIMITS = dict(spell=6, day=None, days_week=4, rule="No more than two bowling days in a row.")
PRESEASON_WEEKS = {"u11": 2, "u13": 2, "u15": 4, "u17": 6, "u19": 8}
CA_SOURCE = "Cricket Australia junior pace bowling guidelines"

# Why each focus matters, in plain words (same evidence as the metric references, without the jargon).
WHY = {
    "front_leg": "A firm front leg acts like a pole-vaulter's pole: it stops the run-up and catapults your upper "
                 "body and arm forward. Bowlers with a straighter front knee at release tend to bowl faster.",
    "trunk_flexion": "Driving the chest forward over the front leg adds speed to the arm. It is one of the "
                     "biggest sources of pace in research on fast bowlers.",
    "side_bend": "Leaning sideways at release loads one side of the lower back and tends to drag the ball off line.",
    "mixed_action": "When the hips and shoulders point different ways at back-foot contact, the lower back has to "
                    "twist under load. This 'mixed action' is linked to back stress injuries, especially in juniors.",
    "release_height": "A higher release point makes the most of your height and gives the ball more bounce.",
    "stride": "A stride that is too long or too short makes it hard to stay tall and braced at release.",
    "rhythm": "A pause between landing and letting go lets the energy from your run-up leak away.",
    "elbow": "Only an accredited lab test can judge whether an action is legal; this is a screening estimate.",
}

# some priorities share a drill but not the reason (a folding back leg is a back-health issue, not a pace one)
WHY_BY_METRIC = {
    "back_knee_bfc": "A back leg that folds when it lands was linked to lower-back stress injuries in a study of "
                     "young fast bowlers. A firmer back leg spreads the landing load.",
    "head_offset_br": "When the head falls away from the front foot at release, accuracy suffers and the lower back "
                      "takes extra sideways load.",
    "elbow_extension": "Only an accredited lab test can judge whether an action is legal; this is a screening estimate.",
}

STRENGTH = {
    "front_leg": ["Single-leg step-downs from a low step, slow on the way down (3 × 8 each leg)",
                  "Glute bridges (3 × 12)"],
    "trunk_flexion": ["Dead bugs (3 × 10)", "Hip-hinge with a broomstick on your back (3 × 10)"],
    "side_bend": ["Side planks (3 × 30 s each side)", "Bird dogs (3 × 10 each side)"],
    "mixed_action": ["Anti-rotation hold with a band or partner (3 × 20 s each side)",
                     "Side planks (3 × 30 s each side)"],
    "release_height": ["Thoracic rotations on all fours (2 × 10 each side)", "Wall slides, arms overhead (3 × 10)"],
    "stride": ["Split squats (3 × 8 each leg)", "Lateral bound and stick (3 × 6 each side)"],
    "rhythm": ["Skipping or ankle hops (3 × 20)", "Fast-feet cone drill (3 × 20 s)"],
}
GENERAL_STRENGTH = ["Plank (3 × 30 s)", "Bodyweight squats (3 × 12)", "Hip-flexor and hamstring stretches (2 × 30 s)"]

GRADE_PHRASE = {"Excellent": "Excellent action", "Elite": "Excellent action","Strong": "Strong action", "Developing": "A good base",
                "Needs work": "Plenty to gain"}


def _level(player: dict | None) -> tuple[str, str]:
    p = player or {}
    return p.get("age_group") or "adult", p.get("style") or "fast"


def summary(result: dict, player: dict | None = None) -> dict:
    """The analysis in a few plain sentences: headline, what's working, what to fix first and why."""
    c = result["coaching"]
    age, style = _level(player)
    pr = c.get("priorities") or []
    if c.get("score") is None:
        headline = "Not enough could be measured reliably in this clip for an overall verdict; here is what we could see."
    elif not pr:
        headline = f"{GRADE_PHRASE.get(c.get('grade'), 'Good action')}: nothing stands out to fix in what this camera angle can see."
    else:
        # "Excellent action" right above things to work on reads as a contradiction
        phrase = "A sound action" if c.get("grade") in ("Excellent", "Elite") else GRADE_PHRASE.get(c.get("grade"), "Your action")
        headline = f"{phrase}. Your next step: {pr[0]['drill']['title'].lower()}."
    fixes = [{"title": p["drill"]["title"], "what": p["headline"],
              "why": WHY_BY_METRIC.get(p.get("key"), WHY.get(_drill_key(p), p.get("why", ""))),
              "cue": p["drill"]["cue"], "event": p.get("event"), "rating": p.get("rating")} for p in pr[:2]]
    view = result["view"]["view"]
    unlock = []
    if view in ("behind", "front_on"):
        unlock.append("Film side-on (10-15 m away, hip height) to also measure your front knee, trunk flexion and stride.")
    else:
        unlock.append("Film from behind the stumps to also measure side-bend, alignment and whether you fall away.")
    if result.get("fps_real", 30) < 90:
        unlock.append("Use your phone's slow-motion mode (120–240 fps) to time release and foot contacts precisely.")
    notes = []
    if age in JUNIOR and style != "spin":
        notes.append("At your age, a safe action and sensible bowling loads matter more than pace; the pace comes later.")
    if style == "spin":
        notes.append("Seamly's reference values come from studies of pace bowlers; for spin, treat the ratings as a rough guide.")
    return {"headline": headline, "working": list(c.get("strengths") or [])[:3], "fixes": fixes,
            "unlock": unlock, "notes": notes}


def _drill_key(priority: dict) -> str:
    if priority.get("drill_key"):
        return priority["drill_key"]
    from .coaching import DRILLS   # analyses made before priorities carried their drill key
    return next((k for k, d in DRILLS.items() if d["title"] == priority["drill"]["title"]), "")


def back_health(result: dict, player: dict | None = None) -> dict | None:
    """Lower-back technique screen for pace bowlers: side-bend, mixed action and back-knee collapse."""
    age, style = _level(player)
    if style == "spin":
        return None
    by = {m["key"]: m for m in result["metrics"]}

    def status(key: str) -> tuple[str, dict | None]:
        m = by.get(key)
        # same reliability bar as the coaching priorities: a shaky reading is reported as unknown, not as a flag
        if not m or m.get("value") is None or m.get("rating") not in ("good", "watch", "risk") or m.get("confidence", 0) < 0.3:
            return "unknown", m
        return {"good": "ok", "watch": "watch", "risk": "flag"}[m["rating"]], m

    checks = []
    s, m = status("trunk_lateral_br")
    checks.append({"key": "side_bend", "label": "Side-bend at release", "status": s,
                   "value": m.get("value") if m and s != "unknown" else None, "unit": "deg",
                   "text": {"ok": "Within the range seen in uninjured junior bowlers.",
                            "watch": "Higher than typical; worth reducing with the 'stay tall' drills.",
                            "flag": "In the range linked to later back injury in junior fast bowlers.",
                            "unknown": (m or {}).get("note") or "Not measurable in this clip; film from behind."}[s]})
    s1, m1 = status("hip_shoulder_sep_bfc")
    s2, m2 = status("shoulder_counter_rotation")
    order = {"flag": 3, "watch": 2, "ok": 1, "unknown": 0}
    s = max((s1, s2), key=lambda x: order[x])   # worst of the measured ones; unknown only if neither was measured
    checks.append({"key": "mixed_action", "label": "Mixed action (hip-shoulder twist)", "status": s,
                   "value": None, "unit": None,
                   "text": {"ok": "Hips and shoulders line up at back-foot contact.",
                            "watch": "Some twist between hips and shoulders; keep an eye on it.",
                            "flag": "A mixed action: hips and shoulders point different ways at back-foot contact.",
                            "unknown": (m1 or {}).get("note") or (m2 or {}).get("note")
                                       or "Not measurable in this clip; film from behind the stumps."}[s]})
    s, m = status("back_knee_bfc")
    checks.append({"key": "back_knee", "label": "Back leg at back-foot contact", "status": s,
                   "value": m.get("value") if m and s != "unknown" else None, "unit": "deg",
                   "text": {"ok": "The back leg stays firm when it lands.",
                            "watch": "The back leg bends a little more than ideal when it lands.",
                            "flag": "The back leg folds on landing, which was linked to back injuries in one study.",
                            "unknown": (m or {}).get("note") or "Not measurable in this clip; film side-on."}[s]})
    measured = [ch["status"] for ch in checks if ch["status"] != "unknown"]
    overall = ("flag" if "flag" in measured else "watch" if "watch" in measured else "ok" if measured else "unknown")
    advice = []
    if overall in ("flag", "watch"):
        advice.append("Show this to a coach and work on the drills in your practice plan.")
    if age in JUNIOR:
        advice.append("Lower-back stress injuries are most common in teenage fast bowlers, especially in the two to "
                      "three years after a growth spurt. Stick to the bowling limits in your plan.")
    advice.append("If you get lower back pain while bowling, stop and see a sports doctor or physiotherapist "
                  "before bowling again.")
    return {"overall": overall, "checks": checks, "advice": advice, "measured": len(measured), "total": len(checks),
            "disclaimer": "A technique screen from one video, not a medical assessment."}


def _limits(age: str, style: str) -> dict | None:
    """Workload limits for the age group. Juniors always get them (for spinners the pace limits are a safe ceiling);
    adult pace bowlers get the 17-19 pattern as general guidance; adult spinners have no fixed limits."""
    lim = LIMITS.get(age)
    if lim:
        src = CA_SOURCE if style != "spin" else f"{CA_SOURCE} (pace limits, used as a safe ceiling for young spinners)"
        return {**lim, "age_group": age, "label": AGE_LABEL[age], "source": src,
                "between_spells_min": 20, "preseason_weeks": PRESEASON_WEEKS[age]}
    if style == "spin":
        return None
    return {**ADULT_LIMITS, "age_group": "adult", "label": AGE_LABEL["adult"],
            "source": "general guidance (the official limits are for juniors)", "between_spells_min": 20,
            "preseason_weeks": None}


def _d(text: str, sets: int, reps: int, balls: bool, adult_only: bool = False) -> dict:
    return {"text": text, "sets": sets, "reps": reps, "balls": balls, "adult_only": adult_only}


# Plan drills (same content as coaching.DRILLS) with the number of deliveries each one bowls, so every session can
# be kept inside the day's limit. "No ball" drills are movement rehearsals and don't count towards it.
PLAN_DRILLS = {
    "front_leg": [
        _d("Standing brace: front foot planted, bowl from a static delivery-stride position, keeping the knee firm", 3, 6, True),
        _d("Walk-through then jog-through deliveries, adding speed only while the knee stays firm", 3, 6, True),
        _d("Gather-and-bound onto a mat, freezing at front-foot contact to feel the brace (no ball)", 2, 8, False),
    ],
    "trunk_flexion": [
        _d("Kneeling throws: front knee down, pull the trunk down and through towards a target (light ball)", 3, 8, False),
        _d("Med-ball slam from the delivery-stride position", 3, 6, False, adult_only=True),
        _d("Follow-through line: bowl and finish with the chest past the front knee on a chalk line", 2, 8, True),
    ],
    "side_bend": [
        _d("Chalk-line run-ups: bowl landing on a straight line so the body isn't forced to lean", 3, 6, True),
        _d("Front-arm drive (no ball): the hand reaches towards the target and finishes near the chest", 2, 10, False),
        _d("Wall drill: bowl alongside a wall or net on the non-bowling side to stop falling away", 2, 8, True),
    ],
    "mixed_action": [
        _d("Chalk the crease: mark back- and front-foot spots and bowl, matching the shoulders to the back-foot line", 3, 6, True),
        _d("Mirror or phone check at back-foot contact from behind (no ball): fix the shoulders first", 2, 8, False),
        _d("Slow-motion walk-throughs freezing at back-foot contact to rehearse alignment (no ball)", 2, 6, False),
    ],
    "release_height": [
        _d("High-target drill: release over a raised rope or bar 1 m in front of the crease", 3, 6, True),
        _d("Standing-start deliveries, reaching up tall through the bowling arm", 3, 6, True),
    ],
    "stride": [
        _d("Stride markers: mark a front-foot spot about 75–80% of your height from the back foot and bowl to it", 3, 6, True),
        _d("Bound and stick (no ball): bound into the delivery stride and hold your balance for two seconds", 2, 8, False),
    ],
    "rhythm": [
        _d("Short run-up (5 steps) deliveries, thinking only about landing and letting go straight away", 3, 6, True),
        _d("Clap timing: a partner claps as your front foot lands and the release follows immediately", 2, 8, True),
    ],
    "elbow": [
        _d("Film side-on in slow motion (120–240 fps) from about 10 m; if the estimate stays high, book an accredited biomechanics test", 1, 1, False),
    ],
}
MAINTAIN_DRILLS = [
    _d("Target bowling: deliveries at a cone on a good length, then at the top of off stump", 2, 6, True),
    _d("Run-up check (no ball): mark your run-up and hit the same spot every time", 1, 6, False),
]


def _item_id(w: int, day: str, text: str, taken: set) -> str:
    """Stable checkbox id from the item's text, so ticks don't land on a different drill after a recompute."""
    base = f"w{w}-{day.lower()}-{zlib.crc32(text.encode()) & 0xffffffff:08x}"
    iid, n = base, 1
    while iid in taken:
        iid, n = f"{base}-{n}", n + 1
    taken.add(iid)
    return iid


def practice_plan(result: dict, player: dict | None = None) -> dict:
    """Two weeks: three bowling sessions a week built around the top priorities, two strength days, rest, and a
    re-film at the end. Every bowling session is counted in deliveries (warm-up, drills and spells) and kept
    inside the age group's daily limit; drill sets shrink to fit before the spell does."""
    age, style = _level(player)
    lim = _limits(age, style)
    pr = (result["coaching"].get("priorities") or [])[:2]
    keys = [k for k in (_drill_key(p) for p in pr) if k in PLAN_DRILLS]
    young = age in UNDER_17

    def drills_for(k: str) -> list[dict]:
        return [d for d in PLAN_DRILLS.get(k, []) if not (d["adult_only"] and age in UNDER_17)]

    from .coaching import DRILLS
    focus = [{"title": DRILLS[k]["title"], "cue": DRILLS[k]["cue"], "key": k} for k in keys]
    day_limit = lim["day"] * 6 if lim and lim.get("day") else None   # deliveries per match day
    spell_overs = lim["spell"] if lim else 6
    # a training session stays well under a match day: at most two spells' worth, and for juniors at most 75% of
    # the match-day limit (every warm-up and drill ball counts towards it)
    budget = 2 * spell_overs * 6
    if day_limit:
        budget = min(budget, int(0.75 * day_limit))
    warm = 4 if age == "u11" else 6
    # cues end with a full stop; they are quoted inside a sentence below
    cue = (focus[0]["cue"] if focus else "Smooth rhythm, hit your length").rstrip(".")

    def bowling_session(w: int, i: int) -> dict:
        items = [{"text": f"Warm-up (10 min): easy jog, leg swings, lunges, arm circles, then {warm} build-up deliveries off a short run."}]
        # two drills: the first focus, then the second focus (or another drill for the first)
        picks: list[tuple[dict, str]] = []
        if keys:
            a = drills_for(keys[0])
            picks.append((a[(i + w) % len(a)], focus[0]["title"]))
            k2 = keys[1] if len(keys) > 1 else keys[0]
            b = [d for d in drills_for(k2) if d is not picks[0][0]]
            if b:
                picks.append((b[(i + w) % len(b)], DRILLS[k2]["title"]))
        else:
            picks = [(d, None) for d in MAINTAIN_DRILLS]
        drill_cap = int((budget - warm) * (0.6 if w == 1 else 0.35))
        drill_balls = 0
        for d, title in picks:
            sets = d["sets"]
            if d["balls"]:
                while sets > 1 and drill_balls + sets * d["reps"] > drill_cap:
                    sets -= 1
                if drill_balls + sets * d["reps"] > drill_cap:
                    continue   # not even one set fits today's load: leave it out
                drill_balls += sets * d["reps"]
            reps = f" ({sets} x {d['reps']})" if d["reps"] > 1 else ""
            items.append({"text": d["text"] + reps, "detail": f"Focus: {title}" if title else None})
        left = budget - warm - drill_balls
        overs = min(spell_overs, left // 6)
        second = min(spell_overs, (left - overs * 6) // 6) if w == 2 else 0
        if overs >= 1:
            ov = lambda n: f"{n} over{'s' if n > 1 else ''}"
            if w == 1:
                items.append({"text": f"Short run-up (5-7 steps): {ov(overs)} focusing only on \"{cue}\"."})
            else:
                txt = f"Full run-up: {ov(overs)} at about 80% effort, keeping \"{cue}\"."
                if second >= 1:
                    txt += f" Rest at least 20 minutes, then an optional second spell of up to {ov(second)}."
                items.append({"text": txt})
        items.append({"text": "Cool-down (5 min): walk, then calf, hamstring and hip-flexor stretches."})
        total = warm + drill_balls + 6 * (overs + second)
        return {"day": ("Mon", "Wed", "Fri")[i], "kind": "bowling", "title": f"Bowling session {i + 1}", "items": items,
                "load": {"deliveries": total, "limit": day_limit}}

    weeks = []
    for w in (1, 2):
        days = []
        for i in range(3):
            if w == 2 and i == 2:
                days.append({"day": "Fri", "kind": "film", "title": "Test day: film and compare", "items": [
                    {"text": f"Warm up as usual (including {warm} build-up deliveries), then bowl 6 deliveries at match intensity."},
                    {"text": "Film them from the same angle as before (side-on and/or from behind), steady and in slow motion if possible."},
                    {"text": "Analyse the best clip with your player profile selected and check 'Since last time' on your progress page."},
                ], "load": {"deliveries": warm + 6, "limit": day_limit}})
                continue
            days.append(bowling_session(w, i))
        strength = [s for k in keys for s in STRENGTH.get(k, [])][:3] or GENERAL_STRENGTH
        if young:
            strength = [s for s in strength if "band" not in s] or GENERAL_STRENGTH
        for day in ("Tue", "Thu"):
            days.append({"day": day, "kind": "strength", "title": "Strength & mobility (no bowling)",
                         "items": [{"text": s} for s in strength] +
                                  ([{"text": "Bodyweight only at your age — no heavy weights needed."}] if age in ("u11", "u13", "u15") else [])})
        if young:
            sat = ("Playing a match? It counts as a bowling day: make Friday a rest day instead." if w == 1 else
                   "Playing a match? Move Friday's test day to the Monday after, so you never bowl two days in a row.")
        else:
            sat = ("Playing a match? It counts as a bowling day, so keep Friday light." if w == 1 else
                   "Playing a match? Keep Friday's test to the warm-up and the 6 filmed deliveries.")
        days.append({"day": "Sat", "kind": "rest", "title": "Match or rest", "items": [{"text": sat}]})
        days.append({"day": "Sun", "kind": "rest", "title": "Rest", "items": [{"text": "Full rest from bowling."}]})
        order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        days.sort(key=lambda d: order.index(d["day"]))
        taken: set = set()
        for d in days:
            d.setdefault("load", None)
            for it in d["items"]:
                it["id"] = _item_id(w, d["day"], it["text"], taken)
                it.setdefault("detail", None)
        weeks.append({"title": "Week 1: learn the movement" if w == 1 else "Week 2: take it to full pace", "days": days})
    notes = []
    if lim:
        notes.append(f"Bowling limits for {lim['label']} bowlers ({lim['source']}): at most {lim['spell']} overs per "
                     "spell" + (f" and {lim['day']} overs ({lim['day'] * 6} deliveries) per day" if lim["day"] else "") +
                     f", up to {lim['days_week']} bowling days a week. {lim['rule']} "
                     f"Take at least {lim['between_spells_min']} minutes between spells at training. Every delivery "
                     "counts, including warm-up and drill balls: each session above is counted and stays well inside the limit.")
        if lim.get("preseason_weeks"):
            notes.append(f"Coming back after a break? Build up over about {lim['preseason_weeks']} weeks before bowling flat out.")
    else:
        notes.append("Spin bowling loads are lower than pace; still keep at least one full rest day a week.")
    notes.append("Stop and see a physio or sports doctor if you get lower back pain while bowling.")
    return {"focus": focus, "weeks": weeks, "limits": lim, "notes": notes}


def insights(result: dict, player: dict | None = None) -> dict:
    return {"summary": summary(result, player), "back_health": back_health(result, player),
            "plan": practice_plan(result, player),
            "player": {k: player.get(k) for k in ("id", "name", "age_group", "style")} if player else None}
