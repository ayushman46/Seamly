import { fmt } from "../lib/format";
/** Small SVG line chart for values over sessions, with an optional "good" band and clickable points. */
export default function Trend({ points, band, height = 90, color = "var(--accent)", format = (v) => fmt(v, 0), onPick }: {
  points: { value: number; label: string; id?: string; rating?: string }[];
  band?: [number | null, number | null] | null;
  height?: number;
  color?: string;
  format?: (v: number) => string;
  onPick?: (id: string) => void;
}) {
  const W = 320, H = height, PX = 14, PY = 14;
  if (!points.length) return <div className="faint" style={{ fontSize: 12 }}>No measurements yet.</div>;
  const vals = points.map((p) => p.value);
  const bandVals = band ? band.filter((b): b is number => b !== null) : [];
  let lo = Math.min(...vals, ...bandVals), hi = Math.max(...vals, ...bandVals);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const x = (i: number) => (points.length === 1 ? W / 2 : PX + (i * (W - 2 * PX)) / (points.length - 1));
  const y = (v: number) => H - PY - ((v - lo) / (hi - lo)) * (H - 2 * PY);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ratingColor = (r?: string) => (r === "good" ? "var(--good)" : r === "watch" ? "var(--watch)" : r === "risk" ? "var(--risk)" : color);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
      aria-label={`Trend: ${points.map((p) => format(p.value)).join(", ")}`}>
      {band && (
        <rect x={0} width={W}
          y={y(band[1] ?? hi)} height={Math.max(0, y(band[0] ?? lo) - y(band[1] ?? hi))}
          fill="var(--good)" opacity={0.08} />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={i} style={{ cursor: onPick && p.id ? "pointer" : undefined }} onClick={() => onPick && p.id && onPick(p.id)}>
          <circle cx={x(i)} cy={y(p.value)} r={4.5} fill={ratingColor(p.rating)} stroke="var(--panel)" strokeWidth={2} />
          <title>{`${p.label}: ${format(p.value)}`}</title>
          {(i === points.length - 1 || points.length <= 6) && (
            <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" fontSize={10} fill="var(--text-2)">{format(p.value)}</text>
          )}
        </g>
      ))}
    </svg>
  );
}
