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
const startup = require('./startup');
const fs = require('fs');
const path = require('path');

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

  // 9. Startup config-parity + DB health gate (deterministic TESTNET deployment)
  try {
    await startup.runStartupChecks();
  } catch (err) {
    logger.error('[SYSTEM] Startup checks failed:', err.message);
  }

  stopped = false;
  stateService.update({ busy: false, lastError: null });

  // Periodic audit retention: drop strategy_decisions older than 30 days.
  trimStrategyDecisions().catch(() => {});

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

// ---- EXIT_B3_SHORT_H1_ADX25 candidate (TESTNET forward test) ----
// These delegate to the SAME research entry/exit logic used by the backtest engine
// (strategy.service.detectTrendCaptureV3A + shortAdxFloor + EXIT-B ATR trailing) so the
// live path is a true parity copy. Gated behind settings.strategy === 'trend_capture_v3_a'.

const CANDIDATE_OPTS = {
  primaryTf: '15m', stratTf: '1h', regimeTf: '4h',
  bbPeriod: 20, bbStdDev: 2, rsiPeriod: 14, adxPeriod: 14, emaFast: 20, emaSlow: 50, atrPeriod: 14,
  confidence: 0.5, rsiEmaPeriod: 14, rsiMaPeriod: 50, adxFloor: 25, adxMin: 22, adxStrong: 30,
  regimeTf: '4h', stratTf: '1h', tpSlSource: 'atr', atrPeriod: 14, tpMult: 2.5, slMult: 2.5,
  bbFrac: 0.02, volFrac: 1.3, rsiMin: 50, rsiMax: 78, severeChopAdx: 20, useVol: true, minQuietAdx: 18,
};

async function researchEntryDecision(symbol, settings, candles) {
  const c = candles || await analyzer.fetchCandles(symbol, settings.executionTimeframe || '15m', 320);
  const tc = strategyEngine.detectTrendCaptureV3A(c, CANDIDATE_OPTS);
  let signal = tc.signal;
  let side = signal === 'LONG' ? 'LONG' : signal === 'SHORT' ? 'SHORT' : null;
  const close = c[c.length - 1][4];
  const ts = c[c.length - 1][0];
  // H1 SHORT filter: ADX >= shortAdxFloor (LONG untouched)
  if (side === 'SHORT' && (tc.reasons.adx == null || tc.reasons.adx < settings.shortAdxFloor)) {
    signal = null; side = null;
  }
  const slPercent = parseFloat(env.slPercent || '2.5');
  const stopPrice = side === 'LONG' ? close * (1 - slPercent / 100) : close * (1 + slPercent / 100);
  return {
    signal, side, score: tc.score, regime: tc.regime,
    reasons: {
      adx: tc.reasons.adx, rsi: tc.reasons.rsi, rsiMa: tc.reasons.rsiMa,
      atr: tc.reasons.atr, bbBasis: tc.reasons.bbBasis, bbLower: tc.reasons.bbLower, bbUpper: tc.reasons.bbUpper,
      pctB: tc.reasons.pctB, trendUp: tc.reasons.trendUp, chop: tc.reasons.chop,
      close, ts, stopPrice, slPercent,
      strategyVersion: settings.strategyVersion,
      entryReason: side ? ('V3A_' + side) : null,
    },
  };
}

