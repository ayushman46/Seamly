# How accurate is Seamly? (tested 2026-10-26)

Everything here can be re-run: `backend/tools/accuracy_bench.py` renders the synthetic clips and scores any engine's
results, and `frontend/tests/pace_sim.test.ts` checks ball speed against simulated deliveries.

## The short answer

| What Seamly reports | How close it gets (side-on unless stated) | Trust it for |
|---|---|---|
| Ball release frame | Synthetic: 2 ms mean (worst 17 ms). Real clips: within one frame of the frame picked by eye on 22 of 23 (§9h) | Timing and anchoring every other measurement |
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
| From behind, on the pitch, nothing marked (§9l) | Rendered deliveries, hands off: pitch found on 12 of 12 in 3–8 s; release height 3.8 cm mean (worst 6.2); front heel 5.3 cm (worst 11.8); stride 5.9 cm (worst 14.8). Real clips from behind: pitch found on 12 of 19; the rest have no readable creases and are reported as not measurable | Where the ball was let go, the feet and the stride in real metres |
| Ball tracked from one camera behind the arm (§9l) | Rendered deliveries, hands off: speed 1.5% mean (worst 3.3%) on nine balls; where it pitched 10 cm along the pitch (worst 20), 0.7 cm across | Speed with a ± of 3–4%; line and length |

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

Each clip was analysed by the **browser engine** (at the time: YOLO11n/s pose, MotionBERT-Lite int8; the pose models have since been replaced, see §9h) with the
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

## 9b. 3D replay: tested on seven real clips (2026-11-14)

The replay was run end to end on the bundled club clip and six more real clips (two Pexels net sessions at 100 and
240 fps, a Pexels portrait phone clip, a Wikimedia Commons club clip, two broadcast clips kept locally), from side-on,
behind and in front, right- and left-arm. All ran without errors. What the audit measured, and what it changed:

