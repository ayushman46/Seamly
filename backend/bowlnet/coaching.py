"""Turn metrics into a headline score, prioritised coaching points and drills.

Feedback style follows what works in the category (one score, then three priorities, each tagged as a
pace or load/injury issue with an evidence level and a drill), and never presents legality or injury
estimates as verdicts.
"""
from __future__ import annotations

import re

from .metrics import NORMS

# headline values that keep their sign (a negative trunk lean is a lean backwards, not a small forward one)
SIGNED = {"trunk_flexion_ffc_br", "trunk_forward_br"}

DRILLS = {
    "front_leg": {
        "title": "Brace the front leg",
        "cue": "Land tall, push the ground away — ‘stand up’ through the front leg as the arm comes over.",
        "drills": [
            "Standing brace: front foot planted, bowl from a static delivery-stride position, focus on a firm knee (3 × 6).",
            "Walk-through then jog-through deliveries, adding speed only while the knee stays firm (3 × 6).",
            "Gather-and-bound drill onto a mat, freezing at front-foot contact to feel the brace (2 × 8).",
        ],
    },
    "trunk_flexion": {
        "title": "Drive the chest through",
        "cue": "Chest over the front knee — finish with your bowling shoulder pointing at the batter.",
        "drills": [
            "Kneeling throws with a light ball: front knee down, pull the trunk down and through towards a target (3 × 8).",
            "Med-ball slam from the delivery stride position, 2–3 kg ball (17+ only) (3 × 6).",
            "Follow-through line drill: finish with the chest past the front knee on a chalk line (2 × 8).",
        ],
    },
    "side_bend": {
        "title": "Stay tall at release",
        "cue": "Head over the front foot, front arm drives towards the target rather than yanking down.",
        "drills": [
            "Chalk-line run-ups: run and land on a straight line so the body isn't forced to lean (3 × 6).",
            "Front-arm drive drill: hand reaches towards the target and finishes near the chest (2 × 10).",
            "Wall drill: bowl alongside a wall/net on the non-bowling side to discourage falling away (2 × 8).",
        ],
    },
    "mixed_action": {
        "title": "Line up hips and shoulders",
        "cue": "Hips and shoulders face the same way at back-foot contact — side-on, semi-open or front-on are all fine; mixing them isn't.",
        "drills": [
            "Chalk the crease: mark back-foot and front-foot positions and match shoulders to the back-foot line (3 × 6).",
            "Mirror/phone checks at back-foot contact from behind; fix the shoulders first (2 × 8).",
            "Slow-motion walk-throughs freezing at back-foot contact to rehearse alignment (2 × 6).",
        ],
    },
    "release_height": {
        "title": "Get taller at release",
        "cue": "Stand tall on your front leg and let the ball go at the top of your natural arm path.",
        "drills": [
            "High-target drill: release over a raised rope/bar 1 m in front of the crease (3 × 6).",
            "Standing-start bowling focusing on reaching up through the bowling arm (3 × 6).",
        ],
    },
    "stride": {
        "title": "Find your stride",
        "cue": "Bound up, not along — land with a stride that lets you stay tall.",
        "drills": [
            "Stride markers: mark a target front-foot position at ~75–80% of your height from the back foot (3 × 6).",
            "Bound and stick: bound into the delivery stride and hold balance for two seconds (2 × 8).",
        ],
    },
    # the same drills for a short stride, with a cue that asks for more length, not less
    "stride_short": {
        "title": "Find your stride",
        "cue": "Push off and reach your front foot a little further down the pitch.",
        "drills": [
            "Stride markers: mark a target front-foot position at ~75–80% of your height from the back foot (3 × 6).",
            "Bound and stick: bound into the delivery stride and hold balance for two seconds (2 × 8).",
        ],
    },
    "rhythm": {
        "title": "Quicker through the crease",
        "cue": "Land and go — front foot down, arm over, no pause.",
        "drills": [
            "Short run-up (5 steps) focusing on the time from front-foot landing to release (3 × 6).",
            "Metronome / clap timing: the release follows the front-foot 'thud' immediately (2 × 8).",
        ],
    },
    "elbow": {
        "title": "Keep an eye on the elbow",
        "cue": "Keep the arm long and relaxed from horizontal to release.",
        "drills": [
            "Film side-on at 120–240 fps from 10 m and re-analyse. If the estimate stays high, talk to your coach; your state or county association can advise if they're worried.",
        ],
    },
}

