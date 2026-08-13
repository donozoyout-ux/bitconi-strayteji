const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const analyzer = require('./analyzer.service');
const stateService = require('./state.service');
const orderService = require('./order.service');

let timer = null;

function start() {
  if (!env.tradingEnabled) {
    logger.warn('Otonom motor KAPALI (TRADING_MODE=off).');
    return;
  }
  logger.info(
    `Otonom analiz motoru baslatildi -> zaman: ${env.analysisTimeframe}, siklik: ${env.checkIntervalMin} dk, mod: ${env.dryRun ? 'DRY-RUN' : 'GERCEK TESTNET'}`
  );
  runCycle();
  timer = setInterval(runCycle, env.checkIntervalMin * 60000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function fetchLivePrice(symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
}

async function runCycle() {
  const state = stateService.get();
  if (!env.tradingEnabled) return;
  if (state.busy) {
    logger.warn('Onceki analiz hala suruyor, bu tur atlandi.');
    return;
  }
  stateService.update({ busy: true });

  try {
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const candles = await analyzer.fetchCandles(symbol, env.analysisTimeframe, 220);
    const analysis = analyzer.detectSignal(candles, env);
    const price = await fetchLivePrice(symbol);
    const balance = await exchange.fetchBalance();
    const realBtc = balance.BTC ? balance.BTC.total : 0;
    const realUsdt = balance.USDT ? balance.USDT.total : 0;

    const st = stateService.get();
    if (st.dryRun.USDT === null || st.dryRun.USDT === undefined) {
      stateService.update({ dryRun: { USDT: realUsdt, BTC: realBtc } });
    }

    if (st.position) {
      await handleExit(analysis, price, symbol);
    } else {
      await handleEntry(analysis, symbol);
    }

    stateService.update({
      busy: false,
      lastCheck: new Date().toISOString(),
      lastError: null,
      lastAnalysis: {
        ts: analysis.ts,
        signal: analysis.signal,
        close: analysis.close,
        bbLower: analysis.reasons.bbLower,
        k: analysis.reasons.k,
        d: analysis.reasons.d,
        price,
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

async function handleEntry(analysis, symbol) {
  if (!analysis.signal) return;

  const state = stateService.get();
  if (state.lastAnalyzedTs === analysis.ts) return;
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 60000);
    logger.info(`BUY sinyali var ama soguma suresi devam ediyor (${remaining} dk kaldi).`);
    return;
  }

  logger.info('[STRATEJI] BUY sinyali tespit edildi', analysis.reasons);
  try {
    const result = await orderService.placeOrder('BUY', symbol, null, env.budgetUsdt);
    logger.info('[STRATEJI] BUY emri acildi', {
      orderId: result.orderId,
      price: result.averagePrice,
      quantity: result.filled,
      mode: result.mode,
    });
  } catch (err) {
    logger.error('[STRATEJI] BUY emri basarisiz', { error: err.message });
  }
  stateService.update({ lastAnalyzedTs: analysis.ts });
}

async function handleExit(analysis, price, symbol) {
  const state = stateService.get();
  const entry = state.position.entryPrice;
  const tp = entry * (1 + env.tpPercent / 100);
  const sl = entry * (1 - env.slPercent / 100);

  let reason = null;
  if (price >= tp) reason = 'TAKE PROFIT';
  else if (price <= sl) reason = 'STOP LOSS';

  if (reason) {
    logger.info(`[STRATEJI] ${reason} tetiklendi -> ${symbol} fiyat ${price} (giris: ${entry}, TP: ${tp}, SL: ${sl})`);

    let sellQty;
    if (env.dryRun) {
      sellQty = state.position.quantity;
    } else {
      const b = await exchange.fetchBalance();
      sellQty = Math.floor((b.BTC ? b.BTC.free : 0) * 1e5) / 1e5;
    }

    if (!sellQty || sellQty <= 0) {
      logger.warn(`[STRATEJI] ${reason} icin satilacak miktar yok.`);
    } else {
      try {
        const result = await orderService.placeOrder('SELL', symbol, sellQty, null);
        logger.info(`[STRATEJI] ${reason} emri gonderildi`, {
          orderId: result.orderId,
          price: result.averagePrice,
          proceeds: result.spent,
          mode: result.mode,
        });
      } catch (err) {
        logger.error(`[STRATEJI] ${reason} emri basarisiz`, { error: err.message });
      }
    }
  }

  stateService.update({ lastAnalyzedTs: analysis.ts });
}

module.exports = { start, stop, runCycle };
