import { useEffect } from "react";

/** Name the browser tab after what is on screen ("Nets, Tuesday · Seamly"); the default title comes back on leaving. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · Seamly`;
    return () => { document.title = before; };
  }, [title]);
}
