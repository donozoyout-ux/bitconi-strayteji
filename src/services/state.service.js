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

async function persistNow() {
  if (!sheetStore.isConfigured() || persistInFlight) {
    if (persistInFlight) persistQueued = true;
    return;
  }
  persistInFlight = true;
  try {
    const snapshot = { ...load(), busy: false };
    await sheetStore.setState(SHEET_STATE_KEY, snapshot);
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
    const remote = await sheetStore.getState(SHEET_STATE_KEY);
    if (remote && typeof remote === 'object') {
      state = {
        ...DEFAULT_STATE,
        ...remote,
        busy: false,
        trades: Array.isArray(remote.trades) ? remote.trades.slice(0, MAX_TRADES) : [],
        orderLog: Array.isArray(remote.orderLog) ? remote.orderLog.slice(0, MAX_LOG) : [],
      };
      saveLocal();
      logger.info('[SHEET-STATE] runtime state Google Sheets üzerinden geri yuklendi.');
      return { ok: true, restored: true };
    }
    state = load();
    await sheetStore.setState(SHEET_STATE_KEY, { ...state, busy: false });
    logger.info('[SHEET-STATE] ilk runtime state Google Sheets icine yazildi.');
    return { ok: true, restored: false };
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
