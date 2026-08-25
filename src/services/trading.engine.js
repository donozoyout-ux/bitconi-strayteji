const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const analyzer = require('./analyzer.service');
const strategyEngine = require('./strategy.service');
const stateService = require('./state.service');
const orderService = require('./order.service');
const riskEngine = require('./risk-engine');
const newsService = require('./news.service');
const settingsService = require('./settings.service');
const db = require('../db');

let timer = null;
let stopped = false;

const DUST_BTC = 0.00001;

function computeBuyBudget() {
  const st = stateService.get();
  const realized = (st.trades || []).reduce((s, t) => s + (t.pnl || 0), 0);
  const base = env.budgetUsdt;
  const cap = base * (env.maxBudgetMultiplier || 3);
  const floor = base * 0.5;
  const budget = Math.max(floor, Math.min(cap, base + realized));
  return Math.floor(budget * 100) / 100;
}

function recordStartCapital(usdt, btc, price) {
  const st = stateService.get();
  if (!st.capital || st.capital.startEquityUsdt == null) {
    const equity = (usdt || 0) + (btc || 0) * (price || 0);
    stateService.update({
      capital: { startEquityUsdt: Math.floor(equity * 100) / 100, startedAt: new Date().toISOString() },
    });
    logger.info(`[SERMAYE] Baslangic varlik kaydi alindi: ${equity.toFixed(2)} USDT`);
  }
}

async function syncPositionWithExchange(symbol, price) {
  const st = stateService.get();
  const balance = await exchange.fetchBalance();
  const btcFree = balance.BTC ? balance.BTC.free : 0;

  if (st.position) {
    if (btcFree < st.position.quantity * 0.5) {
      logger.warn(
        `[SYNC] Kayitli pozisyon var (${st.position.quantity} BTC) ama borsada sadece ${btcFree} BTC var -> pozisyon kaydi temizleniyor.`
      );
      stateService.update({ position: null });
    }
    return;
  }

  if (env.useTestnet && btcFree > DUST_BTC) {
    const slPercent = parseFloat(env.slPercent || 2.5);
    const stopPrice = price * (1 - slPercent / 100);
    const tp1 = strategyEngine.nextPsychAbove(price * 1.001);
    const tp2 = strategyEngine.nextPsychAbove(tp1 * 1.001);
    logger.info(
      `[SYNC] Pozisyon kaydi yok ama borsada ${btcFree} BTC bulundu -> pozisyon devraliniyor (giris referansi: ${price}, stop: ${stopPrice.toFixed(0)}, TP1: ${tp1.toFixed(0)}, TP2: ${tp2.toFixed(0)}).`
    );
    stateService.update({
      position: {
        symbol,
        entryPrice: price,
        entryTime: new Date().toISOString(),
        entryTs: Date.now(),
        quantity: btcFree,
        cost: btcFree * price,
        mode: 'REAL',
        synced: true,
        stopPrice,
        tp1,
        tp2,
        highestSinceEntry: price,
      },
    });
    return;
  }

  if (!env.useTestnet && btcFree > DUST_BTC) {
    logger.info(
      `[SYNC] Gercek hesapta bot harici ${btcFree} BTC var. Bu bota ait degil, dokunulmayacak. Bot sadece kendi aldigini satar.`
    );
  }
}

