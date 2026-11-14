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
- It needs both ends' markings (or stumps) in shot on one frame, and a ball that stands out for at least seven frames. A white ball on a pale pitch under cloud, nets with no creases, or a side-on camera will not track.
- A track that pitches at the bat (a half-volley) has nothing on the ground to fix its distance: the speed is shown as rough or not at all.
- The pose analysis can pick the wrong arm or moment on broadcast clips (two of five here). The tracker checks the flight against the release and falls back to the ball itself, but a speed needs the release frame: step to it and set it.
- "Hitting the stumps" is where the fitted flight goes, as if nothing were in the way, with the bounce's kept speed leaning on a prior when few frames follow the bounce.
- Finding the ball takes 4 to 20 seconds (longer for full HD at 60 fps).

## 10. Still to do

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
