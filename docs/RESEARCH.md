# BowlNet research notes

The evidence behind BowlNet's design, metrics and thresholds. It was compiled on 2026-10-23 from peer-reviewed biomechanics literature, model benchmarks and a review of competing products.

Thresholds marked **heuristic** are ±1–2 SD bands around elite norms, not published cut-offs. The UI labels them that way.

## 1. What a single camera can and cannot measure

| Topic | Finding |
|---|---|
| Markerless vs. marker-based for cricket bowling | OpenCap (2 iPhones, 240 Hz) had an overall joint-angle RMSE of 17.6 ± 7.7°. Knee was best (7.9°) and arm elevation plane worst (28.9°). Only 217 of 473 trials were usable (Abraham, Feros & Fox 2025, doi:10.1177/17479541251348081). |
| Monocular 3D lifting on athletic motion | Models trained only on H36M score 214–237 mm MPJPE on AthletePose3D. Angle waveforms correlate (r ≈ 0.8–0.9), but angular velocities do not (Yeung et al., CVPRW 2025). |
| Rear-view 2D | 2D thorax lateral flexion and pelvis rotation from behind the bowler agree well with 3D (Cottam et al. 2016). This is why BowlNet measures side-bend directly on the video in rear views. |
| Elbow legality | 2D video is invalid unless the camera is perpendicular to the elbow plane, which moves during the delivery (Aginsky & Noakes 2010, BJSM). Marker placement alone changes extension by up to 8° RMS (Yeadon & King 2015). |
| **Design consequence** | Each metric declares the anatomical plane it lives in. If the camera view sees that plane (side-on → sagittal, behind/front → frontal), it is measured on the high-resolution 2D keypoints. Otherwise it is withheld: the app names the camera angle that measures it, and the 3D value appears only in the per-frame charts (marked "est.") and as `estimate_3d` in the JSON export. Synthetic ground truth showed the danger. From behind, a rendered 165–170° front knee was lifted to 96–107°, with nothing in the clip to flag it. Elbow extension is only rated from side-on video at 100 fps or more, and is never presented as a legality verdict. |

## 2. Delivery events

| Event | Definition (lab) | BowlNet method |
|---|---|---|
| BFC / FFC | First frame the foot's motion changes from ground contact (Worthington 2013; Felton 2019) | Foot stops moving in camera-motion-stabilised image coordinates, measured relative to its swing speed so residual zoom is tolerated. Zeni et al. (2008) pelvis-relative foot position is a secondary cue. Solved jointly with timing priors. Contacts that could only be placed from timing are flagged and must be confirmed by the user. From behind or in front, a foot moving along the optical axis looks still. On a mirrored broadcast clip a detected stop preceded the real strike by 2–3 frames (168 ms instead of about 100 ms FFC→BR). So in those views, stride timings are only rated after the user confirms the contacts. |
| UAH | Bowling upper arm reaches horizontal (ICC) | The elbow rises through shoulder height in the image during the final upswing. 3D elevation zero-crossing is the fallback. |
| BR | Ball leaves the hand (> 20 mm ball–wrist separation at 300 Hz) | The final upswing of the bowling wrist: a rise from below the shoulder to its highest point, then the fall into the follow-through. A gather where the arms drop from overhead has no preceding rise, so it never qualifies. At ≥ 90 fps the peak is refined towards peak arm speed (PitcherNet / pitchAI). |
| FT | First foot contact after FFC (Sanders 2018) | The back foot's next stop after release. |

**Minimum frame rate.** Real-time fps is the video fps × the slow-motion factor; distinct fps also discounts repeated frames. Clips below 20 distinct fps are refused. On the Bumrah clip, 25 fps found release within one original frame. At 15 fps it depended on the sampling phase: one phase was correct, the other 20 frames early. At 10 fps it was wrong.

Timing priors come from 92 junior bowlers at 100 fps (Andrews 2024): BFC→FFC 197 ± 59 ms and FFC→BR 126 ± 37 ms. Elite men are faster at 192 ± 31 ms and 103 ± 11 ms (Felton 2019).

Validation against frames labelled by eye on three broadcast clips:

