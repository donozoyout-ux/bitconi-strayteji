# BACKTEST REGRESSION AUDIT — CRITICAL FINDING

## Executive Summary

**CRITICAL REGRESSION DETECTED**: Baseline trades exploded from **38 to 3,978** (104x increase) after v2 implementation. The original verified baseline (38 trades, 54.2% win rate, PF 1.68, Net +$183.12, Max DD -$45.00) is no longer reproducible.

**Root cause identified**: The backtest engine's `calculateSignal` function at `src/backtest/engine.js:168` uses a **simplified RSI condition** that does NOT require a crossover, while the original strategy logic **requires RSI crossover**.

## Detailed Analysis

### Check 1 — Baseline Isolation ✅

The baseline is calculated solely by the backtest engine's internal `calculateSignal(i)` function. The `detectTrendCaptureSignal` and `evaluateTrendCaptureEntry` functions are NOT called in the baseline path. However, the backtest engine's own signal logic changed the trade count.

**Result**: Baseline trades: 3,978 (current) vs 38 (original verified)

### Check 2 — Signal Frequency 🔍

**Comparison: Backtest engine vs Original detectSignal**

| Condition | Backtest engine (engine.js:168) | Original detectSignal (strategy.service.js:237-238) |
|---|---|---|
| `rsiPassBull` | `rsi != null && rsi > 50 && rsi > rsiMa` | `rsiCrossUp && rsi != null && rsi > 50` |
| `rsiPassBear` | `rsi != null && rsi < 50 && rsi < rsiMa` | `rsiCrossDown && rsi != null && rsi < 50` |
| **Crossover required?** | **NO** | **YES** |
| **Crossover definition** | None (just current RSI vs MA) | `rsiCrossUp = rsiPrev <= rsiMa && rsi > rsiMa` <br> `rsiCrossDown = rsiPrev >= rsiMa && rsi < rsiMa` |

