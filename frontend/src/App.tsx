import { Suspense, useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import { lazyPage } from "./lib/lazy";
const AnalysisPage = lazyPage(() => import("./components/AnalysisPage"));
import ErrorBoundary from "./components/ErrorBoundary";
const ComparePage = lazyPage(() => import("./components/ComparePage"));
const ReportPage = lazyPage(() => import("./components/ReportPage"));
const PlayerPage = lazyPage(() => import("./components/PlayerPage"));

type Route = { page: "home" } | { page: "analysis"; id: string; tab?: string } | { page: "compare"; a: string; b: string }
  | { page: "report"; id: string } | { page: "player"; id: string };

function parseRoute(): Route {
  const c = window.location.hash.match(/^#\/compare\/([a-f0-9]{12})\/([a-f0-9]{12})/);
  if (c) return { page: "compare", a: c[1], b: c[2] };
  const rep = window.location.hash.match(/^#\/r\/([a-f0-9]{12})/);
  if (rep) return { page: "report", id: rep[1] };
  const pl = window.location.hash.match(/^#\/p\/([a-f0-9]{12})/);
  if (pl) return { page: "player", id: pl[1] };
  const m = window.location.hash.match(/^#\/a\/([a-f0-9]{12})(?:\/(plan))?/);
  return m ? { page: "analysis", id: m[1], tab: m[2] } : { page: "home" };
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
        : <Home go={go} />}
      </Suspense>
    </ErrorBoundary>
  );
}