| | Ground truth | BowlNet |
|---|---|---|
| Release | — | 0–1 frame error on all three clips |
| Bumrah FFC | 44–45 | 43, a timing estimate flagged for confirmation. Confirming at 44 gives FFC→BR = 100 ms, against the elite norm of 103 ± 11 ms. |
| Shami FFC | 29–30 | 28, a timing estimate flagged for confirmation |
| Anderson FFC | ~81 | 81, a timing estimate flagged for confirmation |

On these behind-the-bowler broadcast clips, the image-based foot-stop detector does not see the strike: the foot travels along the optical axis and the camera zooms. The timing solve then lands within 1–2 frames, and the app asks the user to confirm.

## 3. Metrics, norms and flags

### Timing and front leg

| Metric | Computation | Norm / threshold | Source |
|---|---|---|---|
| FFC → release | (BR − FFC) / fps | Elite men 103 ± 11 ms; juniors 126 ± 37 ms. Good below 140 ms so a typical junior isn't flagged, rated with ± 1 frame tolerance (heuristic). | Felton 2019; Andrews 2024 |
| Front knee at FFC / BR | Angle hip–knee–ankle (180 = straight) | Elite men 164 ± 6° at FFC and 167 ± 19° at BR. Knee angle at BR correlates with ball speed, r ≈ 0.40. | Felton 2019; Ramachandran 2024 meta-analysis |
| Front-leg technique | Flexion = angle(FFC) − min; extension = angle(BR) − min | Flexor: ≥ 10 / < 10. Flexor-extender: ≥ 10 / ≥ 10. Extender: < 10 / ≥ 10. Constant brace: < 10 / < 10. | Portus et al. 2004 |
| Back knee at BFC | Hip–knee–ankle of the back leg | Injured 146° vs uninjured 156° (prospective, MRI-confirmed). Below 146° = risk. | Alway et al. 2021 |

### Trunk and alignment

| Metric | Computation | Norm / threshold | Source |
|---|---|---|---|
| Trunk lateral flexion at BR | Trunk line vs vertical in the frontal plane | Later-injured juniors 50 ± 6° vs uninjured 40 ± 8°. Watch 40–50°, risk above 50°. The link is contested in elite adults. | Bayne 2016; Alway 2021 |
| Trunk forward flexion FFC→BR | Sagittal-plane trunk angle change | Elite men 31 ± 8°. Good from 25° (heuristic). | Felton 2019 |
| Shoulder alignment at BFC | Transverse angle of the shoulder line (180 = side-on, 270 = front-on). From the projected width w = W·cos φ, with the sign from 3D. W is the line's widest (p95) projection over the clip, in the 2D keypoints' own convention: a 3D model's joint distance follows another convention, which pinned the hips at front-on and produced false 39° separations against a true 0°. | Side-on below 210°, semi-open 210–240°, front-on above 240°. Elite men 232 ± 14°. | Portus 2004; Felton 2019 |
| Hip–shoulder separation at BFC | θ_shoulder − θ_hip | 30° or more classifies a mixed action. | Portus 2004 |
| Shoulder counter-rotation | θ_sh(BFC) − min θ_sh until FFC | 30° or more is mixed. Low specificity in adults: it did not predict injury prospectively. | Elliott & Foster 1989; Ranson 2008; Alway 2021 |

### Release and stride

| Metric | Computation | Norm / threshold | Source |
|---|---|---|---|
| Release height | Ball height above ground at BR ÷ stature | Elite men 113 ± 4%. Good from 108% (heuristic). | Felton 2019 |
| Stride length | Ankle distance at FFC ÷ stature | Elite men 79 ± 7%. Good 70–87% (heuristic). | Felton 2019 |

**Release height method.** Measured in 2D, with stature in pixels estimated *at the release frame* from the in-plane bowling arm (upper arm + forearm = 0.332 H) and front leg (thigh + shank = 0.491 H; Drillis & Contini 1966). This makes it independent of camera zoom.

