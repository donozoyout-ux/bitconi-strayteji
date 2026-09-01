const env = require('../config/env');
const logger = require('../utils/logger');
const sheetStore = require('./sheet-store.service');

function isConfigured() {
  return sheetStore.isConfigured() || Boolean(env.googleFormUrl && env.googleFormFields && Object.keys(env.googleFormFields).length);
}

function fieldId(key) {
  if (!env.googleFormFields) return null;
  const v = env.googleFormFields[key];
  return v != null ? String(v).trim() : null;
}

async function sendToLegacyForm(payload) {
  if (!env.googleFormUrl || !env.googleFormFields) return { success: false, reason: 'not_configured' };
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    const entry = fieldId(key);
    if (entry && value != null) body.append(entry, String(value));
  }
  try {
    const res = await fetch(env.googleFormUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return res.ok ? { success: true } : { success: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function logTrade(trade) {
  if (sheetStore.isConfigured()) {
    try {
      return await sheetStore.appendTrade(trade);
    } catch (e) {
      logger.warn('[SHEET] trade yazimi basarisiz: ' + e.message);
    }
  }
  return sendToLegacyForm({
    tarih: new Date(trade.closedAt || trade.timestamp).toLocaleString('tr-TR'),
    islem: 'KAPANIŞ',
    sembol: trade.symbol,
    fiyat: trade.exitPrice != null ? Number(trade.exitPrice).toFixed(2) : null,
    miktar: trade.quantity || trade.size,
    karZarar: trade.pnl != null ? Number(trade.pnl).toFixed(2) : null,
    sonuc: trade.result,
  });
}

async function logOrder(order) {
  if (sheetStore.isConfigured()) {
    try {
      return await sheetStore.appendOrder(order);
    } catch (e) {
      logger.warn('[SHEET] order yazimi basarisiz: ' + e.message);
    }
  }
  return sendToLegacyForm({
    tarih: new Date(order.timestamp).toLocaleString('tr-TR'),
    islem: order.action,
    sembol: order.symbol,
    fiyat: order.averagePrice != null ? Number(order.averagePrice).toFixed(2) : null,
    miktar: order.filled,
    karZarar: null,
    sonuc: order.success ? 'BASARILI' : 'BASARISIZ',
  });
}

module.exports = { isConfigured, logTrade, logOrder };
