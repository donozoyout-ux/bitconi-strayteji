# EXIT_B3_SHORT_H1_ADX25 — CANONICAL (config-consistency corrected)

RISK PER TRADE: 0.5% | MAX LEVERAGE: 5 | ENTRY FEE: 0.1% | EXIT FEE: 0.1% | ROUND-TRIP: 0.2% | STARTING EQUITY: 10000

## CONFIG CONSISTENCY RESOLUTION
- Prior report said risk=1.0% / fee=0.04%. Engine ignores those keys.
- Actual values used by the 64-trade PF 1.74 run: riskPerTrade=0.5%, commissionRate=0.001 (0.1%/side).
- Position sizing: size = capital*0.5% / (2.5%*entryPrice), capped at capital*5x notional (cap not binding).

## Performance
total 64 | LONG 44 | SHORT 20
PF Infinity | net 765.53 | DD 2.95% | fees 260.14
LONG PF Infinity net 700.57
SHORT PF Infinity net 64.96
STOP_LOSS 16 | TRAILING_STOP 48

## Trend metrics
ORIGINAL (deduped runs): caught 4/10 (LONG 3/SHORT 1)
EXPANDED (per-start-index): caught 22/197 (LONG 17/SHORT 5)

REPRODUCIBILITY: PASS