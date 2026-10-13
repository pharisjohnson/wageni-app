import { cn } from "@/lib/utils";

export type ChartDatum = { label: string; value: number };

/**
 * Column chart in plain SVG. The chart is exposed as an image with a text
 * summary, and the same numbers are available to screen readers as a table.
 */
export function BarChart({
  title,
  data,
  unit = "visits",
  className,
  labelEvery = 1,
}: {
  title: string;
  data: ChartDatum[];
  unit?: string;
  className?: string;
  /** Show every n-th x label (for long series). */
  labelEvery?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);
  const W = 100;
  const H = 48;
  const gap = 0.35;
  const slot = W / Math.max(1, data.length);
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0] ?? { label: "", value: 0 });
  const summary =
    total === 0
      ? `${title}: no ${unit}.`
      : `${title}: ${total} ${unit} in total. Highest: ${peak.label} with ${peak.value}.`;
  return (
    <figure className={cn("space-y-2", className)}>
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 8}`} role="img" aria-label={summary} className="h-40 w-full" preserveAspectRatio="none">
        <title>{summary}</title>
        <line x1="0" x2={W} y1={H} y2={H} className="stroke-border" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => {
          const h = (d.value / max) * (H - 2);
          return (
            <rect
              key={`${d.label}-${i}`}
              x={i * slot + slot * (gap / 2)}
              y={H - h}
              width={slot * (1 - gap)}
              height={h}
              rx="0.6"
              className="fill-primary"
            >
              <title>{`${d.label}: ${d.value} ${unit}`}</title>
            </rect>
          );
        })}
      </svg>
      <div aria-hidden className="flex text-[10px] text-muted-foreground">
        {data.map((d, i) => (
          <span key={`${d.label}-${i}`} className="min-w-0 flex-1 truncate text-center">
            {i % labelEvery === 0 ? d.label : ""}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">{unit}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Ranked horizontal bars. The number next to each bar carries the data; the bar is decoration. */
export function BarList({
  title,
  rows,
  empty = "Nothing to show for this range.",
}: {
  title: string;
  rows: { key: string; label: string; count: number; note?: string }[];
  empty?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-sm">
              <span className="truncate" title={r.label}>
                {r.label}
              </span>
              <span aria-hidden className="h-2 rounded-full bg-muted">
                <span className="block h-2 rounded-full bg-primary" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
              </span>
              <span className="tabular-nums text-muted-foreground">
                {r.count}
                {r.note ? ` · ${r.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
