// GTA VI launch-day Twitch viewer forecaster (Node 22, standard library only).
//
// Idea: hour 1's print anchors the whole day, but the shape of the day depends
// strongly on how big hour 1 already is. Across the case's comparable launches,
// the log-ratio ln(viewers_h / viewers_1) is tightly (negatively) related to
// ln(viewers_1): a small hour 1 means most of the world has yet to unlock, so
// the day rises steeply (up to ~30x for the smallest launches); a huge hour 1
// means the launch is already at full strength and the day stays flat or dips.
// Per forecast hour h = 2..24 we fit, on the clean comparables only, the
// quadratic
//
//   ln(y_h / y_1) = a_h + b_h * ln(y_1) + c_h * ln(y_1)^2
//
// (correlation of log hour-1 print with the day's peak log-ratio is about
// -0.94), and take the residual standard deviation as the log spread, smoothed
// over neighbouring hours and shrunk by SPREAD_SCALE. The five quantiles are
// then p1 * exp(median_h + z_tau * sd_h), with z the standard normal quantiles.
//
// Comparables flagged in their unlock text as early-access-contaminated, weak
// tier, or the target's own pre-release history are excluded: their release-day
// curves are distorted (early access peaks days before release) and including
// them measurably worsens the practice score. Everything is computed from the
// case file at run time, so the same program works on the final case, whose
// comparables also include the four practice launches.
//
// Local practice grade (mean pinball loss on the log scale, lower is better):
//   house baseline (persistence): 0.387
//   this program:                 0.140  (p00 0.113, p01 0.155, p02 0.121, p03 0.173)
//   typical miss ~25-34%, 90% coverage ~0.88 on the practice cases.
//
// It runs offline, with no network, under the case's time cap: everything it
// knows is in the case file. Deterministic: no randomness, no clock, no
// environment reads besides the input/output directories, so two runs write
// the same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Shrinkage applied to the fitted residual spread (tuned on the practice). */
const SPREAD_SCALE = 0.3;
/** Bounds on the fitted median log-ratio (guards extrapolation to huge hour 1). */
const MED_CLAMP_LO = -1.5;
const MED_CLAMP_HI = 4.0;
/** Minimum comparables with a point at an hour to fit that hour's curve. */
const MIN_TRAIN = 8;
/** Fallback spread (log units per sqrt hour) when no curve can be fitted. */
const FALLBACK_SIGMA = 0.15;

interface HourlyPoint {
  from: string;
  viewers: number | null;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** A comparable's tier, from the free-text unlock note in the case file. */
const tierOf = (comp: Comparable): 'comparable' | 'other' => {
  const u = comp.unlock ?? '';
  if (u.includes('early-access-contaminated')) return 'other';
  if (u.includes('Tier: weak')) return 'other';
  if (u.includes('target-history')) return 'other';
  return 'comparable';
};

/**
 * A comparable's release-day curve: hour (1..24 of its UTC release day) to
 * mean viewers, averaging points that fall in the same hour, as the house
 * defines an hour's figure.
 */
const dayCurve = (comp: Comparable): Map<number, number> => {
  const start = Date.parse(comp.day_start);
  const sums = new Map<number, { total: number; n: number }>();
  for (const pt of comp.hourly ?? []) {
    if (pt.viewers === null || pt.viewers === undefined) continue;
    const dh = (Date.parse(pt.from) - start) / 3600000;
    if (dh < 0 || dh >= 24) continue;
    const h = Math.floor(dh) + 1;
    const acc = sums.get(h) ?? { total: 0, n: 0 };
    acc.total += pt.viewers;
    acc.n += 1;
    sums.set(h, acc);
  }
  const out = new Map<number, number>();
  for (const [h, acc] of sums) out.set(h, acc.total / acc.n);
  return out;
};

/** A comparable's log-ratios ln(y_h / y_1) for hours 2..24, or null. */
const logRatios = (comp: Comparable): Map<number, number> | null => {
  const curve = dayCurve(comp);
  const y1 = curve.get(1);
  if (y1 === undefined || y1 < 1) return null;
  const out = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const y = curve.get(h);
    if (y !== undefined) out.set(h, Math.log(Math.max(1, y) / y1));
  }
  return out;
};

