const DAY = 86400;
const YEAR = 365;

/** Base units -> a Number in whole token units. Fine for rate math; never for accounting. */
export const toUnits = (raw, decimals) => Number(raw) / 10 ** decimals;

/**
 * Net present value of dated cash flows at annual rate `r`.
 * Sign convention: money you paid in is negative, money you got back positive.
 */
function npv(flows, r, t0) {
  return flows.reduce((sum, f) => {
    const years = (f.timestamp - t0) / (DAY * YEAR);
    return sum + f.amount / (1 + r) ** years;
  }, 0);
}

/**
 * Money-weighted annualised return (XIRR) over dated cash flows.
 *
 * This is the headline metric: unlike a pool's APY it moves when *you* behave
 * differently rather than when the market does. Solved by Newton-Raphson with a
 * bisection fallback, because Newton diverges on flow patterns with a near-flat
 * NPV curve.
 *
 * Returns null when no rate exists: fewer than two flows, zero elapsed time, or
 * all flows the same sign (money only ever went one way, so there is no return
 * to compute).
 */
export function xirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  const sorted = [...flows].sort((a, b) => a.timestamp - b.timestamp);
  const t0 = sorted[0].timestamp;
  const span = sorted[sorted.length - 1].timestamp - t0;
  if (span <= 0) return null;

  const hasNegative = sorted.some((f) => f.amount < 0);
  const hasPositive = sorted.some((f) => f.amount > 0);
  if (!hasNegative || !hasPositive) return null;

  // Newton-Raphson
  let r = 0.1;
  for (let i = 0; i < 100; i += 1) {
    const value = npv(sorted, r, t0);
    if (Math.abs(value) < 1e-9) return r;
    const derivative = sorted.reduce((sum, f) => {
      const years = (f.timestamp - t0) / (DAY * YEAR);
      return sum - (f.amount * years) / (1 + r) ** (years + 1);
    }, 0);
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
    const next = r - value / derivative;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  // Bisection over a wide bracket. -99.99% to +1000000% covers any real position.
  let lo = -0.999999;
  let hi = 10000;
  let flo = npv(sorted, lo, t0);
  let fhi = npv(sorted, hi, t0);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i += 1) {
    const mid = (lo + hi) / 2;
    const fmid = npv(sorted, mid, t0);
    if (Math.abs(fmid) < 1e-10) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Build the XIRR cash-flow series for one position.
 *
 * Principal added is negative (you handed it over), principal removed is
 * positive, and the position's current balance is a final positive flow at
 * `asOf` because you could withdraw it today. Interest is deliberately absent:
 * it is already inside the closing balance, and counting it separately would
 * double it.
 */
export function positionCashflows(ledger, balanceRaw, decimals, asOf) {
  const flows = ledger
    .filter((entry) => entry.principalDelta !== 0n && entry.timestamp)
    .map((entry) => ({
      timestamp: entry.timestamp,
      amount: -toUnits(entry.principalDelta, decimals),
      action: entry.action,
    }));
  const closing = toUnits(balanceRaw, decimals);
  if (closing !== 0) flows.push({ timestamp: asOf, amount: closing, action: "ClosingBalance" });
  return flows;
}

/**
 * Simple (non-annualised) return on a position: total interest over the
 * average principal actually at work, weighted by how long it was at work.
 * Reported alongside XIRR because it is the number people sanity-check against.
 */
export function timeWeightedPrincipal(ledger, decimals, asOf) {
  const entries = ledger.filter((e) => e.timestamp).sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length === 0) return { averagePrincipal: 0, days: 0, deployedDays: 0 };

  let running = 0;
  let weighted = 0;
  let deployedSeconds = 0;
  let previous = entries[0].timestamp;

  for (const entry of entries) {
    const dt = entry.timestamp - previous;
    if (dt > 0) {
      weighted += running * dt;
      if (running > 1e-12) deployedSeconds += dt;
    }
    running += toUnits(entry.principalDelta, decimals);
    previous = entry.timestamp;
  }
  const tail = asOf - previous;
  if (tail > 0) {
    weighted += running * tail;
    if (running > 1e-12) deployedSeconds += tail;
  }

  const totalSeconds = asOf - entries[0].timestamp;
  return {
    averagePrincipal: totalSeconds > 0 ? weighted / totalSeconds : 0,
    days: totalSeconds / DAY,
    deployedDays: deployedSeconds / DAY,
  };
}

