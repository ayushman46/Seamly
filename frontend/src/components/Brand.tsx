import { useId } from "react";

/** The Seamly mark: a red cricket ball whose seam is drawn as an "S". */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const g = `seamly-ball-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}
      aria-label={title} className="logo-mark" focusable="false">
      <defs>
        <radialGradient id={g} cx="34%" cy="28%" r="78%">
          <stop offset="0" stopColor="#ff7a6e" />
          <stop offset="0.5" stopColor="#dc2f3c" />
          <stop offset="1" stopColor="#7c0f1e" />
        </radialGradient>
        <clipPath id={`${g}-c`}><circle cx="16" cy="16" r="15" /></clipPath>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${g})`} />
      <g clipPath={`url(#${g}-c)`}>
      <path d="M12.6 1.9C5.8 11 26.2 20.6 19.4 30.1" fill="none" stroke="#fbefd8" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.4 3.3C3.4 12.4 22.6 20.8 15.6 30.6" fill="none" stroke="#fbefd8" strokeOpacity="0.55" strokeWidth="1.2"
        strokeLinecap="round" strokeDasharray="0.1 2.3" />
      <path d="M16.2 1.5C10 10.6 29.4 19.4 22.6 28.9" fill="none" stroke="#fbefd8" strokeOpacity="0.55" strokeWidth="1.2"
        strokeLinecap="round" strokeDasharray="0.1 2.3" />
      </g>
      <ellipse cx="10.5" cy="9" rx="4.2" ry="2.6" transform="rotate(-35 10.5 9)" fill="#fff" opacity="0.14" />
    </svg>
  );
}

/** Logo mark + "Seamly" wordmark. */
export function Wordmark({ size = 28, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="wordmark">
      <LogoMark size={size} />
      <span className="wordmark-text">
        <span className="wordmark-name">Seamly</span>
        {tagline && <span className="wordmark-tag">Your pocket bowling coach</span>}
      </span>
    </span>
  );
}
