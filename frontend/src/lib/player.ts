/** The player whose deliveries are being uploaded on this device (a per-browser convenience). */
const KEY = "bowlnet-current-player";

export function getCurrentPlayer(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function setCurrentPlayer(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the choice just isn't remembered */ }
}

export const AGE_LABEL: Record<string, string> = {
  u11: "Under 11", u13: "11–12", u15: "13–14", u17: "15–16", u19: "17–18", adult: "Adult (19+)",
};
export const STYLE_LABEL: Record<string, string> = { fast: "Fast", medium: "Medium pace", spin: "Spin" };

/** Drills suitable for the player's age: "(17+ only)" ones are left out for anyone under 17 (as in the practice plan). */
export function drillsForAge(drills: string[], age: string | null | undefined): string[] {
  const junior = !!age && ["u11", "u13", "u15", "u17"].includes(age);
  return junior ? drills.filter((d) => !d.includes("(17+ only)")) : drills;
}
