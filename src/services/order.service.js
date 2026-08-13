const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const telegramService = require('./telegram.service');

const VALID_ACTIONS = ['BUY', 'SELL'];

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

async function placeOrder(action, symbol, quantity, budget) {
  const normalizedAction = action ? String(action).toUpperCase() : '';

  if (!VALID_ACTIONS.includes(normalizedAction)) {
    const error = new Error(`Gecersiz action: "${action}". Sadece BUY veya SELL kabul edilir.`);
    error.statusCode = 400;
    throw error;
  }

  if (!symbol) {
    const error = new Error('symbol alani bos olamaz.');
    error.statusCode = 400;
    throw error;
  }

  const ccxtSymbol = normalizeSymbol(symbol);

  let qty = null;
  let cost = null;

  if (budget !== undefined && budget !== null && budget !== '') {
    cost = validatePositive(budget, 'budget');
    if (!cost) {
      const error = new Error(`Gecersiz budget: "${budget}". Pozitif bir sayi olmali.`);
      error.statusCode = 400;
      throw error;
    }
    if (normalizedAction === 'SELL') {
      const price = await fetchLastPrice(ccxtSymbol);
      qty = cost / (price * (1 - env.commissionRate));
    }
  } else if (quantity !== undefined && quantity !== null && quantity !== '') {
    qty = validatePositive(quantity, 'quantity');
    if (!qty) {
      const error = new Error(`Gecersiz quantity: "${quantity}". Pozitif bir sayi olmali.`);
      error.statusCode = 400;
      throw error;
    }
  } else {
    const error = new Error('budget (USDT) veya quantity alani gerekli.');
    error.statusCode = 400;
    throw error;
  }

  const timestamp = new Date().toISOString();
  logger.info(
    `Emir hazirlaniyor -> ${normalizedAction} ${ccxtSymbol} ${cost ? 'butce: ' + cost + ' USDT' : 'miktar: ' + qty}`,
    { timestamp }
  );

  let order;
  try {
    if (normalizedAction === 'BUY') {
      if (cost) {
        try {
          order = await exchange.createMarketBuyOrderWithCost(ccxtSymbol, cost);
        } catch (err) {
          logger.warn(`BuyWithCost desteklenmedi, fiyattan hesaplaniyor: ${err.message}`);
          const price = await fetchLastPrice(ccxtSymbol);
          qty = cost / price;
          order = await exchange.createMarketBuyOrder(ccxtSymbol, qty);
        }
      } else {
        order = await exchange.createMarketBuyOrder(ccxtSymbol, qty);
      }
    } else {
      order = await exchange.createMarketSellOrder(ccxtSymbol, qty);
    }
  } catch (err) {
    logger.error(`Binance emir BASARISIZ -> ${normalizedAction} ${ccxtSymbol}`, {
      error: err.message,
      timestamp,
    });
    telegramService
      .sendTelegramMessage(
        `<b>${normalizedAction} EMRI BASARISIZ</b>\nParite: ${ccxtSymbol}\nHata: ${err.message}\nZaman: ${new Date(timestamp).toLocaleString('tr-TR')}`
      )
      .catch(() => {});
    throw err;
  }

  const result = {
    success: true,
    timestamp,
    action: normalizedAction,
    symbol: ccxtSymbol,
    quantity: qty,
    cost: cost,
    feeRate: env.commissionRate,
    fee: order.fee || null,
    orderId: order.id,
    status: order.status,
    filled: order.filled,
    averagePrice: order.average,
    spent: order.cost,
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

  telegramService
    .sendTelegramMessage(telegramService.formatOrderNotification(result))
    .catch(() => {});

  return result;
}

module.exports = { placeOrder, VALID_ACTIONS };
