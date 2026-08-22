const env = require('../../config/env');
const stateService = require('../../services/state.service');
const tradingEngine = require('../../services/trading.engine');
const orderService = require('../../services/order.service');
const logger = require('../../utils/logger');

function getStatus(req, res) {
  res.status(200).json({
    success: true,
    enabled: env.tradingEnabled,
    dryRun: env.dryRun,
    timeframe: env.analysisTimeframe,
    intervalMin: env.checkIntervalMin,
    budgetUsdt: env.budgetUsdt,
    tpPercent: env.tpPercent,
    slPercent: env.slPercent,
    symbol: env.tradingSymbol,
    cooldownMin: env.cooldownMin,
    ...stateService.get(),
  });
}

async function checkNow(req, res) {
  try {
    stateService.update({ busy: false });
    await tradingEngine.runCycle();
    res.status(200).json({ success: true, message: 'Analiz tamamlandi.', state: stateService.get() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function resetState(req, res) {
  stateService.reset();
  res.status(200).json({ success: true, message: 'Motor durumu sifirlandi.' });
}

async function analyze(req, res) {
  try {
    const report = await tradingEngine.analyzeOnly();
    res.status(200).json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getLivePrice(req, res) {
  try {
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const ticker = await tradingEngine.fetchLivePrice(symbol);
    res.status(200).json({ success: true, symbol, price: ticker, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getHistory(req, res) {
  const state = stateService.get();
  const trades = state.trades || [];
  const orderLog = state.orderLog || [];

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.result === 'KAR').length;
  const losses = trades.filter((t) => t.result === 'ZARAR').length;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const fees = trades.reduce((s, t) => s + (t.feeUsdt || 0), 0);

  let openPosition = null;
  if (state.position) {
    const pos = state.position;
    openPosition = {
      symbol: pos.symbol,
      entryPrice: pos.entryPrice,
      quantity: pos.quantity,
      mode: pos.mode,
      openedAt: pos.entryTime,
      stopPrice: pos.stopPrice || null,
      tp1: pos.tp1 || null,
      tp2: pos.tp2 || null,
      tp1Done: !!pos.tp1Done,
      unrealizedPnl: null,
      unrealizedPnlPercent: null,
    };
  }

  let performance = null;
  try {
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const price = await tradingEngine.fetchLivePrice(symbol);
    const balance = await (require('../config/binance')).fetchBalance();
    const usdt = balance.USDT ? balance.USDT.total : 0;
    const btc = balance.BTC ? balance.BTC.total : 0;
    const equity = usdt + btc * price;

    if (openPosition) {
      openPosition.currentPrice = price;
      openPosition.unrealizedPnl =
        Math.floor(((price - openPosition.entryPrice) * openPosition.quantity) * 100) / 100;
      openPosition.unrealizedPnlPercent =
        openPosition.entryPrice > 0
          ? Math.floor((((price - openPosition.entryPrice) / openPosition.entryPrice) * 100) * 100) / 100
          : null;
      openPosition.valueUsdt = Math.floor(openPosition.quantity * price * 100) / 100;
    }

    performance = {
      startCapital: state.capital && state.capital.startEquityUsdt != null ? state.capital.startEquityUsdt : null,
      startedAt: state.capital ? state.capital.startedAt : null,
      currentEquity: Math.floor(equity * 100) / 100,
      returnUsdt:
        state.capital && state.capital.startEquityUsdt != null
          ? Math.floor((equity - state.capital.startEquityUsdt) * 100) / 100
          : null,
      returnPercent:
        state.capital && state.capital.startEquityUsdt > 0
          ? Math.floor((((equity - state.capital.startEquityUsdt) / state.capital.startEquityUsdt) * 100) * 100) / 100
          : null,
      realizedPnl: Math.floor(totalPnl * 100) / 100,
      nextBuyBudget: tradingEngine.computeBuyBudget(),
      btcPrice: price,
    };
  } catch (err) {
    performance = { error: err.message };
  }

  res.status(200).json({
    success: true,
    summary: {
      totalTrades,
      wins,
      losses,
      totalPnl,
      fees,
      winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
    },
    performance,
    trades,
    orderLog,
    openPosition,
  });
}

async function closePosition(req, res) {
  try {
    const state = stateService.get();
    const pos = state.position;
    if (!pos) {
      return res.status(400).json({ success: false, error: 'Acik pozisyon yok.' });
    }
    let qty = pos.quantity;
    if (!env.dryRun) {
      const exchange = require('../config/binance');
      const b = await exchange.fetchBalance();
      const free = Math.floor((b.BTC ? b.BTC.free : 0) * 1e5) / 1e5;
      qty = Math.min(pos.quantity, free);
    }
    if (!qty || qty <= 0) {
      return res.status(400).json({ success: false, error: 'Satalacak miktar yok.' });
    }
    logger.info(`[MANUEL] Pozisyon kapatma istegi -> ${pos.symbol} ${qty}`);
    const result = await orderService.placeOrder('SELL', pos.symbol, qty, null);
    res.status(200).json({ success: true, message: 'Pozisyon kapatildi.', result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function openManual(req, res) {
  try {
    const budget = tradingEngine.computeBuyBudget();
    const symbol = env.tradingSymbol || 'BTC/USDT';
    logger.info(`[MANUEL] Manuel alim istegi -> ${symbol} butce: ${budget} USDT`);
    const result = await orderService.placeOrder('BUY', symbol, null, budget);
    res.status(200).json({ success: true, message: `Alim acildi (${budget} USDT).`, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getStatus, checkNow, resetState, analyze, getLivePrice, getHistory, closePosition, openManual };