| Check | Before | After |
|---|---|---|
| Back knee at back-foot contact, skeleton against the measured callout (side-on) | 127° shown for 166° measured | 166° (the legs are re-solved to the knee angles measured on the video) |
| Front knee at landing / at release, skeleton against callout | 8° out | within 1° |
| "Back leg" stop | "collapses ≈126°" from the 3D estimate, contradicting the 166° measured four frames earlier | 169°, "holds firm", from the measured knees |
| Release height, skeleton against callout (six clips) | 4–15 points low | within 1 point on five; one broadcast clip still 14 low (its 110% is beyond the skeleton's reach, so one of the two is wrong there) |
| Planted foot slide, side-on | 18 mm back foot, 10 mm front foot | same |
| Arm ribbon on fast run-ins | smeared up to 3 m along the pitch | carried with the bowler: a clean fan |
| Bound too short to time (0.08 s, three frames) | reported as a 4 cm jump | not reported (needs 0.12 s and three frames in the air) |
| Bone-twist flips between frames | none (worst turn 0.61 of a full cosine) | none |

Jump clearance by clip: 0.17 m (broadcast, 30 fps, 0.22 s in the air), 0.07 m (100 fps net), 0.37 m (240 fps net,
0.47 s in the air); none on clips that start too late to show the bound. The kinetic chain was timed on the 240 fps
clip only: hips, then trunk, then arm and hand, in order; at 25–60 fps it shows the bars but gives no verdict.

Not checked, because there is nothing to check it against: jump clearance and length against a measured jump, the
kinetic chain's timing against motion capture, and the assumed run-in on clips from behind.

## 9c. International match footage (2026-11-14)

Ten deliveries by ten bowlers, cut from the official bcci.tv match highlights of two 2026 internationals (India v
Afghanistan, only Test, day 1; India v New Zealand, 1st ODI): the broadcast camera high behind the bowler, 1080p,
25 fps, each a single shot of 1–3 s. Clips are kept locally and not redistributed. Run in full Chrome; every key
moment was then checked by eye against the frames, and the bowling arm against the bowler's known arm.

| Bowler | Usable? | Camera read | Arm read (true) | Release frame by eye | Release height | Side-bend |
|---|---|---|---|---|---|---|
| Zia-ur-Rehman | yes | behind | left (left) | right | 98% | 65° |
| Saleem Safi | yes | behind | right (right) | right, ball leaves next frame | 80% | 32° |
| AFG seamer ("Malik") | yes | behind | right (right) | right, ball leaves next frame | 114% | 27° |
| Kharoti (spin) | yes | behind | left (left) | within a frame | 108% | 35° |
| Mohammed Siraj | yes, clip starts at back-foot contact | behind | right (right) | right | 88% | 39° |
| Harshit Rana | yes | in front, **wrong** (fixed: now behind) | right (right) | right | 82% | 51° |
| Ravindra Jadeja (spin) | yes | behind | right, **wrong** (left); 20% sure, and the page asks | right | 117% | 7° |
| Kuldeep Yadav (spin) | yes | behind | left (left) | within a frame | 86% | 18° |
| Azmatullah | **no**: followed the batter's swing | – | – | – | – | – |
| Prasidh Krishna | **no**: took an arm turn in the gather for the delivery, 3-frame window | – | – | – | – | – |

What this shows, and what was done:

- **Key moments are reliable on broadcast footage** when the bowler is found: release within one frame on all eight.
- **Two of ten were not analyses of the delivery at all** and were still presented with a score. They are now caught:
  an analysis whose key moments sit on top of each other, or whose "release" has the hand at chest height with a
  low release height, is marked "can't be trusted" and its 3D replay is locked (`lib/sanity.ts`). The same two clips
  analysed correctly in a different browser build: tiny decoding differences tip the bowler-finding step, which is
  the next thing to harden.
- **Behind or in front** is now decided by which side of the picture the right shoulder is on (right on all 13 real
  behind/front clips, including the one the 3D direction of travel got wrong), in both engines.
- **The bowling arm** was wrong once in eight (a 2–2 split of the cues, 20% confidence); the page already asks the
  user to confirm the arm when it is unsure.
- **Magnitudes from this camera are not trustworthy.** Release heights of 80–88% of height for international seamers
  are too low (they release well above their own height), and side-bends of 51° and 65° are too high: the broadcast
  camera looks down on the bowler from high behind, which shortens heights and turns forward lean into apparent
  side-bend, and the camera's height isn't estimated. From this camera the numbers are good for timing and for
  comparing the same bowler ball to ball, not as absolute values.

## 9d. Joint positions against a much larger pose model (2026-11-14)

How close the browser's keypoints are to the best free reference available here: YOLO11x-pose on a 960 px crop,
flip-averaged (about 20 times the browser model's size, far too slow for a phone). 550 frames from 15 real clips
(ten international deliveries, two IPL net clips, three club and net clips). Error is the distance to the reference
keypoint in torso lengths (shoulders-to-hips), over keypoints the reference is confident about. This is agreement
with a stronger model, not with motion capture.

| | Whole body | Arms, within 4 frames of release |
|---|---|---|
| Browser model as shipped (YOLO11s on a 384 px crop) | 0.111 | 0.137 |
| The same model on a 640 px crop | 0.102 | 0.127 |
| YOLO11m on a 640 px crop | 0.094 | 0.115 |

- **The model was not the main problem; the clean-up was.** On 13 of the 15 clips the keypoints the app stores are as
  good as the detector's own. On the two clips filmed from in front they were far worse (wrists 0.61 and 0.86 of a
  torso length out, against 0.15 from the detector): the left/right swap repair follows the smoothest motion, and a
  bowler seen from in front really does cross sides as they turn, so the repair relabelled the arms for 31 of 66
  frames on one clip and the whole body for 160 of 361 on the other.
- **Fixed on one, not on the other.** A repair to the arms is now checked against the body (shoulders against hips,
  elbows against shoulders) and refused where it would hang the limb from the far side. Club clip from in front,
  re-analysed in Chrome: wrists 0.61 → 0.19, elbows 0.52 → 0.14, frames with both wrists on the wrong arms 20 → 2 of
  45; its key moments did not move. The bundled "club match from in front" example is that clip and was regenerated.
  The 100 fps net clip from in front is unchanged (wrists 0.86): there every limb is relabelled together, which looks
  the same as the whole-body mirroring the repair exists to undo on a figure seen from behind, and a rule that told
  them apart by the face failed on the faceless test figure. Its key moments and arm are unaffected; its drawn arms
  are crossed for part of the clip.
- **A larger crop was tried and not shipped.** Running the same model on a 640 px crop (WebGPU only) is 8% closer to
  the reference on average, but in Chrome it moved two releases that had been checked by eye on the international
  clips (one bowler's arm flipped to the wrong side, another's release went three frames late and tripped the
  hand-height warning), so the gain did not survive contact with the events. Unchanged key moments on six re-run
  clips (two international, Bumrah, two club, one net) was the bar for the fix that did ship.

**Arm slot in the 3D replay.** From behind or in front, the skeleton's bowling arm at release leaned by a different
angle from the one measured on the video (ten rear-view analyses: differences of 0 to 39°, because the arm's circle is edge-on
to the camera and the 3D estimate has least to go on). The replay now turns the arm about the pitch's line to the
measured arm slot, eased in and out round release, and draws the swing plane through it; the hand ends within 5 cm of
where it was. Side-on, where the lean lies along the camera's view, the plane is drawn from the 3D estimate and no
angle is quoted.

## 9e. Face it: the simulated flight (2026-11-14)

Face it (`frontend/src/lib/flight.ts`) flies a ball from the bowler's release point to the batter. Nothing here is
measured on a real ball in flight: this section is about whether the physics is computed correctly and whether its
constants give the figures real deliveries show. `frontend/tests/flight.test.ts` holds every check below.

**The integration is right.**

- With drag switched off, the pitching time, the pitching point and the speed at the pitch match the textbook
  parabola to a millimetre and three decimal places of a second.
- With drag, swing and the bounce on, the result was compared with a second implementation written separately for
  the test: fourth-order Runge-Kutta at a tenth of the time step, with the bounce found by bisection. Over four
  deliveries (86 to 148 km/h, with and without swing) the two agree to within 4 mm at the pitch and at the batter,
  0.2 ms in arrival time and 0.02 m/s in arrival speed.
- Aiming: over 180 combinations of pace (75 to 150 km/h), length (0.8 to 12 m), line and swing, the ball pitches
  within 1 cm of the length asked for and passes the stumps within 3 mm of the line.

**The constants give believable deliveries.** From a release 2.10 m high, 1.2 m in front of the bowler's stumps:

| Pace at release | Length (from the batter's stumps) | Release angle below horizontal | Hand to bat | Speed into the pitch | Speed at the batter | Height at the stumps | Length per degree |
|---|---|---|---|---|---|---|---|
| 150 km/h | 1.2 m (yorker) | 3.5° | 454 ms | 134 km/h | 134 km/h (before it pitches) | 16 cm | 1.8 m |
| 140 km/h | 7 m (good) | 7.5° | 515 ms | 130 km/h | 107 km/h | 74 cm | 1.0 m |
| 140 km/h | 11 m (short) | 13.1° | 541 ms | 134 km/h | 105 km/h | 141 cm | 0.5 m |
| 125 km/h | 7 m (good) | 6.9° | 576 ms | 117 km/h | 95 km/h | 72 cm | 0.9 m |
| 100 km/h | 5 m (full) | 3.0° | 703 ms | 93 km/h | 77 km/h | 56 cm | 1.0 m |

A 140 km/h ball taking about half a second, losing about a tenth of its speed in the air and reaching the batter
at about three quarters of its release speed is what ball-tracking broadcasts show, and a good-length ball arriving
at the top of the stumps is what "good length" means. The average speed to the batter as a share of the release speed
stays inside the 0.76-0.95 the ball-speed measurement (§6) already assumes, so the two features agree with each other.

**The release point.** On all four bundled examples the release point is the bowling hand at the release frame,
1.84 to 2.09 m high, by the bowler's crease, on the bowling arm's side, and its height is the one measured on the
video. A pace marked on the clip becomes the starting pace; a marked pitching frame becomes the starting length
(tested by marking a pitch 0.35 s after release and checking the flight to that length takes 0.35 s).

**In the browser.** Run in GPU Chrome on the four bundled examples, at desktop and phone sizes, with no errors: the
on-screen clock stops at the computed hand-to-bat time; a 150 km/h in-swinging yorker to a left-hander, a 145 km/h
bouncer and a 70 km/h lob all play and report; the dialog closes on Esc and returns focus to its button.

**What it does not claim.**

- The flight is not the ball in the video. Only the release height is measured; the bowler's distance from the
  stumps and the hand's position along the pitch are the 3D scene's (the front foot is stood 0.22 m behind the
  popping crease, 0.62 m from middle stump).
- Heights scale with the bowler's height, 1.80 m unless it was entered.
- One bounce model (55% of vertical speed kept, 87% along the ground): a firm pitch. A cricket ball dropped on a hard
  surface keeps 0.58 (R. Cross, University of Sydney); real pitches vary either side, and so will the height at the
  batter.
- Swing is a constant side-force coefficient up to 0.25 until the ball pitches (Test-match tracking spans about 0.1
  to 0.5); late swing, reverse swing, seam movement and spin are not modelled.
- The 0.2 s "last look" is a typical visual reaction time (McLeod 1987), not a measurement of any batter.
- The batter's-eye picture uses a long lens on the bowler that opens out as the ball comes, and the ball has a glow,
  so it can be seen on a phone. Timing is real; apparent size early in the flight is not.

## 9f. Ball tracking from one camera (2026-11-15)

**What it is.** `frontend/src/lib/camcal.ts` solves a pinhole camera (zoom, direction, position: seven unknowns) from marked crease corners and stumps, whose places on the ground are fixed by Laws 7 and 8. `lib/ballfind.ts` cancels the camera's own zoom and pan between frames by matching patches, takes a three-frame difference to find small moving blobs, and links them into smooth chains. `lib/balltrack.ts` fits one flight through the sightings by least squares: position and velocity in the air (gravity, drag coefficient 0.45, a swing side-force), the bounce where the flight meets the ground, and a free velocity off the pitch. `lib/tracker.ts` ties them together; `components/BallTracker.tsx` is the screen.

**What one camera cannot see, and what stands in for it.** A picture gives a line of sight, not a distance. Three things fix the distance: the ball is on the known ground when it pitches; gravity and the frame clock; and the release, which is near the popping crease (the front foot the analysis found, on the ground, and the Laws' own 1.22 m). After the bounce the speed kept along the ground leans on a prior (0.87 ± 0.08 of the speed in). In sunshine the ball's shadow is a second line of sight; through a long lens it still leaves one direction open (how far along the pitch the sun pushes shadows), which marking the shadow of something upright closes.

**Uncertainties.** Each figure's ± is the least-squares covariance pushed through to that figure, scaled up when the flight fits worse than a pixel and a half, plus the spread from re-fitting twelve times with the pitch marks nudged by their own misfit, plus 1.5% of the speed for the drag coefficient.

### Checks with exact truth

| Check | Result |
|---|---|
| Camera from 12 exact marks, five camera placements (phone low and high, broadcast long lens, behind the batter) | marks reproduced to < 0.02 px; any point above the pitch lands within 0.3 px |
| Flight from exact sightings (broadcast 25 fps, phone 60 and 30 fps) | speed within 0.5 km/h, length within 5 cm, path within 8 cm everywhere |
| 120 simulated deliveries with 1.5 px noise on the ball and the marks, release known to ± 0.4 frame and ± 0.3 m | root-mean-square error: speed 5.8 km/h (broadcast 25 fps), 3.8 (phone, high tripod, 60 fps), 1.9 (phone, low, 60 fps); length 6, 7, 12 cm; line 1.2 cm; height at the stumps 8, 5, 3 cm. The truth is inside 2 sigma 88 to 100% of the time |
| Whole pipeline on frames rendered in the test suite (`tests/tracker.test.ts`: textured turf, painted creases, ball and shadow, 60 fps; 30 fps with no shadow; a camera zooming 1.6x at 50 fps) | every case inside: speed 6 to 9 km/h and 3 sigma, length 30 cm, line 5 cm, height at the stumps 15 cm |
| Whole product in Chrome on rendered films with the mannequin bowler (`backend/tools/synth_delivery.py`) | phone, 60 fps: 127.3 ± 5.5 km/h (truth 128), length 6.45 m (6.50), swing 12 cm (12.6), height 61 cm (60.5). Full HD, 60 fps (the bundled example): 129.0 ± 4.2 (131), 6.79 m (6.80), line -20 cm (-19.9), swing 14 cm (14.4), height 64 cm (63.1). Broadcast-style zoom at 25 fps, in the test harness: 141.2 ± 3.2 (141), 8.20 m (8.20), height 76.9 cm (76.9) |
| Camera-movement chain across a 1.7x zoom | the pitch marks carried to within 0.3 px |
| A release frame deliberately 9 or 14 frames wrong | the ball is still found; the release is taken from the ball; the length is unchanged and the speed's ± widens (to ± 13 to 31 km/h) |
| Frames with no ball | nothing is reported |

### Real footage: five international deliveries with the speed gun on screen

Clips cut from official BCCI highlights (25 fps, 1080p, a high camera behind the bowler's arm that zooms through the delivery). They are not in the repository. Each was run through the product in Chrome: the analysis, then eight crease corners clicked from coordinates read off a frame, then "Find the ball" with no further help. The gun figure is the broadcaster's graphic for that ball.

| Delivery | Gun (km/h) | Tracked (km/h) | Error | Sightings, fit | Notes |
|---|---|---|---|---|---|
| Pace, red ball, sunshine | 133.0 | 142.6 ± 9.1 | +7.2% (1.1 sigma) | 10, 0.8 px | pitched 9.22 m ± 5 cm. In the test harness, where the shadow was matched in 10 frames: 143.4 ± 6.0, and 138.9 ± 2.9 with the umpire's shadow marked for the sun's direction |
| Spin, red ball | 82.2 | 78.9 ± 4.2 | -4.0% (0.8 sigma) | 22, 1.2 px | pitched 7.05 m; 5° of turn |
| Spin, red ball | 80.9 | 86.4 ± 4.1 | +6.8% (1.3 sigma) | 23, 1.2 px | pitched 6.41 m; camera marks agreed to 2.0 px |
| Spin, white ball | 91.6 | about 83 ± 13 | -9.4% (0.7 sigma) | 19, 0.5 px | the analysis had the release 7 frames early (the wrong arm); the release was taken from the ball, and the speed flagged as rough |
| Spin, white ball | 86.8 | none | | | not found on its own: the analysis had the release 10 frames late. Marked by hand the ball was never seen to pitch before the bat, and the fit gave 55 to 58 ± 21 to 24: no speed worth quoting |

Mean absolute error on the four that tracked: 6.9%. All four are within 1.3 of their own sigma, so the error bars are doing their job; but this is four deliveries, one ground type of camera, and one frame rate. Length, line, swing and height at the stumps have **no ground truth** on real footage here (there is no Hawk-Eye data to compare with); what can be said is that the fitted flights pass within 0.5 to 1.2 px of every sighting, before and after the bounce, with gravity fixed at 9.81, and that scanning the assumed frame rate on the first clip gives the tightest fit at exactly 25 fps.

### What it does not do

- It is not Hawk-Eye: one camera, 25 to 60 frames a second, against six cameras at 340. Speed is the weakest figure; expect ± 4 to 9 km/h from broadcast footage and, by simulation only, ± 2 to 4 from a phone at 60 fps on a high tripod. No phone footage with a radar reading has been tested.
- It needs both ends' markings (or stumps) in shot on one frame (found automatically, around two taps, or marked by hand: §9g), and a ball that stands out for at least seven frames. A white ball on a pale pitch under cloud, nets with no creases, or a side-on camera will not track.
- A track that pitches at the bat (a half-volley) has nothing on the ground to fix its distance: the speed is shown as rough or not at all.
- The pose analysis can pick the wrong arm or moment on broadcast clips (two of five here). The tracker checks the flight against the release and falls back to the ball itself, but a speed needs the release frame: step to it and set it.
- "Hitting the stumps" is where the fitted flight goes, as if nothing were in the way, with the bounce's kept speed leaning on a prior when few frames follow the bounce.
- Finding the ball takes 4 to 20 seconds (longer for full HD at 60 fps).

## 9g. Finding the pitch without marking it, and two guards against false tracks (2026-11-15)

**What it is.** `frontend/src/lib/autopitch.ts` finds the crease pattern in one frame. Whiteness is smoothed along each line's own direction and thin ridges are kept; lines across the picture are voted for one at a time (each one's pixels removed before the next, so a bold popping crease does not hide the faint bowling crease beside it); sets of four whose spacing is the Laws' spacing in perspective (0, 1.22, 18.90, 20.12 m) are kept, with a hidden bowling crease filled in from the other three; return creases are short upright ridges that cross the bowling crease, reach the popping crease and carry on behind (a wide guide line or a stump does not); four corners give a ground homography, the whole pattern is scored against the paint, and the camera is polished against every stretch of crease that can be seen. A fit is refused if the bowling crease runs on past a "return crease" (the pattern laid over part of the pitch), if the strip between the creases is grass-green, or if the camera would be tilted sideways or somewhere no camera could be. The answer is the same eight corner marks a person would tap, so everything downstream is unchanged.

Two ways in: with no help (accepted only at a high bar: both ends, all four return creases), or around **two taps on the middle stumps**, which tell it where to look and let fainter paint through. Corner-by-corner marking remains.

| Check | Result |
|---|---|
| Rendered pitches with exact truth (`tests/autopitch.test.ts`: noise, mowing stripes, wide guide lines, blocks standing where the umpire, bowler, batter and keeper hide the creases) | every corner within 1.5 px (empty pitch) and 2 px (with people); faint paint with two taps 9 px off: within 2.5 px. No pitch in view, or a strip with no creases: nothing found, with or without taps |
| Rendered broadcast-style film (`synth_delivery.py`), no taps | corners 1.5 px from the truth on average, worst 2.1 |
| Four BCCI frames marked by hand earlier, two taps | 0.9, 2.0, 1.9 and 3.8 px from the hand marks on average (the hand marks are themselves good to a pixel or two) |
| Fifteen real broadcast frames, no taps | 2 accepted, both right; 13 declined; none accepted wrongly |
| Thirteen real broadcast frames, two taps read off the frame by eye | 7 accepted, all right by eye; 6 declined (soft, heavily compressed pictures in which the creases are barely there) |
| In Chrome on the five BCCI clips | pitch found with no taps on three, with two taps on the other two |
| 22 more clips from a public set of compressed broadcast deliveries (Hugging Face `taha1418/Cricket_Delivery_Videos`, test use only, not in the repository), no taps | pitch found on 1; the rest asked for taps. On the five of these tried with two taps, found on 1. These pictures are too soft for the finder; it says so rather than guessing |

**What it does not do.** It is built for a camera that looks down the pitch from height (a broadcast camera, a club's streaming camera, a phone on the pavilion balcony). From a phone at head height behind the stumps the far creases are a few pixels apart and it will usually decline; mark the stumps and corners by hand there. An earlier version accepted a half-width fit on one real frame and a wrong fit on the rendered phone view; the checks above are what refuse those now, and both are in the tests or were re-run.

**Two guards added to the ball finder,** both from a real failure: with the pitch found on a different frame, one spin delivery came back as 160 km/h.

- *A limb is not a ball.* The bowling analysis's skeleton is carried into the tracker. A flight with more than a quarter of its sightings on the bowler's body (within 0.3 of a torso length of a limb) is refused.
- *A flight cannot start before the release, and a release taken from the ball must start at the bowler.* With the analysis's release frame, sightings more than 1.2 frames ahead of it are refused. When the release has to be taken from the ball itself, the first sighting must be within a torso and a half of the bowler in a frame where the bowler was found: a ball first picked up half-way down the pitch fits just as well as one released there at twice the speed, and that is exactly what the 160 km/h was.

`tests/tracker.test.ts` covers both. The five BCCI deliveries, re-run in Chrome through the new flow (pitch found by the app, no corner marking):

| Delivery | Gun (km/h) | Tracked (km/h) | Error | Pitch found |
|---|---|---|---|---|
| Pace, red ball | 133.0 | 142.3 ± 9.1 | +7.0% | two taps |
| Spin, red ball | 82.2 | 78.9 ± 4.2 | -4.0% | two taps |
| Spin, red ball | 80.9 | 86.8 ± 4.1 | +7.3% | on its own |
| Spin, white ball | 91.6 | about 97 ± 13 (flagged rough) | +5.9% | on its own |
| Spin, white ball | 86.8 | none: "could not be picked out" | | on its own |

Mean absolute error on the four that tracked: 6.1%, each within 1.5 of its own sigma. The speeds match the hand-marked runs in §9f to within 0.4 km/h on three; the fourth moved from 83 to 97 because the pitch was found on a different frame of a zooming shot, which is the size of change its ± 13 allows. The accuracy of the speed itself has not improved: it is still a single 25 fps camera. What changed is that nobody has to mark the pitch, and a wrong answer that used to be possible is now refused.

**Hugging Face.** Searched for a model that could do this job better (2026-11-15): there is no cricket ball tracker or pitch-keypoint model of usable quality (one hobby YOLOv8 ball detector trained on a Kaggle set, with weights under a licence that does not suit a product; TrackNet weights for tennis and badminton only). The public delivery-video set above was the useful find: about a third of its clips show the speed gun, but most are too compressed for the creases to be found, so it did not enlarge the speed-gun table.

## 9h. New pose models, free for any use, and the rules retuned on them (2026-11-18)

The website's two pose models were replaced: **RTMO-s** (finds everyone in the frame) and **RTMPose-m** (reads the
bowler's joints on a crop, 26 keypoints), both from OpenMMLab under Apache-2.0, in place of YOLO11n/s-pose
(AGPL-3.0). The first download grows from about 70 MB to about 110 MB; analysis is faster (about 28 s against 40 s
for a 1.5 s clip at 60 fps on the test laptop). The Python engine in `backend/` still uses YOLO and does not have
the rules below.

**Synthetic clips with exact truth** (same 17 clips as §1, same Chrome, bowling arm given):

| Side-on, 11 clips | YOLO11 (before) | RTMO + RTMPose (now) |
|---|---|---|
| Release | 21 ms (worst 167) | 2 ms (worst 17) |
| Back-foot / front-foot contact | 29 / 30 ms (worst 167) | 16 / 16 ms (worst 33) |
| Front knee at landing | 3.5° (worst 19.4) | 3.6° (worst 6.0) |
| Front knee at release | 8.7° (worst 29.2) | 9.4° (worst 14.0) |
| Back knee at back-foot contact | 10.4° | 1.7° |
| Trunk forward lean at release | 28.3° (worst 84.6) | 4.6° (worst 8.0) |
| Stride length | 6.0% | 2.7% |
| Release height | 10.3% | 6.6% |
| 3D joints (PA-MPJPE) | 172 mm (worst 294) | 80 mm (worst 106) |

The front knee at release reads about 9° too straight with every strong model tried (YOLO11x and RTMPose at two
sizes as well), so that offset belongs to the test figure, not to the model. From behind (6 clips) the release is
within a frame on 4 (mean 53 ms over the six, against 132 ms before); on the other two the faceless grey figure is
read as facing the camera, which mirrors left and right. Real bowlers filmed from behind are not read that way
(below).

**Real clips.** 39 clips were run in Chrome on both versions: the three bundled examples, Bumrah and Shami broadcast
clips, eleven Wikimedia Commons and Pexels clips, the ten international deliveries of §9c and the eleven IPL net cuts
of §8. Release frame, bowling arm and camera side were checked by eye on the frames for 23 of them.

| Clip | By eye | Before (YOLO11) | Now |
|---|---|---|---|
| Club match, side-on | 39–40, left arm | 39 | 39 |
| Club match, front-on | 46, right arm | 46 | 46 |
| Nets from behind, 60 fps | 54–55 | 55 | 54 |
| Bumrah / Shami, broadcast | 47–48 / 32–33 | 47 / 32 | 47 / 32 |
| Keedy / Hatfield / net session | 117–118 / 101–102 / 218–226 | 118 / 101 / 225 | 118 / 101 / 225 |
| Bohemians, front-on | 148–149 | 147 | 147 |
| Parry, spinner, front-on | 284–285 | 281 | 283 |
| International, right-arm seamer (a) | 121–122, right, behind | 128, **left** (the other arm's swing in the follow-through) | 122, right, behind |
| International (b) | 14, right, behind | 31, **left, in front** | 14, right, behind |
| International (c) | 15, right | 15 | 15 |
| International, left-arm spinner (j) | 31, left | 24, **right** | 31, left |
| International, left-armer (k, Kharoti) | 27–28, left | 28 | 28 |
| International (nz k) | 21, right | 30, **left** (follow-through arm) | 21, right |
| International (nz g) | 17 | **no usable delivery** (3-frame window) | 17 |
| Net clip, 100 fps, front-on | 590–594, right | 622 | 595 |
| Aythorpe, club, front-on | 112, right | 105, **left** | 112 |
| Rendered clip with a tracked ball, 60 fps | 56–57 | **35** | 56 |
| IPL net cut 10 | 19, right | 18 | 19 |
| IPL net cuts 4 and 11 (close-ups, legs out of frame) | about 10 and 25 | 8 and 16 | 9 and 16 |

On these 23 checked clips the new version is within one frame of the eye on 22 and the old on 13; the one it misses
is a close-up of a spinner whose clip both versions cut short. Bowling arm: 23 of 23 against 17 of 23 (one of
the old six is the clip where it found no delivery). The "before" column is one run of the live version in headless Chrome on this laptop; §9c notes
that its bowler-finding step could tip either way between browser builds, and some of its misses here are that.

**What had to change besides the models** (all in the browser engine):

- *One person, counted once.* RTMO often returns the same skeleton two or three times with different boxes. The
  copies broke tracking (a broadcast clip's window ended 14 frames before the release). The same skeleton is now
  kept once.
- *The bowler through a crossing.* When the bowler ran past the umpire, re-tracking the delivery window swapped the
  two and the skeleton finished on the umpire. Each frame's bowler is now the detection that lies where the scan's
  bowler is, between the scanned frames either side.
- *The bowler, not the batter.* A batter lifting the bat sweeps the arms as widely as a bowler. Of two people who
  swing while both in the picture, the one who swings 0.25 to 1.2 s earlier is the bowler.
- *A cut between two shots of the same ground* (outfield to pitch, both green) is now found; before, the window ran
  back across it onto other players.
- *The bowling arm is the one that goes up and over.* A new cue: the wrist rising from below the shoulder to well
  above it and falling away within a third of a second. Seen from in front or behind the front arm can sweep the
  wider arc, which misled the existing cues.
- *The other arm's swing after the ball has gone* (ten of the clips show it, about 0.3 s after the release, often as
  high as the release itself) is no longer taken for the delivery: bent double with an arm in the air is the
  follow-through, and of two arms going over the top the first is the bowling arm.
- *Where to look for the release.* The search is anchored on the bowling arm's own up-and-over, and moves to it
  when the scan's widest arm turn was somewhere else (the gather, or the follow-through).
- *A wrist the model barely saw* counts for less, and a wrist misread for one frame at the top no longer ends the
  top early (the spinner in the table: three frames early before, one now).
- *Close-ups*: with the legs out of the picture from the first frame, low confidence in the legs no longer ends the
  window early.

What is not better: close-ups with the feet and the hand out of the frame remain guesses in both versions; the
faceless test figure from behind is still mirrored on two of six clips; and a spinner whose front arm goes over
the top before the release is told from a trailing arm only by the other cues (one such clip in the set, read
correctly, at 7% confidence, so the page asks which arm).

## 9i. On the pitch: the bowler measured in metres, from behind (2026-11-18)

Filmed from behind, both sets of stumps and the creases are in the picture, and the Laws fix their sizes. A few marks
on them give the camera (`lib/camcal.ts`); a heel on the ground then has one place on the pitch, and the hand above
the planted front foot has one height (`lib/onpitch.ts`). No height is typed in. The page (`OnPitch3D.tsx`) opens on
the video with the pitch drawn over it from the camera's own position, so the fit can be judged by eye, and then
lets the scene be walked round in 3D.

**What marks the pitch.** Nobody, since 2026-11-19: the app finds the creases itself when the analysis opens (§9k).
The first version asked for four taps, the foot and the top of the middle stump at each end; those are still there
for a clip the finder cannot read, and the figures below (made with exact marks) are the measurement's own accuracy,
whoever places the marks.

**Rendered deliveries with exact answers** (five clips from `backend/tools/synth_delivery.py`: phone on a tall
tripod twice, full-HD phone, tripod at chest height, a broadcast camera that zooms 1.75x through the delivery;
bowlers 1.65 to 1.95 m; analysed in Chrome, camera from exact marks):

| | Mean error | Worst |
|---|---|---|
| Release height | 1.9 cm | 4.0 cm |
| Release, distance from middle stump | 0.6 cm | 1.1 cm |
| Heel, across the pitch | 0.5 cm | 1.1 cm |
| Heel, down the pitch | 2.2 cm | 8.1 cm |
| Stride, heel to heel | 4.2 cm | 9.4 cm |
| Run-up speed (four clips) | 0.6 km/h | 1.0 km/h |

Every one of those errors is inside the ± the page shows for it. Taps a pixel and a half out move the release height
by 1.7 to 4 cm depending on the camera, and that doubt is added to each figure: the marks are nudged a dozen ways,
the camera solved again, and the spread carried through. The whole flow in Chrome on the phone clip, four taps
through to the page: release 1.92 m high and 44 cm left of middle stump (truth 1.90 m and 45 cm), camera 3.4 m up and
10.5 m back (exact).

**Real footage.** Two broadcast deliveries with the crease corners marked by eye:

| | Bumrah | Shami |
|---|---|---|
| Bowler's height, measured | 1.81 m ± 12 cm | 1.78 m ± 10 cm |
| Height as usually listed | 1.78 m | 1.73 m |
| Release | 2.02 m ± 6 cm high, 1.01 m from middle stump | 1.84 m ± 7 cm high, 0.77 m from middle stump |
| Front foot | heel 31 cm ± 23 behind the line: too close to call | hidden behind the back leg: not measured |
| Run-up | 22 km/h ± 5 | 31 km/h ± 5 |

The heights are 3 and 5 cm over the listed ones, about what boots add, and inside their ±. The listed heights are
public figures, not measurements of mine; nothing else on these two clips has a known answer.

**What it cannot do, and says so.**

- *Nets with no stumps at the bowler's end and no creases* (the bundled nets clip is one): there is nothing of known
  size at both ends, so the camera cannot be solved.
- *The front foot seen from straight behind* often lands hidden by the back leg. A "stride" under 45% or over 105% of
  the bowler's height is treated as a foot that was not seen: nothing is measured from it, and the release is placed
  a usual stride ahead of the back foot with a wider ±.
- *A landing frame that is a frame or two early* at 25 to 30 fps catches the foot still swinging through. A foot's
  landing spot is taken only from frames in which the heel has stopped in the picture.
- *A high camera looking only 8° down* (broadcast) turns 3 cm of doubt in a foot's height into 20 cm along the pitch.
  Heights and distances across stay good; the stride and the front-foot line carry ± 15 to 30 cm there and the
  no-ball call is usually "too close to call".
- *The bowler's height* is the top of the head through the run-up. The rendered figure runs crouched, and on the
  chest-height tripod clip it read 12 cm short of standing height; on the two real bowlers it read 3 to 5 cm over.
  Treat it as about right to 6 cm or so.
- *The camera's movement* is measured in the page from the frames themselves. The analysis's own estimate missed a
  slow broadcast zoom altogether (it reported a still camera through a 1.75x zoom), which would have put the feet
  metres out.
- The skeleton in the walk-round view shows each joint on its measured line of sight; how far forward or back each
  joint sits along that line is an estimate, and no figure is taken from it.

Not checked against a motion-capture lab, Hawk-Eye or a marked-out pitch with a tape measure.

## 9j. From behind in poor light, and how steady the answers are (2026-11-18)

Eight hand-checked clips were each altered five ways (re-encoded, mirrored, shrunk to 480p, darkened, shaken by hand,
and at half the frame rate where there were frames to spare): 30 copies, held to the originals' release frame, arm
and camera side. 24 gave the same answers. One of the six that did not was the nets clip from behind, darkened: the
model took the bowler's back for the front, so the clip read as filmed from in front with the other arm. A rule now
catches that: a bowler who shrinks by more than 30% a second through the run-up is running away from the camera, so
the camera is behind (from behind near the camera the clips shrink 35 to 100% a second; no front-on clip shrinks
more than 22%). With it, 25 of 30. The other five are all copies of one clip, the spinner of §9h that was already
right only at 7% confidence: re-encoded, it flips to the wrong arm.

Three clips that had never been checked by eye were checked. One release was within a frame (a club off-spinner).
Two are failures that remain: in a club clip that fades in on the delivery, the app analysed the umpire waving a
sweater 4 s later instead of the bowler; and in a very wide shot of a match with no bowler near the camera it
analysed a fielder instead of saying there was no delivery to analyse.

## 9k. Nobody marks anything: the pitch, the bowler and the ball found by the app (2026-11-19)

The first version of §9i asked for four taps on the stumps. Now, when an analysis of a clip from behind opens, the
app finds the pitch, measures the bowler on it and looks for the ball, and the figures simply appear on the page
(`lib/autocam.ts`, `lib/autopitch.ts`, `lib/stumpfind.ts`). Nothing is asked.

**The finding that shaped it: calibrate from the bowler's end.** A phone 10 m behind the stumps at 720p sees the far
creases a fifth of a pixel thick; no finder can read them. It sees the creases at the bowler's end two or three
pixels thick, and that end is where the bowler is measured. So how good is a camera worked out from one end only?
Sixty trials on each of five cameras (a phone on a tall tripod, a tripod at chest height, the umpire's eye, a club
boundary 25 m back, a broadcast gantry), with marks placed as well as each kind can be:

| Camera worked out from | Release height | A heel, down the pitch |
|---|---|---|
| The four crease corners at the bowler's end, each good to half a pixel; nothing else | 0.2 to 0.5 cm (worst 2) | 0.3 to 3.6 cm (worst 9) |
| The same, and the batter's wicket 4 px out | 0.4 to 0.7 cm | 0.4 to 6 cm |
| The two wickets alone (foot and top of each middle stump, good to a pixel and a half) | 1.3 to 5.3 cm (worst 14) | 4.4 to 16 cm (worst 37) |

The bowling crease, the popping crease and the two return creases are a ruler 2.64 m across and 1.22 m deep lying
exactly where the measuring is done; a stump is a ruler 71 cm tall. And a stump's ends are hard to find: its shadow
starts at its foot, and a crease painted behind it cuts it in two (the rendered clips showed both). So the wickets
are used to find the place, never to set the scale.

**How it looks.** In order, each answer checked before it is believed:

1. *The whole crease pattern, both ends* (§9g's finder), when a high or long-lens camera shows it.
2. *The creases at the bowler's end*, looked for around the bowler's wicket (three equal upright bars of a wicket's
   proportions, near where the bowler's back foot lands) or, when the umpire hides the stumps, around the bowler's
   feet. Return creases are proposed from pairs of paint pixels, so they may lean as far as a low, close camera makes
   them. The camera from the four corners is then slid onto the paint of the four lines (a hundred or more points).
3. *The two wickets alone*, as a last resort and with a wide ±.

On a tripod the bowler is first taken out of the picture (the middle value of each pixel over seven frames, leaving
out the bowler's own box), so nothing hides a crease. The checks: paint found on every one of the four lines (nine
points of thirty-five at least, because each line fixes something the others cannot: without the bowling crease the
camera's distance drifted and the feet came out 13 cm down the pitch), the paint within 1.2 px of the camera's lines,
and the bowler a bowler under that camera (a person's height, a release at a bowler's height, feet by the crease).
When no single picture is sure, the answer is the one several frames agree on.

**Hands off, in Chrome, on real clips filmed from behind** (upload, wait, read the page; run on 2026-11-24 with the
changes of §9l in; the rendered deliveries, where the answers are known exactly, are in §9l):

| Clip | Pitch found by, in | Release height | Stride, m | Front heel behind the line, cm | Height read, m | Ball, km/h | Speed gun on screen, km/h |
|---|---|---|---|---|---|---|---|
| International delivery a (Afghanistan bowling) | creases, 14 s | 2.11 ± 7 cm | 1.61 | +8 ± 13 |  |  |  |
| International delivery b (Afghanistan bowling) | near creases, 14 s | 1.89 ± 6 cm | 1.44 | +12 ± 12 |  | 129 ± 5 |  |
| International delivery c (Afghanistan bowling) | near creases, 7 s | 2.06 ± 6 cm | 1.71 | +46 ± 13 | 1.84 | 148 ± 6 | 133.0 (+11.0%) |
| International delivery h (Afghanistan bowling) | near creases, 7 s | 2.15 ± 7 cm | 0.83 | +64 ± 13 | 1.85 | 80 ± 6 | 82.2 (-2.7%) |
| International delivery k (Afghanistan bowling) | creases, 16 s | 2.02 ± 6 cm | 0.96 | +30 ± 13 | 1.70 | 81 ± 2 | 80.9 (+0.6%) |
| Bumrah, broadcast, 30 fps (1.78 m) | creases, 9 s | 2.09 ± 6 cm | 1.41 | +20 ± 14 | 1.80 |  |  |
| International delivery e (New Zealand bowling) | creases, 4 s | 2.00 ± 7 cm | 1.71 | +7 ± 13 |  | 129 ± 7 |  |
| International delivery g (New Zealand bowling) | near creases, 14 s | 2.15 ± 6 cm | 1.39 | +31 ± 14 | 1.87 |  |  |
| International delivery j (New Zealand bowling) | creases, 7 s | 2.04 ± 6 cm | 0.91 | +73 ± 14 | 1.77 | 87 ± 3 | 91.6 (-5.3%) |
| International delivery k (New Zealand bowling) | creases, 7 s | 2.20 ± 9 cm |  |  | 1.91 |  |  |
| Shami, broadcast, 30 fps (1.73 m) | creases, 4 s | 1.87 ± 8 cm |  |  |  |  |  |
| Bundled rendered delivery, 60 fps (release 1.90 m, 128 km/h) | near creases, 5 s | 1.91 ± 4 cm | 1.45 | +68 ± 8 |  | 131 ± 4 |  |

Pitch found on 12 of 19 real clips filmed from behind. Not found (so nothing is measured, and the page says so): IPL net cut 9; IPL net cut 10 (after 4 s); County spinner from the stands (after 18 s); Net session, 60 fps (after 17 s); Bundled nets clip (artificial turf, no creases) (after 14 s); International delivery f (New Zealand bowling) (after 14 s); County seamer from the stands (after 14 s).

Against the broadcaster's speed gun on 4 balls: 4.9% out on average, 11.0% at worst.

Bumrah is 1.78 m: the app read 1.80 m off his run-up. It gives no height for Shami (1.73 m), whose run-up read
32 km/h through the broadcast zoom, faster than anyone runs in, so nothing that leans on it is given. The two
spinners (Afghanistan's k, New Zealand's j) show in every figure: strides of 0.91 to 0.96 m, balls of 82 and 87 km/h.
The speed gun column is read off the broadcast graphic in the clip's own last frames; nothing in the app sees it.

**The ball.** With the pitch found, the frames after the release are searched as in §9f and the track is kept only
when it is tight (six or more sightings within 2.5 px of the flight, the speed's own ± under 15%). The release
measured on the pitch a moment earlier is now where the flight is told to start, in place of a rule of thumb about
where bowlers let go. Against the rendered deliveries the speed is within 1.5% on average and 3.3% at worst, and the line it pitched on within 1.5 cm (§9l). On the real clips above a flight tight enough to keep was found on six broadcast deliveries and on the bundled rendered delivery (131 ± 4 km/h against a true 128). Four of the six show the broadcaster's speed gun in the clip's last frames, and the app is 4.9% from it on average (§9l). The measured flight is drawn in the same 3D scene as the bowler, and over the video
in the camera's own view.

**The release is the top of the hand's arc, not the hand in one frame.** The hand is the fastest thing in the
picture: about a metre between frames at 30 fps. The frame taken as the release can catch it anywhere within half a
frame of the moment, and on the broadcast clips (25 and 30 fps) that alone made the release height uncertain by 19 to
41 cm, and low on average. But the ball leaves going nearly level (about 6 degrees below level for a fast bowler's
good-length ball, about level for a spinner's), and a hand on the end of a turning arm is going level at the top of
its arc: so the ball leaves at the top, to within a centimetre of height for anything from a yorker to a bouncer.
The top does not depend on catching the moment. It is the bowling shoulder, plus the arm's length from shoulder to
ball (as long as the upper arm and forearm are ever seen through the delivery stride, checked against what a person
of the bowler's measured height has), along the line the arm is seen on, which from behind stays put as the arm
turns. An arm caught leaning towards the camera or away from it is first put where it is (the part of its length
that does not show says how far it leans). A test arm turning 70 degrees a frame, caught 28 degrees before the top
and 21 degrees after it, came out within 2.5 cm of the true top either way, where the frame itself had the hand
13 cm low. On the rendered deliveries thinned to every frame rate from 20 to 60 a second (59 cases, each at every phase), with the plane the hand is on known, the release height came out 3.4 cm from the truth on average and 8.0 at worst, where the hand as the release frame caught it was up to 8.7 cm out; §9l changed how the top is read (from the frames themselves, weighed against the arm's length) and what it is read from (the arm's joints before they are smoothed in time).

**What it cannot do.** With no crease lines to read at the bowler's end there is nothing of known size where the
measuring is done: the bundled nets clip (artificial turf, no paint) and two county clips filmed from the stands
(creases too faint at 720p) are reported as not measurable, each after 4 to 15 s of looking. The four taps on the
stumps are still offered for those.

**Where the time goes, and one thing that was not kept.** A 1.7 s clip at 60 fps (104 frames) takes 19 s of work on
the test laptop once the models are in the browser's store (49 s the first time, 30 of it fetching and starting the
models): 9.0 s finding people in every frame (6.9 of it the model itself), 6.3 s on the joints, 2.5 s on the 3D
estimate, 0.5 s on the rest; fetching the frames is 2.2 s of that. Running each crop and its mirror image through
the joints model as one batch cut the joints step to 4.8 s, but on the browser's graphics backend the joints came
out up to 8 px different from two separate runs (the same model on a CPU gives identical answers either way), and
one clip's back-foot contact moved three frames. It was taken out.

## 9l. The accuracy loop: every rule scored against truth before it is kept (2026-11-24)

§9k was written from a handful of runs. Since then the same checks have been made into a loop that takes seconds:
the models' raw output for every test clip is saved once from Chrome, and the rules that turn it into answers
(key moments, bowling arm, the bowler on the pitch, the ball) are replayed on it in Node against what is known to be
true. A change is kept only if the score says so. Three sets of truth:

- **Twelve rendered deliveries** with everything known exactly: a phone on a tall tripod (720p), a phone just behind
  the umpire (1080p), a tripod at chest height and a broadcast gantry with a zooming lens, at 25 to 120 frames a
  second, bowlers 1.65 to 1.95 m tall, balls of 110 to 140 km/h.
- **The seventeen synthetic clips** of §1.
- **Thirty-nine real clips**, 23 of them with the release frame, the arm and the camera side checked by eye (§9h).

**The test figure had to be fixed first.** Its planted feet slid along the ground, the front foot by half a metre
between landing and release, so "where the heel landed" had no true answer. Each foot of the delivery stride is now
held where it lands. Then it turned out to let go half a metre past its front foot. Three real bowlers filmed
side-on have the bowling shoulder 0.21, 0.01 and 0.02 of their height *behind* the front ankle with the arm
upright, and the hips 0.17 to 0.23 behind it; the figure now lands its front foot where its hip will be 0.25 m
behind it at release, and lets go at 1.09 to 1.10 times its height (elite bowlers: 1.13 ± 0.04). Nothing in the app
is tuned to the figure's arm length or to how far over its front foot it gets; those come from real people.

**A larger pose model was tested and not taken.** RTMPose-l at 384×288 (four to five times the work of the
RTMPose-m at 256×192 the app ships) was run on 281 frames of the rendered deliveries with the true joints known:
wrist 1.1 cm against 1.3 cm (median), ankle 1.9 against 3.1, heel 2.8 against 3.5. The pose model is not what
limits the measurements; the rules that use it were. The app keeps its model, and its speed.

**What the loop found and fixed** (before → after, against the rendered deliveries unless said):

| What was wrong | Why | Before → after |
|---|---|---|
| A 25 fps broadcast-style clip read as a left-armer, release 8 frames early | The scan had settled on the front arm's rise before the delivery, and the bowling arm's own up-and-over scored a little under the bar for moving the window: at 25 fps the fall after the top is three frames long. The window now moves to a clear up-and-over when its own stretch holds none | Wrong arm, −8 frames → right arm, 0 frames. No change on the 23 real clips checked by eye |
| Front heel 9 cm (up to 21) too near the camera, stride short by as much | The front foot was placed by its toes as well as its heel, and from above and behind the toes of a flat foot read 10 to 20 cm short. Only the back foot (which can be up on its toes) is read that way now | Front heel 8.8 → 3.7 cm; stride 10.2 → 5.0 cm (camera known exactly) |
| Release height 5 cm high whatever the frame rate | It was the shoulder plus an arm's length taken from the bowler's height: right for an average arm only. It is now read off the frames (the hand's height over the shoulder in three frames is A·cos of the turn, which gives the top with no arm length assumed) and weighed against the arm-length reading by how sure each is: at 50 fps and more the frames decide, at 25 fps the arm does unless a frame fell at the top | With the plane the hand is on known, 59 cases at 20 to 120 fps: 4.2 → 3.4 cm from the truth on average (worst 6.8 and 8.0); the hand as one frame caught it was up to 8.7 cm out. On a real 30 fps broadcast clip the frames alone would have put the top 10 cm higher than the arm's length allows, which is why the two are weighed |
| The release moment late by 14 ms at 120 fps, 9 ms at 60 | The joints are smoothed in time for everything else, and smoothing flattens and delays the top of a fast arm; one misread wrist near the top was smeared over its neighbours. The release is now measured from the elbow and wrist as each frame showed them, and a one-frame misreading of an arm joint is mended before smoothing (50 fps and above) | 14 → 3 ms at 120 fps; 8.6 → 4.6 ms (rms) at 50 to 60 fps. It also put right a 120 fps synthetic clip from behind that had been read as filmed from in front, 30 frames out |
| No ball found on a 60 fps phone clip | The frames before the release (the bowler running in, ball in hand) were linked into the same chains as the flight, and the twelve longest chains were all the run-up. Chains are now linked from the release on first; and a ball's chain and its shadow's are joined at the first and last places they meet as well as the closest | Not found → 132 km/h (128), length within 8 cm |
| Ball speed 9% high and the pitching spot 61 cm out on a 120 fps phone clip | From 10 m behind at 720p the far creases are a fifth of a pixel thick, and the far corners of the crease pattern were guesses. The batter's stumps are seen: their top (not their foot, which reads 3 to 17 px out among shadow and paint) now stands for the far end whenever the far creases are under half a pixel thick | 148 → 143 km/h (140); −61 → −15 cm |
| The ball "not found" on a busy or slow device | The search for a flight stopped after three seconds on the clock. A real flight is found in the first five to eight tries; the limit is now a number of tries, the same on a phone as on a laptop | Two clips lost under load → found |
| A spinner "measured" letting go at 1.48 m on a county-ground clip | Two wrong pairs of stump-like shapes in one frame agreed with each other. Answers from stumps alone must now agree across different frames, and on where the camera is | False measurement → correctly not measured |
| The ball not looked for on two of four broadcast clips with a speed gun reading, and 13.6% fast on a third | With the batter in front of his stumps the far end had nothing to fix it, and a camera worked out from the bowler's end alone is unsure how far away it stands: its four corners a pixel out move the far crease a metre (simulated: 65 to 120 cm). The far popping crease is now looked for where that camera expects it, a pale line with a batter and a keeper standing on part of it, and its height in the picture settles the distance | Far end 67 to 82 cm → 8 to 12 cm (rendered, corners nudged a pixel). The pace ball's pitching spot 8.98 → 9.20 m (9.22 when its creases were marked by hand), its speed 151 → 148 km/h against the gun's 133 |
| The pitch slow to find, or missed, on broadcast clips where the bowler and umpire stand on the creases | A camera that moves had no bowler-free picture. Its frames are now laid over the release frame by their measured zoom and shift, and the middle value of each pixel taken with the bowler's box left out, as on a tripod; that picture is used for the bowler's end | One gun-timed clip: found in 7 s where it took 13; the other clips unchanged |
| A fast bowler's ball never tried among a thousand moving things | The stretches of chain were tried longest first, sixty at most; a pace ball at 25 fps is eleven frames long. Those that begin at the bowling hand within a few frames of the release now go first | Balls kept on real broadcast clips: 2 → 6 |
| The bowler's height 10 to 15 cm short from a tripod at chest height close behind, and 4 cm tall on a broadcast clip | The head was read at the distance of the foot being left behind. The hips are a short step ahead of that foot and a running bowler's head a little ahead of the hips, a quarter of the bowler's height in all: from a close, low camera that makes the bowler smaller, from a high one taller. The head is now read where it is, and 2.5% allowed for a runner riding under standing height | Rendered deliveries: worst 14.6 → 6.4 cm, and the same few centimetres short from every camera (the figure runs in more crouched than a person). Bumrah, 1.78 m: 1.82 → 1.80 |
| Release height from the arm 4 to 14 cm high from a high camera | How far in front of the front foot the hand is cannot be seen from behind, and a high camera turns each 10 cm of that into 2 cm of height. Once the ball is tracked its own first sightings say more: the flight's start is now the release height shown | 6.4 → 3.8 cm on average; worst 13.8 → 6.2 |

**Where that leaves it, hands off in Chrome** (the twelve rendered deliveries; nothing marked, nothing entered):

| Camera, frame rate, bowler | Pitch found in | Release height, m (true) | Front heel, cm from true | Stride, m (true) | Ball, km/h (true) | Pitched: length / line, cm from true |
|---|---|---|---|---|---|---|
| Phone on a tall tripod, 720p, 60 fps, 1.80 m bowler | 3 s | 2.03 (1.99) | +2 | 1.61 (1.62) | 132 ± 4 (128) | +8 / +0 |
| Phone on a tall tripod, 720p, 30 fps, 1.65 m bowler | 3 s | 1.85 (1.80) | +7 | 1.57 (1.63) | 111 ± 4 (110) | +12 / +0 |
| Phone on a tall tripod, 720p, 120 fps, 1.95 m bowler | 4 s | 2.18 (2.16) | -7 | 1.83 (1.68) | 143 ± 5 (140) | -15 / -0 |
| Phone behind the umpire, 1080p, 60 fps, 1.80 m bowler | 5 s | 2.01 (1.99) | -3 | 1.68 (1.62) | 127 ± 4 (128) | +12 / -1 |
| Phone behind the umpire, 1080p, 30 fps, 1.70 m bowler | 4 s | 1.88 (1.85) | +4 | 1.65 (1.65) | 118 ± 4 (118) | +14 / -1 |
| Phone behind the umpire, 1080p, 60 fps, 1.90 m bowler | 5 s | 2.13 (2.09) | -1 | 1.68 (1.66) | 133 ± 4 (135) | +20 / +0 |
| Tripod at chest height, 1080p, 60 fps, 1.80 m bowler | 5 s | 2.02 (1.99) | +3 | 1.73 (1.62) | far end out of the picture: not looked for |  |
| Tripod at chest height, 1080p, 30 fps, 1.70 m bowler | 5 s | 1.89 (1.85) | +4 | 1.63 (1.65) | far end out of the picture: not looked for |  |
| Tripod at chest height, 1080p, 60 fps, 1.92 m bowler | 5 s | 2.15 (2.12) | +3 | 1.67 (1.67) | far end out of the picture: not looked for |  |
| Broadcast gantry, zooming, 50 fps, 1.80 m bowler | 6 s | 2.02 (1.98) | +10 | 1.56 (1.63) | 128 ± 3 (128) | +3 / +1 |
| Broadcast gantry, zooming, 25 fps, 1.90 m bowler | 5 s | 2.12 (2.06) | +8 | 1.82 (1.69) | 143 ± 5 (140) | +3 / +1 |
| Broadcast gantry, zooming, 30 fps, 1.75 m bowler | 5 s | 1.96 (1.91) | +12 | 1.59 (1.66) | 139 ± 4 (136) | +2 / +1 |

Pitch found on 12 of 12 in 3 to 6 s. Mean error (worst): release height 3.8 cm (6.1), from the arm alone 6.3 (13.5); front heel 5.3 cm (11.8); stride 5.9 cm (14.8); ball speed 1.5% (3.3) on 9 balls; pitching length 9.9 cm (20.0); line 0.7 cm (1.5).

**Against the speed gun.** Four of the international clips end on the broadcaster's speed graphic. Hands off, in
Chrome, with nothing marked: 81 ± 2 km/h against the gun's 80.9 (+0.6%), 80 ± 6 against 82.2 (−2.7%), 87 ± 3
against 91.6 (−5.3%), and for the one fast bowler 148 ± 6 against 133.0 (+11.0%): 4.9% out on average. When these
same clips had their creases marked by hand (§9f) the average was 6.9%. The pace ball is the hard one: at 25 frames
a second it is seen twelve times, and a release moment known to half a frame is 7% of its flight to the pitch. Its ±
was too small for that; the speed's range is now never tighter than the release moment allows (half a frame, or 6 ms
at high frame rates, against the time the ball was followed for), which makes it 147 ± 11 and leaves all four balls
within 1.5 of their own ranges. Spinners and clips at 50 fps and more are unchanged by it.

**What still limits it.** Three things, none of them the pose model. *How far in front of the front foot the ball
is let go* is not visible from behind: the app assumes the hand above the front ankle (what the three real side-on
bowlers show, give or take 20 cm), and a high camera turns each 10 cm of that into about 2 cm of release height and
0.6% of ball speed. *The release moment* is known to about 5 ms at 60 fps, which is 0.2 m of flight for a fast ball.
*The far end* from a phone at 720p is one pixel to 23 cm at the far crease. The stated ± on each figure carries
these; the truth sat inside the stated range for the speed on all nine balls.

**Speed.** The models now start loading the moment a clip is chosen (and on opening the app, once they are in the
browser's store), instead of when Analyse is pressed, so on a return visit the wait for them is no longer part of
the analysis: measured on the test laptop, the step that waited for the models took 28.5 s on a first visit and 0.2 s
on a return one, and the bundled 60 fps nets clip then takes 20 s (8.7 s of it the people-finding model, which
only accepts a square picture and so spends nearly half its work on padding; 4.7 s the joints; 2.1 s the 3D estimate). A faster scan was also built (people looked for in about thirty frames of each real second, the bowler placed in the frames between from the scanned ones either side) and scored the same way on 22 clips filmed at 50 frames a second and more. Side-on it changed nothing: the key moments were the same frame on ten clips and no measurement moved by more than 0.6. From behind it moved the key moments by a frame or two on six of seven rendered deliveries, turned one 120 fps synthetic clip into a front-on reading eleven frames out, and put the release of the real 100 fps net clip three frames outside what the eye sees. It stays off: about a fifth of the analysis time is not worth a wrong frame.

## 9m. The non-bowling arm when the body hides it (2026-11-24)

**What was measured.** The 12 rendered deliveries and 8 of the plain bench clips have an exact answer for every
joint in every frame, and for whether each joint is hidden behind another part of the body (the body's own surface
lies between the joint and the camera). The app's joints were scored against that, over the delivery, from just
before the back foot lands to the end of the follow-through. Tool: `frontend/_local/loop/armtruth.py` (truth) and
`armhid.test.ts` (score). There is no joint-by-joint truth for real video; real clips were checked by eye only.

**Before.** Non-bowling arm, error in cm at the bowler, typical / worst tenth of frames:

| | Seen | Hidden by the body |
|---|---|---|
| Elbow, from behind | 3.1 / 14.2 | 12.6 / 16.6 |
| Wrist, from behind | 1.6 / 4.4 | 4.8 / 16.3 |
| Elbow, side-on | 3.4 / 22.4 | 4.4 / 5.4 |
| Wrist, side-on | 1.0 / 64.1 | 10.5 / 25.0 |

The model says when it has lost a joint: a wrist it gives under 0.5 confidence is typically 15 to 70 cm out, one over
0.8 is 1 to 2 cm out. Side-on, in the follow-through, a lost wrist was put on the bowling arm's wrist. Nothing used
that confidence, and the overlay drew a lost arm like a seen one.

**What changed.** For the non-bowling arm only (the bowling arm and the release are read exactly as before):

- an elbow or wrist the model gives under 0.55 for a short stretch (up to 0.12 s) is not believed. It is carried in a
  straight line, relative to the shoulder, from where it was last seen to where it is next seen;
- a lost wrist that keeps landing on the other arm's wrist is held as last seen, however long the loss;
- the 3D figure's arm is fitted to the carried joints on those frames, not to the misreading;
- the overlay draws the arm dashed wherever it was carried or the model was unsure of it (under 0.55).

**After.** Same clips, same measure:

| | Hidden, before | Hidden, after |
|---|---|---|
| Wrist, from behind | 4.8 / 16.3 | 4.4 / 7.8 |
| Wrist, side-on | 10.5 / 25.0 | 10.6 / 19.4 |
| Wrist, side-on, seen again after a loss | 1.0 / 64.1 | 1.0 / 11.1 |
| Elbow, from behind | 12.6 / 16.6 | 12.6 / 16.6 (no change) |
| 3D elbow bend, from behind (degrees) | 60 / 124 | 44 / 130 |
| 3D forearm direction, side-on, seen again after a loss (degrees) | 8 / 98 | 8 / 47 |

Nothing else moved: on the 48-clip scorecard (events, release, feet, height, ball) the only numbers that changed are
the non-bowling wrist's.

**What was tried and not kept.**

- *Believing nothing under 0.75, for any length of time.* Best on the rendered clips (hidden wrist 16 → 7 cm from
  behind and 25 → 12 cm side-on). On real footage the model's confidence runs lower, and on two county clips this
  replaced good joints with a straight line for a third of a second or more: clearly worse by eye. The shipped rule
  touches 0 to 5 frames of a real delivery, never more than 0.13 s at a stretch.
- *Turning the arm about the shoulder across the loss* (rather than a straight line): right side-on, wrong from
  behind, where the arm's swing is seen edge-on and its picture is a straight line.
- *The elbow put half-way along a straight arm.* Helps the hidden frames, hurts the seen ones; applied only where the
  elbow sits impossibly along the line it changes almost nothing.
- *A depth rule* (a joint lost inside the trunk's outline is behind the trunk): no measurable effect.

**Still not right.**

- From behind the hidden elbow is 11 to 17 cm out and the model is confident of it, so nothing flags it. It sits
  about 12 cm low while the arm points at or away from the camera.
- The 3D arm from behind is poor even when seen (upper arm 24 degrees out, forearm 34): depth from one camera.
- All of this is measured on a plain rendered figure, where an arm and the trunk are the same colour. On real video
  the change is small and was judged by eye only; it has not been measured.

## 10. Still to do

- Telling an umpire's signal or a fielder from a bowler when the clip has no clear delivery near the camera (§9j), and the
  spinner whose bowling arm is a coin flip.
- On the pitch (§9i, §9l): a session at a marked-out pitch with a tape measure, and with a second camera side-on: how far in front of the front foot real bowlers let go is the largest thing the rendered deliveries cannot say.
- Lab validation against marker-based motion capture (real bodies, real knees): the synthetic body can't say whether
  the detector's knee placement on a bent knee differs on people.
- Two real phones on the same balls (a side-on and a behind-the-stumps phone through a net session): the pair
  features are measured on rendered pairs and on real clips of different balls, not yet on one real ball filmed twice.
- The bowler-finding step on broadcast footage (a batter's swing or an arm turn in the gather can win); and the
  camera's height, so heights and side-bend from a high broadcast camera can be corrected.
- A radar-gun session for ball speed.
- Spinners: a release rule for slower arms.
- Left/right label consistency in the browser's pose model at 60+ fps side-on, and front/back from behind (both seen
  mainly on the faceless mannequin). A view correction now repairs the labels (§5); the automatic reading still
  needs the face or the direction of travel to tell front from back.