function researchExitDecision(pos, candles, livePrice, settings) {
  const last = candles[candles.length - 1];
  const hi = last[2], lo = last[3];
  const extHigh = Math.max(pos.extHigh != null ? pos.extHigh : pos.entryPrice, hi);
  const extLow = Math.min(pos.extLow != null ? pos.extLow : pos.entryPrice, lo);
  const atrArr = strategyEngine.atrSeries ? strategyEngine.atrSeries(candles, 14) : null;
  const atr = atrArr ? atrArr[atrArr.length - 1] : (pos.atr || 0);
  const mult = settings.trendTrailingAtrMult || 3.0;
  const slPercent = parseFloat(env.slPercent || '2.5');
  const hardSL = pos.side === 'LONG' ? pos.entryPrice * (1 - slPercent / 100) : pos.entryPrice * (1 + slPercent / 100);
  let mfe = pos.mfe || 0;
  mfe = pos.side === 'LONG'
    ? Math.max(mfe, (extHigh - pos.entryPrice) / pos.entryPrice * 100)
    : Math.max(mfe, (pos.entryPrice - extLow) / pos.entryPrice * 100);
  let trailActive = pos.trailActive || false;
  if (!trailActive && mfe >= 1) trailActive = true;
  let trailingStop = null;
  if (trailActive && atr) trailingStop = pos.side === 'LONG' ? extHigh - mult * atr : extLow + mult * atr;

  let action = null, reason = null, exitPrice = null;
  if (pos.side === 'LONG' && livePrice <= hardSL) { action = 'SELL_ALL'; reason = 'STOP_LOSS'; exitPrice = hardSL; }
  else if (pos.side === 'SHORT' && livePrice >= hardSL) { action = 'SELL_ALL'; reason = 'STOP_LOSS'; exitPrice = hardSL; }
  if (!action && trailingStop != null) {
    if (pos.side === 'LONG' && livePrice <= trailingStop) { action = 'SELL_ALL'; reason = 'TRAILING_STOP'; exitPrice = trailingStop; }
    else if (pos.side === 'SHORT' && livePrice >= trailingStop) { action = 'SELL_ALL'; reason = 'TRAILING_STOP'; exitPrice = trailingStop; }
  }
  return { action, reason, exitPrice, extHigh, extLow, mfe, trailActive, trailingStop, hardSL, atr };
}

// Pre-trade safety/startup guard (section 7). Returns { ok, reasons }.
async function preTradeChecks(settings) {
  const reasons = [];
  // Config parity + startup gate (global blocks)
  const g = startup.getGate();
  if (g && g.blockReason) reasons.push(g.blockReason);
  const parity = settingsService.assertConfigParity(settings);
  if (!parity.ok) reasons.push('CONFIG_PARITY_FAIL: ' + parity.mismatches.join('; '));
  if (!env.useTestnet) reasons.push('USE_TESTNET=false (live endpoint would be used)');
  if (!env.isTestnet) reasons.push('isTestnet=false');
  if (env.emergencyStop) reasons.push('EMERGENCY_STOP active');
  if (!settings.useTestnet) reasons.push('settings.useTestnet=false');
  // DB healthy
  try { await db.query('SELECT 1'); } catch (e) { reasons.push('DB unreachable: ' + e.message); }
  // Fresh 15m candle
  try {
    const c = await analyzer.fetchCandles(env.tradingSymbol || 'BTC/USDT', settings.executionTimeframe || '15m', 2);
    const lastTs = c[c.length - 1][0];
    const ageMin = (Date.now() - lastTs) / 60000;
    if (ageMin > 25) reasons.push('stale 15m candle (age ' + ageMin.toFixed(1) + ' min)');
  } catch (e) { reasons.push('candle freshness check failed: ' + e.message); }
  // No orphan position / duplicate open order (best-effort)
  try {
    const st = stateService.get();
    if (st.position && st.position.symbol) {
      const openOrders = await exchange.fetchOpenOrders(env.tradingSymbol || 'BTC/USDT');
      const hasOpen = openOrders.some(o => o.symbol === (env.tradingSymbol || 'BTC/USDT'));
      if (hasOpen) reasons.push('open order already exists for symbol');
    }
  } catch (e) { reasons.push('order reconciliation check failed: ' + e.message); }
  return { ok: reasons.length === 0, reasons };
}

