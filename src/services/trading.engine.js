const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const analyzer = require('./analyzer.service');
const strategyEngine = require('./strategy.service');
const stateService = require('./state.service');
const orderService = require('./order.service');
const newsService = require('./news.service');

let timer = null;
let stopped = false;

const DUST_BTC = 0.00001;

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
    logger.info(
      `[SYNC] Pozisyon kaydi yok ama borsada ${btcFree} BTC bulundu -> pozisyon devraliniyor (giris referansi: ${price}).`
    );
    stateService.update({
      position: {
        symbol,
        entryPrice: price,
        entryTime: new Date().toISOString(),
        quantity: btcFree,
        cost: btcFree * price,
        mode: 'REAL',
        synced: true,
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

function start() {
  if (!env.tradingEnabled) {
    logger.warn('Otonom motor KAPALI (TRADING_MODE=off).');
    return;
  }
  stopped = false;
  stateService.update({ busy: false, lastError: null });
  logger.info(
    `Otonom analiz motoru baslatildi -> zaman: ${env.analysisTimeframe}, siklik: ${env.checkIntervalMin} dk, mod: ${env.dryRun ? 'DRY-RUN' : 'GERCEK TESTNET'}`
  );
  runCycle();
  scheduleNext();
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

    if (st.position) {
      await handleExit(price, symbol, candles);
    } else if (env.strategyMode === 'trend') {
      await handleEntry(entryEval, symbol, strategy);
    } else {
      await handleEntry(analysis, symbol, strategy);
    }

    stateService.update({
      busy: false,
      lastCheck: new Date().toISOString(),
      lastError: null,
      lastAnalysis: {
        ts: analysis.ts,
        signal: entryEval.signal || analysis.signal,
        entryType: entryEval.type,
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
  const candleTs = analysis.ts != null ? analysis.ts : analysis.reasons && analysis.reasons.price;
  if (state.lastAnalyzedTs === candleTs) return;
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 60000);
    logger.info(`BUY sinyali var ama soguma suresi devam ediyor (${remaining} dk kaldi).`);
    return;
  }

  if (strategy && strategy.scores && strategy.scores.overall < -0.5) {
    logger.warn(
      `BUY sinyali var ama strateji riski yuksek (genel skor ${strategy.scores.overall.toFixed(2)}). Emir atlanildi. Verdict: ${strategy.verdict}`
    );
    stateService.update({ lastAnalyzedTs: candleTs });
    return;
  }

  logger.info('[STRATEJI] BUY sinyali tespit edildi', analysis.reasons);
  try {
    const result = await orderService.placeOrder('BUY', symbol, null, env.budgetUsdt);

    const pos = stateService.get().position;
    if (pos && env.strategyMode === 'trend') {
      stateService.update({
        position: {
          ...pos,
          entryTs: Date.parse(result.timestamp),
          stopPrice: analysis.reasons.stopPrice,
          tp1: analysis.reasons.tp1,
          tp2: analysis.reasons.tp2,
          highestSinceEntry: result.averagePrice || pos.entryPrice,
        },
      });
    }

    logger.info('[STRATEJI] BUY emri acildi', {
      orderId: result.orderId,
      price: result.averagePrice,
      quantity: result.filled,
      mode: result.mode,
      stopPrice: analysis.reasons.stopPrice,
      tp1: analysis.reasons.tp1,
      tp2: analysis.reasons.tp2,
    });
  } catch (err) {
    logger.error('[STRATEJI] BUY emri basarisiz', { error: err.message });
  }
  stateService.update({ lastAnalyzedTs: candleTs });
}

async function handleExit(price, symbol, candles) {
  const state = stateService.get();
  const pos = state.position;
  if (!pos) return;

  const exitEval = strategyEngine.evaluateExit(pos, candles, price, env);

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

module.exports = { start, stop, runCycle, analyzeOnly, fetchLivePrice };
