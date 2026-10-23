import type { ReactNode } from "react";
import { Wordmark } from "./Brand";

export const REPO_URL = "https://github.com/ayushman46/Seamly";

/** Scroll smoothly to a section of the home page without touching the hash (the hash is the router). */
export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

const NAV: [string, string][] = [["how", "How it works"], ["features", "What you get"], ["privacy", "Privacy"], ["filming", "Filming guide"], ["faq", "FAQ"]];

export default function Header({ go, title, children, nav = false }: {
  go: (to: string) => void; title?: string; children?: ReactNode; nav?: boolean;
}) {
  return (
    <header className="app-header">
      <button type="button" className="brand" onClick={() => go("/")} aria-label="Seamly home">
        <Wordmark size={30} />
      </button>
      {nav && (
        <nav className="header-nav" aria-label="Sections">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); scrollToId(id); }}>{label}</a>
          ))}
        </nav>
      )}
      {title && <div className="header-title" title={title}><span>{title}</span></div>}
      <div className="header-spacer" />
      <div className="header-actions">{children}</div>
    </header>
  );
}
