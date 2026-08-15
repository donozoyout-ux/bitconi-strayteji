const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const stateService = require('./state.service');
const telegramService = require('./telegram.service');
const spreadsheetService = require('./spreadsheet.service');

const VALID_ACTIONS = ['BUY', 'SELL'];

function recordClosedTrade(position, exitPrice, exitTime, mode, result, note) {
  if (!position) return;
  const qty = position.quantity || 0;
  const entry = position.entryPrice || 0;
  const exit = exitPrice || 0;
  const pnl = qty > 0 && entry > 0 ? (exit - entry) * qty : null;
  const pnlPct = pnl != null && entry > 0 ? (pnl / (entry * qty)) * 100 : null;

  const trade = {
    symbol: position.symbol,
    entryPrice: entry,
    exitPrice: exit,
    quantity: qty,
    pnl,
    pnlPercent: pnlPct,
    result: pnl == null ? 'HATA' : pnl >= 0 ? 'KAR' : 'ZARAR',
    mode,
    note: note || '',
    openedAt: position.entryTime,
    closedAt: exitTime,
    timestamp: exitTime,
  };
  stateService.pushTrades(trade);
  spreadsheetService.logTrade(trade).catch(() => {});
  return trade;
}

function badReq(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validatePositive(value, name) {
  const num = parseFloat(value);
  if (Number.isNaN(num) || !num || num <= 0) {
    return null;
  }
  return num;
}

function normalizeSymbol(symbol) {
  const cleaned = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = cleaned.match(/^([A-Z0-9]+)(BTC|ETH|USDT|USDC|BNB|BUSD|FDUSD)$/);
  return match ? `${match[1]}/${match[2]}` : cleaned;
}

async function fetchLastPrice(symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  if (!ticker || !ticker.last) {
    throw new Error(`Fiyat alinamadi: ${symbol}`);
  }
  return ticker.last;
}

async function ensureDryRunBalances() {
  const state = stateService.get();
  if (state.dryRun.USDT === null || state.dryRun.USDT === undefined) {
    const balance = await exchange.fetchBalance();
    stateService.update({
      dryRun: {
        USDT: balance.USDT ? balance.USDT.total : 0,
        BTC: balance.BTC ? balance.BTC.total : 0,
      },
    });
  }
}

function buildResult(action, symbol, quantity, cost, price, spent, mode, timestamp, fee) {
  return {
    success: true,
    timestamp,
    action,
    symbol,
    quantity,
    cost,
    feeRate: env.commissionRate,
    fee,
    orderId: mode === 'REAL' ? price.orderId : `DRY-${Date.now()}`,
    status: 'closed',
    filled: quantity,
    averagePrice: price.price || price,
    spent,
    mode,
    raw: {},
  };
}

async function placeDryRun(action, symbol, qty, cost, timestamp) {
  await ensureDryRunBalances();
  const price = await fetchLastPrice(symbol);
  const state = stateService.get();
  const dr = { ...state.dryRun };

  let quantity = qty;
  let spent = cost;

  if (action === 'BUY' && (!quantity || quantity <= 0) && cost) {
    quantity = Math.floor((cost / price) * 1e5) / 1e5;
  }

  if (!quantity || quantity <= 0) {
    throw badReq('Dry-run: emir miktari hesaplanamadi.');
  }

  if (action === 'BUY') {
    spent = quantity * price;
    if (dr.USDT < spent) {
      throw badReq(
        `Dry-run USDT yetersiz (gerekli: ${spent.toFixed(2)}, mevcut: ${Number(dr.USDT).toFixed(2)}).`
      );
    }
    dr.USDT -= spent;
    dr.BTC += quantity;
    const feeBtc = quantity * env.commissionRate;
    stateService.update({
      dryRun: dr,
      position: {
        symbol,
        entryPrice: price,
        entryTime: timestamp,
        quantity,
        cost: spent,
        mode: 'DRY_RUN',
      },
      cooldownUntil: null,
    });
    const result = buildResult(
      action,
      symbol,
      quantity,
      cost,
      { price },
      spent,
      'DRY_RUN',
      timestamp,
      { currency: symbol.split('/')[0], cost: feeBtc }
    );
    logger.info(`[DRY-RUN] BUY simule edildi -> ${symbol}`, {
      price,
      quantity,
      spent: spent.toFixed(2),
      entry: price,
    });
    return result;
  }

  if (dr.BTC < quantity) {
    throw badReq(
      `Dry-run BTC yetersiz (gerekli: ${quantity}, mevcut: ${Number(dr.BTC).toFixed(6)}).`
    );
  }
  const proceeds = quantity * price * (1 - env.commissionRate);
  dr.USDT += proceeds;
  dr.BTC -= quantity;
  const feeUsdt = quantity * price * env.commissionRate;
  const prevPosition = state.position || null;
  stateService.update({
    dryRun: dr,
    position: null,
    cooldownUntil: Date.now() + env.cooldownMin * 60000,
  });
  if (prevPosition) {
    recordClosedTrade(prevPosition, price, timestamp, 'DRY_RUN', 'KAPANIŞ');
  }
  const result = buildResult(
    action,
    symbol,
    quantity,
    null,
    { price },
    proceeds,
    'DRY_RUN',
    timestamp,
    { currency: 'USDT', cost: feeUsdt }
  );
  logger.info(`[DRY-RUN] SELL simule edildi -> ${symbol}`, {
    price,
    quantity,
    proceeds: proceeds.toFixed(2),
    cooldownMin: env.cooldownMin,
  });
  return result;
}

async function placeReal(action, symbol, qty, cost, timestamp) {
  let order;
  if (action === 'BUY') {
    if (cost) {
      try {
        order = await exchange.createMarketBuyOrderWithCost(symbol, cost);
      } catch (err) {
        logger.warn(`BuyWithCost desteklenmedi, fiyattan hesaplaniyor: ${err.message}`);
        const price = await fetchLastPrice(symbol);
        qty = Math.floor((cost / price) * 1e5) / 1e5;
        order = await exchange.createMarketBuyOrder(symbol, qty);
      }
    } else {
      order = await exchange.createMarketBuyOrder(symbol, qty);
    }
  } else {
    order = await exchange.createMarketSellOrder(symbol, qty);
  }

  if (action === 'BUY') {
    stateService.update({
      position: {
        symbol,
        entryPrice: order.average || order.price,
        entryTime: timestamp,
        quantity: order.filled,
        cost: order.cost,
        mode: 'REAL',
      },
      cooldownUntil: null,
    });
  } else {
    const prevPosition = stateService.get().position || null;
    stateService.update({
      position: null,
      cooldownUntil: Date.now() + env.cooldownMin * 60000,
    });
    if (prevPosition) {
      recordClosedTrade(prevPosition, order.average || order.price, timestamp, 'REAL', 'KAPANIŞ');
    }
  }

  const result = {
    success: true,
    timestamp,
    action,
    symbol,
    quantity: order.filled,
    cost,
    feeRate: env.commissionRate,
    fee: order.fee || null,
    orderId: order.id,
    status: order.status,
    filled: order.filled,
    averagePrice: order.average,
    spent: order.cost,
    mode: 'REAL',
    raw: order,
  };

  logger.info(`Emir GONDERILDI -> ${result.action} ${result.symbol}`, {
    orderId: result.orderId,
    status: result.status,
    filled: result.filled,
    averagePrice: result.averagePrice,
    cost: result.cost,
    fee: result.fee,
  });

  return result;
}

async function placeOrder(action, symbol, quantity, budget) {
  const normalizedAction = action ? String(action).toUpperCase() : '';

  if (!VALID_ACTIONS.includes(normalizedAction)) {
    throw badReq(`Gecersiz action: "${action}". Sadece BUY veya SELL kabul edilir.`);
  }

  if (!symbol) {
    throw badReq('symbol alani bos olamaz.');
  }

  const ccxtSymbol = normalizeSymbol(symbol);

  let qty = null;
  let cost = null;

  if (budget !== undefined && budget !== null && budget !== '') {
    cost = validatePositive(budget, 'budget');
    if (!cost) {
      throw badReq(`Gecersiz budget: "${budget}". Pozitif bir sayi olmali.`);
    }
    if (normalizedAction === 'SELL') {
      const price = await fetchLastPrice(ccxtSymbol);
      qty = cost / (price * (1 - env.commissionRate));
    }
  } else if (quantity !== undefined && quantity !== null && quantity !== '') {
    qty = validatePositive(quantity, 'quantity');
    if (!qty) {
      throw badReq(`Gecersiz quantity: "${quantity}". Pozitif bir sayi olmali.`);
    }
  } else {
    throw badReq('budget (USDT) veya quantity alani gerekli.');
  }

  const timestamp = new Date().toISOString();
  logger.info(
    `Emir hazirlaniyor -> ${normalizedAction} ${ccxtSymbol} ${cost ? 'butce: ' + cost + ' USDT' : 'miktar: ' + qty}`,
    { timestamp, mode: env.dryRun ? 'DRY_RUN' : 'REAL' }
  );

  try {
    const result = env.dryRun
      ? await placeDryRun(normalizedAction, ccxtSymbol, qty, cost, timestamp)
      : await placeReal(normalizedAction, ccxtSymbol, qty, cost, timestamp);

    telegramService
      .sendTelegramMessage(telegramService.formatOrderNotification(result))
      .catch(() => {});
    stateService.pushOrderLog({
      timestamp,
      action: normalizedAction,
      symbol: ccxtSymbol,
      success: true,
      price: result.averagePrice,
      filled: result.filled,
      mode: result.mode,
    });
    spreadsheetService.logOrder({ ...result, timestamp, success: true }).catch(() => {});
    return result;
  } catch (err) {
    logger.error(`Emir BASARISIZ -> ${normalizedAction} ${ccxtSymbol}`, {
      error: err.message,
      timestamp,
    });
    telegramService
      .sendTelegramMessage(
        `<b>${normalizedAction} EMRI BASARISIZ</b>\nParite: ${ccxtSymbol}\nHata: ${err.message}\nZaman: ${new Date(timestamp).toLocaleString('tr-TR')}`
      )
      .catch(() => {});
    stateService.pushOrderLog({
      timestamp,
      action: normalizedAction,
      symbol: ccxtSymbol,
      success: false,
      error: err.message,
      price: null,
      filled: null,
      mode: env.dryRun ? 'DRY_RUN' : 'REAL',
    });
    spreadsheetService
      .logOrder({
        timestamp,
        action: normalizedAction,
        symbol: ccxtSymbol,
        averagePrice: null,
        filled: null,
        success: false,
      })
      .catch(() => {});
    throw err;
  }
}

module.exports = { placeOrder, VALID_ACTIONS };
