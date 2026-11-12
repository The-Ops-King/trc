// Building blocks for the dashboard page, laid out like PMU's (Tyler, 2026-11-12): metric cards with a target, a badge and an
// explainer, the change against the period before, sections with a one-line intro, and the daily chart. Server components only:
// the explainer opens with <details>, so the page needs no client JavaScript.
import type { ReactNode } from "react";
import type { Judgement } from "@/lib/targets";
import type { DayRow } from "@/lib/dash";

/** The ⓘ next to a number: what it is and how it is counted. */
export function Info({ children, label }: { children: ReactNode; label: string }) {
  return (
    <details className="info">
      <summary aria-label={`How "${label}" is counted`}>i</summary>
      <div className="info-pop">{children}</div>
    </details>
  );
}

export function Badge({ flag }: { flag: Judgement }) {
  if (flag === "miss") return <span className="badge miss">Below target</span>;
  if (flag === "ok") return <span className="badge ok">On target</span>;
  if (flag === "thin") return <span className="badge thin">Too few to judge</span>;
  return null;
}

/**
 * Change against the previous period of the same length. Counts and dollars: % change. Rates: percentage points, since a %
 * change of a % is easy to misread. `better` says which way is good (green) for this number.
 */
export function Delta({ cur, prev, kind, better = "up", label, money = false }: {
  cur: number | null; prev: number | null; kind: "count" | "rate"; better?: "up" | "down" | "neither"; label: string; money?: boolean;
}) {
  if (cur === null || prev === null) return <div className="delta flat">no comparison · {label}</div>;
  const diff = cur - prev;
  const cents = Math.abs(prev) < 100 ? 2 : 0;
  const was = kind === "rate" ? `${(prev * 100).toFixed(1)}%`
    : money ? prev.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents, minimumFractionDigits: cents })
    : Number.isInteger(prev) ? prev.toLocaleString("en-US") : prev.toFixed(2);
  if (Math.abs(diff) < 1e-9) return <div className="delta flat">no change ({was}) · {label}</div>;
  const good = (diff > 0) === (better === "up");
  const arrow = diff > 0 ? "▲" : "▼";
  let text: string;
  if (kind === "rate") text = `${diff > 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(1)} pts`;
  else if (prev === 0) text = "new";
  else text = `${diff > 0 ? "+" : "−"}${Math.abs((diff / prev) * 100).toFixed(1)}%`;
  return <div className={`delta ${better === "neither" ? "neutral" : good ? "good" : "bad"}`}>{arrow} {text} <span className="muted">· {label} ({was})</span></div>;
}

export type CardProps = {
  n?: number | string;
  title: string;
  value: string;
  sub?: ReactNode;
  info?: ReactNode;
  target?: string;
  flag?: Judgement;
  needs?: string;          // the connection this number waits for: the card shows it instead of a number
  warn?: string;
  delta?: ReactNode;
  big?: boolean;
};

export function Card({ n, title, value, sub, info, target, flag = null, needs, warn, delta, big }: CardProps) {
  return (
    <div className={`card metric${needs ? " blocked" : ""}${big ? " big" : ""}${flag ? ` flag-${flag}` : ""}`}>
      <div className="metric-head">
        {n !== undefined && <span className="tag">{n}</span>}
        <span className="metric-title">{title}</span>
        {info && <Info label={title}>{info}</Info>}
        {target && !needs && <span className="target">{target}</span>}
      </div>
      <div className="metric-value">{needs ? "—" : value}</div>
      {!needs && delta}
      <div className="metric-sub">
        {needs ? <span className="pill">Needs {needs}</span> : sub}
        {!needs && warn && <span className="pill warn">{warn}</span>}
        {!needs && <Badge flag={flag} />}
      </div>
    </div>
  );
}

export function Section({ title, intro, aside, children, id }: { title: string; intro?: ReactNode; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {intro && <p className="intro">{intro}</p>}
      {children}
    </section>
  );
}

const W = 1000, PAD_L = 56, PAD_R = 20, TOP_H = 140, BOT_H = 130, GAP = 30;
function niceMax(v: number) {
  if (v <= 0) return 3;
  const step = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 3, 5, 10].map((k) => k * step).find((x) => x >= v) ?? v;
}
const short = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Daily ad spend (top) and sign-ups and webinar attendance (bottom), on the same days. Two charts rather than two axes on one:
 * dollars and people don't share a scale. A day with no ad data is left empty, not drawn as $0. Each day has a hover title.
 */
export function DailyChart({ days }: { days: DayRow[] }) {
  if (days.length < 2) return null;
  const n = days.length;
  const band = (W - PAD_L - PAD_R) / n;
  const x = (i: number) => PAD_L + band * (i + 0.5);
  const sMax = niceMax(Math.max(...days.map((d) => d.spend ?? 0)));
  const cMax = niceMax(Math.max(...days.map((d) => Math.max(d.registrants, d.attended ?? 0))));
  const yS = (v: number) => TOP_H - (v / sMax) * (TOP_H - 10);
  const y0 = TOP_H + GAP;
  const yC = (v: number) => y0 + BOT_H - (v / cMax) * (BOT_H - 10);
  const line = days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yC(d.registrants).toFixed(1)}`).join(" ");
  const every = Math.max(1, Math.ceil(n / 9));
  const H = y0 + BOT_H + 22;
  return (
    <div className="chart">
      <div className="chart-legend">
        <span><i className="sw spend" /> Ad spend</span>
        <span><i className="sw reg" /> Sign-ups (by the day they registered)</span>
        <span><i className="sw att" /> Webinar attendance (on the webinar day)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ad spend, sign-ups and attendance, ${short(days[0]!.day)} to ${short(days[n - 1]!.day)}`}>
        {[0, sMax / 2, sMax].map((v) => (
          <g key={`s${v}`}>
            <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={yS(v)} y2={yS(v)} />
            <text className="tick" x={PAD_L - 8} y={yS(v) + 4} textAnchor="end">{money0(v)}</text>
          </g>
        ))}
        {[0, cMax / 2, cMax].map((v) => (
          <g key={`c${v}`}>
            <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={yC(v)} y2={yC(v)} />
            <text className="tick" x={PAD_L - 8} y={yC(v) + 4} textAnchor="end">{Number.isInteger(v) ? v : v.toFixed(1)}</text>
          </g>
        ))}
        {days.map((d, i) => (
          <g key={d.day}>
            <title>{`${short(d.day)}: ${d.spend === null ? "no ad data" : money0(d.spend) + " spent"} · ${d.registrants} sign-ups${d.attended !== null ? ` · ${d.attended} at the webinar` : ""}`}</title>
            <rect className="hit" x={x(i) - band / 2} width={band} y={0} height={H - 20} />
            {d.spend !== null && d.spend > 0 && (
              <rect className="bar-spend" x={x(i) - Math.max(1, band * 0.36)} width={Math.max(2, band * 0.72)} y={yS(d.spend)} height={TOP_H - yS(d.spend)} rx="2" />
            )}
            {d.spend === null && <rect className="bar-none" x={x(i) - Math.max(1, band * 0.36)} width={Math.max(2, band * 0.72)} y={TOP_H - 3} height={3} />}
            {d.attended !== null && <circle className="dot-att" cx={x(i)} cy={yC(d.attended)} r={4} />}
            {i % every === 0 && <text className="tick" x={x(i)} y={H - 4} textAnchor="middle">{short(d.day)}</text>}
          </g>
        ))}
        <path className="line-reg" d={line} />
      </svg>
    </div>
  );
}