**Validation.** Synthetic renders of the Anny model have exact ground truth of 105.3%. BowlNet reads 114.2% side-on and 112.9% from behind. Anny's leg matches the Drillis–Contini ratio (0.491 H), but its arm is shorter (0.307 H vs 0.332 H), and YOLO's hip–knee–ankle chain on the render spans about 8% less than the joint centres. Three elite broadcast deliveries read 100–116%, against a norm of 113 ± 4%. A blanket −8% correction would move them below the elite range, so none is applied. The metric's description in the app states this ± 8 points precision.

### Elbow extension (ICC)

**Computation:** the maximum flexion in the [UAH, BR] window minus the minimum flexion that follows it, with flexion floored at 0 so hyperextension is excluded.

**Norms:**
- Legal bowlers: mean about 6°, range 0–10° (Ferdinands & Kersting 2005; King & Yeadon 2013).
- The ICC limit is 15°, assessed in accredited labs at high frame rates.

**In BowlNet:** screening only, and rated only from side-on video at 100 fps or more.

**Why not simpler formulas.** "UAH − BR" underestimates when the elbow flexes after UAH. "Max − BR" underestimates when it re-flexes before release, which happens in 70% of bowlers (Ferdinands & Kersting 2005).

### Synthetic validation

The test suite renders a scripted delivery with the Anny body model (`tools/synth_bowler.py`, 60 fps), side-on and from behind. Ground truth is measured on the rendered body, the same way BowlNet defines each metric. A scripted 28° side-bend renders as 21.2° because the IK-posed body doesn't reproduce scripted angles exactly. "—" means withheld for that view.

| | Truth | Side-on | Behind |
|---|---|---|---|
| BFC / FFC / UAH / BR (frame) | 36 / 48 / 52 / 55 | 35 / 47 / 51 / 55 | 37 / 47 / 52 / 55 |
| Front knee at FFC / BR | 165° / 170° | 168.5° / 171.2° | — |
| Trunk forward flexion at BR | 38.0° | 32.2° | — |
| Trunk flexion FFC→BR | 31.4° | 30.4° | — |
| Trunk side-bend at BR | 21.2° | — | 18.6° |
| Stride length | 52.8% | 52.2% | — |
| Release height | 105.3% | 114.2% | 112.9% |

## 4. Model choices

