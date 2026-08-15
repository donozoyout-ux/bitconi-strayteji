const env = require('../config/env');
const logger = require('../utils/logger');

// Google Forms -> Google Sheets entegrasyonu.
// .env icerisine GOOGLE_FORM_URL (formResponse adresi) ve GOOGLE_FORM_FIELDS (JSON esleme) girilmelidir.
// Ornek GOOGLE_FORM_FIELDS:
// {"tarih":"entry.123456","islem":"entry.234567","sembol":"entry.345678","fiyat":"entry.456789","miktar":"entry.567890","karZarar":"entry.678901","sonuc":"entry.789012"}
//
// FORM_URL: Google Form -> 3 nokta -> Yanitlari gore -> 3 nokta -> Google Sheets (yeni tablo)
// formResponse adresi formun kaynak kodunda /forms/d/e/.../formResponse seklinde bulunur.

function isConfigured() {
  return Boolean(env.googleFormUrl && env.googleFormFields && Object.keys(env.googleFormFields).length);
}

function fieldId(key) {
  if (!env.googleFormFields) return null;
  const v = env.googleFormFields[key];
  return v != null ? String(v).trim() : null;
}

async function sendToForm(payload) {
  if (!isConfigured()) {
    logger.warn('Google Forms ayarlari eksik; kayit atlaniyor.');
    return { success: false, reason: 'not_configured' };
  }

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
    if (res.ok) {
      logger.info('Google Forms kaydi gonderildi.');
      return { success: true };
    }
    logger.error('Google Forms gonderim basarisiz', { status: res.status });
    return { success: false, error: `HTTP ${res.status}` };
  } catch (err) {
    logger.error('Google Forms baglanti hatasi', { error: err.message });
    return { success: false, error: err.message };
  }
}

async function logTrade(trade) {
  const res = await sendToForm({
    tarih: new Date(trade.closedAt || trade.timestamp).toLocaleString('tr-TR'),
    islem: 'KAPANIŞ',
    sembol: trade.symbol,
    fiyat: trade.exitPrice != null ? Number(trade.exitPrice).toFixed(2) : null,
    miktar: trade.quantity,
    karZarar: trade.pnl != null ? Number(trade.pnl).toFixed(2) : null,
    sonuc: trade.result,
  });
  return res;
}

async function logOrder(order) {
  const res = await sendToForm({
    tarih: new Date(order.timestamp).toLocaleString('tr-TR'),
    islem: order.action,
    sembol: order.symbol,
    fiyat: order.averagePrice != null ? Number(order.averagePrice).toFixed(2) : null,
    miktar: order.filled,
    karZarar: null,
    sonuc: order.success ? 'BASARILI' : 'BASARISIZ',
  });
  return res;
}

module.exports = { isConfigured, sendToForm, logTrade, logOrder };