const { rsiSeries, rsiMaSeries, bollinger, stochRsi, emaSeries, adxSeries, atrSeries, detectTrendCaptureSignal, detectTrendCaptureV3A, detectTrendCaptureV3B, detectTrendCaptureV3C, evaluateTrendCaptureEntry, precomputeIndicators } = require('../services/strategy.service');

function normalizeCandle(c) {
  if (!c) return c;
  if (Array.isArray(c)) return c; // already normalized or array format
  return [
    Number(c.timestamp),
    Number(c.open),
    Number(c.high),
    Number(c.low),
    Number(c.close),
    Number(c.volume),
  ];
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return candles;
  return candles.map(normalizeCandle);
}

function backtest(strategy, candles, initialCapital = 10000, config = {}) {
  const normalized = normalizeCandles(candles);
  const {
    riskPerTrade = 0.5,
    maxLeverage = 5,
    commissionRate = 0.001,
    slPercent = 2.5,
    tpPercent = 5,
    useRsi2 = false,
    // Exit strategy: 'scalp' (default: TP partial + trailing 2.5*ATR + 5-candle time exit)
    //               'trend' (EXIT-B: ATR trailing at trendTrailingAtrMult, no time exit, no TP, hard SL backstop)
    exitStrategy = 'scalp',
    trendTrailingAtrMult = 2.5,
    trendUseTP = false,
    trendTimeExitCandles = null,
    shortAdxFloor = 0,
  } = config;

  // Immutable strategy identity for observability / TESTNET auditing. Derived from the
  // active exit + entry configuration so every recorded trade carries the exact variant.
  const strategyVersion = 'EXIT_B3'
    + (exitStrategy === 'trend' ? '' : '_' + exitStrategy.toUpperCase())
    + (exitStrategy === 'trend' && trendTrailingAtrMult !== 2.5 ? '_M' + trendTrailingAtrMult : '')
    + (shortAdxFloor > 0 ? '_SHORT_H1_ADX' + shortAdxFloor : '');

  const n = normalized.length;
  if (n < 60) {
    throw new Error('Not enough candle data for backtest');
  }

  // Initialize tracking
  let capital = initialCapital;
  let position = null;
  let trades = [];
  let equityCurve = [];
  let consecutiveLosses = 0;
  let maxDrawdown = 0;
  let totalFees = 0;
  let winTrades = 0;
  let lossTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let signalScores = [];

  // Helper: get current close price
  function getClose(i) {
    return normalized[i][4]; // close price
  }
  function getOpen(i) {
    return normalized[i][1]; // open price
  }
  function getHigh(i) {
    return normalized[i][2]; // high price
  }
  function getLow(i) {
    return normalized[i][3]; // low price
  }
  function getTimestamp(i) {
    return normalized[i][0];
  }

  // Helper: calculate signal for candle at index i
  function calculateSignal(i) {
    // Need enough data - at least 30 + 5 candles before
    if (i < 35) return { signal: null, side: null, score: 0, regime: 'UNKNOWN', chop: true };

    // Get candle data up to and including i
    // Use closed candles only (slice(0, -1) equivalent)
    const lookback = i; // we're using 0-indexed, candle i is the current one
    const closePrices = [];
    const highs = [];
    const lows = [];

    for (let j = 1; j <= lookback; j++) {
      closePrices.push(normalized[lookback - j][4]);
      highs.push(normalized[lookback - j][2]);
      lows.push(normalized[lookback - j][3]);
    }

    // Reverse so oldest first, then current is last
    closePrices.reverse();
    highs.reverse();
    lows.reverse();

    // Get the current candle (last in array)
    const currentClose = closePrices[closePrices.length - 1];
    const currentHigh = highs[highs.length - 1];
    const currentLow = lows[lows.length - 1];

    // Calculate RSI (length 20)
    const rsiLen = 20;
    const rsiSeriesResult = rsiSeries(closePrices, rsiLen);
    const rsi = rsiSeriesResult[rsiSeriesResult.length - 1];

    // Calculate RSI MA (length 20)
    const rsiMaSeriesResult = rsiMaSeries(closePrices, rsiLen);
    const rsiMa = rsiMaSeriesResult[rsiMaSeriesResult.length - 1];

    // Calculate Bollinger Bands (length 30, mult 2)
    const bbLen = 30;
    const bbMult = 2;
    const bbResult = bollinger(closePrices, bbLen, bbMult);
    const bbLower = bbResult.lower[bbResult.lower.length - 1];
    const bbUpper = bbResult.upper[bbResult.length - 1];
    const bbBasis = bbResult.basis[bbResult.basis.length - 1];

    // Determine regime
    const adxLen = 14;
    const adxResult = adxSeries(normalized, adxLen);
    const adxVal = adxResult.adx[adxResult.adx.length - 1];
    const plusDI = adxResult.plusDI[adxResult.plusDI.length - 1];
    const minusDI = adxResult.minusDI[adxResult.minusDI.length - 1];
    const atrResult = atrSeries(normalized, 14);
    const atrVal = atrResult[atrResult.length - 1];

    const ema20SeriesResult = emaSeries(closePrices, 20);
    const ema20v = ema20SeriesResult[ema20SeriesResult.length - 1];
    const ema50SeriesResult = emaSeries(closePrices, 50);
    const ema50v = ema50SeriesResult[ema50SeriesResult.length - 1];

    let regime = 'UNKNOWN';
    let chop = true;
    const trendUp = ema20v > ema50v;

    if (adxVal != null) {
      const adxStrong = adxVal > 25;
      const adxModerate = adxVal > 20;

      if (adxStrong && trendUp) regime = 'STRONG_BULL';
      else if (adxStrong && !trendUp) regime = 'STRONG_BEAR';
      else if (adxModerate && trendUp) regime = 'BULL';
      else if (adxModerate && !trendUp) regime = 'BEAR';
      else if (bbUpper - bbLower > bbBasis * 0.4) regime = 'HIGH_VOLATILITY';
      else if ((bbUpper - bbLower) / bbBasis * 100 < 15) regime = 'RANGE';

      // Chop filter: count EMA crossovers
      let crossovers = 0;
      const lookbackWindow = Math.min(30, lookback);
      for (let j = 1; j < lookbackWindow; j++) {
        const ema20j = emaSeries(closePrices, 20)[j - 1] || 0;
        const ema50j = emaSeries(closePrices, 50)[j - 1] || 0;
        if (ema20j > ema50j && emaSeries(closePrices, 20)[j] <= emaSeries(closePrices, 50)[j]) crossovers++;
        if (ema20j < ema50j && emaSeries(closePrices, 20)[j] >= emaSeries(closePrices, 50)[j]) crossovers++;
      }
      chop = crossovers > 35;
      if (!chop && regime === 'UNKNOWN') {
        // Default regime if not choppy
        if (trendUp) regime = 'BULL';
        else regime = 'BEAR';
      }
    }

    // Signal determination: RSI + Bollinger only (Stoch RSI removed from core)
    let signal = null;
    let side = null;
    let score = 0;

    // RSI crossover detection
    // Use previous candle's RSI vs MA comparison (same as original strategy)
    const rsiPrev = rsiSeries(closePrices, rsiLen)[i - 1];
    const rsiMaPrev = rsiMaSeries(closePrices, rsiLen)[i - 1];

    const rsiCrossUp =
      rsiPrev != null &&
      rsiMaPrev != null &&
      rsiPrev <= rsiMaPrev &&
      rsi > rsiMa;

    const rsiCrossDown =
      rsiPrev != null &&
      rsiMaPrev != null &&
      rsiPrev >= rsiMaPrev &&
      rsi < rsiMa;

    const rsiPassBull =
      rsiCrossUp &&
      rsi != null &&
      rsi > 50;

    const rsiPassBear =
      rsiCrossDown &&
      rsi != null &&
      rsi < 50;

    const priceAboveBasis = currentClose >= bbBasis;
    const priceBelowBasis = currentClose <= bbBasis;
    const priceTouchLower = bbLower != null && (currentLow < bbLower || (currentClose != null && (currentClose - bbLower) / bbBasis < -0.005));
    const priceTouchUpper = bbUpper != null && (currentClose > bbUpper || (currentClose != null && (currentClose - bbUpper) / bbUpper > 0.005));

    // Bullish LONG signal: RSI bullish + BB confirmation
    if (rsiPassBull && (priceTouchLower || (priceAboveBasis && rsi > rsiMa))) {
      signal = 'LONG';
      side = 'LONG';
      // Calculate signal score: RSI + BB + regime + trend - chop
      let signalScore = 0;

      // RSI component (30 points)
      const rsiDistance = Math.abs(rsi - rsiMa) / 10;
      if (rsi > rsiMa && rsi > 50) {
        signalScore += 30 - rsiDistance * 2;
      } else if (rsi < rsiMa && rsi < 50) {
        signalScore += 30 - rsiDistance * 2;
      }

      // Bollinger confirmation (20 points)
      const pctB = bbBasis != null && bbLower != null && bbUpper != null
        ? ((currentClose - bbLower) / (bbUpper - bbLower) * 100)
        : null;
      if (pctB != null && pctB < 5) {
        signalScore += 20; // Price near lower band = strong bullish
      } else if (pctB != null && pctB > 95) {
        signalScore += 20; // Price near upper band = strong bearish
      } else if (pctB != null && pctB > 30 && pctB < 70) {
        signalScore += 10; // Price in middle = neutral
      }

      // Market regime (20 points)
      if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
        signalScore += 20;
        if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') {
          signalScore += 10;
        }
      } else if (regime === 'CHOPPY') {
        signalScore -= 30; // Penalty for choppy market
      }

      // Trend confirmation (15 points)
      if (ema20v != null) {
        signalScore += trendUp ? 15 : 5;
      }

      // Anti-chop (15 points)
      if (chop) {
        signalScore -= 30;
      }

      score = Math.max(0, Math.min(100, signalScore));
    }
    // Bearish SHORT signal
    else if (rsiPassBear && (priceTouchUpper || (priceBelowBasis && rsi < rsiMa))) {
      signal = 'SHORT';
      side = 'SHORT';
      let signalScore = 0;

      const rsiDistance = Math.abs(rsi - rsiMa) / 10;
      if (rsi < rsiMa && rsi < 50) {
        signalScore += 30 - rsiDistance * 2;
      }

      const pctB = bbBasis != null && bbLower != null && bbUpper != null
        ? ((currentClose - bbLower) / (bbUpper - bbLower) * 100)
        : null;
      if (pctB != null && pctB > 95) {
        signalScore += 20;
      } else if (pctB != null && pctB < 30 && pctB > 70) {
        signalScore += 10;
      }

      if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
        signalScore += 20;
        if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') {
          signalScore += 10;
        }
      } else if (regime === 'CHOPPY') {
        signalScore -= 30;
      }

      if (ema20v != null) {
        signalScore += !trendUp ? 15 : 5;
      }

      if (chop) {
        signalScore -= 30;
      }

      score = Math.max(0, Math.min(100, signalScore));
    }

    return {
      signal,
      side,
      score,
      regime,
      chop,
    };
  }

