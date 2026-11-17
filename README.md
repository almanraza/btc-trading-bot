# btc-trading-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/almanraza/btc-trading-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/almanraza/btc-trading-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A mean-reversion bot for Coinbase Wrapped BTC (cbBTC) against USDC, entered in
[make.fun's "Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261117-0603) bounty.

## The idea

The universe is one asset, one open position at most, and a round trip costs about **12 bps**
(4 bps fee twice, 2 bps slippage twice) before any price impact. On the published dev window every
trend-following rule I tested lost money — SMA crosses from 5/20 up to 60/240, breakout momentum,
trailing stops — and lost in proportion to how often it traded. The 1-minute tape drifts only ~49 bps
across the whole day, far less than the cost of chasing it.

What survives the cost is the opposite: the pool overshoots its own slow mean and comes back.

| Rule | Value |
| --- | --- |
| Mean | mean of the last **300** closes (5 hours) |
| Entry | buy when the close is **≥ 50 bps below** the mean |
| Exit | sell when the close is **≥ 10 bps above** the mean |
| Hard stop | **200 bps** below the entry price |
| Time stop | **720 bars** (12 hours) |

The 50 bps entry threshold is several times the round-trip cost, so the reversion only has to give
back a fraction of the dislocation to pay for itself. The stop and the time stop never fire on the
dev window; they bound the damage on a window nobody has seen.

Sizing is the whole cash balance, capped by `caps.max_weight_bps` of equity. Slippage is left wide
open (10,000 bps) because a ~1,000 USDC order moves a ~0.8–1.0M USDC pool by only ~12 bps, well
inside what the strategy is trying to capture; a tight cap would only turn fills into rejections.

## Dev-window result

Graded with the kit's own local grader (`grade-local`, two executions, action logs must match):

```
status    finished
net PnL   8.456547 USDC  (return 0.008456547)
trading   8 trades over 1 symbols, win rate 1.000000000, max drawdown 0.008730306,
          exposure 0.220138888, sharpe 0.017551900, 0 rejected
fees      3.212743 USDC; at 2x fees net PnL 5.248667 USDC
guardrails met (trades ok, symbols ok, drawdown ok)
L1 regrade reproduced byte for byte
```

Four round trips, all four profitable, 0.87% maximum drawdown, and the result survives doubling the
fees. The parameter neighbourhood is uniformly positive (mean window 360–600 bars × entry 40–80 bps
all end above zero), which is why the thresholds are round numbers rather than a fitted optimum.

## Determinism

No clock, no randomness, no network. Every decision is a function of the closes the harness has
already delivered, so two runs on the same window produce the same action log — the grader's two
executions matched byte for byte.

## Run it

```sh
# from inside the unpacked competition kit
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-trading-bot --driver process
```

The grader runs `node main.ts` with this directory mounted at `/bot`. `vendor/makefun-bars.ts` is a
byte-identical copy of the kit's `sdk/makefun-bars.ts` (sha256 `9677370b…`), which is the protocol
shim the harness speaks.

## Layout

```
main.ts                 the bot: mean, entry, exit, rails
vendor/makefun-bars.ts  the kit's protocol shim, unmodified
LICENSE                 MIT
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=c0cc74v9&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