/** Solve a 3x3 linear system by Gaussian elimination with partial pivoting. */
const solve3 = (a: number[][], b: number[]): number[] => {
  const m = [
    [a[0][0], a[0][1], a[0][2], b[0]],
    [a[1][0], a[1][1], a[1][2], b[1]],
    [a[2][0], a[2][1], a[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    const tmp = m[col];
    m[col] = m[piv];
    m[piv] = tmp;
    const pv = m[col][col];
    if (Math.abs(pv) < 1e-12) continue;
    for (let r = 0; r < 3; r++) {
      if (r !== col && m[r][col] !== 0) {
        const fac = m[r][col] / pv;
        for (let cc = col; cc < 4; cc++) m[r][cc] -= fac * m[col][cc];
      }
    }
  }
  return [0, 1, 2].map((i) => (Math.abs(m[i][i]) > 1e-12 ? m[i][3] / m[i][i] : 0));
};

/**
 * Fit the per-hour quadratic log-ratio curves on the clean comparables.
 * Returns, per hour, the fitted median log-ratio at the target's hour-1
 * print and the (smoothed) residual spread.
 */
const fitCurves = (
  comps: Comparable[],
  logY1: number,
): { med: Map<number, number>; sd: Map<number, number>; n: number } => {
  const rows: Array<{ y1: number; lr: Map<number, number> }> = [];
  for (const comp of comps) {
    if (tierOf(comp) !== 'comparable') continue;
    const lr = logRatios(comp);
    if (lr === null) continue;
    const curve = dayCurve(comp);
    const y1 = curve.get(1);
    if (y1 === undefined) continue;
    rows.push({ y1, lr });
  }
  const med = new Map<number, number>();
  const sdRaw = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const data = rows.filter((r) => r.lr.has(h));
    if (data.length < MIN_TRAIN) {
      med.set(h, 0);
      sdRaw.set(h, 0.5);
      continue;
    }
    // Normal equations for [1, ly, ly^2].
    const xtx: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const xty: number[] = [0, 0, 0];
    for (const r of data) {
      const ly = Math.log(r.y1);
      const x = [1, ly, ly * ly];
      const y = r.lr.get(h) as number;
      for (let a = 0; a < 3; a++) {
        xty[a] += x[a] * y;
        for (let b = 0; b < 3; b++) xtx[a][b] += x[a] * x[b];
      }
    }
    const beta = solve3(xtx, xty);
    let ss = 0;
    for (const r of data) {
      const ly = Math.log(r.y1);
      const pred = beta[0] + beta[1] * ly + beta[2] * ly * ly;
      const res = (r.lr.get(h) as number) - pred;
      ss += res * res;
    }
    const s = Math.sqrt(ss / Math.max(1, data.length - 3));
    const m = beta[0] + beta[1] * logY1 + beta[2] * logY1 * logY1;
    med.set(h, Math.min(MED_CLAMP_HI, Math.max(MED_CLAMP_LO, m)));
    sdRaw.set(h, s);
  }
  // Smooth the spread over neighbouring hours; the per-hour residual sds are
  // noisy estimates from ~26 comparables.
  const sd = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const vals: number[] = [];
    for (let hh = Math.max(2, h - 1); hh <= Math.min(24, h + 1); hh++) {
      vals.push(sdRaw.get(hh) as number);
    }
    sd.set(h, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return { med, sd, n: rows.length };
};

/** The five quantiles for one hour around hour 1's print. */
const hourQuantiles = (p1: number, m: number, s: number): number[] => {
  const out: number[] = [];
  let prev = 0;
  for (const z of Z) {
    let q = round2(p1 * Math.exp(m + z * s * SPREAD_SCALE));
    if (!(q > 0) || !Number.isFinite(q)) q = 0.01;
    if (q > 1e9) q = 1e9;
    if (q < prev) q = prev;
    out.push(q);
    prev = q;
  }
  return out;
};

/** The persistence fallback: every hour stays at hour 1's print. */
const fallbackQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1))));

const forecastCase = (c: Case): { hours: Array<{ hour: number; q: number[] }> } => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const { med, sd, n } = fitCurves(c.comparables ?? [], Math.log(p1));
  // Too few clean comparables to fit curves: fall back to persistence.
  const usable = n >= MIN_TRAIN;
  const hours = c.forecast.map(({ hour }) => {
    const m = med.get(hour);
    const s = sd.get(hour);
    const q =
      usable && m !== undefined && s !== undefined
        ? hourQuantiles(p1, m, s)
        : fallbackQuantiles(p1, hour);
    return { hour, q };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: out.hours })}\n`);
}
