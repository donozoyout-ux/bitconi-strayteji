const exchange = require('../config/binance');
const logger = require('../utils/logger');

const VALID_ACTIONS = ['BUY', 'SELL'];

function validateQuantity(quantity) {
  const qty = parseFloat(quantity);
  if (Number.isNaN(qty) || !qty || qty <= 0) {
    return null;
  }
  return qty;
}

function normalizeSymbol(symbol) {
  const cleaned = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = cleaned.match(/^([A-Z0-9]+)(BTC|ETH|USDT|USDC|BNB|BUSD|FDUSD)$/);
  return match ? `${match[1]}/${match[2]}` : cleaned;
}

async function placeOrder(action, symbol, quantity) {
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

  const qty = validateQuantity(quantity);
  if (!qty) {
    const error = new Error(`Gecersiz quantity: "${quantity}". Pozitif bir sayi olmali.`);
    error.statusCode = 400;
    throw error;
  }

  const ccxtSymbol = normalizeSymbol(symbol);
  const timestamp = new Date().toISOString();
  logger.info(`Emir hazirlaniyor -> ${normalizedAction} ${ccxtSymbol} miktar: ${qty}`, { timestamp });

  let order;
  try {
    if (normalizedAction === 'BUY') {
      order = await exchange.createMarketBuyOrder(ccxtSymbol, qty);
    } else {
      order = await exchange.createMarketSellOrder(ccxtSymbol, qty);
    }
  } catch (err) {
    logger.error(`Binance emir BASARISIZ -> ${normalizedAction} ${ccxtSymbol}`, {
      error: err.message,
      timestamp,
    });
    throw err;
  }

  const result = {
    success: true,
    timestamp,
    action: normalizedAction,
    symbol: ccxtSymbol,
    quantity: qty,
    orderId: order.id,
    status: order.status,
    filled: order.filled,
    averagePrice: order.average,
    raw: order,
  };

  logger.info(`Emir GONDERILDI -> ${result.action} ${result.symbol}`, {
    orderId: result.orderId,
    status: result.status,
    filled: result.filled,
    averagePrice: result.averagePrice,
  });

  return result;
}

module.exports = { placeOrder, VALID_ACTIONS };
