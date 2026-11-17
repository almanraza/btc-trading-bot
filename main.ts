// CBBTC mean-reversion bot for make.fun's "Race a BTC trading bot live for 24 hours".
//
// The universe is one asset (CBBTC/USDC on an Orca Whirlpool), one open position at most, and a
// round trip costs 4 bps of fee twice plus 2 bps of slippage twice: about 12 bps before any price
// impact. On the published dev window every trend-following rule I tested (SMA crosses from 5/20 to
// 60/240, breakout momentum, trailing stops) lost money, and lost it in proportion to how often it
// traded: the 1-minute tape's own drift is ~49 bps over the whole day, far less than the cost of
// chasing it. What survives the cost is the opposite: the pool overshoots its own slow mean and
// comes back. So this bot waits for a real dislocation and then takes it.
//
//   - Mean: the mean of the last MEAN_BARS closes (5 hours), recomputed each bar.
//   - Entry: with no position, buy when the close sits at least ENTRY_BPS (50 bps) below that mean.
//     That is a dislocation several times the round-trip cost, so the reversion only has to give
//     back a fraction of it to pay.
//   - Exit: sell once the close is back at or above the mean plus EXIT_BPS (10 bps), i.e. the
//     overshoot has been repaid and a little more.
//   - Rails, which never fire on the dev window but bound the damage on a window nobody has seen:
//     a hard stop at STOP_BPS (200 bps) below the entry price, and a time stop after MAX_HOLD_BARS
//     (12 hours) so a position can never be carried into the close by inertia.
//
// Sizing: the whole cash balance, capped by caps.max_weight_bps of equity. One position, so there is
// nothing to split. Slippage is left wide open (MAX_SLIPPAGE_BPS = 10_000) because the order is
// small against the pool's ~0.8-1.0M USDC depth: a 1,000 USDC order moves the price ~12 bps, well
// inside what the strategy is trying to capture, and a tight cap would only turn fills into
// rejections.
//
// Determinism: no clock, no randomness, no network. Every decision is a function of the closes the
// harness has already delivered, so two runs on the same window produce the same action log.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

/** Bars in the mean: 5 hours of 1-minute bars. */
const MEAN_BARS = 300;
/** How far below the mean the close must sit to buy, in bps, at the least. */
const ENTRY_BPS = 50n;
/** The entry threshold also scales with recent volatility: this many times the last hour's stdev. */
const VOL_MULT = 4n;
/** Bars in the volatility estimate: one hour. */
const VOL_BARS = 60;
/** How far above the mean the close must sit to sell, in bps. */
const EXIT_BPS = 10n;
/** Hard stop below the entry price, in bps. */
const STOP_BPS = 200n;
/** Longest a position may be held, in bars (12 hours). */
const MAX_HOLD_BARS = 720;
/** Slippage is left wide open: the order is small against the pool's depth. */
const MAX_SLIPPAGE_BPS = 10_000;

/** The symbol this bot trades; the universe holds only it. */
const SYMBOL = 'CBBTC';

/** Every close delivered so far, oldest first. */
const closes: bigint[] = [];
/** The bar index and price the open position was entered at, or null when flat. */
let entryBar: number | null = null;
let entryPrice = 0n;

/** The mean of the last MEAN_BARS closes, or null until there are that many. */
function mean(): bigint | null {
  if (closes.length < MEAN_BARS) return null;
  let sum = 0n;
  for (let i = closes.length - MEAN_BARS; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(MEAN_BARS);
}

/**
 * The last hour's realized volatility, in bps: the population stdev of the one-minute returns, as an
 * integer. Null until there are VOL_BARS + 1 closes. Computed in bps so it stays exact enough to
 * compare against a threshold without floating point.
 */
function volBps(): bigint | null {
  if (closes.length < VOL_BARS + 1) return null;
  const start = closes.length - VOL_BARS - 1;
  // Each return in bps, scaled by 10^4 to keep integer precision through the stdev.
  const rets: bigint[] = [];
  for (let i = start + 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev === 0n) continue;
    rets.push(((closes[i]! - prev) * BPS * 10_000n) / prev);
  }
  if (rets.length < 2) return null;
  const n = BigInt(rets.length);
  let sum = 0n;
  for (const r of rets) sum += r;
  const meanRet = sum / n;
  let sq = 0n;
  for (const r of rets) {
    const d = r - meanRet;
    sq += d * d;
  }
  // sqrt of (sq / n) in the 10^4-scaled bps space, by Newton's method on integers.
  const variance = sq / n;
  if (variance <= 0n) return 0n;
  let x = variance;
  for (let k = 0; k < 40; k++) {
    const next = (x + variance / x) / 2n;
    if (next === x) break;
    x = next;
  }
  return x / 10_000n;
}

/** The entry threshold in bps: ENTRY_BPS, or VOL_MULT times the last hour's volatility if larger. */
function entryThreshold(): bigint {
  const vol = volBps();
  if (vol === null) return ENTRY_BPS;
  const scaled = VOL_MULT * vol;
  return scaled > ENTRY_BPS ? scaled : ENTRY_BPS;
}

/** True when `price` is at least `bps` below `reference`, compared exactly (no division). */
function belowBy(price: bigint, reference: bigint, bps: bigint): boolean {
  return price * BPS <= reference * (BPS - bps);
}

/** True when `price` is at least `bps` above `reference`, compared exactly. */
function aboveBy(price: bigint, reference: bigint, bps: bigint): boolean {
  return price * BPS >= reference * (BPS + bps);
}

/** The whole cash balance, capped by the weight cap and the minimum notional. */
function buyOrder(state: BarsState): BuyInput[] {
  const { caps, fees } = state.hello;
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const notional = state.cash < byWeight ? state.cash : byWeight;
  if (notional <= 0n || notional < BigInt(fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

/** Sell the whole position. */
function sellOrder(state: BarsState): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty <= 0n) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onHello() {
    closes.length = 0;
    entryBar = null;
    entryPrice = 0n;
  },
  onBatch(state, batch) {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    // A warm-up batch takes no orders; the harness rejects them anyway.
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const inPosition = held !== undefined && held.qty > 0n;

    if (inPosition) {
      if (entryBar === null) {
        // A position this bot did not open (it cannot happen, but never leave one unmanaged).
        entryBar = batch.seq;
        entryPrice = close;
      }
      const m = mean();
      if (m !== null && aboveBy(close, m, EXIT_BPS)) return sellOrder(state);
      if (belowBy(close, entryPrice, STOP_BPS)) return sellOrder(state);
      if (batch.seq - entryBar >= MAX_HOLD_BARS) return sellOrder(state);
      return [];
    }

    const m = mean();
    if (m === null) return [];
    if (!belowBy(close, m, entryThreshold())) return [];

    const orders = buyOrder(state);
    if (orders.length > 0) {
      entryBar = batch.seq;
      entryPrice = close;
    }
    return orders;
  },
});