| Component | Choice | Why |
|---|---|---|
| Person detection and pose | YOLO11m-pose (tracking pass) + YOLO11x-pose on bowler crops with flip TTA | YOLO11x is COCO-pose 69.5 mAP. YOLO26 needs ultralytics 8.4. RTMPose-x Halpe26 was evaluated (72 ms/crop) and agreed with YOLO11x within 2–3% of body height on the wrists, but added no measurable benefit on this footage. Ultralytics' NMS time limit is lifted: when a batch exceeds about 2.4 s (a busy machine, or MPS warm-up), it otherwise returns no detections for the rest of the batch. |
| Tracking | Custom: SORT + global motion compensation, appearance and pose similarity; same-person duplicate boxes dropped before association | The pinned ultralytics trackers swap IDs between near-equal-confidence detections even with nobody moving. This was reproduced on CPU and MPS. At release the detector can return two boxes for the bowler (with and without the outstretched arm, IoU ≈ 0.68, which survives NMS at 0.7); the spare started a new track that took over the bowler and cut the analysis at release. Duplicates share their keypoints (median distance < 8% of height) while overlapping players differ by ≥ 20%, so the spare is dropped. |
| Bowler vs batter | A batter's swing sweeps the arms as fast as a bowling arm (352° at 1,680°/s on a club clip filmed from behind the batter), but with both hands on the bat. A track whose arm sweep has the wrists within 12% of body height of each other for more than 60% of the sweep is scored ×0.3. | On a front-on club clip the batter in the foreground had been picked as the bowler; after the rule the far-end bowler is the only candidate. A bowler's hands come together only briefly, at the gather. |
| Forearm swap repair | Left/right swap repair also runs on the forearms alone (elbows + wrists) after the whole-arm chain. When the arms cross at release a detector can swap the elbows and wrists but not the shoulders, which the whole-arm chain can't repair. | With the browser's YOLO11s on crops, this put release on the true frame (55) of the synthetic delivery instead of 2 frames early, and the arm vote went from 0.2 to 0.7 confidence. |
| Camera view | The planted stride's foreshortening: median horizontal ankle-to-ankle distance from FFC to just after release, in leg lengths (depth-free). Above 0.7 → side-on, below 0.4 → behind/front-on; in between, the run-up hip-width ratio, then the 3D direction of travel. Without a run-up in the clip, the direction of travel is the FFC stride vector (the hips have already turned at release). | Behind-view clips measure 0.03–0.29, side-on 1.04–1.10. A real club-match clip (handheld zoom panning with the bowler, no run-up in frame) had been read as "behind" (47° from the 3D hip line at release) and withheld every side-on metric; it now reads side-on at 78°. |
| 2D → 3D | MotionBERT-Lite (H36M, 243 frames, Apache-2.0, 64 MB), with flip TTA and resampling to its 50 fps training rate | Strong temporal lifter with a non-gated checkpoint. MotionAGFormer-B is a candidate for an A/B test. |
| Metric skeleton | Weak-perspective fit with: symmetric bone lengths that match the 2D keypoints' own conventions (robust p95 of projected length ÷ image scale; anthropometric lengths folded limbs because YOLO keypoint segments are ~13% shorter than joint-centre segments); a confidence-weighted 2D reprojection; lifter depth; temporal smoothness; a knee hinge constraint; a weak "least bend consistent with the image" elbow prior; and a second pass with physics priors (planted front foot stays ahead of its knee and the pelvis from FFC to just after BR). | Bone-length CV drops from ~12% (raw lifter) to below 1%. On the synthetic side-on clip, the 3D front knee is 163/173° vs truth 165/170° (was 121° at BR), and the bowling elbow at BR is 15° vs truth 6° (was 42°). On real behind-view clips, elbow flexion at BR is 8–17° (was ~100°) and the front knee at BR is 143–180°. |
| Camera motion | Dense ECC affine alignment on the background, seeded by sparse optical flow, with sanity bounds. People are masked, and so is anything that stayed near-identical over the last six frames (score bars, logos). | The sparse corner flow silently degraded to identity during broadcast zooms (scale = 1.000), because grass and pitch have few corners. A static score bar then pinned ECC to "no motion" as well. With both fixes, the post-release zoom on a broadcast clip measures 1–4.6% per frame, and duplicated (telecined) frames correctly read as identity. A tripod clip stays exactly identity. |
| 2D → 3D (image-based, optional) | SAM 3D Body ViT-H (Meta 2026) on the bowler crop each frame; MHR-70 keypoints mapped to H36M-17; skeleton-fit depth weight 20 (vs 6 for MotionBERT) | Sees appearance rather than inferring depth from 2D joints. Synthetic ground truth (PA-MPJPE): side-on raw 71 mm vs MotionBERT 80 mm, and 74 mm after the BowlNet fit. From behind, 175 mm vs 212 mm; the faceless mannequin is front/back ambiguous for an image model, and with left/right swapped the raw error is 160 mm. On real behind-view clips the delivery stride becomes physically plausible: the front leg reaches forward, the back leg trails, the body folds over the brace. |
| Body mesh | NAVER Anny (Apache-2.0 code, CC0 MakeHuman assets) exported to a 4.6 MB grid over gender, height and weight. Posed by analytic two-vector IK; skinned in the browser. | SMPL needs a licence and registration. SAM 3D Body is gated and 2.8 GB. Multi-HMR-Anny is non-commercial and 1.5 GB. |

## 5. Coaching for non-professional bowlers

