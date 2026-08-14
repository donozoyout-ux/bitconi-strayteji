const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const analyzer = require('./analyzer.service');
const stateService = require('./state.service');
const orderService = require('./order.service');
const newsService = require('./news.service');

let timer = null;

function start() {
  if (!env.tradingEnabled) {
    logger.warn('Otonom motor KAPALI (TRADING_MODE=off).');
    return;
  }
  stateService.update({ busy: false, lastError: null });
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
    logger.warn('Onceki analiz hala suruyor, bu tur atlandi.');
    return;
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

    const st = stateService.get();
    if (st.dryRun.USDT === null || st.dryRun.USDT === undefined) {
      stateService.update({ dryRun: { USDT: realUsdt, BTC: realBtc } });
    }

    if (st.position) {
      await handleExit(analysis, price, symbol);
    } else {
      await handleEntry(analysis, symbol, strategy);
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
        priceTouch: analysis.reasons.priceTouch,
        goldenCross: analysis.reasons.goldenCross,
        oversoldLevel: analysis.reasons.oversoldLevel,
        cooldownUntil: st.cooldownUntil,
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

async function handleEntry(analysis, symbol, strategy) {
  if (!analysis.signal) return;

  const state = stateService.get();
  if (state.lastAnalyzedTs === analysis.ts) return;
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 60000);
    logger.info(`BUY sinyali var ama soguma suresi devam ediyor (${remaining} dk kaldi).`);
    return;
  }

  if (strategy && strategy.scores && strategy.scores.overall < -0.5) {
    logger.warn(
      `BUY sinyali var ama strateji riski yuksek (genel skor ${strategy.scores.overall.toFixed(2)}). Emir atlanildi. Verdict: ${strategy.verdict}`
    );
    stateService.update({ lastAnalyzedTs: analysis.ts });
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

module.exports = { start, stop, runCycle, analyzeOnly, fetchLivePrice };
