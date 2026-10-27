# How accurate is Seamly? (tested 2026-10-26)

Everything here can be re-run: `backend/tools/accuracy_bench.py` renders the synthetic clips and scores any engine's
results, and `frontend/tests/pace_sim.test.ts` checks ball speed against simulated deliveries.

## The short answer

| What Seamly reports | How close it gets (side-on unless stated) | Trust it for |
|---|---|---|
| Ball release frame | Synthetic: 4 ms mean (worst 17 ms). Real clips: inside the hand-marked frame window on 6 of 8, one frame early on 1, three frames early on a spinner | Timing and anchoring every other measurement |
| Foot contacts | 15–16 ms mean (worst 33 ms, one frame at 30 fps) | Stride timings |
| Front knee at landing | 1.0° mean (worst 3.7°) | Braced vs bent |
| Front knee at release | 3.5° mean (worst 8.3°) | Braced vs bent; not differences under ~5° |
| Trunk lean at release / trunk flexion | 2.1° / 2.2° mean (worst 3.7° / 4.6°) | Yes |
| Side-bend at release (from behind) | 2.6° mean (worst 5.9°), when the view is read correctly | Yes, but see the front/back caveat |
| Stride length | 3.3 points of height mean (worst 6.4) | Yes |
| Release height | 7.4 points of height mean (worst 13.7) | Rough guide only |
| Back knee at back-foot contact | 7.7° mean, read low (worst 9.1°) | Rough guide only |
| 3D skeleton | 105 mm per joint (PA-MPJPE) side-on, 238 mm from behind | Visualisation, not measurement |
| 3D body mesh | 9–12 cm mean surface error side-on, 20–28 cm from behind | Visualisation, not measurement |
| Ball speed | Median 3–6 km/h, 95% within 8–20 km/h depending on frame rate; the stated range holds the true speed 92–100% of the time (simulated) | An estimate with an honest range, not a radar |

All the angles a coach sees are measured from the 2D keypoints on the video; the 3D body is drawn from a 3D estimate
that is less accurate, which is why no rating uses it.

## 1. How it was tested

**Synthetic deliveries with exactly known answers.** A scripted delivery is posed on the Anny body model and rendered
(the camera sees a body, not a stick figure), so every joint, angle and event is known. 17 clips vary:

- frame rate: 30, 60, 120 and 240 fps;
- view: side-on and from behind the bowler;
- technique: front knee braced (165°/170° at landing/release), bent (150°/140°) and collapsing (160°/125°); trunk upright (27°) or bent (42–44°); side-bend 20°, 36° and 54°;
- bowler: 1.62 m (height not entered), 1.80 m and 1.95 m;
- camera: bowler half the usual size (far away), and "phone quality" (480p, JPEG at quality 35, 25 px handheld shake).

Each clip was analysed by the **browser engine** (what the live site runs: YOLO11n/s pose, MotionBERT-Lite int8) with the
bowling arm set, as a user answering the app's arm question would, and by the **Python reference engine** with the same
3D model. Truth is measured on the rendered body with the same definitions the app uses.

**Real footage.** Release frames were marked by eye (one annotator, before looking at the new results) on 8 real clips:
a club match side-on, two broadcast clips from behind, three Wikimedia Commons county and club clips, a spinner, and a
240 fps net clip. Foot contacts could be marked on the club clip only (elsewhere the feet are hidden or at the frame edge).
The club clip was also re-analysed at 480p, with heavy JPEG compression, mirrored, and cropped.

**Ball speed.** 20,000 simulated deliveries (95–150 km/h) with quadratic air drag (new to old ball), a bounce anywhere
from 9 to 16 m that keeps 70–92% of the horizontal speed, a release point from 0.2 m behind to 0.7 m in front of the
popping crease, and each mark a frame off either way, run through the app's own `paceFrom`.

## 2. Key moments

| | Browser, side-on (7 clips) | Python, side-on (10 clips) | Browser, behind (3 clips, view read correctly) |
|---|---|---|---|
| Release | 4 ms (worst 17) | 1 ms (worst 12) | 0 ms |
| Back-foot contact | 15 ms (worst 33) | 19 ms (worst 33) | 0 ms |
| Front-foot contact | 16 ms (worst 33) | 16 ms (worst 33) | 17 ms |
| Follow-through | 66 ms (worst 100) | 52 ms (worst 183) | 39 ms |

Real clips, release frame against the hand-marked window:

| Clip | Camera, fps | App | By eye | Error |
|---|---|---|---|---|
| Club match | side-on, 25 | 39 | 39–40 | 0 |
| Bumrah, broadcast | behind, 30 | 47 | 47–48 | 0 |
| Shami, broadcast | behind, 30 | 32 | 32–33 | 0 |
| Keedy, Commons | behind, 30 | 118 | 117–118 | 0 |
| Hatfield, Commons club | front-on, 30 | 101 | 101–102 | 0 |
| Net session (Pexels) | behind, 240 | 225 | 218–226 | 0 |
| Bohemians, Commons club | front-on, 30 | 147 | 148–149 | −1 frame (33 ms) |
| Parry, Commons, spinner | front-on, 30 | 281 | 284–285 | −3 frames (100 ms) |

The release rule looks for the bowling arm's fast final upswing, which a slow spinner's arm does not make as sharply.
On the club clip the foot contacts matched by eye exactly (back foot 31, front foot 36).

## 3. Measurements

Browser engine, side-on, mean absolute error (worst), on the 7 clips where its pose model kept left and right apart:

| Measurement | Error |
|---|---|
| Front knee at front-foot contact | 1.0° (3.7°) |
| Front knee at release | 3.5° (8.3°) |
| Back knee at back-foot contact | 7.7° (9.1°), always read low |
| Trunk lean at release | 2.1° (3.7°) |
| Trunk flexion, landing to release | 2.2° (4.6°) |
| Stride length, % of height | 3.3 (6.4) |
| Release height, % of height | 7.4 (13.7) |
| Front-foot contact to release | 19 ms (33 ms) |

On a bent front knee (140° at release) the browser read 140.3°; on a collapsing one (125°) it withheld every body
measurement because it judged the camera angled. The Python reference reads bent knees 14–15° straighter than they
are (154° for 140°): its larger pose model places the knee keypoint on the front of a bent knee. The 2D image angle of
the rendered body equals the truth exactly, so this is the detector, not the camera.

From behind (browser), with the view read correctly: side-bend 2.6° (5.9°) across bends of 20°, 36° and 54°;
release height 5.4 (11.1) points.

## 4. 3D skeleton and body

| | Side-on | From behind |
|---|---|---|
| 3D joints, PA-MPJPE (browser) | 105 mm (worst clip 113) | 238 mm |
| 3D joints, PA-MPJPE (Python, same 3D model) | 83 mm (worst 99) | (view misread, see §5) |
| Body mesh surface at back-foot contact / front-foot contact / release (browser) | 9.3 / 9.6 / 11.7 cm | 20 / 28 / 28 cm |
| Body mesh at release (Python) | 8.7 cm | |

PA-MPJPE is the mean distance per limb joint after the best rotation, translation and scale, the usual measure for
single-camera 3D pose. Research lifters report roughly 35–60 mm on lab datasets of everyday movement; 105 mm here is
about twice that, partly because the joints are compared with the body model's joint centres (a slightly different
definition) and because a fast bowling action is far from the lifter's training data. From behind, depth is the axis
the camera can't see, so the 3D is much looser; Seamly takes no rating from it. Entering the wrong height
(1.62 m assumed as 1.80 m) adds about 3 cm to the mesh error, all of it overall size.

## 5. Where it fails

| Situation | What happened | How often |
|---|---|---|
| Left and right limbs confused by the pose model | Wrong arm or leg measured: on one clip trunk lean read 85° off, on another the front knee 22° off | 3 of 11 side-on synthetic clips (the faceless, symmetric mannequin swapped 35–72 times per clip); 1 of 17 real clips (a front-on club clip, release still right) |
| Faceless mannequin from behind read as front-on | Events 5–15 frames off, side-bend 26–35° off. Setting the view to "Behind" in Detection & settings now repairs it (since 2026-10-27): events within 1 frame, side-bend 6° and 0.5° off, 3D 239–244 mm | 2 of 5 rear-view synthetic clips; 0 of 7 real rear-view clips |
| Phone quality (480p + JPEG + shake) | Side-on: errors of 8–24°. From behind: refused, "couldn't find a delivery" | 2 of 2 |
| Resolution alone, 480p (Python engine) | Release 17 frames early, view misread, body metrics withheld | JPEG alone and shake alone were fine |
| Tight crop with the bowler near the frame edge (real clip) | Release 2 frames later, trunk lean +21°, score 72 → 88 | 1 of 4 real-clip variants |

Real-clip robustness, club match, change against the original analysis:

| Copy | Release | Front knee (landing / release) | Trunk lean | Stride | Release height | Score |
|---|---|---|---|---|---|---|
| 480p | same frame | −1.3° / +2.0° | −0.4° | +2.1 | +0.5 | 72 → 64 |
| JPEG quality 30 | same frame | −2.0° / +1.0° | +0.1° | −2.4 | +6.5 | 72 |
| Mirrored (arm set to right) | same frame | +1.5° / +2.1° | −0.1° | +0.2 | −1.2 | 72 |
| Cropped to 80% | +2 frames | −2.1° / +5.9° | +20.6° | −4.6 | −5.6 | 72 → 88 |

