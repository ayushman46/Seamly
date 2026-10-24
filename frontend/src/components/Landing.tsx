import type { ReactNode } from "react";
import { MODE } from "../api";
import { LogoMark, Wordmark } from "./Brand";
import { REPO_URL } from "./Header";
import {
  IAngle, ICalendar, IChat, ICheck, IChevronDown, IColumns, ICube, IFile, IFilm, IFrame, IGithub, ILock, IPhone,
  IShield, ISun, ITrend, ITripod, IUsers, IVideo, ICpu, IArrowRight, IPlay, IWifiOff,
} from "./Icons";

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
          <span className="hero-badge"><b>Free</b> No account · {LOCAL ? "runs in your browser" : "self-hosted"}</span>
          <h1 className="hero-title" id="hero-title">Your pocket <span className="hl">bowling coach.</span></h1>
          <p className="hero-sub">
            Film one delivery on your phone. Seamly marks the key moments of your action on your own video, measures your angles against
            published research, and gives you a plain-English summary and a two-week practice plan &mdash; {LOCAL ? "without your video ever leaving your device." : "all on your own Seamly server."}
          </p>
          <div className="hero-ctas">
            <button type="button" className="btn primary lg" onClick={onAnalyse}><IVideo size={18} /> Analyse a delivery</button>
            <button type="button" className="btn outline lg" onClick={onDemo} disabled={demoBusy || disabled}>
              {demoBusy ? <div className="spinner sm" /> : <IPlay size={15} />} {demoBusy ? "Loading the sample…" : "See a sample analysis"}
            </button>
          </div>
          {demoError && <div className="notice error hero-error" role="alert">Couldn't start the sample analysis: {demoError}</div>}
          <ul className="hero-trust">
            <li><ILock size={15} /> {LOCAL ? "Your video stays on your device" : "Your video stays on your server"}</li>
            <li><ICheck size={15} /> No sign-up</li>
            {LOCAL && <li><IWifiOff size={15} /> Works offline</li>}
            <li><IGithub size={14} /> Open source</li>
          </ul>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

const J = {
  head: [358, 100], bs: [334, 128], be: [338, 84], bw: [342, 42], fs: [350, 134], fe: [382, 160], fw: [370, 196],
  bh: [294, 210], fh: [306, 214], fk: [346, 272], fa: [396, 326], ft: [422, 330], bk: [252, 262], ba: [212, 312], bt: [192, 326],
  hc: [300, 212], sc: [342, 131],
} as const;
type JK = keyof typeof J;
const seg = (a: JK, b: JK) => `M${J[a][0]} ${J[a][1]}L${J[b][0]} ${J[b][1]}`;
const TL = { x: 32, w: 536 };
const tx = (p: number) => TL.x + TL.w * p;
const FLAGS: [string, number, string][] = [["BFC", 0.3, "#f59e0b"], ["FFC", 0.47, "#22c55e"], ["REL", 0.56, "#f43f5e"], ["FT", 0.74, "#38bdf8"]];

/** An illustrated analysis: a side-on bowler at release with the overlays Seamly draws on your clip. */
export function HeroVisual() {
  const bowling: [JK, JK][] = [["bs", "be"], ["be", "bw"]];
  const front: [JK, JK][] = [["fs", "fe"], ["fe", "fw"], ["fh", "fk"], ["fk", "fa"], ["fa", "ft"]];
  const body: [JK, JK][] = [["bs", "fs"], ["bh", "fh"], ["bs", "bh"], ["fs", "fh"], ["bh", "bk"], ["bk", "ba"], ["ba", "bt"]];
  const limbs: [JK, JK, number][] = [["bh", "bk", 19], ["bk", "ba", 15], ["ba", "bt", 10], ["fh", "fk", 19], ["fk", "fa", 15], ["fa", "ft", 10],
    ["bs", "be", 14], ["be", "bw", 12], ["fs", "fe", 14], ["fe", "fw", 12]];
  return (
    <figure className="hero-visual">
      <div className="hv-frame">
        <svg viewBox="0 0 600 440" role="img" aria-labelledby="hv-title">
          <title id="hv-title">Illustration of a Seamly analysis: a bowler at ball release with the front-knee angle, trunk lean and wrist path drawn over the video, and the key moments marked on a timeline.</title>
          <defs>
            <linearGradient id="hv-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0a1426" /><stop offset="0.6" stopColor="#11253b" /><stop offset="1" stopColor="#14304a" />
            </linearGradient>
            <linearGradient id="hv-field" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#13402c" /><stop offset="1" stopColor="#0a2318" />
            </linearGradient>
            <radialGradient id="hv-glow" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#fff7df" stopOpacity="0.5" /><stop offset="1" stopColor="#fff7df" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="hv-trail" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#f43f5e" stopOpacity="0" /><stop offset="1" stopColor="#f43f5e" stopOpacity="0.95" />
            </linearGradient>
            <radialGradient id="hv-ball" cx="0.35" cy="0.3" r="0.8">
              <stop offset="0" stopColor="#ff7a6e" /><stop offset="0.55" stopColor="#dc2f3c" /><stop offset="1" stopColor="#7c0f1e" />
            </radialGradient>
          </defs>
          <rect width="600" height="440" fill="url(#hv-sky)" />
          <circle cx="70" cy="-10" r="150" fill="url(#hv-glow)" opacity="0.35" />
          <circle cx="560" cy="0" r="120" fill="url(#hv-glow)" opacity="0.25" />
          <path d="M0 252 Q40 238 80 246 T160 242 T250 248 T340 240 T430 247 T520 239 T600 246 V262 H0Z" fill="#0b1626" />
          <rect x="48" y="196" width="92" height="56" rx="3" fill="#dfe7ef" opacity="0.06" />
          <rect y="258" width="600" height="182" fill="url(#hv-field)" />
          {[0, 1, 2, 3].map((i) => <rect key={i} y={262 + i * 26} width="600" height="13" fill="#fff" opacity="0.018" />)}
          <rect y="298" width="600" height="46" fill="#9a8860" opacity="0.38" />
          <path d="M414 298 L408 344" stroke="#f1f5f9" strokeWidth="2.5" opacity="0.7" />
          {/* body (a bowler in whites) */}
          <g stroke="#e9e2d0" strokeLinecap="round" opacity="0.2" fill="none">
            <path d={seg("hc", "sc")} strokeWidth="40" />
            {limbs.map(([a, b, w]) => <path key={`${a}${b}`} d={seg(a, b)} strokeWidth={w} />)}
          </g>
          <circle cx={J.head[0]} cy={J.head[1]} r="15" fill="#e9e2d0" opacity="0.2" />
          {/* wrist path */}
          <path d="M246 232 C206 160 252 52 342 42" fill="none" stroke="url(#hv-trail)" strokeWidth="6" strokeLinecap="round" />
          {/* trunk lean */}
          <path d={`M${J.hc[0]} ${J.hc[1]} L${J.hc[0]} 122`} stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="6 6" />
          <path d="M300 168 A44 44 0 0 1 320.3 172.9" fill="none" stroke="#38bdf8" strokeWidth="2.5" />
          <path d={seg("hc", "sc")} stroke="#38bdf8" strokeWidth="4" strokeLinecap="round" />
          {/* skeleton */}
          <g strokeLinecap="round" strokeWidth="4.5" fill="none">
            {body.map(([a, b]) => <path key={`${a}${b}`} d={seg(a, b)} stroke="#e2e8f0" strokeOpacity="0.85" />)}
            {front.map(([a, b]) => <path key={`${a}${b}`} d={seg(a, b)} stroke="#34d399" />)}
            {bowling.map(([a, b]) => <path key={`${a}${b}`} d={seg(a, b)} stroke="#fb7185" />)}
          </g>
          {(["bs", "be", "bw", "fs", "fe", "fw", "bh", "fh", "fk", "fa", "bk", "ba"] as JK[]).map((k) => (
            <circle key={k} cx={J[k][0]} cy={J[k][1]} r="4.5" fill="#fff" />
          ))}
          {/* front knee angle */}
          <path d="M362.3 289.6 A24 24 0 0 0 332.4 252.2" fill="none" stroke="#34d399" strokeWidth="3" />
          {/* the ball */}
          <g transform="translate(345 31)">
            <circle r="9" fill="url(#hv-ball)" />
            <path d="M-3 -8.4 C-7 -2 6 2 2.6 8.6" stroke="#fbefd8" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </g>
          {/* labels */}
          <g fontFamily="Inter, system-ui, sans-serif" fontWeight="600" fontSize="13">
            <rect x="372" y="232" width="126" height="27" rx="7" fill="#05080d" opacity="0.82" />
            <text x="435" y="250" textAnchor="middle" fill="#6ee7b7">Front knee 171°</text>
            <rect x="182" y="117" width="112" height="27" rx="7" fill="#05080d" opacity="0.82" />
            <text x="238" y="135" textAnchor="middle" fill="#7dd3fc">Trunk lean 27°</text>
            <rect x="16" y="16" width="96" height="28" rx="14" fill="#05080d" opacity="0.78" stroke="#fff" strokeOpacity="0.55" />
            <circle cx="33" cy="30" r="4.5" fill="#f43f5e" />
            <text x="44" y="34.5" fill="#fff" fontSize="12.5" fontWeight="700">Release</text>
          </g>
          {/* timeline */}
          <rect y="360" width="600" height="80" fill="#060910" opacity="0.88" />
          <rect y="360" width="600" height="1" fill="#fff" opacity="0.07" />
          <rect x={TL.x} y="402" width={TL.w} height="6" rx="3" fill="#263147" />
          <rect x={tx(0.3)} y="400" width={tx(0.47) - tx(0.3)} height="10" rx="3" fill="#f59e0b" opacity="0.35" />
          <rect x={tx(0.47)} y="400" width={tx(0.56) - tx(0.47)} height="10" rx="3" fill="#22c55e" opacity="0.35" />
          <rect x={tx(0.56)} y="400" width={tx(0.74) - tx(0.56)} height="10" rx="3" fill="#38bdf8" opacity="0.35" />
          <rect x={TL.x} y="402" width={tx(0.56) - TL.x} height="6" rx="3" fill="#3ddc97" opacity="0.5" />
          {FLAGS.map(([l, p, c]) => (
            <g key={l}>
              <rect x={tx(p) - 1} y="389" width="2" height="19" fill={c} />
              <rect x={tx(p) - 17} y="374" width="34" height="16" rx="4" fill={c} />
              <text x={tx(p)} y="385.5" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9.5" fontWeight="800" fill="#0b0f17">{l}</text>
            </g>
          ))}
          <rect x={tx(0.56) - 2} y="393" width="4" height="24" rx="2" fill="#fff" />
          <text x={TL.x} y="430" fontFamily="ui-monospace, Menlo, monospace" fontSize="11" fill="#8290a6">f 61 · 0.000 s</text>
          <text x={TL.x + TL.w} y="430" textAnchor="end" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8290a6">Drag a flag to correct it</text>
        </svg>
      </div>
      <div className="hv-extras" aria-hidden="true">
        <div className="hv-card hv-score">
          <div className="ring-sm">
            <svg width="52" height="52" viewBox="0 0 52 52" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="26" cy="26" r="21" stroke="#263147" strokeWidth="6" fill="none" />
              <circle cx="26" cy="26" r="21" stroke="#4ade80" strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 21 * 0.82} 200`} />
            </svg>
            <b>82</b>
          </div>
          <div><small>Action score</small><strong>2 things to work on</strong></div>
        </div>
        <div className="hv-card hv-fix">
          <div className="lbl"><span className="fix-n" style={{ width: 18, height: 18, fontSize: 10 }}>1</span> Work on first</div>
          <b>Get taller at the crease</b>
          <div className="cue">“Tall at the crease — arm brushes the ear.”</div>
        </div>
      </div>
    </figure>
  );
}

/* ---------------------------------------------------------------- shared */

function SectionHead({ eyebrow, title, lead, center = false, id }: { eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean; id?: string }) {
  return (
    <div className={`section-head ${center ? "center" : ""}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="section-title" id={id}>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </div>
  );
}

