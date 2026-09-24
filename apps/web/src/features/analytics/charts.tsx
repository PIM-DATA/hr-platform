/** Tiny CSS/SVG charts. Enough for bars, a trend line and a donut; no chart framework for a dashboard of counts. */
export function BarList({ rows, max, format }: { rows: { label: string; value: number; hint?: string }[]; max?: number; format?: (n: number) => string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-slate-400">Nothing in this range.</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex items-baseline justify-between gap-2"><span className="truncate text-slate-700">{r.label}</span><span className="tabular-nums text-slate-900">{format ? format(r.value) : r.value}{r.hint && <span className="ml-1 text-xs text-slate-400">{r.hint}</span>}</span></div>
          <div className="mt-0.5 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${Math.max(0, Math.min(100, Math.round((r.value / top) * 100)))}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function TrendLine({ points, label }: { points: { x: string; y: number }[]; label: string }) {
  if (points.length === 0) return <p className="text-sm text-slate-400">Nothing in this range.</p>;
  const w = 320, h = 80, pad = 6;
  const max = Math.max(1, ...points.map((p) => p.y));
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => [pad + i * step, h - pad - (p.y / max) * (h - pad * 2)] as const);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" role="img" aria-label={label}>
        <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-500" points={coords.map(([x, y]) => `${x},${y}`).join(' ')} />
        {coords.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.5" className="fill-brand-600" />)}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400"><span>{points[0]!.x}</span><span>{points[points.length - 1]!.x}</span></div>
    </div>
  );
}

export function Donut({ parts }: { parts: { label: string; value: number; className: string }[] }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const r = 28, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 72 72" className="h-20 w-20 shrink-0" role="img" aria-label="distribution">
        <circle cx="36" cy="36" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        {total > 0 && parts.map((p) => { const len = (p.value / total) * c; const el = <circle key={p.label} cx="36" cy="36" r={r} fill="none" stroke="currentColor" strokeWidth="10" className={p.className} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 36 36)" />; offset += len; return el; })}
      </svg>
      <ul className="space-y-0.5 text-xs text-slate-600">{parts.map((p) => <li key={p.label} className="flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${p.className.replace('text-', 'bg-')}`} />{p.label} <span className="tabular-nums text-slate-900">{p.value}</span></li>)}</ul>
    </div>
  );
}
