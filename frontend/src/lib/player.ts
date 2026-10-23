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