// Forward-test journal (section 6): append-only JSONL for every evaluated signal + closed trade,
// capturing the full research/audit field set. Avoids DB schema coupling.
const FORWARD_JOURNAL = path.join(__dirname, '..', '..', 'data', 'forward-test-journal.jsonl');
function appendForwardJournal(rec) {
  try {
    if (!fs.existsSync(path.dirname(FORWARD_JOURNAL))) fs.mkdirSync(path.dirname(FORWARD_JOURNAL), { recursive: true });
    fs.appendFileSync(FORWARD_JOURNAL, JSON.stringify(rec) + '\n');
  } catch (e) {
    logger.warn('[FORWARD-JOURNAL] write failed: ' + e.message);
  }
}

// ---- Strategy decision journal (audit / history) ----
// Every analysis cycle is persisted so the dashboard, backtests and audits can
// reconstruct what the bot "saw" (indicators + score + decision + reason) at any
// point in time. Errors are swallowed so logging never breaks the trading loop.
async function recordStrategyDecision(rec) {
  const { decision, score, regime, chop, reasons, symbol, price, ts } = rec || {};
  try {
    await db.query(
      `INSERT INTO strategy_decisions (decision, reasons, signal_score, regime, chop, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        decision,
        JSON.stringify({ ...(reasons || {}), symbol, price }),
        score == null || Number.isNaN(Number(score)) ? null : Math.round(Number(score)),
        regime || null,
        chop ? true : false,
        ts ? new Date(ts) : new Date(),
      ]
    );
  } catch (err) {
    logger.warn('[DECISION-LOG] strategy_decisions yazimi basarisiz:', err.message);
  }
}

// Keep strategy_decisions from growing without bound (default: keep 30 days).
async function trimStrategyDecisions(retentionDays = 30) {
  try {
    await db.query(
      `DELETE FROM strategy_decisions WHERE timestamp < NOW() - ($1 || ' days')::interval`,
      [String(retentionDays)]
    );
  } catch (err) {
    logger.warn('[DECISION-LOG] eski kayit temizligi basarisiz:', err.message);
  }
}

async function analyzeOnly() {
  const symbol = env.tradingSymbol || 'BTC/USDT';
  const settings = settingsService.get();
  const isCandidate = settings.strategy === 'trend_capture_v3_a';

  let candles, analysis, entryEval;
  if (isCandidate) {
    candles = await analyzer.fetchCandles(symbol, settings.executionTimeframe || '15m', 320);
    entryEval = await researchEntryDecision(symbol, settings, candles);
    analysis = { ts: entryEval.reasons.ts, close: entryEval.reasons.close, signal: entryEval.signal, reasons: entryEval.reasons };
  } else {
    candles = await analyzer.fetchCandles(symbol, env.analysisTimeframe, 220);
    analysis = analyzer.detectSignal(candles, env);
    entryEval = strategyEngine.evaluateEntry(candles, env);
  }

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
    trendEntry: { signal: entryEval.signal, type: entryEval.type, score: entryEval.score, reasons: entryEval.reasons },

    // Persist this analysis to the decision journal. When the autonomous engine is
    // enabled it already logs every cycle in runCycle(), so we only log here in
    // dashboard-only mode to avoid duplicate rows per candle. Throttled by candle ts.
    ...(env.tradingEnabled
      ? {}
      : (() => {
          const logTs = analysis.ts;
          const lastLogTs = stateService.get().lastDecisionLogTs;
          if (logTs && logTs !== lastLogTs) {
            stateService.update({ lastDecisionLogTs: logTs });
            recordStrategyDecision({
              decision: entryEval.signal || 'WAIT',
              score: entryEval.score,
              regime: entryEval.reasons && entryEval.reasons.regime,
              chop: entryEval.reasons && entryEval.reasons.chop,
              reasons: entryEval.reasons,
              symbol,
              price,
              ts: logTs,
            }).catch(() => {});
          }
          return {};
        })()),
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

  // Global startup gate: block ALL trading if config parity failed or DB unhealthy.
  const gate = startup.getGate();
  if (gate && gate.blockReason) {
    logger.error('[GATE] ' + gate.blockReason + ' -> tum islemler engellendi (NO TRADE).');
    stateService.update({ busy: false, lastError: gate.blockReason });
    return;
  }

  try {
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const settings = settingsService.get();
    const isCandidate = settings.strategy === 'trend_capture_v3_a';

    // Pre-trade safety / startup guard (section 7). NO TRADE if any check fails.
    if (isCandidate) {
      const guard = await preTradeChecks(settings);
      if (!guard.ok) {
        logger.error('[GUARD] Pre-trade checks failed -> NO TRADE: ' + guard.reasons.join('; '));
        stateService.update({ busy: false, lastError: 'PRE_TRADE_GUARD:' + guard.reasons.join('; ') });
        return;
      }
    }

    const candles = isCandidate
      ? await analyzer.fetchCandles(symbol, settings.executionTimeframe || '15m', 320)
      : await analyzer.fetchCandles(symbol, env.analysisTimeframe, 220);

    let entryEval, analysis;
    if (isCandidate) {
      entryEval = await researchEntryDecision(symbol, settings, candles);
      analysis = { ts: entryEval.reasons.ts, close: entryEval.reasons.close, signal: entryEval.signal, reasons: entryEval.reasons };
    } else {
      analysis = analyzer.detectSignal(candles, env);
      entryEval = strategyEngine.evaluateEntry(candles, env);
    }

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

    if (isCandidate) {
      appendForwardJournal({
        type: 'ENTRY_EVAL',
        ts: Date.now(),
        strategyVersion: settings.strategyVersion,
        symbol,
        signal: entryEval.signal,
        side: entryEval.side,
        score: entryEval.score,
        adx: entryEval.reasons.adx,
        rsi: entryEval.reasons.rsi,
        regime: entryEval.reasons.regime,
        adxAboveFloor: entryEval.reasons.adxAboveFloor,
        stopPrice: entryEval.reasons.stopPrice,
        atr: entryEval.reasons.atr,
        entryReason: entryEval.reasons.entryReason,
        reasons: entryEval.reasons,
      });
    }

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
      await recordStrategyDecision({ decision: 'NO_TRADE', score: entryEval.score, regime, chop: true, reasons: { reason: 'CHOPPY', ...entryEval.reasons }, symbol, price, ts: analysis.ts });
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
      await recordStrategyDecision({ decision: 'NO_TRADE', score: entryEval.score, regime, chop: true, reasons: { reason: 'COOLDOWN', ...entryEval.reasons }, symbol, price, ts: analysis.ts });
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

      await recordStrategyDecision({
        decision: 'NO_TRADE',
        score: entryEval.score,
        regime,
        chop: riskCheck.consecutiveLossesLimit > 0,
        reasons: { filters: decisionReasons, ...entryEval.reasons },
        symbol,
        price,
        ts: analysis.ts,
      });

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

    // Size position using risk engine
    let positionSize = null;
    if (entryEval.signal && isCandidate && entryEval.reasons.stopPrice != null && entryEval.reasons.close != null) {
      // EXIT_B3 candidate: risk is measured to the hard SL (2.5%)
      const stopDistance = Math.abs(entryEval.reasons.stopPrice - entryEval.reasons.close);
      if (stopDistance > 0) {
        const riskResult = riskEngine.calculatePositionSize(
          realUsdt,
          settings.riskPerTrade || env.riskPerTrade || 0.5,
          stopDistance,
          settings.maxLeverage || env.maxLeverage || 5
        );
        if (riskResult.success) positionSize = riskResult.positionSize;
      }
    } else if (entryEval.signal && entryEval.reasons.bbLower != null && entryEval.reasons.bbUpper != null) {
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

    // Journal this cycle's decision (LONG/SHORT when a signal fired, else WAIT).
    const finalDecision = entryEval.signal ? entryEval.signal : 'WAIT';
    await recordStrategyDecision({
      decision: finalDecision,
      score: entryEval.score,
      regime: entryEval.reasons.regime,
      chop: entryEval.reasons.chop,
      reasons: entryEval.reasons,
      symbol,
      price,
      ts: analysis.ts,
    });

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

  const settings = settingsService.get();
  const isCandidate = settings.strategy === 'trend_capture_v3_a';

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
    const action = entryEval.side === 'SHORT' || entryEval.side === 'SELL' ? 'SELL' : 'BUY';
    const result = await orderService.placeOrder(
      action,
      symbol,
      null,
      entryEval.side === 'LONG' || entryEval.side === 'BUY' ? budget : null
    );

    const pos = stateService.get().position;
    if (pos && isCandidate) {
      // EXIT_B3 candidate: store research metadata + trailing state on the position
      stateService.update({
        position: {
          ...pos,
          entryTs: Date.parse(result.timestamp),
          strategyVersion: entryEval.reasons.strategyVersion,
          entryReason: entryEval.reasons.entryReason,
          entryAdx: entryEval.reasons.adx,
          entryRsi: entryEval.reasons.rsi,
          atr: entryEval.reasons.atr,
          stopPrice: entryEval.reasons.stopPrice,
          tp1: null,
          tp2: null,
          extHigh: result.averagePrice || pos.entryPrice,
          extLow: result.averagePrice || pos.entryPrice,
          mfe: 0,
          trailActive: false,
        },
      });
    } else if (pos && env.strategyMode === 'trend') {
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

  const settings = settingsService.get();
  const isCandidate = settings.strategy === 'trend_capture_v3_a' && settings.exitStrategy === 'trend';
  const livePrice = await fetchLivePrice(symbol);

  if (isCandidate) {
    const dec = researchExitDecision(pos, candles, livePrice, settings);
    // persist trailing state each cycle
    stateService.update({
      position: { ...pos, extHigh: dec.extHigh, extLow: dec.extLow, mfe: dec.mfe, trailActive: dec.trailActive },
    });

    if (!dec.action) {
      // still log the evaluated signal each cycle (section 6: every signal)
      appendForwardJournal({
        type: 'EXIT_EVAL',
        ts: Date.now(),
        strategyVersion: settings.strategyVersion,
        symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        livePrice,
        extHigh: dec.extHigh,
        extLow: dec.extLow,
        mfe: dec.mfe,
        trailActive: dec.trailActive,
        hardSL: dec.hardSL,
        trailingStop: dec.trailingStop,
        atr: dec.atr,
        reason: dec.reason,
      });
      return;
    }

    logger.info(`[STRATEJI][${settings.strategyVersion}] ${dec.reason} tetiklendi -> ${symbol}`, {
      entry: pos.entryPrice,
      stop: dec.hardSL,
      trailing: dec.trailingStop,
      mfe: dec.mfe,
    });

    try {
      const result = await orderService.placeOrder('SELL', symbol, pos.quantity, null, {
        partial: false,
        tradeDetails: {
          strategyVersion: pos.strategyVersion,
          entryReason: pos.entryReason,
          exitReason: dec.reason,
          adx: pos.entryAdx,
          rsi: pos.entryRsi,
          mfe: dec.mfe,
          mae: pos.mae,
          atr: dec.atr,
          hardSL: dec.hardSL,
          trailingStop: dec.trailingStop,
        },
      });
      appendForwardJournal({
        type: 'TRADE_CLOSE',
        ts: Date.now(),
        strategyVersion: settings.strategyVersion,
        symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: livePrice,
        quantity: pos.quantity,
        entryReason: pos.entryReason,
        exitReason: dec.reason,
        adx: pos.entryAdx,
        rsi: pos.entryRsi,
        mfe: dec.mfe,
        mae: pos.mae,
        atr: dec.atr,
        orderId: result && result.orderId,
      });
    } catch (err) {
      logger.error('[STRATEJI] %s kapanis emri basarisiz -> %s', dec.reason, { error: err.message });
    }
    return;
  }

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