## 6. Ball speed (simulated)

| Frame rate | Pitch frame | Median error | 95% within | Range holds the true speed |
|---|---|---|---|---|
| 30 fps | not marked | 6.5 km/h | 20.4 km/h | 98% |
| 30 fps | marked | 5.5 | 16.9 | 94% |
| 60 fps | not marked | 4.9 | 14.1 | 99% |
| 60 fps | marked | 3.6 | 11.1 | 93% |
| 120 fps | not marked | 4.8 | 12.2 | 99% |
| 120 fps | marked | 2.9 | 8.5 | 93% |
| 240 fps | not marked | 4.8 | 11.3 | 100% |
| 240 fps | marked | 2.8 | 8.1 | 92% |

Without the pitch frame the estimate reads about 3 km/h high on average (the bounce is assumed to cost a little more
than it does in this simulation); with it, under 1 km/h. This test led to two changes: the range now allows a frame's
slip at both the release and the arrival (it held the truth only 80–91% of the time with the pitch marked before), and
only readings above 175 km/h are refused (a genuine 150 km/h ball at 30 fps could read 165+). The simulation's bounce
and release-point assumptions are themselves estimates; a radar session at the nets is the real test.

## 7. What this means for a coach

- **Trust:** the key moments and the timings, front-knee bracing (landing and release), trunk lean and flexion, stride
  length, and side-bend from behind the stumps. Differences of a few degrees between two clips are within the error.
- **Use as a guide:** release height (±7 points), back knee (reads about 8° low), ball speed (always with its range).
- **Don't read numbers off the 3D body:** it is 10 cm off side-on and 25 cm from behind; it shows the shape of the
  action. Every number comes from the video.
- **Filming matters most:** 720p or better, the whole body well inside the frame, side-on or straight behind the
  stumps. When the app asks which arm bowls or says the camera is angled, its numbers for that clip are not reliable.

## 8. Real IPL net clips (2026-10-27)

Eleven short cuts of IPL players bowling in the nets, from features on the official site (iplt20.com, streamed to any
visitor; kept on the laptop, never published). Each is one camera shot from an edited video: 0.6–1.9 s at 24–25 fps,
starting at the bound or later, so there is no run-up. Release frames were checked by eye on zoomed frames around
each release.

| | Result |
|---|---|
| Release frame | within one frame on 8 of the 9 cuts checked by eye (ipl01, 02, 05, 07, 09, 10, 12, 13); two frames early on a close-up of a spinner (Varun Chakaravarthy). Two cuts weren't checked by eye: against the scout's rough estimates they are 2 and 5 frames early (ipl08 starts with the arm already overhead) |
| Delivery found | 10 of 11 at first; the eleventh starts mid-swing, so the arm's sweep measured 140° (the bar was 150°). A sweep cut short by the start or end of the clip now counts from 120° at 450°/s or more (both engines) |
| Camera view | with no run-up in any cut and the feet below the frame in 7, the 2D view cues are mostly missing: 10 of 11 are now marked angled or uncertain, so plane-specific measurements are withheld with the reason shown. Before, one cut filmed from behind and to one side (where a forward lean shows up as side-bend) read a 57° side-bend and raised a back-health flag |
| Body out of the picture | close-ups put the feet below the frame and the bowling hand above it at release; a capture tip now says so, and nothing measured from the feet (knees, stride, release height, head over the front foot) or from a hand past the top edge is rated |
| Motion blur at 24 fps | on the one cut still rated (ipl01) the bowling wrist's keypoint jumps to the front hand on the release frames, so its arm slot (71°) and release height (80%) are unreliable; the app already says release measurements are approximate at 24 fps |

After these fixes, nine earlier real clips (two broadcast, four Commons, the club match and two degraded copies of it) gave identical views, arms, events, scores and measurements.

What this footage can't show: none of the cuts has a run-up or a ball reaching the batter, so run-up speed and ball
speed couldn't be checked; at 24 fps one frame is 42 ms.

## 9. Two cameras, one ball (2026-10-28)

The same scripted delivery rendered side-on and from behind (the camera positions a coach would use), analysed by the
browser engine as a pair. Ground truth comes from the rendered body.

| | Side-on alone | Behind alone | Both cameras |
|---|---|---|---|
| Key measurements made (of 10) | 5.7 | 2.0 | 8.3 |
| Back-health checks made (of 3) | 0 | 1 | 2.7 |

Mean over three pairs (side-bend 20° and 54°, and the default delivery at 240 fps side-on with 60 fps behind). Values
taken from the camera that measures them keep that camera's accuracy; what the pair adds:

