const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 12000;

function isConfigured() {
  return Boolean(env.googleSheetsWebAppUrl && env.googleSheetsSecret);
}

async function request(action, payload = {}) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_SHEETS_WEBAPP_URL / GOOGLE_SHEETS_SECRET ayarlanmamis.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(env.googleSheetsWebAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
      body: JSON.stringify({ secret: env.googleSheetsSecret, action, ...payload }),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : {}; } catch (_) {
      throw new Error(`Google Sheets JSON donmedi (HTTP ${res.status}).`);
    }
    if (!res.ok || !body || body.success === false) {
      throw new Error((body && body.error) || `Google Sheets HTTP ${res.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function healthCheck() {
  if (!isConfigured()) return { ok: false, configured: false, error: 'SHEET_NOT_CONFIGURED' };
  try {
    const r = await request('health');
    return { ok: true, configured: true, spreadsheetName: r.spreadsheetName || null };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

async function getState(key) {
  const r = await request('state:get', { key });
  return r.value == null ? null : r.value;
}

async function setState(key, value) {
  return request('state:set', { key, value });
}

function makeTradeKey(t) {
  if (t && t.tradeKey) return t.tradeKey;
  const raw = [
    t && (t.symbol || 'BTC/USDT'),
    t && (t.side || 'LONG'),
    t && (t.openedAt || t.entryTime || ''),
    t && (t.closedAt || t.exitTime || t.timestamp || ''),
    t && (t.entryPrice || 0),
    t && (t.exitPrice || 0),
    t && (t.size || t.quantity || 0),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function appendUnique(sheet, keyField, keyValue, data) {
  return request('appendUnique', { sheet, keyField, keyValue, data });
}

async function append(sheet, data) {
  return request('append', { sheet, data });
}

async function list(sheet) {
  const r = await request('list', { sheet });
  return Array.isArray(r.rows) ? r.rows : [];
}

async function appendTrade(trade) {
  const data = { ...trade, tradeKey: makeTradeKey(trade) };
  return appendUnique('TRADES', 'tradeKey', data.tradeKey, data);
}

async function appendOrder(order) {
  const key = order.orderId || `${order.timestamp || Date.now()}-${order.action || 'ORDER'}`;
  return appendUnique('ORDERS', 'orderKey', String(key), { ...order, orderKey: String(key) });
}

async function appendDecision(decision) {
  const key = decision.decisionKey || crypto.createHash('sha1').update([
    decision.timestamp || Date.now(), decision.decision || '', decision.symbol || '', decision.price || ''
  ].join('|')).digest('hex');
  return appendUnique('DECISIONS', 'decisionKey', key, { ...decision, decisionKey: key });
}

async function appendCheckpoint(checkpoint) {
  const n = Number(checkpoint.checkpointNumber);
  const r = await appendUnique('CHECKPOINTS', 'checkpointNumber', n, checkpoint);
  if (checkpoint.candidate && checkpoint.candidate.key && checkpoint.candidate.key !== 'NO_CHANGE') {
    await appendUnique('CANDIDATES', 'checkpointNumber', n, {
      checkpointNumber: n,
      tradeCount: checkpoint.tradeCount,
      strategyVersion: checkpoint.activeStrategyVersion,
      status: checkpoint.status,
      confirmedPattern: Boolean(checkpoint.confirmedPattern),
      ...checkpoint.candidate,
    });
  }
  return r;
}

async function listTrades() { return list('TRADES'); }
async function listDecisions() { return list('DECISIONS'); }
async function listCheckpoints() { return list('CHECKPOINTS'); }
async function listCandidates() { return list('CANDIDATES'); }

async function trimDecisions(retentionDays = 30) {
  return request('pruneByDate', {
    sheet: 'DECISIONS',
    field: 'timestamp',
    before: new Date(Date.now() - Number(retentionDays) * 86400000).toISOString(),
  });
}

module.exports = {
  isConfigured,
  healthCheck,
  getState,
  setState,
  append,
  appendUnique,
  list,
  appendTrade,
  appendOrder,
  appendDecision,
  appendCheckpoint,
  listTrades,
  listDecisions,
  listCheckpoints,
  listCandidates,
  trimDecisions,
  makeTradeKey,
};