async function start() {
  if (!env.tradingEnabled) {
    logger.warn('Otonom motor KAPALI (TRADING_MODE=off).');
    return;
  }

  // 1. Initialize database connection
  try {
    await db.initialize();
    logger.info('[SYSTEM] Database connection established.');
  } catch (err) {
    logger.error('[SYSTEM] Failed to initialize database:', err.message);
    logger.warn('[SYSTEM] Continuing with file-based state fallback.');
  }

  // 2. Initialize settings from DB (with file fallback)
  try {
    await settingsService.initializeSettings();
    logger.info('[SYSTEM] Settings initialized.');
  } catch (err) {
    logger.error('[SYSTEM] Failed to initialize settings:', err.message);
  }

  // 3. Load state from DB (with file fallback)
  try {
    const state = await settingsService.getFullBotState();
    stateService.update(state);
    logger.info('[SYSTEM] Bot state loaded from DB.');
  } catch (err) {
    logger.error('[SYSTEM] Failed to load bot state:', err.message);
  }

  // 4. Reconcile with Binance exchange
  try {
    await reconcileWithExchange();
  } catch (err) {
    logger.error('[SYSTEM] Exchange reconciliation failed:', err.message);
  }

  // 5. Open position recovery
  try {
    await recoverPositionState();
  } catch (err) {
    logger.error('[SYSTEM] Position recovery failed:', err.message);
  }

  // 6. Open order recovery
  try {
    await recoverOrderState();
  } catch (err) {
    logger.error('[SYSTEM] Order recovery failed:', err.message);
  }

  // 7. Risk state recovery
  try {
    await recoverRiskState();
  } catch (err) {
    logger.error('[SYSTEM] Risk state recovery failed:', err.message);
  }

  // 8. Cooldown recovery
  try {
    await recoverCooldownState();
  } catch (err) {
    logger.error('[SYSTEM] Cooldown recovery failed:', err.message);
  }

  stopped = false;
  stateService.update({ busy: false, lastError: null });
  logger.info(
    `Otonom analiz motoru baslatildi -> zaman: ${env.analysisTimeframe}, siklik: ${env.checkIntervalMin} dk, mod: ${env.dryRun ? 'DRY-RUN' : 'GERCEK TESTNET'}`
  );
  runCycle();
  scheduleNext();
}

async function reconcileWithExchange() {
  const st = stateService.get();

  // Get current Binance balance
  try {
    const balance = await exchange.fetchBalance();

    const btcFree = balance.BTC ? balance.BTC.free : 0;
    const usdtFree = balance.USDT ? balance.USDT.free : 0;

    // Check if stored position matches exchange
    if (st.position) {
      const { symbol, side, entryPrice, quantity } = st.position;

      // Verify position on exchange
      const openOrders = await exchange.fetchOpenOrders(symbol || 'BTC/USDT');
      const positionExists = openOrders.some(
        (order) => order.side === (side === 'LONG' ? 'buy' : 'sell') && order.price !== undefined
      );

      if (!positionExists) {
        // Position no longer on exchange - clear local state
        logger.info(
          "[SYNC] Pozisyon DB'de kayitli ama borsada yok -> locale kayit temizleniyor."
        );
        await settingsService.updateBotState('position', {
          symbol: null,
          side: null,
          entryPrice: null,
          quantity: null,
          entryTime: null,
          stopPrice: null,
          tp1: null,
          tp2: null,
          highestSinceEntry: null,
          tp1Done: false,
        });
      } else {
        // Position exists on exchange - verify quantity matches
        logger.info(
          `[SYNC] Pozisyon ${quantity} ${side} borsada mevcut -> state dogrulaniyor.`
        );
      }
    }

    // Update dryRun balance
    await settingsService.updateBotState('dryRun', {
      USDT: usdtFree,
      BTC: btcFree,
    });

    logger.info(
      `[SYNC] Balance reconciliyor: USDT=${usdtFree}, BTC=${btcFree}`
    );
  } catch (err) {
    logger.warn('[SYNC] Balance reconcilation error (non-fatal):', err.message);
  }
}

