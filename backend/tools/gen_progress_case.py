"""Python reference for frontend/src/engine/progress.ts: summarise() on the fixture results, improved() on a grid,
and the /api/players/{pid}/progress payload for a few players on a temporary store.

    cd backend && ../.venv/bin/python <this file> ../frontend/tests/fixtures/progress_case.json
"""
import copy, itertools, json, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from bowlnet import config, players, progress, store

FX = Path("../frontend/tests/fixtures")
NAMES = ["synth_side", "epping_side", "bumrah_behind", "anderson_edited"]
results = {n: json.loads((FX / f"{n}.json").read_text())["result"] for n in NAMES}
summ = {n: progress.summarise(r) for n, r in results.items()}
edge = copy.deepcopy(results["bumrah_behind"]); edge["coaching"]["priorities"] = []; edge.pop("fps_real", None)
summ_edge = progress.summarise(edge)


def _player_out(p, metas):   # api._player_out
    mine = sorted((m for m in metas if m.get("player_id") == p["id"] and m.get("status") == "done"),
                  key=lambda m: m.get("created", 0))
    return {**p, "analyses": len(mine), "latest_score": mine[-1].get("score") if mine else None,
            "last_analysis": mine[-1].get("created") if mine else None}


def S(base, top=..., score=..., fps=None, drop=(), **vals):
    s = copy.deepcopy(summ[base])
    if top is not ...: s["top"] = top
    if score is not ...: s["score"] = score
    if fps is not None: s["fps_real"] = fps
    for k in drop: s["metrics"].pop(k, None)
    for k, v in vals.items():
        if isinstance(v, tuple): s["metrics"][k].update(value=v[0], rating=v[1])
        else: s["metrics"][k]["value"] = v
    return s


TOP_RH = {"key": "release_height_pct", "headline": "Release point is low (101% of height)", "title": "Get taller at release"}
TOP_HEAD = {"key": "head_offset_br", "headline": "Head falls 25 cm outside the front foot", "title": "Stay tall at release"}

with tempfile.TemporaryDirectory() as td:
    config.DATA_DIR = Path(td); config.ANALYSES_DIR = Path(td) / "analyses"
    A = players.create({"name": "Asha", "age_group": "u15", "style": "fast", "height_cm": 165})
    B = players.create({"name": "Ben", "arm": "left"})
    E = players.create({"name": "Empty", "style": "spin"})
    F = players.create({"name": "Solo"})

    def add(pid, created, summary=None, status="done", name=None):
        aid = store.new_id(); store.path(aid).mkdir(parents=True)
        f = dict(id=aid, name=name or f"clip {created}", created=created, status=status, player_id=pid)
        if summary is not None:
            f.update(summary=summary, score=summary["score"], grade=summary["grade"], view=summary["view"], arm=summary["arm"])
        store.write_meta(aid, **f)

    # Asha: side-on and behind sessions, one failed, one without a summary, a session that can't measure the focus
    add(A["id"], 1000.0, summ["epping_side"])
    add(A["id"], 2000.0, S("bumrah_behind", top=TOP_HEAD))
    add(A["id"], 2500.0, summ["synth_side"], status="failed")
    add(A["id"], 2600.0, None)
    add(A["id"], 3000.0, S("synth_side", top=TOP_RH, release_height_pct=(100.5, "watch"), stride_length_pct=(95.0, "watch")))
    add(A["id"], 3500.0, S("anderson_edited", drop=("release_height_pct",)))
    add(A["id"], 4000.0, S("epping_side", top=TOP_RH, fps=30.0, release_height_pct=(103.0, "watch"), front_knee_br=175.0,
                           stride_length_pct=(60.0, "watch"), ffc_to_br_ms=100.0, trunk_flexion_ffc_br=33.0,
                           front_knee_flexion=(7.0, "good"), back_knee_bfc=(173.5, "good"), trunk_forward_br=(20.0, "watch")))
    add(B["id"], 5000.0, summ["anderson_edited"])
    add(B["id"], 6000.0, S("bumrah_behind", top=None, score=None, trunk_lateral_br=(38.0, "good"), head_offset_br=(25.0, "watch")))
    add(B["id"], 6500.0, summ["epping_side"], status="queued")
    add(E["id"], 7000.0, summ["synth_side"], status="running")
    add(F["id"], 8000.0, S("synth_side", fps=0.0))
    add(None, 9000.0, summ["epping_side"])
    metas = store.list_meta()
    cases = []
    for p in (A, B, E, F):
        out = {"player": _player_out(players.get(p["id"]), store.list_meta()), **progress.player_progress(p["id"])}
        cases.append({"player": players.get(p["id"]), "out": out})
    metas = store.list_meta()   # as the store lists them (newest first)

keys = list(progress.BETTER) + ["arm_slot_br", "bfc_to_ffc_ms", "unknown"]
units = {k: v["unit"] for s in summ.values() for k, v in s["metrics"].items()}
imp = []
for k, (b, a), fps in itertools.product(keys, [(100, 104), (100, 102.5), (60, 66), (90, 75), (80, 74), (65, 68), (150, 120),
                                               (120, 150), (10, 12), (10, 20), (88, 92)], (None, 0, 25.0, 240.0)):
    u = units.get(k, "deg" if k != "unknown" else "")
    imp.append([k, b, a, u, fps, progress.improved(k, b, a, u, fps)])
for k, b, a, u, fps in [("ffc_to_br_ms", 100, 125, "ms", 30.0), ("ffc_to_br_ms", 100, 125, "ms", 60.0),
                        ("stride_length_pct", 60, 62.5, "% height", None), ("head_offset_br", 20, 26, "cm", None)]:
    imp.append([k, b, a, u, fps, progress.improved(k, b, a, u, fps)])

Path(sys.argv[1]).write_text(json.dumps({"summaries": summ, "summarise_edge": summ_edge, "metas": metas, "cases": cases,
                                         "improved": imp}, indent=None, separators=(",", ":")))
print("cases", [len(c["out"]["sessions"]) for c in cases], "improved", len(imp))
for c in cases:
    o = c["out"]; print(o["player"]["name"], "focus", o["focus"], "since", [(d["key"], d["improved"]) for d in o["since_last"]], "best", list(o["best"]))