const v2Opts = {
    rsiLen: 20,
    bbLength: 30,
    bbMult: 2,
    executionTimeframe: '15m',
    higherTimeframe: '1h',
    regimeTimeframe: '4h',
    chopThreshold: 35,
  };

  // Initialize per-variant diagnostics (V2 + V3 research variants)
  const tcVariants = ['trend_capture_v2', 'trend_capture_v3_a', 'trend_capture_v3_b', 'trend_capture_v3_c'];
  function makeDiag() {
    return {
      functionCalls: 0,
      validContexts: 0,
      longCandidates: 0,
      shortCandidates: 0,
      rejectedBy4hRegime: 0,
      rejectedBy1hAlignment: 0,
      rejectedByADX: 0,
      rejectedByChop: 0,
      rejectedByBBPosition: 0,
      rejectedByPctB: 0,
      rejectedByRSI: 0,
      rejectedByPullback: 0,
      rejectedByResumption: 0,
      rejectedByAntiFomo: 0,
      finalSignals: 0,
      trades: 0,
    };
  }
  const tcDiag = {};
  tcVariants.forEach((v) => { tcDiag[v] = makeDiag(); });

  function selectTCFn(strategy) {
    if (strategy.indexOf('trend_capture_v2') !== -1) return detectTrendCaptureSignal;
    if (strategy.indexOf('trend_capture_v3_a') !== -1) return detectTrendCaptureV3A;
    if (strategy.indexOf('trend_capture_v3_b') !== -1) return detectTrendCaptureV3B;
    if (strategy.indexOf('trend_capture_v3_c') !== -1) return detectTrendCaptureV3C;
    return null;
  }

  // Raw candles for V2 (detectTrendCaptureSignal internally normalizes them)
  // We must pass the original raw candles, not the backtest's normalized arrays,
  // because detectTrendCaptureSignal's normalizeCandle expects objects with
  // named keys (timestamp, open, etc.), not numeric arrays.
  const rawCandles = candles;

  // Precompute full-series indicators ONCE for trend-capture variants to avoid
  // the O(n^2) per-candle recompute that previously caused OOM. The detector's
  // resolveTrendIndicators uses opts.precomputed at index opts.precomputedIndex.
  const isTCStrategy = /trend_capture_(v2|v3)/.test(strategy);
  const tcPrecomputed = isTCStrategy ? precomputeIndicators(rawCandles, v2Opts) : null;

  // Main backtest loop - candle by candle, no look-ahead
  for (let i = 35; i < n; i++) {
    let result;

// Strategy mode: use V2 / V3 variants or baseline
    const tcFn = selectTCFn(strategy);
    if (tcFn && i >= 39) {
      // Start from i=39 to ensure RSI MA is valid (rsiMa first non-null at index 39)
      // Pass candles up to and including i: rawCandles.slice(0, i+1).
      // Strategy function internally normalizes, and evaluates candle at index i.
      const tcCandles = rawCandles; // precomputed path ignores the slice; pass full set
      if (rawCandles.length >= 39) {
        const d = tcDiag[strategy];
        d.functionCalls++;
        const tcResult = tcFn(tcCandles, Object.assign({}, v2Opts, { precomputed: tcPrecomputed, precomputedIndex: i }));
        d.functionCalls++;

        const tcRegime = tcResult.regime;
        const tcAdx = tcResult.reasons.adx;
        const tcTrendUp = tcResult.reasons.trendUp;
        const tcPctB = tcResult.reasons.pctB;
        const tcRsi = tcResult.reasons.rsi;
        const tcRsiMa = tcResult.reasons.rsiMa;

        const validContext =
          tcRegime != null &&
          tcAdx != null &&
          tcTrendUp != null &&
          tcPctB != null &&
          tcRsi != null &&
          tcRsiMa != null;

        if (validContext) {
          d.validContexts++;
          if (tcResult.signal === 'LONG') {
            d.longCandidates++;
            d.finalSignals++;
          } else if (tcResult.signal === 'SHORT') {
            d.shortCandidates++;
            d.finalSignals++;
          }
        }
        result = {
          signal: tcResult.signal,
          side: tcResult.signal === 'LONG' ? 'LONG' : tcResult.signal === 'SHORT' ? 'SHORT' : null,
          score: tcResult.score,
          regime: tcResult.regime,
          chop: tcResult.chop,
        };
        // Research-only SHORT quality filter (H1): require ADX >= shortAdxFloor.
        // LONG untouched. Default 0 = disabled (EXIT-B3 unchanged).
        if (shortAdxFloor > 0 && result.signal === 'SHORT' && (tcAdx == null || tcAdx < shortAdxFloor)) {
          result = { signal: null, side: null, score: 0, regime: result.regime, chop: result.chop };
        }
      } else {
        result = { signal: null, side: null, score: 0, regime: 'UNKNOWN', chop: true };
      }
    } else {
      // === BASELINE_V1 MODE (default) ===
      result = calculateSignal(i);
      signalScores.push(result.score);
    }

    const close = getClose(i);
    const timestamp = getTimestamp(i);

    // If no position and we get a signal, enter trade
    if (!position && result.signal) {
      const entryPrice = close;
      const side = result.side;

      // Calculate position size using risk engine logic
      const stopDistance = slPercent / 100 * entryPrice; // based on percentage
      const riskBudget = capital * (riskPerTrade / 100);
      const rawPositionSize = riskBudget / stopDistance;
      const minLotSize = 0.00001;
      let positionSize = Math.max(minLotSize, rawPositionSize);

      // Apply leverage constraint
      const maxNotional = capital * maxLeverage;
      const notional = positionSize * entryPrice;
      if (notional > maxNotional) {
        const scaledPositionSize = maxNotional / entryPrice;
        positionSize = Math.min(positionSize, scaledPositionSize);
      }

      // Calculate TP/SL levels
      const tp1Price = side === 'LONG'
        ? entryPrice * (1 + tpPercent / 100)
        : entryPrice * (1 - tpPercent / 100);
      const tp2Price = side === 'LONG'
        ? entryPrice * (1 + tpPercent * 1.5 / 100)
        : entryPrice * (1 - tpPercent * 1.5 / 100);
      const stopPrice = side === 'LONG'
        ? entryPrice * (1 - slPercent / 100)
        : entryPrice * (1 + slPercent / 100);

      // Open position
      position = {
        entryPrice,
        entryTime: timestamp,
        side,
        quantity: positionSize,
        stopPrice,
        tp1: tp1Price,
        tp2: tp2Price,
        tp1Done: false,
        highestSinceEntry: entryPrice,
        lowestSinceEntry: entryPrice,
        extHigh: getHigh(i),
        extLow: getLow(i),
        barsHeld: 1,
        mfe: 0,
        mae: 0,
        trailActive: false,
        entryAdx: (tcPrecomputed && tcPrecomputed.adx) ? tcPrecomputed.adx.adx[i] : null,
        entryRsi: (tcPrecomputed && tcPrecomputed.rsi) ? tcPrecomputed.rsi[i] : null,
        regime: result.regime,
        entryReason: 'V3A_' + side,
        strategyVersion: strategyVersion,
      };

      // Track trades for trend_capture variants (V2 + V3)
      if (tcDiag[strategy]) {
        tcDiag[strategy].trades++;
      }

      signalScores.push(result.score);
    }

    // If in a position, check for exit conditions
    if (position) {
      // Update highest/lowest since entry
      if (position.side === 'LONG') {
        if (close > position.highestSinceEntry) {
          position.highestSinceEntry = close;
        }
        if (close < position.lowestSinceEntry) {
          position.lowestSinceEntry = close;
        }
        if (getHigh(i) > position.extHigh) position.extHigh = getHigh(i);
        if (getLow(i) < position.extLow) position.extLow = getLow(i);
      } else {
        if (close < position.lowestSinceEntry) {
          position.lowestSinceEntry = close;
        }
        if (close > position.highestSinceEntry) {
          position.highestSinceEntry = close;
        }
        if (getLow(i) < position.extLow) position.extLow = getLow(i);
        if (getHigh(i) > position.extHigh) position.extHigh = getHigh(i);
      }

      // Check TP1 hit (partial) — only in scalp mode or when trend TP enabled
      let exited = false;
      let exitPrice = null;
      let exitReason = null;
      let sellFraction = 1;

      if ((exitStrategy === 'scalp' || trendUseTP) && !position.tp1Done) {
        if (position.side === 'LONG' && close >= position.tp1) {
          exitPrice = position.tp1;
          exitReason = 'TP1_HIT';
          sellFraction = 50 / 100; // 50% partial
          position.tp1Done = true;
          exited = true;
        } else if (position.side === 'SHORT' && close <= position.tp1) {
          exitPrice = position.tp1;
          exitReason = 'TP1_HIT';
          sellFraction = 50 / 100;
          position.tp1Done = true;
          exited = true;
        }
      }

      // Check TP2 hit (full remaining)
      if (position.tp1Done && position.tp2) {
        if (position.side === 'LONG' && close >= position.tp2) {
          exitPrice = position.tp2;
          exitReason = 'TP2_HIT';
          exited = true;
        } else if (position.side === 'SHORT' && close <= position.tp2) {
          exitPrice = position.tp2;
          exitReason = 'TP2_HIT';
          exited = true;
        }
      }

      // Track max favorable excursion (MFE, in %) for trend mode so the trailing
      // stop only activates after the trade is at least +1% in profit (matches
      // research harness EXIT-B behaviour: trailing engages at +1R).
      if (exitStrategy === 'trend') {
        if (position.side === 'LONG') position.mfe = Math.max(position.mfe, (position.extHigh - position.entryPrice) / position.entryPrice * 100);
        else position.mfe = Math.max(position.mfe, (position.entryPrice - position.extLow) / position.entryPrice * 100);
        if (position.side === 'LONG') position.mae = Math.max(position.mae, (position.entryPrice - position.extLow) / position.entryPrice * 100);
        else position.mae = Math.max(position.mae, (position.extHigh - position.entryPrice) / position.entryPrice * 100);
        if (!position.trailActive && position.mfe >= 1) position.trailActive = true;
      }

      // Check trailing stop
      if (!exited && (exitStrategy !== 'trend' || position.trailActive)) {
        const atr = (tcPrecomputed && tcPrecomputed.atr) ? tcPrecomputed.atr[i] : (atrSeries(normalized, 14)[i] || 0);
        const trailMult = (exitStrategy === 'trend') ? trendTrailingAtrMult : 2.5;
        // In trend mode use extreme high/low (matches research harness); scalp keeps close-based extreme
        const extHi = (exitStrategy === 'trend') ? position.extHigh : position.highestSinceEntry;
        const extLo = (exitStrategy === 'trend') ? position.extLow : position.lowestSinceEntry;
        let trailingStop;
        if (position.side === 'LONG') {
          // Trailing stop: highest since entry - ATR * trailMult
          trailingStop = extHi - trailMult * atr;
        } else {
          trailingStop = extLo + trailMult * atr;
        }

        if (position.side === 'LONG' && close <= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'TRAILING_STOP';
          exited = true;
        } else if (position.side === 'SHORT' && close >= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'TRAILING_STOP';
          exited = true;
        }
      }

      // Check time exit (scalp: 5 candles; trend: configurable or disabled)
      if (!exited) {
        const timeExitCandles = (exitStrategy === 'trend') ? trendTimeExitCandles : 5;
        if (timeExitCandles && position.barsHeld != null) {
          position.barsHeld = (position.barsHeld || 0) + 1;
          if (position.barsHeld >= timeExitCandles) {
            exitPrice = close;
            exitReason = 'TIME_EXIT';
            exited = true;
          }
        }
      }

      // Check stop loss
      if (!exited) {
        if (position.side === 'LONG' && close <= position.stopPrice) {
          exitPrice = position.stopPrice;
          exitReason = 'STOP_LOSS';
          exited = true;
        } else if (position.side === 'SHORT' && close >= position.stopPrice) {
          exitPrice = position.stopPrice;
          exitReason = 'STOP_LOSS';
          exited = true;
        }
      }

      // Execute exit if any condition met
      if (exited && exitPrice != null) {
        // Calculate PnL
        let pnl = 0;
        let fees = 0;

        // For partial exits, only count fraction
        const effectiveQuantity = position.quantity * sellFraction;

        if (position.side === 'LONG') {
          pnl = (exitPrice - position.entryPrice) * effectiveQuantity;
        } else {
          pnl = (position.entryPrice - exitPrice) * effectiveQuantity;
        }

        // Calculate fees (round-trip: entry + exit)
        fees = Math.abs(position.entryPrice * effectiveQuantity * commissionRate) + Math.abs(exitPrice * effectiveQuantity * commissionRate);
        totalFees += fees;

        // Update capital
        capital += pnl - fees;
        const netP = pnl - fees;
        if (netP > 0) grossWin += netP; else grossLoss += Math.abs(netP);
        winTrades += pnl > 0 ? sellFraction : 0;
        lossTrades += pnl < 0 ? sellFraction : 0;
        consecutiveLosses += pnl < 0 ? sellFraction : 0;
        maxDrawdown = Math.max(maxDrawdown, Math.abs(pnl - fees));

        // Track trade
        const trade = {
          entryPrice: position.entryPrice,
          exitPrice,
          quantity: effectiveQuantity,
          side: position.side,
          entryTime: position.entryTime,
          exitTime: timestamp,
          pnl: pnl - fees,
          pnlPercent: ((exitPrice - position.entryPrice) / position.entryPrice) * 100 * (position.side === 'LONG' ? 1 : -1),
          fee: fees,
          exitReason,
          entryReason: position.entryReason,
          regime: result.regime,
          signalScore: result.score,
          adx: position.entryAdx,
          rsi: position.entryRsi,
          mfe: position.mfe,
          mae: position.mae,
          strategyVersion: position.strategyVersion,
          maxDrawdown,
        };

        trades.push(trade);

        // Reset position
        position = null;
        consecutiveLosses = pnl < 0 ? (consecutiveLosses + sellFraction) : 0;
      } else {
        // Increment bars held
        if (position.barsHeld == null) position.barsHeld = 1;
        else position.barsHeld++;
      }
    }

    equityCurve.push(capital);
  }

  // Calculate final metrics
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? Infinity : 1);
  const netPnL = capital - initialCapital;
  const expectancy = totalTrades > 0 ? (winRate / 100) * profitFactor * (profitFactor > 0 ? profitFactor : 1) - (1 - winRate / 100) : 0;
  const avgWin = winTrades > 0 ? totalWins / winTrades : 0;
  const avgLoss = lossTrades > 0 ? totalLosses / lossTrades : 0;
  const avgTrade = totalTrades > 0 ? netPnL / totalTrades : 0;
  const longTradeCount = trades.filter(t => t.side === 'LONG').length;
  const shortTradeCount = trades.filter(t => t.side === 'SHORT').length;

  return {
    initialCapital,
    finalCapital: capital,
    netPnL,
    totalTrades,
    winRate: Math.round(winRate * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    avgTrade: Math.round(avgTrade * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    longTrades,
    shortTrades,
    tradeDetails: trades,
    equityCurve,
    signalStats: {
      avgScore: signalScores.length > 0
        ? Math.round((signalScores.reduce((a, b) => a + b, 0) / signalScores.length) * 100) / 100
        : 0,
      minScore: signalScores.length > 0 ? Math.min(...signalScores) : 0,
      maxScore: signalScores.length > 0 ? Math.max(...signalScores) : 0,
    },
    config: {
      riskPerTrade,
      maxLeverage,
      commissionRate,
      slPercent,
      tpPercent,
      useRsi2,
    },
    // Per-variant diagnostics (V2 + V3 research variants)
    trendCaptureDiagnostics: tcVariants.reduce((acc, v) => {
      acc[v] = tcDiag[v];
      return acc;
    }, {}),
  };
}

module.exports = { backtest };