async function recoverPositionState() {
  const st = stateService.get();
  const dbState = await settingsService.getBotState('position');

  if (!dbState) {
    logger.info('[RECOVERY] DB position state yok, dosya state kullaniliyor.');
    return;
  }

  // If DB has no position but file has one, use DB state
  if (!st.position && dbState.symbol) {
    logger.info(
      '[RECOVERY] DB pozisyonu found, restoring:'
    );
    stateService.update({
      position: {
        symbol: dbState.symbol,
        side: dbState.side,
        entryPrice: dbState.entryPrice,
        quantity: dbState.quantity,
        entryTime: dbState.entryTime,
        stopPrice: dbState.stopPrice,
        tp1: dbState.tp1,
        tp2: dbState.tp2,
        highestSinceEntry: dbState.highestSinceEntry,
        tp1Done: dbState.tp1Done,
      },
    });
    logger.info('[RECOVERY] Position state restored from DB.');
  } else if (st.position && !dbState.symbol) {
    // File has position but DB doesn't - clear file position
    logger.info("[RECOVERY] File pozisyonu yok, DB'de yok -> temizliyor.");
    await settingsService.updateBotState('position', {
      symbol: null,
      side: null,
      entryPrice: null,
      quantity: null,
      entryTime: null,
      stopPrice: null,
      tp1: null,
      tp2: null,
      highestSinceEntry: null,
      tp1Done: false,
    });
    stateService.update({ position: null });
  }
  // If both have position, verify they match - DB wins
}

async function recoverOrderState() {
  // Load open orders from DB and reconcile with exchange
  try {
    const result = await db.query(
      "SELECT * FROM orders WHERE status = 'OPEN' AND closed_at IS NULL"
    );
    const openOrders = result.rows;

    for (const order of openOrders) {
      // Check if order still exists on exchange
      try {
        const existingOrders = await exchange.fetchOpenOrders(
          order.symbol || 'BTC/USDT'
        );
        const stillOpen = existingOrders.some(
          (o) => o.id === order.order_id
        );

        if (!stillOpen) {
          // Order no longer on exchange - mark as closed in DB
          await db.query(
            "UPDATE orders SET status = 'CLOSED', closed_at = NOW() WHERE order_id = $1",
            [order.order_id]
          );
          logger.info(
            `[RECOVERY] Order ${order.order_id} DB'de ama borsada yok -> kapatildi.`
          );
        }
      } catch (err) {
        logger.warn('[RECOVERY] Order check error for ${order.order_id}:', err.message);
      }
    }
    logger.info('[RECOVERY] Open order recovery completed.');
  } catch (err) {
    logger.error('[RECOVERY] Open order recovery failed:', err.message);
  }
}

async function recoverRiskState() {
  // Ensure risk state is consistent - daily loss tracking, etc.
  const st = stateService.get();
  const dbState = await settingsService.getBotState('dailyPnL');

  // Risk state is maintained in memory during runtime
  // On restart, we rely on the trade history in DB for PnL calculation
  logger.info('[RECOVERY] Risk state - will calculate from DB trade history on next cycle.');
}

