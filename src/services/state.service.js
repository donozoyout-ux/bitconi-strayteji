const fs = require('fs');
const path = require('path');

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

function pushTrades(trade) {
  const s = load();
  s.trades = [trade, ...(s.trades || [])].slice(0, MAX_TRADES);
  save();
  return s;
}

function pushOrderLog(entry) {
  const s = load();
  s.orderLog = [entry, ...(s.orderLog || [])].slice(0, MAX_LOG);
  save();
  return s;
}

let state = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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

function save() {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function get() {
  return load();
}

function update(patch) {
  const s = load();
  Object.assign(s, patch);
  save();
  return s;
}

function reset() {
  state = { ...DEFAULT_STATE };
  save();
}

module.exports = { get, update, reset, save, pushTrades, pushOrderLog, DEFAULT_STATE };