RULES = [
    # key, issue (rating that triggers), category, drill, weight, headline (formatted with value)
    ("front_knee_br", ("watch",), "pace", "front_leg", 1.0,
     "Front knee softens to {v:.0f}° at release (aim for 160° or straighter)", "Moderate evidence for pace (r ≈ 0.4)"),
    ("front_knee_flexion", ("watch",), "pace", "front_leg", 0.7,
     "Front knee flexes {v:.0f}° after landing", "Moderate evidence"),
    ("trunk_flexion_ffc_br", ("watch",), "pace", "trunk_flexion", 0.8,
     "Not much forward bend of the upper body from landing to release ({v:.0f}°)", "Moderate evidence for pace"),
    ("trunk_forward_br", ("watch",), "pace", "trunk_flexion", 0.6,
     "Upright trunk at release ({v:.0f}°)", "Moderate evidence for pace"),
    ("trunk_lateral_br", ("watch", "risk"), "load", "side_bend", 1.1,
     "High side-bend at release ({v:.0f}°)", "Moderate evidence in juniors, contested in adults"),
    ("hip_shoulder_sep_bfc", ("watch", "risk"), "load", "mixed_action", 1.0,
     "Hips and shoulders misaligned at back-foot contact ({v:.0f}°)", "Classification; injury link debated"),
    ("shoulder_counter_rotation", ("watch", "risk"), "load", "mixed_action", 0.9,
     "Shoulders twist back {v:.0f}° after back-foot contact", "Low-moderate evidence (stronger in juniors)"),
    ("back_knee_bfc", ("watch", "risk"), "load", "front_leg", 0.6,
     "Back leg folds at back-foot contact ({v:.0f}°)", "One prospective study"),
    ("release_height_pct", ("watch",), "pace", "release_height", 0.6,
     "Release point is low ({v:.0f}% of height)", "Descriptive"),
    ("stride_length_pct", ("watch",), "pace", "stride", 0.4,
     "{side} delivery stride ({v:.0f}% of height; typical 70–87%)", "Weak evidence"),
    ("ffc_to_br_ms", ("watch",), "pace", "rhythm", 0.4,
     "Slow from front-foot contact to release ({v:.0f} ms)", "Low confidence"),
    ("head_offset_br", ("watch", "risk"), "accuracy", "side_bend", 0.6,
     "Head falls {v:.0f} cm outside the front foot", "Coaching heuristic"),
    ("elbow_extension", ("watch", "risk"), "legality", "elbow", 0.8,
     "Estimated elbow extension {v:.0f}°", "Screening only — not an ICC test"),
]

POSITIVES = {
    "front_knee_br": "Strong, braced front leg at release",
    "trunk_lateral_br": "Controlled side-bend at release",
    "hip_shoulder_sep_bfc": "Hips and shoulders aligned at back-foot contact",
    "shoulder_counter_rotation": "Minimal shoulder counter-rotation",
    "release_height_pct": "High release point",
    "trunk_flexion_ffc_br": "Good forward bend of the upper body from landing to release",
    "stride_length_pct": "Stride length in the typical elite range",
    "back_knee_bfc": "Firm back leg at back-foot contact",
    "head_offset_br": "Head stays over the front foot",
}

# body area of each metric, so a strength is never listed for an area that is also a fix
AREA = {
    "front_knee_br": "front_knee", "front_knee_flexion": "front_knee", "front_knee_ffc": "front_knee",
    "trunk_flexion_ffc_br": "trunk", "trunk_forward_br": "trunk", "trunk_lateral_br": "side_bend",
    "head_offset_br": "side_bend", "hip_shoulder_sep_bfc": "alignment", "shoulder_counter_rotation": "alignment",
    "back_knee_bfc": "back_knee", "release_height_pct": "release", "stride_length_pct": "stride",
    "ffc_to_br_ms": "rhythm", "elbow_extension": "elbow",
}

SCORE_WEIGHTS = {
    "front_knee_br": 1.0, "trunk_flexion_ffc_br": 0.8, "trunk_lateral_br": 1.0, "hip_shoulder_sep_bfc": 0.8,
    "shoulder_counter_rotation": 0.6, "release_height_pct": 0.6, "stride_length_pct": 0.4,
    "back_knee_bfc": 0.5, "ffc_to_br_ms": 0.3, "head_offset_br": 0.5, "trunk_forward_br": 0.4,
}
RATING_POINTS = {"good": 1.0, "watch": 0.55, "risk": 0.15}
# a "watch" reading within one measurement step of its target is borderline: still listed, but ranked below clear misses.
# The ranking weight ramps up smoothly over two steps, so a degree either side of a boundary (a frame decoded slightly
# differently in another browser) doesn't reorder the plan.
BORDER_STEP = {"deg": 3.0, "% height": 3.0, "cm": 5.0}
MIN_SCORED = 3


