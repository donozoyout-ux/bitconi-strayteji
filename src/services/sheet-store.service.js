const crypto = require('crypto');
const env = require('../config/env');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_TIMEOUT_MS = 12000;
const REQUIRED_SHEETS = ['STATE', 'TRADES', 'ORDERS', 'DECISIONS', 'CHECKPOINTS', 'CANDIDATES'];

let tokenCache = { token: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(env.googleServiceAccountEmail && env.googlePrivateKey && env.googleSheetsSpreadsheetId);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!res.ok) {
      const msg = body && body.error && (body.error.message || body.error_description)
        ? (body.error.message || body.error_description)
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  if (!isConfigured()) throw new Error('Google Sheets Service Account env ayarlanmamis.');
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: env.googleServiceAccountEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(env.googlePrivateKey).toString('base64url');
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const token = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  tokenCache = {
    token: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function sheetsRequest(path, options = {}) {
  const token = await getAccessToken();
  return fetchJson(`${SHEETS_BASE}/${env.googleSheetsSpreadsheetId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function getMetadata() {
  return sheetsRequest('?fields=properties.title,sheets.properties');
}

function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function ensureSheets() {
  const meta = await getMetadata();
  const existing = new Set((meta.sheets || []).map(s => s.properties && s.properties.title).filter(Boolean));
  const requests = REQUIRED_SHEETS
    .filter(name => !existing.has(name))
    .map(title => ({ addSheet: { properties: { title } } }));
  if (requests.length) {
    await sheetsRequest(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }
  return meta.properties && meta.properties.title ? meta.properties.title : null;
}

async function valuesGet(range) {
  const encoded = encodeURIComponent(range);
  const r = await sheetsRequest(`/values/${encoded}?majorDimension=ROWS`);
  return Array.isArray(r.values) ? r.values : [];
}

async function valuesAppend(range, row) {
  const encoded = encodeURIComponent(range);
  return sheetsRequest(`/values/${encoded}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
}

async function valuesUpdate(range, rows) {
  const encoded = encodeURIComponent(range);
  return sheetsRequest(`/values/${encoded}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
}

async function valuesClear(range) {
  const encoded = encodeURIComponent(range);
  return sheetsRequest(`/values/${encoded}:clear`, { method: 'POST', body: '{}' });
}

async function healthCheck() {
  if (!isConfigured()) return { ok: false, configured: false, error: 'SHEET_NOT_CONFIGURED' };
  try {
    const spreadsheetName = await ensureSheets();
    return { ok: true, configured: true, spreadsheetName };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

async function getState(key) {
  const rows = await valuesGet(`${quoteSheet('STATE')}!A:B`);
  const found = rows.find(r => String(r[0]) === String(key));
  if (!found || found[1] == null || found[1] === '') return null;
  try { return JSON.parse(found[1]); } catch (_) { return found[1]; }
}

async function setState(key, value) {
  const rows = await valuesGet(`${quoteSheet('STATE')}!A:B`);
  const idx = rows.findIndex(r => String(r[0]) === String(key));
  const payload = [String(key), JSON.stringify(value)];
  if (idx >= 0) return valuesUpdate(`${quoteSheet('STATE')}!A${idx + 1}:B${idx + 1}`, [payload]);
  return valuesAppend(`${quoteSheet('STATE')}!A:B`, payload);
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
  const rows = await valuesGet(`${quoteSheet(sheet)}!A:B`);
  const exists = rows.some(r => String(r[0]) === String(keyValue));
  if (exists) return { success: true, duplicate: true };
  await valuesAppend(`${quoteSheet(sheet)}!A:B`, [String(keyValue), JSON.stringify({ ...data, [keyField]: keyValue })]);
  return { success: true, duplicate: false };
}

async function append(sheet, data) {
  const key = `${Date.now()}-${crypto.randomUUID()}`;
  await valuesAppend(`${quoteSheet(sheet)}!A:B`, [key, JSON.stringify(data)]);
  return { success: true };
}

async function list(sheet) {
  const rows = await valuesGet(`${quoteSheet(sheet)}!A:B`);
  return rows.map(r => {
    try { return JSON.parse(r[1]); } catch (_) { return null; }
  }).filter(Boolean);
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
  const cutoff = Date.now() - Number(retentionDays) * 86400000;
  const rows = await valuesGet(`${quoteSheet('DECISIONS')}!A:B`);
  const kept = rows.filter(r => {
    try {
      const d = JSON.parse(r[1]);
      return !d.timestamp || new Date(d.timestamp).getTime() >= cutoff;
    } catch (_) {
      return true;
    }
  });
  if (kept.length === rows.length) return { success: true, pruned: 0 };
  await valuesClear(`${quoteSheet('DECISIONS')}!A:B`);
  if (kept.length) await valuesUpdate(`${quoteSheet('DECISIONS')}!A1:B${kept.length}`, kept);
  return { success: true, pruned: rows.length - kept.length };
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