/**
 * Annualised time-weighted return of a pool over a window, compounded from its
 * daily rate history. This is what the pool actually paid while you were in it,
 * as opposed to the forward-looking APY its front page shows today.
 *
 * `series` rows are DefiLlama's { timestamp, apyBase } with apy in percent.
 * Returns null when the window is not covered by the series, so an uncovered
 * window renders as unavailable rather than as zero.
 */
export function poolTwr(series, fromTs, toTs) {
  if (!Array.isArray(series) || series.length === 0 || toTs <= fromTs) return null;

  const points = series
    .map((row) => ({
      timestamp: typeof row.timestamp === "number" ? row.timestamp : Date.parse(row.timestamp) / 1000,
      apy: row.apyBase ?? row.apy,
    }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.apy))
    .sort((a, b) => a.timestamp - b.timestamp);

  const inWindow = points.filter((p) => p.timestamp >= fromTs && p.timestamp <= toTs);
  if (inWindow.length < 2) return null;

  // The series must actually reach back to the window start, or the answer
  // silently describes a shorter period than the caller asked about.
  const coverageStart = inWindow[0].timestamp;
  if (coverageStart - fromTs > 7 * DAY) return null;

  let factor = 1;
  for (let i = 1; i < inWindow.length; i += 1) {
    const dtDays = (inWindow[i].timestamp - inWindow[i - 1].timestamp) / DAY;
    // Rate applying over the interval: the previous observation.
    factor *= (1 + inWindow[i - 1].apy / 100 / YEAR) ** dtDays;
  }
  const spanDays = (inWindow[inWindow.length - 1].timestamp - coverageStart) / DAY;
  if (spanDays <= 0) return null;
  return factor ** (YEAR / spanDays) - 1;
}

/**
 * Exact balance-vs-principal history, from events alone. No price data, no
 * interpolation, no archive node.
 *
 * Every Aave event updates the user's interest index, so at the instant of each
 * event all interest accrued so far has just been credited. That makes the
 * balance at event i exactly:
 *
 *   balance_i = SUM(principalDelta <= i) + SUM(interestRealized <= i)
 *
 * Plotting that against the principal line alone makes the gap between them the
 * interest earned, which is the one chart that explains the headline number
 * without asking the reader to trust it.
 */
export function balanceSeries(ledger, balanceRaw, decimals, asOf) {
  const entries = ledger.filter((e) => e.timestamp).sort((a, b) => a.timestamp - b.timestamp);
  const points = [];
  let principal = 0n;
  let interest = 0n;

  if (entries.length > 0) {
    points.push({
      timestamp: entries[0].timestamp - 1,
      principal: 0,
      balance: 0,
      interest: 0,
      action: "Start",
    });
  }
  for (const entry of entries) {
    principal += entry.principalDelta;
    interest += entry.interestRealized;
    points.push({
      timestamp: entry.timestamp,
      principal: toUnits(principal, decimals),
      balance: toUnits(principal + interest, decimals),
      interest: toUnits(interest, decimals),
      action: entry.action,
      delta: toUnits(entry.principalDelta, decimals),
      txHash: entry.txHash,
    });
  }
  // Closing point carries pending interest, which no event has credited yet.
  points.push({
    timestamp: asOf,
    principal: toUnits(principal, decimals),
    balance: toUnits(balanceRaw, decimals),
    interest: toUnits(balanceRaw - principal, decimals),
    action: "Now",
  });
  return points;
}

