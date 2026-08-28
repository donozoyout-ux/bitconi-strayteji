# V3-A EXIT ROOT CAUSE AUDIT

Analysis only. No code/param changes. 154 trades.

## Actual exit mechanics (discovered in engine)
- STOP_LOSS: fixed 2.5%
- TP1: +5% (50% partial)
- TP2: +7.5% (remaining 50%)
- TRAILING_STOP: highestSinceEntry - 2.5*ATR (dynamic)
- TIME_EXIT: after 5 candles

## HEADLINE FINDING
**99.4% of V3-A trades (153/154) are force-closed by TIME_EXIT after just 5 candles (~75 minutes).**
Trend events in this study run ~24h (96 candles). The 5-candle time exit closes trend positions
long before the trend develops (avg MFE only 0.38%). The SL (2.5%) and TP (5%/7.5%) essentially
NEVER trigger (1 SL, 0 TP across 154 trades), so the "stop too tight / TP too early" hypotheses are REJECTED.
The dominant bottleneck is the exit *duration* (time-exit window), not the SL/TP *width*.

## Exit classification (mapped to STOP_LOSS / TAKE_PROFIT / TIME_EXIT / OTHER)

| Bucket | Count | % | Win% | NetPnL |
|---|---|---|---|---|
| STOP_LOSS | 0 | 0% | 0% | 0 |
| TAKE_PROFIT | 0 | 0% | 0% | 0 |
| TIME_EXIT | 153 | 99.35% | 23.53% | -449.36 |
| OTHER | 1 | 0.65% | 0% | -27.18 |

Raw exit reasons: {"TIME_EXIT":153,"TRAILING_STOP":1}

## MFE / MAE

Avg MFE: 0.38%  Avg MAE: 0.34%

MFE dist: {"0-1%":146,"1-2%":5,"2-3%":2,"3-5%":1,"5-8%":0,"8%+":0}

MAE dist: {"0-1%":145,"1-2%":9,"2-2.5%":0,"2.5-4%":0,"4%+":0}

## Stopped-out then trend continued (STOP_LOSS + TRAILING_STOP, n=1)
- Recovered (any, 40c): 1 (100%)
- Recovered materially (>=2.5%, 40c): 0 (0%)
- Avg later favorable move: 0.61%  Median: 0.61%  Max: 0.61%

## TP hit then continued (n=0)
- +1%: 0  +2%: 0  +3%: 0  +5%: 0  +8%: 0
- Avg extra: NaN%  Median: 0%  Max: -Infinity%

## Winner/Loser shape
- Winners avg MFE: 0.86%  avg MAE: 0.25%  hold: 3c
- Losers avg MFE: 0.24%  avg MAE: 0.36%  hold: -13.94c
- Losers that first went profitable: MFE>0: 116  >1%: 1  >2%: 0

## LONG vs SHORT
- LONG PF: 0.29  net: -284.9  SL%: 1.23  TP%: 0  stopThenRecovered%: 1.23
- SHORT PF: 0.46  net: -191.64  SL%: 0  TP%: 0  stopThenRecovered%: 0

## Regime exit behavior
| Regime | Trades | PF | NetPnL | AvgMFE | AvgMAE |
|---|---|---|---|---|---|
| trend | 153 | 0.37 | -474.42 | 0.38 | 0.34 |
| range_chop | 1 | 0 | -2.13 | 0 | 0 |
| high_vol | 0 | undefined | undefined | undefined | undefined |

## Entry timing
| Timing | Trades | Win% | PF | NetPnL |
|---|---|---|---|---|
| EARLY | 0 | 0% | 0 | 0 |
| NORMAL | 2 | 50% | 1.96 | 3.11 |
| LATE | 107 | 20.56% | 0.3 | -377.99 |
| NO_EVENT | 45 | 28.89% | 0.51 | -101.67 |

## Exit failure categories (deterministic thresholds documented in JSON)

- STOP_TOO_TIGHT: 0 (0%)
- TP_TOO_EARLY: 0 (0%)
- TIME_EXIT_TOO_EARLY: 153 (99.35%)
- BAD_ENTRY: 0 (0%)
- LATE_ENTRY: 1 (0.65%)
- NORMAL_WIN: 0 (0%)
- NORMAL_LOSS: 0 (0%)

## ROOT CAUSE SUMMARY
Dominant: TIME_EXIT_TOO_EARLY (99.35%)
PF: undefined  NetPnL: -476.55
FINAL VERDICT: EXIT MECHANICS ARE PRIMARY BOTTLENECK

## Next research category (recommendation only — NOT implemented)
Trailing-stop / ATR-based stop / partial-TP / break-even research is warranted: the 0.0% of trades are explained by stop-too-tight or TP-too-early.