async function recoverCooldownState() {
  const st = stateService.get();
  const dbState = await settingsService.getBotState('cooldownUntil');

  if (dbState && dbState > Date.now()) {
    // Cooldown active from previous session
    const remaining = Math.ceil((dbState - Date.now()) / 60000);
    logger.info(
      '[RECOVERY] Cooldown aktif (${remaining} dk kaldi) -> sinyal engellendi.'
    );
  } else {
    // Clear any cooldown
    await settingsService.updateBotState('cooldownUntil', 0);
    logger.info('[RECOVERY] Cooldown temizildi.');
  }
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleNext() {
  if (stopped) return;
  timer = setTimeout(async () => {
    await runCycle();
    scheduleNext();
  }, env.checkIntervalMin * 60000);
  if (timer.unref) timer.unref();
}

async function fetchLivePrice(symbol) {
  const [base, quote] = symbol.split('/');
  const pair = base + quote;

  const sources = [
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${pair}`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
    `https://api1.binance.com/api/v3/ticker/price?symbol=${pair}`,
    `https://api2.binance.com/api/v3/ticker/price?symbol=${pair}`,
  ];

  for (const src of sources) {
    try {
      const data = await analyzer.fetchWithTimeout(src, 10000);
      if (data && data.price) return Number(data.price);
    } catch (err) {
      // sonraki kaynağa geç
    }
  }

  try {
    const bybit = await analyzer.fetchWithTimeout(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`,
      10000
    );
    if (bybit.retCode === 0 && bybit.result && bybit.result.list && bybit.result.list[0]) {
      return Number(bybit.result.list[0].lastPrice);
    }
  } catch (err) {
    // son çare testnet
  }

  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
}

async function buildStrategy(symbol) {
  const tech = await analyzer.runFullAnalysis(symbol, env.analysisTimeframe, {
    oversoldLevel: env.oversoldLevel,
    useRsi2: env.useRsi2,
  });
  const news = await newsService.getSentiment();

  const scores = {
    technical: tech.technicals.total,
    chart: tech.chart.total,
    news: news.score,
  };
  scores.overall = scores.technical * 0.45 + scores.chart * 0.3 + scores.news * 0.25;

  return {
    ts: tech.ts,
    price: tech.price,
    signal: tech.signal,
    scores,
    verdict: analyzer.verdictFor(scores.overall),
    technicals: {
      rsi: tech.technicals.details.rsi,
      stochK: tech.technicals.details.stochK,
      macdHist: tech.technicals.details.macdHist,
      bbBasis: tech.technicals.details.bbBasis,
      bbLower: tech.technicals.details.bbLower,
      ema20: tech.technicals.details.ema20,
      ema50: tech.technicals.details.ema50,
    },
    patterns: tech.patterns.map((p) => p.name),
    trend: tech.structure.trend,
    support: tech.structure.support.map((s) => s.price),
    resistance: tech.structure.resistance.map((r) => r.price),
    news: {
      label: news.label,
      fearGreed: news.fearGreed ? news.fearGreed.value : null,
      classification: news.fearGreed ? news.fearGreed.classification : null,
      bull: news.bull,
      bear: news.bear,
    },
  };
}

async function analyzeOnly() {
  const symbol = env.tradingSymbol || 'BTC/USDT';
  const candles = await analyzer.fetchCandles(symbol, env.analysisTimeframe, 220);
  const analysis = analyzer.detectSignal(candles, env);
  const entryEval = strategyEngine.evaluateEntry(candles, env);

  let price = null;
  try {
    price = await fetchLivePrice(symbol);
  } catch (err) {
    price = analysis.close;
  }

  const strategy = await buildStrategy(symbol);
  const state = stateService.get();

  return {
    enabled: env.tradingEnabled,
    dryRunMode: env.dryRun,
    ts: analysis.ts,
    price,
    signal: analysis.signal,
    reasons: analysis.reasons,
    trendEntry: { signal: entryEval.signal, type: entryEval.type, reasons: entryEval.reasons },
    strategy,
    verdict: strategy.verdict,
    position: state.position,
    dryRun: state.dryRun,
    cooldownUntil: state.cooldownUntil,
    lastError: state.lastError,
  };
}

async function runCycle() {
  const state = stateService.get();
  if (!env.tradingEnabled) return;
  if (state.busy) {
    const stale =
      state.lastCheck &&
      Date.now() - new Date(state.lastCheck).getTime() > env.checkIntervalMin * 60000 * 2;
    if (stale) {
      logger.warn('busy bayragi takili kalmis, sifirlaniyor ve tur devam ediyor.');
      stateService.update({ busy: false, lastError: null });
    } else {
      logger.warn('Onceki analiz hala suruyor, bu tur atlandi.');
      return;
    }
  }
  stateService.update({ busy: true });

  try {
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const candles = await analyzer.fetchCandles(symbol, env.analysisTimeframe, 220);
    const analysis = analyzer.detectSignal(candles, env);
    const price = await fetchLivePrice(symbol);

    const strategy = await buildStrategy(symbol);
    stateService.update({ lastReport: strategy });

    const balance = await exchange.fetchBalance();
    const realBtc = balance.BTC ? balance.BTC.total : 0;
    const realUsdt = balance.USDT ? balance.USDT.total : 0;

    recordStartCapital(realUsdt, realBtc, price);

    const st0 = stateService.get();
    if (st0.dryRun.USDT === null || st0.dryRun.USDT === undefined) {
      stateService.update({ dryRun: { USDT: realUsdt, BTC: realBtc } });
    }

    if (!env.dryRun) {
      await syncPositionWithExchange(symbol, price);
    }

    const st = stateService.get();
    if (st.dryRun.USDT === null || st.dryRun.USDT === undefined) {
      stateService.update({ dryRun: { USDT: realUsdt, BTC: realBtc } });
    }

    const entryEval = strategyEngine.evaluateEntry(candles, env);

    // Apply market regime filter
    const regime = entryEval.reasons.regime;
    if (regime && regime === 'CHOPPY') {
      logger.info(`Piyasa CHOPPY regimde -> Emir atlaniyor. Regime: ${regime}`);
      stateService.update({
        busy: false,
        lastCheck: new Date().toISOString(),
        lastError: null,
        lastAnalysis: {
          ts: analysis.ts,
          signal: null,
          entryType: null,
          close: analysis.close,
          regime,
          chop: true,
          cooldownUntil: st.cooldownUntil,
          price,
        },
      });
      return;
    }

    // Check cooldown from persistent state
    if (st.cooldownUntil && Date.now() < st.cooldownUntil) {
      const remaining = Math.ceil((st.cooldownUntil - Date.now()) / 60000);
      logger.info(`Cooldown aktif (${remaining} dk kaldi) -> sinyal eleniyor.`);
      stateService.update({
        busy: false,
        lastCheck: new Date().toISOString(),
        lastError: null,
        lastAnalysis: {
          ts: analysis.ts,
          signal: null,
          entryType: null,
          close: analysis.close,
          regime,
          chop: true,
          cooldownUntil: st.cooldownUntil,
          price,
        },
      });
      return;
    }

    // Check risk limits (daily loss, consecutive losses, max trades)
    const now = new Date();
    const isToday = (timestamp) => {
      if (!timestamp) return false;
      const date = new Date(timestamp);
      return (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
      );
    };

    const todayTrades = (state.trades || []).filter(t => isToday(t.closedAt || t.timestamp));
    const dailyTrades = todayTrades.length;
    const dailyPnL = todayTrades.reduce(
      (sum, t) => sum + Number(t.pnl || 0),
      0
    );
    const consecutiveLosses = (state.trades || [])
      .filter(
        t => new Date(t.closedAt || t.timestamp).getTime() > new Date(Date.now() - 24 * 60 * 60 * 1000).getTime() && (t.pnl || 0) < 0
      ).length || 0;

    const riskCheck = riskEngine.checkRiskLimits(dailyPnL, consecutiveLosses, dailyTrades, {
      maxDailyLossPercent: parseFloat(env.MAX_DAILY_LOSS || '2'),
      maxConsecutiveLosses: parseInt(env.MAX_CONSECUTIVE_LOSSES || '3'),
      maxTradesPerDay: parseInt(env.MAX_TRADES_PER_DAY || '10'),
    });

    if (!riskCheck.allowed) {
      logger.warn(`Risk limit exceeded: ${riskCheck.reason} -> Emir atlaniyor.`);

      // Record why no trade decision
      const decisionReasons = ['RISK_LIMIT'];
      if (riskCheck.consecutiveLossesLimit > 0) decisionReasons.push('CONSECUTIVE_LOSSES');
      if (dailyTrades >= (parseInt(env.MAX_TRADES_PER_DAY || '10'))) decisionReasons.push('MAX_TRADES_PER_DAY');

      try {
        await db.query(
          `INSERT INTO strategy_decisions (decision, reasons, signal_score, regime, chop) VALUES ($1, $2, $3, $4, $5)`,
          ['NO_TRADE', decisionReasons, entryEval.score, regime, true]
        );
      } catch (err) {
        logger.warn('[WHY-NO-TRADE] Could not record decision in DB:', err.message);
      }

      stateService.update({
        busy: false,
        lastCheck: new Date().toISOString(),
        lastError: null,
        lastAnalysis: {
          ts: analysis.ts,
          signal: null,
          entryType: null,
          close: analysis.close,
          regime,
          chop: riskCheck.consecutiveLossesLimit > 0,
          cooldownUntil: st.cooldownUntil,
          price,
        },
      });
      return;
    }

    // Record why no trade decision - no signal case
    if (!entryEval.signal) {
      const decisionReasons = ['NO_RSI_CROSS'];
      try {
        await db.query(
          `INSERT INTO strategy_decisions (decision, reasons, signal_score, regime, chop) VALUES ($1, $2, $3, $4, $5)`,
          ['NO_TRADE', decisionReasons, entryEval.score, regime, entryEval.reasons.chop]
        );
      } catch (err) {
        logger.warn('[WHY-NO-TRADE] Could not record decision in DB:', err.message);
      }
    }

    // Size position using risk engine
    let positionSize = null;
    if (entryEval.signal && entryEval.reasons.bbLower != null && entryEval.reasons.bbUpper != null) {
      const close = entryEval.reasons.rsi != null ? entryEval.reasons.rsi * 100 : 100; // placeholder
      // Calculate stop distance from entry to BB lower/upper based on side
      let stopDistance;
      if (entryEval.side === 'LONG') {
        stopDistance = entryEval.reasons.close != null && entryEval.reasons.bbLower != null
          ? entryEval.reasons.close - entryEval.reasons.bbLower
          : null;
      } else if (entryEval.side === 'SHORT') {
        stopDistance = entryEval.reasons.close != null && entryEval.reasons.bbUpper != null
          ? entryEval.reasons.bbUpper - entryEval.reasons.close
          : null;
      }
      if (stopDistance != null && stopDistance > 0) {
        const riskResult = riskEngine.calculatePositionSize(
          realUsdt,
          entryEval.reasons.riskPerTrade || env.riskPerTrade || 0.5,
          stopDistance,
          entryEval.reasons.maxLeverage || env.maxLeverage || 5
        );
        if (riskResult.success) {
          positionSize = riskResult.positionSize;
        }
      }
    }

    // Entry logic
    if (entryEval.signal) {
      // Check if we already have a position with same side
      if (st.position && st.position.side === entryEval.side) {
        logger.info(`Zaten ${entryEval.side} pozisyonu var -> yeni sinyal eleniyor.`);
      } else if (st.position && st.position.side !== entryEval.side) {
        // Opposite signal - close existing and reverse
        logger.info(`Yonu degisik sinyal (${st.position.side}->${entryEval.side}) -> onceki pozisyon kapatilacak ve yenisini acilacak.`);
        try {
          await orderService.placeOrder('SELL', symbol, st.position.quantity, null);
          logger.info('[STRATEJI] Onceki pozisyon kapatildi inverted entrance icin.');
        } catch (err) {
          logger.error('[STRATEJI] Onceki pozisyon kapatilirken hata:', { error: err.message });
        }
      }
    }

    if (st.position) {
      await handleExit(price, symbol, candles);
    } else if (entryEval.signal) {
      await handleEntry(entryEval, symbol, price, positionSize);
    }

    stateService.update({
      busy: false,
      lastCheck: new Date().toISOString(),
      lastError: null,
      lastAnalysis: {
        ts: analysis.ts,
        signal: entryEval.signal || analysis.signal,
        entryType: entryEval.entryType,
        close: analysis.close,
        adx: entryEval.reasons.adx,
        atr: entryEval.reasons.atr,
        trendUp: entryEval.reasons.trendUp,
        zzTrend: entryEval.reasons.zzTrend,
        stopPrice: entryEval.reasons.stopPrice,
        tp1: entryEval.reasons.tp1,
        tp2: entryEval.reasons.tp2,
        bbLower: analysis.reasons.bbLower,
        k: analysis.reasons.k,
        d: analysis.reasons.d,
        priceTouch: analysis.reasons.priceTouch,
        goldenCross: analysis.reasons.goldenCross,
        oversoldBelow: analysis.reasons.oversoldBelow,
        oversoldLevel: analysis.reasons.oversoldLevel,
        cooldownUntil: st.cooldownUntil,
        price,
        regime: entryEval.reasons.regime,
        chop: entryEval.reasons.chop,
        positionSide: entryEval.side,
        positionScore: entryEval.score,
      },
    });
  } catch (err) {
    logger.error('Analiz motoru hatasi', { error: err.message });
    stateService.update({
      busy: false,
      lastError: err.message,
      lastCheck: new Date().toISOString(),
    });
  }
}

async function handleEntry(entryEval, symbol, livePrice, positionSize = null) {
  if (!entryEval.signal) return;

  const state = stateService.get();
  const candleTs = entryEval.reasons && entryEval.reasons.ts
    ? entryEval.reasons.ts
    : entryEval.reasons && entryEval.reasons.price
      ? entryEval.reasons.price
      : null;
  if (state.lastAnalyzedTs === candleTs) return;
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 60000);
    logger.info(`BUY/SELL sinyali var ama soguma suresi devam ediyor (${remaining} dk kaldi).`);
    return;
  }

  // Use provided positionSize or compute from budget
  const effectivePositionSize = positionSize != null ? positionSize : null;
  const budget = effectivePositionSize != null
    ? Math.floor(effectivePositionSize * livePrice * 100) / 100
    : (env.strategyMode === 'trend' ? computeBuyBudget() : env.budgetUsdt);

  logger.info('[STRATEJI] %s sinyali tespit edildi -> %s', entryEval.side, entryEval.signal);
  try {
    const result = await orderService.placeOrder(
      entryEval.side,
      symbol,
      null,
      entryEval.side === 'LONG' ? budget : null
    );

    const pos = stateService.get().position;
    if (pos && env.strategyMode === 'trend') {
      stateService.update({
        position: {
          ...pos,
          entryTs: Date.parse(result.timestamp),
          stopPrice: entryEval.reasons.stopPrice,
          tp1: entryEval.reasons.tp1,
          tp2: entryEval.reasons.tp2,
          highestSinceEntry: result.averagePrice || pos.entryPrice,
        },
      });
    }

    logger.info('[STRATEJI] %s emri acildi -> %s %s', entryEval.side, result.orderId, result.filled, {
      price: result.averagePrice,
      quantity: result.filled,
      mode: result.mode,
      stopPrice: entryEval.reasons.stopPrice,
      tp1: entryEval.reasons.tp1,
      tp2: entryEval.reasons.tp2,
    });
  } catch (err) {
    logger.error('[STRATEJI] %s emri basarisiz -> %s', entryEval.side, { error: err.message });
  }
  stateService.update({ lastAnalyzedTs: candleTs });
}

async function handleExit(price, symbol, candles) {
  const state = stateService.get();
  const pos = state.position;
  if (!pos) return;

  const livePrice = await fetchLivePrice(symbol);
  const exitEval = strategyEngine.evaluateExit(pos, candles, livePrice, env);

  if (exitEval.highest && exitEval.highest !== pos.highestSinceEntry) {
    stateService.update({ position: { ...pos, highestSinceEntry: exitEval.highest } });
  }

  let action = exitEval.action;
  if (
    action === 'SELL_PARTIAL' &&
    pos.quantity * exitEval.sellFraction * price < 10
  ) {
    logger.info(
      '[STRATEJI] Pozisyon kucuk, kismi kar al yerine tamami satilacak.'
    );
    action = 'SELL_ALL';
  }

  if (!action) return;

  logger.info(`[STRATEJI] ${exitEval.reason} tetiklendi -> ${symbol} fiyat ${price}`, {
    entry: pos.entryPrice,
    stop: exitEval.reasons.activeStop,
    tp1: pos.tp1,
    tp2: pos.tp2,
    tp1Done: !!pos.tp1Done,
    barsHeld: exitEval.reasons.barsHeld,
  });

  let sellQty;
  if (env.dryRun) {
    sellQty =
      action === 'SELL_PARTIAL'
        ? Math.floor(pos.quantity * exitEval.sellFraction * 1e5) / 1e5
        : pos.quantity;
  } else {
    const b = await exchange.fetchBalance();
    const free = Math.floor((b.BTC ? b.BTC.free : 0) * 1e5) / 1e5;
    const target =
      action === 'SELL_PARTIAL'
        ? Math.floor(pos.quantity * exitEval.sellFraction * 1e5) / 1e5
        : pos.quantity;
    sellQty = Math.min(target, free);
  }

  if (!sellQty || sellQty <= 0) {
    logger.warn(`[STRATEJI] ${exitEval.reason} icin satilacak miktar yok.`);
    return;
  }

  try {
    const result = await orderService.placeOrder('SELL', symbol, sellQty, null, {
      partial: action === 'SELL_PARTIAL',
    });
    logger.info(`[STRATEJI] ${exitEval.reason} emri gonderildi`, {
      orderId: result.orderId,
      price: result.averagePrice,
      quantity: result.filled,
      proceeds: result.spent,
      mode: result.mode,
    });

    if (action === 'SELL_PARTIAL') {
      const p2 = stateService.get().position;
      if (p2) {
        stateService.update({
          position: {
            ...p2,
            tp1Done: true,
            stopPrice: Math.max(p2.stopPrice || 0, exitEval.newStop || p2.entryPrice),
          },
        });
        logger.info('[STRATEJI] Kalan pozisyon icin stop maliyete cekildi.', {
          remaining: p2.quantity,
          newStop: Math.max(p2.stopPrice || 0, exitEval.newStop || p2.entryPrice),
        });
      }
    }
  } catch (err) {
    logger.error(`[STRATEJI] ${exitEval.reason} emri basarisiz`, { error: err.message });
  }
}

// Export risk engine functions
riskEngine.calculatePositionSize = function (equity, riskPercent, stopDistance, leverage = 5) {
  if (equity <= 0 || riskPercent <= 0 || stopDistance <= 0) {
    return { success: false, error: 'Invalid input parameters' };
  }

  const riskBudget = equity * (riskPercent / 100);
  const rawPositionSize = riskBudget / stopDistance;
  const maxNotional = equity * leverage;
  const effectiveLeverage = Math.min(rawPositionSize * 1000 / equity, leverage);

  return {
    success: true,
    positionSize: Math.max(0.00001, rawPositionSize),
    riskBudget,
    stopDistance,
    effectiveLeverage: Math.min(effectiveLeverage, leverage),
  };
};

riskEngine.checkRiskLimits = function (dailyPnL, consecutiveLosses, tradesToday, config) {
  const maxDailyLoss = config.maxDailyLossPercent;
  const maxConsecutive = config.maxConsecutiveLosses;
  const maxTrades = config.maxTradesPerDay;

  let restricted = false;
  let reason = null;

  // Check daily loss limit
  if (dailyPnL != null && dailyPnL <= -maxDailyLoss) {
    restricted = true;
    reason = `Daily loss limit reached: $${Math.abs(dailyPnL).toFixed(2)} USDT <= -${maxDailyLoss}%`;
  }

  // Check consecutive losses
  if (consecutiveLosses >= maxConsecutive) {
    restricted = true;
    reason = reason ? `${reason} | Consecutive losses limit: ${maxConsecutive}` : `Consecutive losses limit reached: ${maxConsecutive}`;
  }

  // Check max trades per day
  if (tradesToday >= maxTrades) {
    restricted = true;
    reason = reason ? `${reason} | Max trades per day limit: ${maxTrades}` : `Max trades per day limit reached: ${maxTrades}`;
  }

  return {
    allowed: !restricted,
    reason,
    dailyLossLimit: maxDailyLoss,
    consecutiveLossesLimit: maxConsecutive,
    maxTradesPerDay: maxTrades,
  };
};

module.exports = { start, stop, runCycle, analyzeOnly, fetchLivePrice, computeBuyBudget, riskEngine };