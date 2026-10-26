# Seamly: your pocket bowling coach

**Live app: [seamly-cricket.vercel.app](https://seamly-cricket.vercel.app)**

Film one delivery on your phone. Seamly finds the bowler and marks the key moments on your own video: back-foot contact, front-foot contact, release and follow-through. It rebuilds the action in 3D, measures your angles against published research, and gives you a plain-English summary, a back-health check and a two-week practice plan.

**Everything runs in your browser.** Your video never leaves your device. There is no account, no upload and no server, and analyses are saved in the browser.

> Estimates come from a single video. Seamly is not a medical assessment and **not an ICC legality test**.
> Every metric shows its confidence. Metrics that the camera angle can't measure are not reported; the app says which angle would measure them.

## What you get

- **The key moments on your own video**, with the skeleton, joint angles and wrist trail drawn on the frame. If a marker is a frame off, drag it, and everything recomputes in about a third of a second.
- **Pace from the same clip, free.** Ball speed from the release frame and the frame the ball reaches the batter, timed over the pitch's fixed length (no calibration, slow motion divided back to real time), with an honest range that narrows if you mark where the ball pitched. Alongside it, the technique factors most linked to ball speed that the clip measures: run-up speed at back-foot contact (side-on), the time from front-foot landing to release, and the front knee at release. While measuring, a bar under the screen holds the frame controls and the marks, so the video and the result stay in view on a phone. The player page tracks speed across sessions and flags when a spell drops 5% below the day's best.
- **Camera check before you film**: point the phone where it will film from and the camera's live picture tells you whether the angle, distance, framing and light will measure well (side-on or behind the stumps), using the same pose model on the device. Nothing is recorded.
- **A 3D body model** of the delivery that you can orbit, with side, behind, batter's-view and top presets, live joint-angle tags that follow the body as it plays, and an enlarged view with its own playback.
- **Measured angles against published norms**, each with a confidence and a reference:
  - front knee at landing and release
  - trunk flexion
  - stride length
  - release height
  - side-bend
  - hip–shoulder alignment and mixed-action screening
  - head position
  - rhythm timings
- **A verdict at the top.** The score, one line on the delivery, the one thing to fix first with its coaching cue, and the facts that change how to read it (what's working, back health, camera limits). The Coaching tab has every priority with drills and a "Show me" button that jumps to the moment in the video.
- **Back-health check** for pace bowlers: side-bend at release, mixed action and a folding back leg. These are the technique factors linked to lower-back stress injuries in young fast bowlers.
- **Two-week practice plan** that respects the [Cricket Australia junior pace bowling guidelines](https://play.cricket.com.au/community/resources/player-safety/junior-bowling-guidelines/guidelines) for the player's age group: overs per spell, bowling days per week and rest days. It is dated from the coming Monday, and the re-test day can be added to the phone's calendar.
- **Player profiles and progress over time**: score and measurement trends, personal bests, "since last time", the current focus, and one tap to overlay the latest delivery on the best one filmed from the same angle.
- **A whole spell at once**: choose up to 12 clips (one ball each, say a nets spell) and they are analysed one after another for the selected player.
- **Consistency**: how much each key measurement moves from ball to ball over a player's last six deliveries from the same angle, judged against what one camera can resolve at those frame rates.
- **Bowling log**: record matches, club nets and practice per player; each week is checked against the age group's limits (bowling days, overs a day, rest days), and once three weeks are logged, this week's load is set against the 4-week average (acute:chronic ratio, with a warning above 1.3).
- **Compare two deliveries** side by side, or **overlaid**: both skeletons on one canvas, lined up at the hips, scaled to body size and matched phase by phase (each clip's own back-foot contact, front-foot contact and release line up), with a slider and play-through. Print a **coaching report**, and export **CSV / JSON / OBJ**.
- **Share summary**: one image (release frame with skeleton, score, verdict and the top fixes with cues) to send to a coach or parent through the phone's share sheet.
- **Works offline after the first analysis.** A service worker keeps the app and the models, so you can film and analyse at the nets with no signal.
- **Backup and restore.** One file carries every analysis and player to another browser, phone or computer. Nothing goes through a server.

## Filming tips

- **Side-on:** 10–15 m away, at hip height, square to the popping crease. This view measures the knees, trunk flexion, stride and release height.
- **From behind the stumps:** this view measures side-bend, alignment and head position. Film from behind the *bowler's* stumps, not the batter's: a batter close to the camera gets analysed instead of a far-away bowler.
- **Keep the whole action in frame**, from the last strides of the run-up to the follow-through. A tripod helps.
- **Use slow motion (120–240 fps) if your phone has it**; 30 fps works. Below 20 distinct frames per second a delivery stride lasts only 4–5 frames, so those clips are refused rather than mis-measured.

## How it works (in the browser)

```
video ─► exact frame times from the container (MP4/MOV via mp4box), frame-accurate seeking
      ─► YOLO11n-pose on every frame (ONNX Runtime Web: WebGPU, or WebAssembly as a fallback)
      ─► multi-person tracker: camera-motion compensation (coarse-to-fine block matching on the background, people and static
         overlays masked), constant-velocity prediction, colour appearance, pose similarity, Hungarian
         assignment, same-person duplicate boxes merged
      ─► bowler selection: the track whose arm makes a fast ~270-360° sweep with legs in view
         (a batter's two-handed swing is discounted)
      ─► YOLO11s-pose on bowler crops with flip test-time augmentation
      ─► 2D clean-up: Hampel outliers, left/right swap repair (whole arm, then forearm), gap filling, Butterworth
      ─► MotionBERT-Lite 3D lifting (int8 ONNX), resampled to its 50 fps training rate
      ─► metric skeleton (L-BFGS fit: constant symmetric bones, re-projection, knee hinge, physics priors)
      ─► bowling arm, camera view, world frame ─► events ─► view-aware metrics ─► coaching, insights, plan
      ─► NAVER Anny body model posed by IK, skinned in three.js
```

The analysis engine (`frontend/src/engine/`) is a TypeScript port of the Python pipeline in `backend/bowlnet/`. The test suite (`frontend/tests/`, 364 tests) checks every stage after pose detection against fixtures recorded from the Python pipeline. The results match Python exactly or to floating-point precision: events, metrics, coaching, insights, progress, the body-model binaries, and the skeleton fit to about 1 mm.

The first analysis downloads about 70 MB of models, which the browser caches afterwards. On a recent laptop a short clip takes about 15–30 s; phones take longer.

### Accuracy on a synthetic delivery with exact ground truth

| | Truth | Python pipeline | Seamly in the browser |
|---|---|---|---|
| Back-foot contact / front-foot contact / release (frame) | 36 / 48 / 55 | 35 / 47 / 55 | 35 / 47 / 55 |
| Front knee at front-foot contact | 165.0° | 168.5° | 164.0° |
| Front knee at release | 169.8° | 171.2° | 166.0° |
| Trunk flexion, front-foot contact → release | 32.0° | 30.4° | 31.7° |
| Release height | 105% | 114% | 109% |
| Stride length | 52.8% | 49.8% | 49.3% |

Full sources for every threshold are in [`docs/RESEARCH.md`](docs/RESEARCH.md).

Tested in Chrome (WebGPU), Safari's engine (WebKit, on an emulated iPhone) and Firefox (WebAssembly: a full analysis of the club clip took about 2.5 minutes headless). The club clip gets the same verdict and top fix in all three; WebKit reads the front knee a degree differently (158° against 157°) because it decodes the video slightly differently. Not yet tested on a physical phone.

## Develop

```bash
cd frontend
pnpm install
pnpm dev                 # http://localhost:5173 - the in-browser app
pnpm test                # engine parity tests (vitest)
pnpm build               # static site in frontend/dist (deploy anywhere: Vercel, Netlify, GitHub Pages)
```

`frontend/public/` holds the browser models: YOLO11n/s-pose ONNX exports, MotionBERT-Lite int8 and the Anny body asset. It also holds two sample analyses (`samples/`). The tools that regenerate them are in `backend/tools/`: `export_body_asset.py`, `make_web_samples.py`, `export_web_sample.py` and `export_fixtures.py`.

### Deploy

The site is static. The live deployment is the Vercel project `seamly`, at https://seamly-cricket.vercel.app. Build with the site URL for social previews, then deploy the output:

```bash
cd frontend && VITE_SITE_URL=https://seamly-cricket.vercel.app/ pnpm build
vercel deploy dist --prod --project seamly
```

Alternatively, connect the repository in Vercel with root directory `frontend` (framework: Vite). `frontend/public/vercel.json` sets the cache and security headers. For a sub-path such as GitHub Pages, build with `VITE_BASE=/<repo>/ pnpm build`.

**Bandwidth.** The analysis models (about 70 MB, downloaded once per browser) are fetched from jsDelivr, straight from this public repository at a pinned commit (`MODEL_CDN` in `frontend/src/engine/detector.ts`); the site's own copy in `public/models/` is the fallback. jsDelivr serves files up to 20 MB, so the 40 MB detector is stored as `yolo11s-pose.onnx.part1/2` and joined in the browser. A first visit therefore costs the host only the app itself (~2 MB). If a model file changes, push it, then point `MODEL_CDN` at that commit.

**Offline.** `vite.config.ts` generates `sw.js`, a service worker that precaches the built app; with the models in Cache Storage, Seamly works without a connection after the first analysis.

## Self-hosted server (optional, more accurate 3D)

`backend/` is the original Python engine (FastAPI). It runs YOLO11m/x-pose and can use **SAM 3D Body**, an image-based 3D model that needs about 8 GB of RAM. To use it:

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd backend && ../.venv/bin/python -m tools.download_models && cd ..   # ~225 MB, checksum-verified
cd frontend && pnpm install && VITE_API=server pnpm build && cd ..
./run.sh                                                             # http://127.0.0.1:8000
```

SAM 3D Body is gated. Accept Meta's licence at https://huggingface.co/facebook/sam-3d-body-vith, log in with `.venv/bin/hf auth login`, then run `cd backend && ../.venv/bin/python -m tools.download_models --sam3d`. The server uses it automatically on machines with at least 12 GB of RAM.

Server tests: `cd backend && ../.venv/bin/python -m pytest -q` (the full suite takes about 7 minutes, including real-clip and synthetic ground-truth runs).

## Known limitations

These are surfaced in the app rather than hidden:

- **Depth from one camera is ambiguous.** Knee and trunk flexion can't be measured from behind; side-bend and alignment can't be measured side-on. The app reports each metric only from the view that measures it and says which clip to add.
- **Angled cameras.** When the camera is well off the line of the pitch (high in the stands, or far to one side), the view cues contradict each other. Seamly then marks the view as angled, rates none of the body measurements (knee, trunk, stride, side-bend, alignment, release height, head position) and asks for a clip filmed square on.
- **Foot contacts from behind** are often placed from typical timing. Their timings stay unrated until you confirm the markers: drag them, or use "Set this frame as" in the Frame tab.
- **25–30 fps** limits release and timing precision to ±1 frame (33–40 ms). Elbow extension needs side-on video at 100 fps or more, and it is shown for reference only, never rated: on a rendered straight-armed delivery at 120 fps one camera read 12°.
- **Side-bend from behind may read low.** On a synthetic mannequin bending 34° at release, the 2D reading was 27°. Real broadcast clips of elite seamers read a typical 31–35°, but until side-bend is checked against a lab reference, treat values near the 45° and 50° back-health bands as possibly higher.
- **Ball speed is an estimate, not a radar reading.** It is timed between two frames you mark, so its precision follows the frame rate and how much the ball slowed: a 240 fps clip with the pitching frame marked is within about ±5%, a 30 fps clip without it about ±12%. The range is always shown. The ball is too small and blurred at normal frame rates to be tracked automatically.
- **Analysis pauses while its tab is in the background.** Browsers throttle hidden tabs and can hand back stale video frames, so Seamly waits and carries on when you come back, rather than measuring the wrong frames. Keep the tab open on screen until it finishes.
- **Analyses live in the browser that made them** (IndexedDB). Nothing is uploaded, so a link only opens on that device. Clearing site data deletes them, so use **Download backup** in your workspace to keep a copy or move players and analyses to another device (Restore a backup), and the PDF report to share one.
- **The bowling arm is hard to tell from behind or front-on.** On rear-view broadcast clips the detector is often unsure, and a low-confidence call can differ between devices. Below 50% agreement Seamly asks "Is this a left-arm bowler?" with one-tap Yes/No (and marks the arm with a "?" up to 70%), and saves the answer to the player's profile so later clips don't have to guess. Setting the arm in the profile skips detection entirely.
- **Browsers decode video slightly differently** (Safari's colours are a few percent brighter than Chrome's), so the same clip can land a foot contact a frame apart in different browsers. Release, upper-arm-horizontal and follow-through matched exactly in our Safari-engine (WebKit) test.
- **The browser engine uses smaller models than the server** (YOLO11n/s instead of m/x, and int8 MotionBERT), so it can differ from the server by a frame on fast arm movements.

## Project layout

```
frontend/   the Seamly web app: React + TypeScript + three.js
  src/engine/   in-browser analysis engine (detector, video, tracking, pose2d, lifter, kinematics,
                events, metrics, coaching, insights, progress, body, pipeline, store)
  src/api.ts    data layer: api.local.ts (browser, default) or api.remote.ts (VITE_API=server)
  public/       models, sample analyses, icons
  tests/        parity tests against fixtures recorded from the Python pipeline
backend/    the Python engine and FastAPI server (source of truth for the algorithms)
docs/       RESEARCH.md
legacy/     the original Streamlit + SPIN prototype
```

## Licences and credits

| Component | Licence | Note |
|---|---|---|
| Seamly code | not chosen yet | No LICENSE file yet. The browser build ships the AGPL-3.0 YOLO11 weights, so AGPL-3.0 is the simplest compatible choice. |
| Ultralytics YOLO11 (models in `frontend/public/models`) | **AGPL-3.0** | The source of this site is public in this repository |
| MotionBERT (model code + weights) | Apache-2.0 | `backend/bowlnet/lifting/LICENSE-MotionBERT` |
| ONNX Runtime Web | MIT | loaded from jsDelivr |
| mp4box.js | BSD-3-Clause | |
| NAVER Anny body model | Apache-2.0 code, CC0 1.0 MakeHuman/MPFB2 assets | |
| SAM 3D Body (server only, optional) | SAM License (Meta) | weights are downloaded by you |
| three.js, React, FastAPI | MIT / BSD | |
| Sample clip: "Epping Foresters CC v Great Totham CC at Epping, Essex, England Video 1" by Acabashi | CC BY-SA 4.0 | via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Epping_Foresters_CC_v_Great_Totham_CC_at_Epping,_Essex,_England_Video_1.webm); trimmed and re-encoded (`frontend/public/samples/club-side-on.mp4`, same licence) |
