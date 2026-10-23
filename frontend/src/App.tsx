import { Suspense, useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import { lazyPage } from "./lib/lazy";
const AnalysisPage = lazyPage(() => import("./components/AnalysisPage"));
import ErrorBoundary from "./components/ErrorBoundary";
import Header from "./components/Header";
const ComparePage = lazyPage(() => import("./components/ComparePage"));
const ReportPage = lazyPage(() => import("./components/ReportPage"));
const PlayerPage = lazyPage(() => import("./components/PlayerPage"));

type Route = { page: "home" } | { page: "analysis"; id: string; tab?: string } | { page: "compare"; a: string; b: string }
  | { page: "report"; id: string } | { page: "player"; id: string } | { page: "missing" };

function parseRoute(): Route {
  const c = window.location.hash.match(/^#\/compare\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/);
  if (c) return { page: "compare", a: c[1], b: c[2] };
  const rep = window.location.hash.match(/^#\/r\/([A-Za-z0-9_-]+)/);
  if (rep) return { page: "report", id: rep[1] };
  const pl = window.location.hash.match(/^#\/p\/([A-Za-z0-9_-]+)/);
  if (pl) return { page: "player", id: pl[1] };
  const m = window.location.hash.match(/^#\/a\/([A-Za-z0-9_-]+?)(?:\/(plan))?$/);
  if (m) return { page: "analysis", id: m[1], tab: m[2] };
  // "#how" etc. are section links of the home page; anything else under "#/" is a link to nothing
  return /^#\/./.test(window.location.hash) ? { page: "missing" } : { page: "home" };
}

function Missing({ go }: { go: (to: string) => void }) {
  return (
    <>
    <Header go={go} />
    <main id="main" tabIndex={-1} className="page">
      <div className="empty" style={{ marginTop: 48 }}>
        <span className="empty-icon">?</span>
        <b>This link doesn't lead anywhere in Seamly</b>
        <span>It may be cut short or mistyped. Analyses and players open only in the browser that made them.</span>
        <button type="button" className="btn primary sm" style={{ marginTop: 8 }} onClick={() => go("/")}>Go to Seamly</button>
      </div>
    </main>
    </>
  );
}

export default function App() {
  const [route, setRoute] = useState(parseRoute());
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to;
    window.scrollTo({ top: 0 });
  }, []);
  const skip = () => {
    const main = document.getElementById("main");
    main?.focus();
    main?.scrollIntoView();
  };
  return (
    <ErrorBoundary label="Seamly">
      <button type="button" className="skip-link" onClick={skip}>Skip to content</button>
      <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton-box" style={{ height: 56, maxWidth: 420, marginBottom: 18 }} /><div className="skeleton-box" style={{ height: 420 }} /></div>}>
      {route.page === "analysis" ? <AnalysisPage key={route.id} id={route.id} go={go} initialTab={route.tab} />
        : route.page === "player" ? <PlayerPage key={route.id} pid={route.id} go={go} />
        : route.page === "compare" ? <ComparePage key={`${route.a}-${route.b}`} a={route.a} b={route.b} go={go} />
        : route.page === "report" ? <ReportPage key={route.id} id={route.id} go={go} />
        : route.page === "missing" ? <Missing go={go} />
        : <Home go={go} />}
      </Suspense>
    </ErrorBoundary>
  );
}
