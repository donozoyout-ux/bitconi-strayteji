const env = require('../config/env');
const stateService = require('../services/state.service');
const tradingEngine = require('../services/trading.engine');

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

function getHistory(req, res) {
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
    };
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
    trades,
    orderLog,
    openPosition,
  });
}

module.exports = { getStatus, checkNow, resetState, analyze, getLivePrice, getHistory };
