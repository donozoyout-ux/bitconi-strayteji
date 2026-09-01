const fs = require('fs');
const path = require('path');
const sheetStore = require('./sheet-store.service');
const logger = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  position: null,
  dryRun: { USDT: null, BTC: null },
  cooldownUntil: null,
  lastAnalyzedTs: null,
  lastCheck: null,
  lastError: null,
  lastAnalysis: null,
  lastDecisionLogTs: null,
  busy: false,
  trades: [],
  orderLog: [],
  capital: { startEquityUsdt: null, startedAt: null },
};

const MAX_TRADES = 100;
const MAX_LOG = 50;
const SHEET_STATE_KEY = 'runtime';

let state = null;
let persistTimer = null;
let persistInFlight = false;
let persistQueued = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (state) return state;
  ensureDir();
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    state = { ...DEFAULT_STATE };
  }
  return state;
}

function saveLocal() {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function compactRuntimeState(s) {
  const { trades, orderLog, ...runtime } = s || {};
  return { ...runtime, busy: false };
}

async function persistNow() {
  if (!sheetStore.isConfigured() || persistInFlight) {
    if (persistInFlight) persistQueued = true;
    return;
  }
  persistInFlight = true;
  try {
    await sheetStore.setState(SHEET_STATE_KEY, compactRuntimeState(load()));
  } catch (e) {
    logger.warn('[SHEET-STATE] state yazimi basarisiz: ' + e.message);
  } finally {
    persistInFlight = false;
    if (persistQueued) {
      persistQueued = false;
      schedulePersist(1000);
    }
  }
}

function schedulePersist(delay = 1500) {
  if (!sheetStore.isConfigured()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, delay);
  if (persistTimer.unref) persistTimer.unref();
}

function get() {
  return load();
}

function update(patch) {
  const s = load();
  Object.assign(s, patch);
  saveLocal();
  schedulePersist();
  return s;
}

function pushTrades(trade) {
  const s = load();
  s.trades = [trade, ...(s.trades || [])].slice(0, MAX_TRADES);
  saveLocal();
  schedulePersist(250);
  return s;
}

function pushOrderLog(entry) {
  const s = load();
  s.orderLog = [entry, ...(s.orderLog || [])].slice(0, MAX_LOG);
  saveLocal();
  schedulePersist(250);
  return s;
}

async function hydrateFromSheet() {
  if (!sheetStore.isConfigured()) return { ok: false, reason: 'sheet-not-configured' };
  try {
    const [remote, tradeRows, orderRows] = await Promise.all([
      sheetStore.getState(SHEET_STATE_KEY),
      sheetStore.listTrades().catch(() => []),
      sheetStore.list('ORDERS').catch(() => []),
    ]);

    const recentTrades = tradeRows
      .slice()
      .sort((a, b) => new Date(b.closedAt || b.exitTime || b.exit_time || b.timestamp || 0) - new Date(a.closedAt || a.exitTime || a.exit_time || a.timestamp || 0))
      .slice(0, MAX_TRADES);
    const recentOrders = orderRows
      .slice()
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, MAX_LOG);

    if (remote && typeof remote === 'object') {
      state = { ...DEFAULT_STATE, ...remote, busy: false, trades: recentTrades, orderLog: recentOrders };
      saveLocal();
      logger.info('[SHEET-STATE] runtime + trade/order hafizasi Google Sheets uzerinden geri yuklendi.');
      return { ok: true, restored: true, trades: recentTrades.length, orders: recentOrders.length };
    }

    state = { ...load(), trades: recentTrades, orderLog: recentOrders, busy: false };
    await sheetStore.setState(SHEET_STATE_KEY, compactRuntimeState(state));
    saveLocal();
    logger.info('[SHEET-STATE] ilk runtime state Google Sheets icine yazildi.');
    return { ok: true, restored: false, trades: recentTrades.length, orders: recentOrders.length };
  } catch (e) {
    logger.warn('[SHEET-STATE] state recovery basarisiz: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function reset() {
  state = { ...DEFAULT_STATE };
  saveLocal();
  schedulePersist(100);
}

function save() {
  saveLocal();
  schedulePersist();
}

module.exports = {
  get,
  update,
  reset,
  save,
  pushTrades,
  pushOrderLog,
  hydrateFromSheet,
  persistNow,
  DEFAULT_STATE,
};