/**
 * Interest over time as it was ACTUALLY earned: a continuous curve, not a step.
 *
 * Aave credits nothing when you act. Your balance is `scaledBalance x liquidityIndex`,
 * and the index rises every block, so interest accrues every second whether or not
 * you touch the position. The `balanceIncrease` carried by each Mint and Burn is
 * only a checkpoint - Aave writing down what accrued since you last touched it - so
 * plotting cumulative balanceIncrease draws lumps whose size is really just "how
 * long since the previous transaction". That is an artefact of the bookkeeping, not
 * of the earnings.
 *
 * The real quantity at any time is
 *
 *   interest(t) = scaledBalance(t) * index(t) - netPrincipal(t)
 *
 * where scaledBalance and netPrincipal step only at events and index rises smoothly
 * between them. It is continuous ACROSS events too: a deposit raises balance and
 * principal by the same amount, so their difference does not jump.
 *
 * The index is known exactly at every Mint and Burn (each event stamps one) and at
 * the present moment (balance / scaledBalance). Between two known points it is
 * interpolated geometrically, which is what constant-rate compounding does.
 */
export function interestSeries(ledger, decimals, asOf, indexNow) {
  const entries = ledger.filter((e) => e.timestamp).sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length === 0) return [];

  const known = [];
  for (const e of entries) {
    if (e.index) {
      const value = Number(e.index) / 1e27;
      if (Number.isFinite(value) && value > 0) known.push({ t: e.timestamp, index: value });
    }
  }
  if (indexNow && Number.isFinite(indexNow) && indexNow > 0) known.push({ t: asOf, index: indexNow });
  if (known.length === 0) return [];
  known.sort((a, b) => a.t - b.t);

  const indexAt = (t) => {
    if (t <= known[0].t) return known[0].index;
    const last = known[known.length - 1];
    if (t >= last.t) return last.index;
    let i = 0;
    while (i < known.length - 1 && known[i + 1].t < t) i += 1;
    const a = known[i];
    const b = known[i + 1];
    if (!b || b.t === a.t) return a.index;
    return a.index * (b.index / a.index) ** ((t - a.t) / (b.t - a.t));
  };

  const steps = [];
  let scaled = 0;
  let principal = 0;
  for (const e of entries) {
    scaled += Number(e.scaledDelta ?? 0n);
    principal += Number(e.principalDelta);
    steps.push({ t: e.timestamp, scaled, principal, action: e.action });
  }
  const stateAt = (t) => {
    let state = { scaled: 0, principal: 0 };
    for (const step of steps) {
      if (step.t > t) break;
      state = step;
    }
    return state;
  };

  const start = entries[0].timestamp;
  const points = [];
  // Anything below one base unit is ray-rounding noise, not interest. Left in,
  // it renders as a "-0" axis label and a curve that dips under the axis.
  const unit = 10 ** -decimals;
  const push = (t, action) => {
    const state = stateAt(t);
    const value = (state.scaled * indexAt(t) - state.principal) / 10 ** decimals;
    points.push({
      timestamp: t,
      interest: Math.abs(value) < unit ? 0 : value,
      ...(action ? { action } : {}),
    });
  };

  push(start - 1);
  const stride = Math.max(DAY, Math.floor((asOf - start) / 400));
  for (let t = start; t < asOf; t += stride) push(t);
  for (const step of steps) push(step.t, step.action);
  push(asOf, "Now");

  return points
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((pt, i, all) => i === 0 || pt.timestamp !== all[i - 1].timestamp || pt.action);
}

/**
 * Format a rate as a percentage, or an explicit dash when unavailable.
 * Anything that rounds to zero prints "0.00%" rather than "-0.00%".
 */
export const pct = (r, digits = 2) => {
  if (r == null || !Number.isFinite(r)) return "—";
  const p = r * 100;
  const shown = Math.abs(p) < 0.5 * 10 ** -digits ? 0 : p;
  return `${shown.toFixed(digits)}%`;
};
