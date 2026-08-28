# TREND CAPTURE V3 — BB POSITION REDESIGN RESEARCH

Dataset: BTC/USDT 15m, 19,604 candles, 2026-02-11 to 2026-08-23

Strong trend events detected: 26 (LONG=15, SHORT=11)

## FINAL COMPARISON TABLE

| Metric | V2 | V3-A | V3-B | V3-C |
|---|---|---|---|---|
| Signals | 3048 | 172 | 1575 | 609 |
| Trades | 1106 | 154 | 680 | 440 |
| LONG | 555 | 81 | 336 | 228 |
| SHORT | 551 | 73 | 344 | 212 |
| Win Rate % | 21.34 | 23.38 | 23.82 | 14.32 |
| Profit Factor | 0.23 | 0.37 | 0.28 | 0.15 |
| Expectancy | -3.42 | -3.09 | -3.38 | -5.14 |
| Net PnL | -3781.68 | -476.55 | -2295.73 | -2262.61 |
| Max DD % | 38.01 | 5.91 | 23.46 | 22.8 |
| Trend Catch | 8 | 8 | 8 | 7 |
| Trend Catch % | 30.77 | 30.77 | 30.77 | 26.92 |
| LONG Catch | 5 | 5 | 5 | 4 |
| SHORT Catch | 3 | 3 | 3 | 3 |
| BB Rejection % | 0 | 50.67 | 34.94 | 0 |
| Trades/Week | 41.16 | 5.67 | 25.31 | 16.33 |

## DETERMINISM

- V2: deterministic=true (run1 trades=1106, run2 trades=1106, PF 0.95/0.95)
- V3-A: deterministic=true (run1 trades=154, run2 trades=154, PF 1.2/1.2)
- V3-B: deterministic=true (run1 trades=680, run2 trades=680, PF 1.05/1.05)
- V3-C: deterministic=true (run1 trades=440, run2 trades=440, PF 0.63/0.63)

## DIAGNOSTIC FUNNEL (rejection stages)

### V2
- LONG candidates: 4461, SHORT candidates: 4455
- Rejected by 4h regime: 10522, 1h alignment: 127
- Rejected by ADX: 0, Chop: 0, Anti-FOMO/pctB: 8916
- Rejected by BB position: 0, Pullback/Resumption: 0
- Final signals: 3048

### V3-A
- LONG candidates: 4461, SHORT candidates: 4455
- Rejected by 4h regime: 10522, 1h alignment: 127
- Rejected by ADX: 0, Chop: 0, Anti-FOMO/pctB: 4226
- Rejected by BB position: 4518, Pullback/Resumption: 0
- Final signals: 172

### V3-B
- LONG candidates: 4461, SHORT candidates: 4455
- Rejected by 4h regime: 10522, 1h alignment: 127
- Rejected by ADX: 0, Chop: 0, Anti-FOMO/pctB: 4226
- Rejected by BB position: 3115, Pullback/Resumption: 1575
- Final signals: 1575

### V3-C
- LONG candidates: 4461, SHORT candidates: 4455
- Rejected by 4h regime: 10522, 1h alignment: 127
- Rejected by ADX: 0, Chop: 0, Anti-FOMO/pctB: 4226
- Rejected by BB position: 0, Pullback/Resumption: 3769
- Final signals: 609