| Topic | Source | How BowlNet uses it |
|---|---|---|
| Junior workload limits | [Cricket Australia junior pace bowling guidelines](https://play.cricket.com.au/community/resources/player-safety/junior-bowling-guidelines/guidelines). Match limits per spell / per day: U11 2/4, 11–13 4/8, 13–15 5/12, 15–17 5/16, 17–19 6/18 overs. Training: under-17s at most 3 bowling days a week with a day off after each; 17–19 at most 4, no more than 2 in a row; spells of at most 5 or 6 overs, 20 minutes apart. Pre-season build-up of 2–8 weeks. | The practice plan's overs per spell, bowling days and rest rules for the player's age group. Adults get the 17–19 pattern as general guidance. |
| Who is at risk | Lumbar stress fractures are most common in adolescent fast bowlers (Cricket Australia: around 1 in 3), especially in the 2–3 years after the main growth spurt. Workload spikes raise the risk in the following 3–6 weeks (Alway et al., Loughborough). | Junior wording in the summary and the back-health card. The plan never adds bowling days, and the CA back-pain advice is included. |
| Technique risk factors | Side-bend at release (Bayne 2016: later-injured juniors 50 ± 6° vs uninjured 40 ± 8°; Seamly rates below 45° good, 45–50° worth watching, 50° and above flagged), mixed action (Portus 2004; Ranson 2008), back-knee collapse at BFC (Alway 2021) | The back-health check reports these three when the camera angle can measure them, and says which angle would measure the rest. |
| Spin bowling | The norms above come from pace-bowling studies. | Spinners get a note that ratings are a rough guide, and no pace workload limits. |

The ECB's fast-bowling directives circulate in several conflicting versions (2009 table, 2025 county revisions), so Cricket Australia's current published guidelines are used.

## 6. Product research (competitor landscape)

- **Amateur apps** are mostly batting-focused (CricVision, Ludimos), plain video replay (Cricket Coach Plus), or drills content (PitchVision). Hardware systems such as TrackMan measure the ball rather than the body. None turns one phone clip into a plain-language fix, an age-appropriate practice plan and progress tracking.
- **Cricket action products** such as Pitchwolf and DineticQ PaceFlow deliver *static* reports, often overnight. **Interactive cricket apps** such as Fulltrack AI track the ball only. Nobody offers instant, interactive 3D bowling analysis tied to delivery events.
- **What works.** One headline score, three priorities, and for each priority: why it matters, the evidence level, a cue and a drill. Editable event markers with live recompute. Confidence on every number. A kinogram of the key positions. Synced 3D views with cricket-specific camera presets. Clear disclaimers on legality and injury.
- **Filming guidance.** Film side-on (10–15 m away, hip height) and/or from behind the stumps. Use 120–240 fps where possible. Keep the whole action in frame and the camera on a tripod.

## 6. The in-browser engine (Seamly web app)

The web app runs the whole pipeline in the visitor's browser. It is a TypeScript port in `frontend/src/engine/`. Every stage after pose detection is checked against fixtures recorded from the Python pipeline:

- Events, view, arm, metrics, coaching, insights, progress and the body mesh match exactly or to floating-point precision.
- The skeleton fit (L-BFGS with analytic gradients) matches to about 1 mm.

The detection models are smaller than the server's:

| Stage | Server | Browser |
|---|---|---|
| Tracking | YOLO11m-pose | YOLO11n-pose @ 640 |
| Crops | YOLO11x-pose | YOLO11s-pose @ 384 |
| Lifter | MotionBERT-Lite fp32 | MotionBERT-Lite int8 (root-relative error vs fp32 ≈ 0.5% of body height) |

| Clip | Ground truth or server | Browser |
|---|---|---|
| Synthetic side-on, 60 fps: BFC / FFC / BR | truth 36 / 48 / 55; server 35 / 47 / 55 | 35 / 47 / 55 |
| Synthetic: front knee at FFC; trunk flexion; release height | 165° / 32° / 105% (server 168.5° / 30.4° / 114%) | 164.0° / 31.7° / 109% |
| Club match, side-on, 25 fps | server BFC / FFC / BR 52 / 57 / 60 | 51 / 56 / 59 (±1 frame at 25 fps) |
| Broadcast, behind (Shami) | server events 22 / 28 / 31 / 32 / 40 | identical |
| Broadcast, behind (Bumrah) | server BFC / FFC / BR 37 / 43 / 47 | 38 / 43 / 47 |

Speed on an M4 laptop, with the models already downloaded:

| Backend | Synthetic clip (87 frames) | Club clip (130 frames) |
|---|---|---|
| WebGPU | 12 s | 15–18 s |
| WebAssembly fallback (single thread) | 51 s | — |

Both backends give the same events.

### Behind the bowler and professional clips (browser engine, 2026-10-25)

**Synthetic delivery from behind.** The same scripted right-arm delivery, rendered from behind the stumps (`tools/synth_bowler.py --view behind`), re-encoded to H.264 and analysed in the browser:

| | Truth | 30 fps | 60 fps |
|---|---|---|---|
| BFC / FFC / UAH / BR (frame) | 18 / 24 / 26 / 28 and 36 / 48 / 52 / 55 | 18 / 24 / 26 / 28 | 37 / 48 / 53 / 56 |
| Trunk side-bend at BR | 21.7° / 21.2° | 24.7° | 25.2° |
| Release height | 104.1% / 105.3% | 108.2% | 109.9% |

Events, side-bend and release height are within the stated precision. One failure: the browser's smaller pose models read the faceless synthetic body as *front-on* rather than from behind (the server's larger models read it correctly), which mirrors the bowling arm (left, 4 of 4 cues). Real rear-view clips below were all classified as behind, so this is a limit of the synthetic test, but it is the reason the arm question exists.