/* ---------------------------------------------------------- how it works */

export function HowItWorks() {
  const steps: { icon: ReactNode; title: string; text: string }[] = [
    { icon: <IPhone size={22} />, title: "Film one delivery", text: "Prop your phone side-on, 10–15 m away at hip height, and record a single delivery — in slow motion if your phone has it." },
    { icon: <ICpu size={22} />, title: "Let Seamly analyse it", text: `Choose the clip. Seamly finds the bowler, tracks every joint and rebuilds the action in 3D${LOCAL ? ", right here in your browser" : ""}.` },
    { icon: <ITrend size={22} />, title: "Practise, re-film, improve", text: "Get the key moments, your angles and what they mean, a back-health check and a two-week plan. Re-film and watch the progress." },
  ];
  return (
    <section className="section" id="how" aria-labelledby="how-title">
      <div className="container">
        <SectionHead eyebrow="How it works" id="how-title" title="From phone clip to practice plan in three steps" />
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className="card step">
              <div className="step-top"><span className="step-icon">{s.icon}</span><span className="step-num" aria-hidden="true">0{i + 1}</span></div>
              <h3><span className="sr-only">Step {i + 1}: </span>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- features */

export function Features() {
  const items: { icon: ReactNode; title: string; text: string }[] = [
    { icon: <IFilm size={20} />, title: "Key moments on your video", text: "Back-foot contact, front-foot contact, release and follow-through are found automatically and marked on your own clip. If one is a frame out, drag it — every number updates." },
    { icon: <IAngle size={20} />, title: "Angles against published norms", text: "Front knee, trunk lean, side-bend, stride, timings and more, each compared with ranges from peer-reviewed biomechanics research. Angles your camera view can't see are left out, not guessed." },
    { icon: <ICube size={20} />, title: "A 3D body model", text: "Your action rebuilt as a 3D body you can orbit from side-on, behind or the batter's view. It's an estimate from one camera, so it sits next to your video rather than replacing it." },
    { icon: <IChat size={20} />, title: "A plain-English summary", text: "What's working, the one or two things to fix first and why, and a short cue to take into the nets. No jargon you need a sports-science degree for." },
    { icon: <IShield size={20} />, title: "Back-health check", text: "Screens for action patterns that research links to lower-back stress in young fast bowlers, such as a big side-bend. A prompt to talk to a coach — not a diagnosis." },
    { icon: <ICalendar size={20} />, title: "Two-week practice plan", text: "Drills for your top fix, strength days and a re-test, with bowling loads kept within Cricket Australia's junior workload guidelines for the player's age." },
    { icon: <IUsers size={20} />, title: "Player profiles & progress", text: "Keep a profile for yourself, your child or each bowler you coach. See scores and key angles session by session, personal bests and what changed since last time." },
    { icon: <IColumns size={20} />, title: "Side-by-side compare", text: "Put two deliveries next to each other at the same moment of the action, with a metric-by-metric table of what changed between them." },
    { icon: <IFile size={20} />, title: "Share, report & export", text: "Send a one-image summary to a coach or parent, or print a one-page coaching report as a PDF. Export the joint angles (CSV), the full analysis (JSON) or a 3D frame (OBJ), or back everything up in one file." },
  ];
  return (
    <section className="section alt" id="features" aria-labelledby="features-title">
      <div className="container">
        <SectionHead eyebrow="What you get" id="features-title" title="An honest look at your action, not a magic number"
          lead="Every result says how it was measured and how sure Seamly is about it. Where one phone camera can't tell, it says so." />
        <div className="features">
          {items.map((f) => (
            <article key={f.title} className="card feature-card">
              <span className="feature-icon">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- privacy */

export function Privacy() {
  return (
    <section className="section" id="privacy" aria-labelledby="privacy-title">
      <div className="container">
        <div className="privacy-band">
          <div>
            <div className="privacy-lock"><ILock size={28} /></div>
            <span className="eyebrow">Privacy by design</span>
            <h2 className="section-title" id="privacy-title">{LOCAL ? "Runs in your browser. Your video never leaves your device." : "Self-hosted. Your video stays on your own server."}</h2>
            <p className="section-lead">
              {LOCAL
                ? "Seamly does all the work on your own phone or computer — finding the bowler, tracking joints, rebuilding the action in 3D and doing the maths. Nothing is uploaded, and there's no account to create."
                : "This copy of Seamly runs on a server you control. Clips go to that server only — never to a third party — and there's no account to create."}
            </p>
          </div>
          <ul className="privacy-points">
            {LOCAL
              ? <li><span className="pi"><IVideo size={18} /></span><div><b>No upload</b><span>Your clip is read straight from your device by your browser. It isn't sent to a server — ours or anyone's.</span></div></li>
              : <li><span className="pi"><IVideo size={18} /></span><div><b>Your server only</b><span>Clips are processed by your own Seamly server and nowhere else.</span></div></li>}
            <li><span className="pi"><IUsers size={18} /></span><div><b>No account</b><span>No email, no password, no sign-up. Just open the page and analyse.</span></div></li>
            {LOCAL
              ? <li><span className="pi"><IPhone size={18} /></span><div><b>Saved on this device</b><span>Analyses and player profiles are kept in this browser only. Clearing your browser data removes them, so download a backup to keep a copy or move to a new phone.</span></div></li>
              : <li><span className="pi"><IPhone size={18} /></span><div><b>Saved on your server</b><span>Analyses and player profiles are kept by your Seamly server, so every device that uses it sees them.</span></div></li>}
            <li><span className="pi"><IGithub size={17} /></span><div><b>Open source</b><span>Don't take our word for it — <a href={REPO_URL} target="_blank" rel="noreferrer">read the code on GitHub</a>.</span></div></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------- filming guide */

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
  const tips: { icon: ReactNode; title: string; text: string }[] = [
    { icon: <IPlay size={16} />, title: "Slow motion if you can", text: "120–240 fps makes release and contact timings far more precise than normal 30 fps video. Tell Seamly the clip speed when you add it." },
    { icon: <IFrame size={18} />, title: "Whole action in frame", text: "From the last strides of the run-up to the follow-through, feet visible, with the bowler at least a third of the frame height." },
    { icon: <ITripod size={18} />, title: "Keep the phone still", text: "Use a tripod or prop the phone against something. Don't pan to follow the bowler and don't use digital zoom." },
    { icon: <ISun size={18} />, title: "Good light, one ball", text: `Bright light means less motion blur. One delivery per clip works best — trim long videos to under ${LOCAL ? "a minute" : "two minutes"}.` },
  ];
  return (
    <section className="section alt" id="filming" aria-labelledby="filming-title">
      <div className="container">
        <SectionHead eyebrow="Filming guide" id="filming-title" title="A good clip makes a good analysis"
          lead="Seamly reads angles off your video, so where you stand matters. Pick one of these two spots and film the same way each time, so sessions compare fairly." />
        <div className="film-grid">
          <article className="card film-card">
            <div className="film-diagram"><SideOnDiagram /></div>
            <div className="film-body">
              <span className="chip accent">Recommended</span>
              <h3>Side-on</h3>
              <p>Stand level with the bowling crease, 10–15 m from the pitch, with the phone at hip height and pointing straight across.</p>
              <div className="film-best"><span className="chip">Front knee</span><span className="chip">Trunk lean</span><span className="chip">Stride</span><span className="chip">Timings</span><span className="chip">Release height</span></div>
            </div>
          </article>
          <article className="card film-card">
            <div className="film-diagram"><BehindDiagram /></div>
            <div className="film-body">
              <span className="chip">Also works</span>
              <h3>From behind the stumps</h3>
              <p>Stand behind the bowler's end, in line with the stumps, looking down the pitch towards the batter.</p>
              <div className="film-best"><span className="chip">Side-bend</span><span className="chip">Shoulder &amp; hip alignment</span><span className="chip">Back-health check</span></div>
            </div>
          </article>
        </div>
        <div className="film-tips">
          {tips.map((t) => (
            <div key={t.title} className="card tip">
              <span className="tip-icon">{t.icon}</span>
              <b>{t.title}</b>
              <span>{t.text}</span>
            </div>
          ))}
        </div>
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
        <p>It's an estimate from a single video, not a lab measurement. Even on a clear, steady side-on clip, expect angles to be out by several
          degrees — and by more on blurry, zoomed, distant or low-frame-rate clips. A single camera simply can't see everything a multi-camera lab can.</p>
        <p>Seamly is upfront about this: every metric shows a confidence, angles your camera view can't see are left out rather than guessed,
          and foot contacts that are hard to see are flagged for you to check. Use the numbers to guide practice, and compare clips filmed the same way.</p>
      </>
    ),
  },
  {
    q: "Is this an ICC bowling-action (legality) test?",
    a: <p>No. Testing elbow extension against the ICC's 15° limit needs a multi-camera lab. Seamly shows elbow bend as a coaching guide only and never gives a legality verdict.</p>,
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
        <SectionHead center eyebrow="FAQ" id="faq-title" title="Straight answers" />
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

export function CtaBand({ onAnalyse, onDemo, demoBusy, disabled }: { onAnalyse: () => void; onDemo: () => void; demoBusy: boolean; disabled: boolean }) {
  return (
    <section className="section" style={{ paddingTop: 0 }} aria-labelledby="cta-title">
      <div className="container">
        <div className="cta-band">
          <LogoMark size={44} />
          <h2 className="section-title" id="cta-title" style={{ marginTop: 18 }}>Ready to see your action?</h2>
          <p className="section-lead" style={{ maxWidth: 520, margin: "0 auto" }}>One delivery is all it takes. Free, private{LOCAL ? " and done in your browser" : ""}.</p>
          <div className="hero-ctas">
            <button type="button" className="btn primary lg" onClick={onAnalyse}>Analyse a delivery <IArrowRight size={17} /></button>
            <button type="button" className="btn outline lg" onClick={onDemo} disabled={demoBusy || disabled}>{demoBusy ? <div className="spinner sm" /> : <IPlay size={15} />} See a sample analysis</button>
          </div>
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
        <div className="footer-grid">
          <div className="footer-col">
            <Wordmark size={32} tagline />
            <p className="footer-about">Free video analysis for amateur and junior bowlers, their coaches and parents.{LOCAL ? " Runs entirely in your browser." : ""}</p>
            <a className="btn outline sm" href={REPO_URL} target="_blank" rel="noreferrer"><IGithub size={15} /> Open source on GitHub</a>
          </div>
          <div className="footer-col">
            <h4>Seamly</h4>
            <ul>
              <li>Free, no account</li>
              <li>{LOCAL ? "Your video stays on your device" : "Self-hosted"}</li>
              <li><a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">Report a problem</a></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Credits</h4>
            <ul>
              <li>Person detection &amp; pose: <a href="https://github.com/ultralytics/ultralytics" target="_blank" rel="noreferrer">YOLO11</a> by Ultralytics (AGPL-3.0)</li>
              <li>3D pose lifting: <a href="https://github.com/Walter0807/MotionBERT" target="_blank" rel="noreferrer">MotionBERT</a></li>
              <li>Body model: <a href="https://github.com/naver/anny" target="_blank" rel="noreferrer">Anny</a> by NAVER LABS Europe</li>
              <li>Sample clip: “Epping Foresters CC v Great Totham CC” by Acabashi, <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>, via <a href="https://commons.wikimedia.org/wiki/File:Epping_Foresters_CC_v_Great_Totham_CC_at_Epping,_Essex,_England_Video_1.webm" target="_blank" rel="noreferrer">Wikimedia Commons</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>{DISCLAIMER}</span>
          <span>Made for club cricket.</span>
        </div>
      </div>
    </footer>
  );
}