- **Back-foot contact** carried from the camera behind landed on the true frame of the 240 fps side-on clip (side-on
  alone had only estimated it, 6 frames early), which made the **back knee** and the **stride timing** measurable
  (10° and 40 ms mean error; the back knee is known to read about 8° low, so a red flag resting on a carried contact
  is shown as "watch" until the contact is confirmed on its own clip).
- **Release height** comes from both cameras: when they agree within 12 points, weighted by each camera's measured
  error (7.4 points side-on, 5.4 from behind, §3), otherwise from the camera behind. Mean error 6.7 points over the
  three pairs (6.4 on the default delivery, where the two agreed), against 21 side-on alone (two of those side clips
  swapped the mannequin's wrists) and 5.4 from behind alone: on three pairs the difference from the better camera alone
  is within the noise.
- **Alignment.** Lining the clips up at the release each camera found puts them as far apart as the two release
  frames' errors: 0–83 ms on five synthetic pairs (mean 50 ms; the renders share one clock, so the truth is known).
  Seamly instead matches the movement in both clips (wrists and ankles above the hips, in torso lengths) and keeps the
  releases only when the movement doesn't decide: 1–33 ms (mean 9 ms). Its peak is about a frame wide, so an error of
  two frames at 60 fps can stay; big ones (83 ms, a mannequin's release found five frames early) are removed.

The same-ball check only says "the same ball" when a stride timing both cameras saw agrees within a frame of each;
from behind the foot contacts are often too hard to see, so it usually says "check these are the same ball". On the
faceless test mannequin two of the five rear clips are read as front-on (§5): the pair is then refused with a clear
message, and setting the view to Behind (§5) makes it work.

**Real clips of different balls, paired on purpose** (the real side-on club clip with four real clips of other
bowlers, 25 and 30 fps): two were called "may not be the same ball" (left-arm against right-arm), one was refused
(the clip from behind reads as angled), and one, where the camera behind misread a right-arm bowler as left-arm,
was called "check these are the same ball" with "the movement doesn't line up (17% match)". How well the movement
matched didn't separate same from different balls (0.70–0.72 for two different bowlers, 0.70–0.82 for the same
rendered ball): bowling actions look alike. At 25–30 fps the stride's timing can't either (a frame each is ~75 ms,
and one such pair agreed within it), so the check now only says "the same ball" when a frame of each is short enough
(both 60 fps, or one in slow motion); otherwise it says "check" and why. The arm's last phase (upper arm horizontal
to release) is no longer compared: from behind or in front it was misread by over 100 ms on two of six clips, which
called a correctly paired ball "may not be the same ball".

**A clip at the wrong speed.** Slow motion saved at normal speed (a phone's usual export) makes that clip's time run
4× or 8× too long; analysed at normal speed its foot contacts are usually not found, and it can even read as angled.
Seamly looks for two things that agree: the clip's wrist rises to release far slower than any bowler's (under 1 torso
length a second on the slowed clips, 13–51 on every real and rendered delivery tested) or the stride's phases are a
whole number of times longer, and the movement matches better with that clip's time shrunk. The factor comes from the
wrist's rise time (20–80% of its climb), snapped to the factors phones use (60, 120 or 240 fps over the file's rate).

| Pair | Wrong speed found | Factor | After the one-click fix |
|---|---|---|---|
| 240 fps side-on + 120 fps behind saved at 30 fps (4×), analysed at 1× (refused: read as angled) | behind | 4× (measured 3.8) | "the same ball"; 9 of 11 measurements identical to the pair filmed right, the other two within 1° |
| 240 fps side-on saved at 30 fps (8×), analysed at 1×, + 60 fps behind | side-on | 8× (measured 9.3) | key moments within 4 frames (17 ms) of the clip filmed right; that file's left and right then read swapped on the faceless mannequin (trunk lean −41° for 38°), which the same render re-encoded at 240 fps didn't |
| 4 correctly paired rendered balls, 4 real pairs of different balls | none | — | — |

Matching the movement alone gave false alarms on two of the four real pairs (a wrist's rise is one bump, and one bump
still looks like another stretched), so it is only used to confirm.

## 10. Still to do

- Lab validation against marker-based motion capture (real bodies, real knees): the synthetic body can't say whether
  the detector's knee placement on a bent knee differs on people.
- Two real phones on the same balls (a side-on and a behind-the-stumps phone through a net session): the pair
  features are measured on rendered pairs and on real clips of different balls, not yet on one real ball filmed twice.
- A radar-gun session for ball speed.
- Spinners: a release rule for slower arms.
- Left/right label consistency in the browser's pose model at 60+ fps side-on, and front/back from behind (both seen
  mainly on the faceless mannequin). A view correction now repairs the labels (§5); the automatic reading still
  needs the face or the direction of travel to tell front from back.