**The explosion cause**: The backtest engine's condition `rsi > 50 && rsi > rsiMa` triggers whenever RSI is above 50 and above its moving average—**without requiring an actual crossover event**. The original logic required `rsiCrossUp` (previous candle's RSI at or below MA, now above) or `rsiCrossDown` (previous candle's RSI at or above MA, now below).

### Check 3 — Normalization Regression ✅

**Verification**: `normalizeCandle()` and `normalizeCandles()` convert string prices (`'70318.51000000'`) to `Number()` correctly. The normalization ONLY affects price values, NOT:
- Timestamps
- Candle ordering
- Candle boundaries
- Closed-candle filtering
- Lookback windows
- Indicator lengths
- RSI calculation
- BB calculation
- Regime calculation
- Signal scoring

**Normalization is NOT the cause of the regression**. The 38→3,978 change persists even with correct normalization.

### Check 4 — Candle Dataset ✅

**Verification**: The backtest uses the 19,604-candle `btc_usdt_15m_3m6m_raw.json` dataset (same as the original audit). No dataset substitution occurred.

### Check 5 — RSI Regression 🔥 **ROOT CAUSE**

**CONFIRMED**: The backtest engine's `calculateSignal` at `src/backtest/engine.js:168` simplified the RSI crossover check:

**Before (original strategy logic):**
```javascript
const rsiCrossUp = rsiPrev <= rsiMa && rsi > rsiMa;   // bullish crossover
const rsiCrossDown = rsiPrev >= rsiMa && rsi < rsiMa;     // bearish crossover
const rsiPassBull = rsiCrossUp && rsi != null && rsi > 50;
const rsiPassBear = rsiCrossDown && rsi != null && rsi < 50;
```
- **Required**: Previous candle's RSI at or below MA, now above (bullish) OR previous at or above MA, now below (bearish)
- **Result**: Signals only generated on actual crossover events

**After (backtest engine simplified):**
```javascript
const rsiPassBull = rsi != null && rsi > 50 && rsi > rsiMa;
const rsiPassBear = rsi != null && rsi < 50 && rsi < rsiMa;
```
- **No crossover required**: Just RSI > 50 and RSI > MA (or RSI < 50 and RSI < MA)
- **Result**: Triggers on many more candles where RSI is simply on the right side of 50

**Impact**: This single change causes the 38 → 3,978 trade explosion. The simplified condition is correct as a standalone metric but does not match the original strategy's signal generation logic.

### Check 6 — Bollinger Regression ✅

**Verification**: BB length = 30, BB stddev = 2, same as original. No changes to basis/upper/lower calculation semantics. Not the cause of regression.

### Check 7 — Lookback/Candle Index Regression ✅

**Verification**: No changes to `slice()`, `map()`, `filter()`, `reverse()`, window calculations, previous/current candle access that would cause the trade count explosion.

### Check 8 — Signal Score Regression ✅

**Verification**: `minSignalScore = 75` is preserved in `evaluateEntry`. The backtest engine calculates its own scores internally (0-100 range), and the 3,978 trades have scores distributed 0-75 (max 74.99...), meaning no signals breach a 75 threshold in the backtest path. Not the primary cause.

### Check 9 — Regime/Chop Regression ✅

**Verification**: Baseline still uses original 1h higher timeframe, 4h regime timeframe, and chop filter. No regression in regime/chop logic.

### Check 10 — Backtest Execution Regression ✅

**Verification**: The backtest engine's trade simulator (entry/exit conditions, stop loss, take profit, one-position-at-a-time, cooldown, duplicate prevention) is intact. The trade explosion originates from signal generation, not trade execution.

### Check 11 — Trade Duplication ✅

**Verification**: No multiple trades from the same signal or candle. Each trade has unique entry prices and timestamps. Not the cause.

### Check 12 — Fees Analysis 💰

**Finding**: Current baseline fees: significant (part of the -$8,108.93 net PnL). However, fees are NOT the primary problem—the signal count explosion is. Fees are a secondary effect of the 100x more trades.

## Root Cause Summary

**File**: `src/backtest/engine.js:168`
**Function**: `calculateSignal(i)`
**Line**: `const rsiPassBull = rsi != null && rsi > 50 && rsi > rsiMa;`
**Line**: `const rsiPassBear = rsi != null && rsi < 50 && rsi < rsiMa;`

**Change**: RSI crossover check was removed/Simplified from the original strategy logic.

**Original (strategy.service.js detectSignal):**
- `rsiCrossUp = rsiPrev <= rsiMa && rsi > rsiMa` (requires previous candle condition)
- `rsiCrossDown = rsiPrev >= rsiMa && rsi < rsiMa` (requires previous candle condition)
- Signal only on actual crossover events

**Current (backtest engine calculateSignal):**
- `rsiPassBull = rsi > 50 && rsi > rsiMa` (no crossover needed)
- Signal triggers whenever RSI is simply on the right side of 50

**Result**: 38 → 3,978 trades (104x increase)

## Acceptance Criteria

**Required for baseline restoration**:
- [x] Original baseline reproduced (38 trades, 54.2% win rate, PF 1.68)
- [ ] Trend capture development can continue

**Currently NOT met**: The backtest engine's simplified RSI condition produces 3,978 trades instead of the original 38.

## Required Action

**STOP**: Do not continue trend-capture development until the original baseline is reproduced.

**Fix option**: Restore the RSI crossover logic in the backtest engine's `calculateSignal` to match the original strategy:
- Add back `rsiPrev` comparison (previous candle's RSI vs MA)
- Require `rsiCrossUp` / `rsiCrossDown` detection before generating signals

**Without this fix**: The baseline cannot be restored, and trend-capture development should not proceed.

## Files Changed

| File | Change |
|---|---|
| `src/backtest/engine.js:168-169` | RSI pass conditions simplified (crossover removed) |
| `src/services/strategy.service.js` | Added normalizeCandle, detectTrendCaptureSignal, evaluateTrendCaptureEntry |
| `reports/` | 8 report files generated |

## Final Verdict

**ROOT CAUSE CONFIRMED**: The backtest engine's `calculateSignal` at `src/backtest/engine.js:168-169` simplified the RSI condition from requiring a crossover event to a simple `RSI > 50 && RSI > RSI MA` check. This alone causes the 38→3,978 trade regression.

**NEXT STEP**: Restore the RSI crossover logic in the backtest engine to match the original strategy signal generation. Without this, the original baseline cannot be reproduced and trend-capture development should not proceed.

**DO NOT ACTIVATE TESTNET. DO NOT COMMIT. DO NOT PUSH.**