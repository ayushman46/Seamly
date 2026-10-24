import type { ReactNode } from "react";
import { MODE } from "../api";
import { Wordmark } from "./Brand";
import { REPO_URL } from "./Header";
import { IArrowRight, IChevronDown } from "./Icons";
import { COCO_EDGES } from "../lib/constants";

/* ------------------------------------------------------------------ hero */

/** The public site analyses in the browser; a self-hosted server build must not claim the video stays on the device. */
const LOCAL = MODE === "browser";

export function Hero({ onAnalyse, onDemo, demoBusy, demoError, disabled }: {
  onAnalyse: () => void; onDemo: () => void; demoBusy: boolean; demoError: string | null; disabled: boolean;
}) {
  return (
    <section className="landing-hero" aria-labelledby="hero-title">
      <div className="container hero-grid">
        <div className="hero-copy">
          <h1 className="hero-title" id="hero-title">Analyse your bowling action from one phone video.</h1>
          <p className="hero-sub">
            Key moments, joint angles, a 3D body and a practice plan in about a minute.{" "}
            {LOCAL ? "Free, and your video never leaves your phone." : "Free, on your own Seamly server."}
          </p>
          <div className="hero-ctas">
            <button type="button" className="btn primary lg" onClick={onAnalyse}>Analyse a delivery</button>
            <button type="button" className="btn ghost lg" onClick={onDemo} disabled={demoBusy || disabled}>
              {demoBusy ? <div className="spinner sm" /> : null} {demoBusy ? "Loading…" : "See an example"} {!demoBusy && <IArrowRight size={16} />}
            </button>
          </div>
          {demoError && <div className="notice error hero-error" role="alert">Couldn't open the example: {demoError}</div>}
          <p className="hero-facts">{LOCAL ? "Free · No sign-up · Private · Works offline" : "Free · No sign-up · Self-hosted"}</p>
        </div>
        <HeroShot />
      </div>
    </section>
  );
}

// the example's release frame (the club sample), its keypoints in the 960 × 720 crop, and what Seamly measured there
const SHOT_KP: [number, number, number][] = [[465, 119, 0.57], [530, 152, 0.05], [458, 114, 0.47], [411, 125, 0.31], [437, 136, 0.97],
  [361, 159, 1], [417, 222, 1], [341, 92, 0.98], [406, 329, 1], [346, 26, 0.93], [413, 419, 0.99], [301, 341, 1], [364, 365, 1],
  [236, 462, 1], [455, 476, 1], [161, 592, 0.99], [490, 603, 0.99]];
const SHOT_BOWL = new Set([5, 7, 9, 11, 13, 15]);   // a left-arm bowler: the bowling side is the left
const SHOT_FRONT = new Set([6, 8, 10, 12, 14, 16]);

/** A real analysis: the example clip at ball release with the skeleton and three of its measurements. */
export function HeroShot() {
  const P = (j: number) => SHOT_KP[j];
  const label = (x: number, y: number, text: string, color: string) => (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="-22" width={text.length * 11.2 + 22} height="34" rx="8" fill="rgba(11,11,12,0.82)" />
      <text x="11" y="1" fill={color} fontSize="19" fontWeight="600" fontFamily="Inter, system-ui, sans-serif">{text}</text>
    </g>
  );
  return (
    <figure className="hero-shot">
      <svg viewBox="0 0 960 720" role="img" aria-label="A club bowler at ball release with Seamly's skeleton overlay: front knee 157 degrees, trunk lean 19 degrees, release height 94% of height">
        <image href={`${import.meta.env.BASE_URL}hero-release.webp`} width="960" height="720" preserveAspectRatio="xMidYMid slice" />
        {COCO_EDGES.map(([a, b]) => {
          if (P(a)[2] < 0.2 || P(b)[2] < 0.2) return null;
          const c = SHOT_BOWL.has(a) && SHOT_BOWL.has(b) ? "#fb7185" : SHOT_FRONT.has(a) && SHOT_FRONT.has(b) ? "#34d399" : "rgba(244,244,245,0.85)";
          return <line key={`${a}-${b}`} x1={P(a)[0]} y1={P(a)[1]} x2={P(b)[0]} y2={P(b)[1]} stroke={c} strokeWidth="6" strokeLinecap="round" />;
        })}
        {SHOT_KP.map(([x, y, c], j) => (j >= 5 && c > 0.2 ? <circle key={j} cx={x} cy={y} r="6" fill="#fff" /> : null))}
        {label(372, 40, "Release height 94%", "#fda4af")}
        {label(436, 200, "Trunk lean 19°", "#e4e4e7")}
        {label(488, 486, "Front knee 157°", "#6ee7b7")}
      </svg>
      <figcaption>
        <span className="hero-shot-score"><b>72</b> Strong</span>
        <span className="hero-shot-next">Next: brace the front leg</span>
      </figcaption>
    </figure>
  );
}

function SectionHead({ title, lead, center = false, id }: { title: ReactNode; lead?: ReactNode; center?: boolean; id?: string }) {
  return (
    <div className={`section-head ${center ? "center" : ""}`}>
      <h2 className="section-title" id={id}>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </div>
  );
}

/* ---------------------------------------------------------- what you get */

export function WhatYouGet() {
  const items: { title: string; text: string }[] = [
    { title: "The moments that matter", text: "Back-foot contact, front-foot contact, release and follow-through, marked on your own clip." },
    { title: "Angles, measured honestly", text: "Front knee, trunk, stride and release height against published ranges. Only what your camera can really see." },
    { title: "One thing to fix", text: "A clear verdict, a cue for the nets and a two-week plan that keeps junior bowling loads safe." },
    { title: "Progress you can see", text: "A 3D body, two deliveries laid over each other, player progress and a bowling log that watches the workload." },
  ];
  return (
    <section className="section" id="features" aria-labelledby="features-title">
      <div className="container">
        <SectionHead id="features-title" title="What you get" />
        <ol className="wyg">
          {items.map((f, i) => (
            <li key={f.title}>
              <span className="wyg-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function CameraIcon({ x, y, rot = 0 }: { x: number; y: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x="-10" y="-15" width="20" height="30" rx="4" fill="#f7efdf" />
      <circle cx="0" cy="-8" r="3.2" fill="#0a0e18" />
    </g>
  );
}

function PitchBase() {
  return (
    <g>
      <rect x="70" y="92" width="260" height="36" rx="2" fill="#c2ae7e" opacity="0.5" />
      {[86, 314].map((x) => <path key={x} d={`M${x} 84 V136`} stroke="#f8fafc" strokeWidth="1.6" opacity="0.8" />)}
      {[104, 296].map((x) => <path key={x} d={`M${x} 80 V140`} stroke="#f8fafc" strokeWidth="1.6" opacity="0.8" />)}
      {[86, 314].map((x) => [104, 110, 116].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" fill="#f7efdf" />))}
      <text x="314" y="76" textAnchor="middle" fontSize="11" fontWeight="600" fill="#cbd5e1" opacity="0.85">Batter</text>
    </g>
  );
}

function SideOnDiagram() {
  return (
    <svg viewBox="4 58 344 162" role="img" aria-label="Top-down diagram: the camera stands level with the bowler's crease, 10 to 15 metres to the side of the pitch, pointing straight across it.">
      <PitchBase />
      <path d="M100 196 L40 70 L170 70 Z" fill="#3ddc97" opacity="0.1" />
      <path d="M100 196 L40 70 M100 196 L170 70" stroke="#3ddc97" strokeWidth="1.4" strokeDasharray="4 4" opacity="0.7" />
      <circle cx="98" cy="110" r="8" fill="#f43f5e" stroke="#fff" strokeWidth="2" />
      <path d="M58 110 H84" stroke="#f43f5e" strokeWidth="2" strokeLinecap="round" />
      <path d="M78 105 L86 110 L78 115" stroke="#f43f5e" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <text x="98" y="76" textAnchor="middle" fontSize="11" fontWeight="600" fill="#fecdd3">Bowler</text>
      <path d="M128 132 V184" stroke="#cbd5e1" strokeWidth="1.2" strokeDasharray="3 3" />
      <path d="M124 136 L128 130 L132 136 M124 180 L128 186 L132 180" stroke="#cbd5e1" strokeWidth="1.2" fill="none" />
      <text x="136" y="162" fontSize="12" fontWeight="700" fill="#f1f5f9">10–15 m</text>
      <CameraIcon x={100} y={200} />
      <text x="124" y="208" fontSize="11" fill="#cbd5e1">at hip height</text>
    </svg>
  );
}

function BehindDiagram() {
  return (
    <svg viewBox="4 58 344 162" role="img" aria-label="Top-down diagram: the camera stands behind the bowler's stumps, in line with the pitch, pointing down it towards the batter.">
      <PitchBase />
      <path d="M44 110 L214 54 L214 166 Z" fill="#3ddc97" opacity="0.1" />
      <path d="M44 110 L214 54 M44 110 L214 166" stroke="#3ddc97" strokeWidth="1.4" strokeDasharray="4 4" opacity="0.7" />
      <circle cx="98" cy="110" r="8" fill="#f43f5e" stroke="#fff" strokeWidth="2" />
      <text x="98" y="76" textAnchor="middle" fontSize="11" fontWeight="600" fill="#fecdd3">Bowler</text>
      <CameraIcon x={40} y={110} rot={90} />
      <text x="44" y="150" textAnchor="middle" fontSize="11" fill="#cbd5e1">in line with</text>
      <text x="44" y="164" textAnchor="middle" fontSize="11" fill="#cbd5e1">the stumps</text>
    </svg>
  );
}

export function FilmingGuide() {
  return (
    <section className="section" id="filming" aria-labelledby="filming-title">
      <div className="container">
        <SectionHead id="filming-title" title="How to film" lead="Where you stand decides what Seamly can measure. Film the same way each time so sessions compare fairly." />
        <div className="film-grid">
          <article className="card film-card">
            <div className="film-diagram"><SideOnDiagram /></div>
            <div className="film-body">
              <h3>Side-on <span className="faint" style={{ fontWeight: 500 }}>· recommended</span></h3>
              <p>Level with the bowling crease, 10–15 m from the pitch, phone at hip height. Measures front knee, trunk, stride, timings and release height.</p>
            </div>
          </article>
          <article className="card film-card">
            <div className="film-diagram"><BehindDiagram /></div>
            <div className="film-body">
              <h3>From behind the stumps</h3>
              <p>In line with the stumps, looking down the pitch. Measures side-bend, hip–shoulder alignment and the back-health check.</p>
            </div>
          </article>
        </div>
        <ul className="film-rules">
          <li>Keep the phone still</li>
          <li>Whole action in frame, feet visible</li>
          <li>Slow motion if your phone has it</li>
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ FAQ */

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "How accurate is it?",
    a: (
      <>
        <p>It's an estimate from a single video, not a lab measurement. On a rendered delivery where every angle is known exactly, Seamly
          found the key moments within one frame and the angles within 4°, from the side and from behind. Real clips that are blurry,
          zoomed, distant or low-frame-rate are less precise: a single camera can't see everything a multi-camera lab can.</p>
        <p>Seamly is upfront about this: every metric shows a confidence, angles your camera view can't see are left out rather than guessed,
          and foot contacts that are hard to see are flagged for you to check. Use the numbers to guide practice, and compare clips filmed the same way.</p>
      </>
    ),
  },
  {
    q: "Is this an ICC bowling-action (legality) test?",
    a: <p>No. Testing elbow extension against the ICC's 15° limit needs a multi-camera lab. Seamly shows elbow extension from side-on slow-motion clips for reference only: it is never rated, scored or used as a verdict.</p>,
  },
  {
    q: "Is the back-health check medical advice?",
    a: <p>No. It screens for technique patterns that research links to lower-back stress in young fast bowlers. It's a prompt to talk to a coach or physio, not a diagnosis. If a bowler has back pain, they should see a medical professional.</p>,
  },
  {
    q: "Where are my videos and results stored?",
    a: LOCAL
      ? <p>In this browser, on this device. Nothing is uploaded and there's no account. That also means clearing your browser data deletes your analyses and players, and they won't appear on your other devices — use "Download backup" in your workspace to keep a copy or move them to a new phone.</p>
      : <p>On the Seamly server this page is connected to. Nothing is sent anywhere else, and there's no account.</p>,
  },
  {
    q: "Does it need an internet connection?",
    a: LOCAL
      ? <p>Only the first time. Open Seamly and analyse one clip while you're online (that downloads the analysis models, about 70 MB), and after that it works with no signal: at the nets, film, analyse and review right there. A recent phone or laptop works best; older devices can take noticeably longer.</p>
      : <p>Yes, to reach the Seamly server this page is connected to.</p>,
  },
  {
    q: "What do I need to film with?",
    a: <p>Any modern phone. Slow motion (120 or 240 fps) gives the most precise timings, but normal video works too. Clips with fewer than about 20 distinct frames per second can't be analysed reliably.</p>,
  },
  {
    q: "Who is it for?",
    a: <p>Amateur and junior seam and pace bowlers, and the coaches and parents who help them. Spinners can use it, but the reference ranges come from pace-bowling research, so treat them with care.</p>,
  },
  {
    q: "Does it cost anything?",
    a: <p>No. Seamly is free and open source, with no ads and no account. <a href={REPO_URL} target="_blank" rel="noreferrer">The code is on GitHub</a>.</p>,
  },
];

export function Faq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="container">
        <SectionHead id="faq-title" title="Questions" />
        <div className="faq">
          {FAQS.map((f) => (
            <details key={f.q}>
              <summary>{f.q}<IChevronDown size={18} /></summary>
              <div className="faq-body">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- footer */

export const DISCLAIMER = "Seamly gives estimates from a single video for coaching and practice. It isn't a medical assessment or an ICC bowling-action test.";

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <footer className="mini-footer">
        <span>Seamly · estimates from a single video, not a medical or ICC test.</span>
        <span><a href={REPO_URL} target="_blank" rel="noreferrer">Open source on GitHub</a></span>
      </footer>
    );
  }
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-row">
          <Wordmark size={26} />
          <span className="faint">{LOCAL ? "Free · Private · Runs in your browser" : "Free · Self-hosted"}</span>
          <div className="grow" />
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">Report a problem</a>
        </div>
        <p className="footer-credits">
          {DISCLAIMER} Pose: <a href="https://github.com/ultralytics/ultralytics" target="_blank" rel="noreferrer">YOLO11</a> (AGPL-3.0).
          3D: <a href="https://github.com/Walter0807/MotionBERT" target="_blank" rel="noreferrer">MotionBERT</a> and <a href="https://github.com/naver/anny" target="_blank" rel="noreferrer">Anny</a> (NAVER LABS Europe).
          Example clip: “Epping Foresters CC v Great Totham CC” by Acabashi, <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>,
          via <a href="https://commons.wikimedia.org/wiki/File:Epping_Foresters_CC_v_Great_Totham_CC_at_Epping,_Essex,_England_Video_1.webm" target="_blank" rel="noreferrer">Wikimedia Commons</a>.
        </p>
      </div>
    </footer>
  );
}