**Bowling arm on real footage.** Six clips of professional bowlers (two broadcast clips kept locally, four 2012 county T20 clips by Nev1 on Wikimedia Commons, CC BY-SA 3.0), with the arm checked by eye on the frames around release rather than taken from the player's name:

| Clip | View found | Arm found (agreement) | Correct | What the app does |
|---|---|---|---|---|
| Bumrah, broadcast | behind | right (100%) | yes | — |
| Shami, broadcast | behind | left (20%) | no | asks "Is this a left-arm bowler?" |
| Graham Onions, Commons | front-on | right (100%) | yes | — |
| Stephen Parry, Commons | front-on | right (100%) | yes (by eye) | — |
| Gary Keedy, Commons | behind | left (70%) | yes | — |
| Ben Stokes, Commons | front-on | left (50%) | no | asks (since 2026-10-25: a 3-to-1 split from behind or front-on now asks too) |

Every wrong call had 50% agreement or less, and the app now asks at that level from behind or front-on. Side-on keeps the old threshold (below 50%), where the arm cues are strongest.

**Measurements on the professional clips** (30 fps, stature assumed 1.80 m, only values measured from that view; arm confirmed where it was wrong):

| Bowler | View | Side-bend at BR | Release height | Arm slot | Other |
|---|---|---|---|---|---|
| Bumrah | behind | 34.8° | 96.5% | 10.8° | shoulders 213° at BFC (semi-open), hip–shoulder separation 3° |
| Shami (arm set right) | behind | 31.5° | 129.5% | 6.6° | — |
| Onions | front-on (cues disagree) | 0.5° | 89.8% | 27.4° | hip–shoulder separation 1° |
| Parry | front-on | 21.1° | 107.4% | 21.7° | — |
| Keedy | behind | 10.7° | 95.4% | 40.9° | shoulders 270° at BFC (front-on), counter-rotation 48° |

Bumrah and Shami, filmed from directly behind, bend 31–35° away from the bowling arm, which is typical of elite seamers. Onions reads 0.5°, which is unlikely for a seamer. On that clip the view cues disagree (hips as narrow as side-on, feet together as from the front), the camera is high in the stands and the bowler is about 100 pixels tall: the app still picks one view and rates the metric. Since this test both engines mark such a clip as an *angled* view, when the stride and hip-width cues contradict each other or both sit in their in-between bands, and withhold every body-measurement rating, release height and head position included, with a note to film square on. On Onions and Stokes that leaves no score at all, which is the honest answer for that footage. The cues also depend on the arm: Stokes reads front-on as a left-armer and side-on once the arm is set to right, because the front and back ankles swap. Release height spreads from 90% to 130% across these elite bowlers, much wider than the 113 ± 4% reported for elite men. From behind the stumps the synthetic test is within 5 points, so the spread most likely comes from the footage: long lenses from high in the stands, 30–50° off the line of the pitch, the bowler 100–200 pixels tall, and the assumed stature (Shami is about 1.73 m, not 1.80 m; entering the real height rescales the value). Treat release height from broadcast or stand footage as indicative; a phone side-on or behind the stumps at the bowler's own height is the reference set-up.

Not possible tonight: IPL net-session footage. None is openly licensed (Wikimedia Commons has none), and downloading it from YouTube or Instagram was ruled out.