def coach(metrics: list[dict], view: str, fps: float) -> dict:
    by = {m["key"]: m for m in metrics}
    # ---------- headline score: confidence-weighted average of rated metrics ----------
    num = den = 0.0
    contrib = []
    for k, w in SCORE_WEIGHTS.items():
        m = by.get(k)
        if not m or m["value"] is None or m["rating"] not in RATING_POINTS or m["confidence"] < 0.3:
            continue
        cw = w * (0.3 + 0.7 * m["confidence"])
        num += cw * RATING_POINTS[m["rating"]]
        den += cw
        contrib.append({"key": k, "label": m["label"], "rating": m["rating"], "weight": round(cw, 2)})
    # a headline number needs a few independent measurements behind it, not one lucky metric
    score = int(round(100 * num / den)) if den and len(contrib) >= MIN_SCORED else None
    grade = None
    if score is not None:
        # grades the action's checkpoints, not the player's standard (so no "Elite" for a club bowler)
        grade = "Excellent" if score >= 85 else "Strong" if score >= 70 else "Developing" if score >= 55 else "Needs work"

    # ---------- priorities ----------
    issues = []
    for key, trig, cat, drill, w, head, evidence in RULES:
        m = by.get(key)
        if not m or m["value"] is None or m["rating"] not in trig or m["confidence"] < 0.3:
            continue
        sev = (1.5 if m["rating"] == "risk" else 1.0) * w * (0.4 + 0.6 * m["confidence"])
        # {side}: which way a two-sided band was missed (a beginner needs "short", not "outside the range")
        good = NORMS.get(key, {}).get("good") or (None, None)
        lo, hi = good[0], good[1]
        v = m["value"]
        side = "Short" if lo is not None and v < lo else "Long"
        gap = (lo - v) if lo is not None and v < lo else (v - hi) if hi is not None and v > hi else 0.0
        step = 1000.0 / fps if m.get("unit") == "ms" and fps else BORDER_STEP.get(m.get("unit"), 0.0)
        borderline = m["rating"] == "watch" and 0 < gap <= step
        if m["rating"] == "watch" and step and 0 < gap < 2 * step:
            sev *= 0.5 + 0.25 * gap / step
        issues.append({
            "key": key, "category": cat, "severity": round(sev, 2), "rating": m["rating"], "borderline": borderline,
            # trunk lean keeps its sign (a negative value leans back); a true minus sign for display
            "headline": re.sub(r"(^|[\s(])-(?=\d)", "\\1\u2212", head.format(v=m["value"] if key in SIGNED else abs(m["value"]), side=side)),
            "evidence": evidence,
            "why": m.get("explain", ""), "metric": key, "confidence": m["confidence"],
            "drill": DRILLS["stride_short" if drill == "stride" and side == "Short" else drill], "drill_key": drill,
            "event": m.get("event"),
        })
    issues.sort(key=lambda x: -x["severity"])
    seen, priorities = set(), []
    for it in issues:
        if it["drill"]["title"] in seen:
            continue
        seen.add(it["drill"]["title"])
        priorities.append(it)
        if len(priorities) == 3:
            break
    # never praise a body area that is also flagged (e.g. "good trunk flexion" next to "upright trunk at release")
    flagged = {AREA.get(i["key"]) for i in issues}
    strengths = [POSITIVES[m["key"]] for m in metrics
                 if m["key"] in POSITIVES and m["rating"] == "good" and m["confidence"] >= 0.3
                 and AREA.get(m["key"]) not in flagged][:4]

    # ---------- capture quality advice ----------
    capture = []
    if fps < 90:
        capture.append(f"Filmed at {fps:.0f} fps, so release timing is approximate: the arm moves about "
                       f"{min(80, 2000 / fps):.0f}° from one frame to the next. Film in slow motion (120–240 fps) next time "
                       "for precise release and elbow measurements.")
    if view == "oblique":
        capture.append("Filmed at an angle to the pitch: knee, trunk, stride, side-bend and alignment can't be measured "
                       "reliably. Film square on: side-on (10–15 m away, hip height) or straight from behind the stumps.")
    elif view in ("behind", "front_on"):
        capture.append("Filmed from behind/in front: side-bend, arm slot and alignment are measured well, but knee, "
                       "trunk-flexion and stride can't be measured from this angle. Add a side-on clip for those.")
    elif view == "side_on":
        capture.append("Filmed side-on: knee, trunk flexion, stride and release height are measured well; add a "
                       "clip from behind the bowler for side-bend and alignment.")
    return {"score": score, "grade": grade, "score_breakdown": contrib, "priorities": priorities,
            "all_issues": issues, "strengths": strengths, "capture_tips": capture,
            "disclaimer": "Estimates from a single video. Not a medical assessment and not an ICC legality test."}
