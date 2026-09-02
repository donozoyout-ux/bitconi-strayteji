const fs = require('fs');
const path = require('path');
const sheetStore = require('./sheet-store.service');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  strategy: 'trend_capture_v3_a',
  strategyVersion: 'EXIT_B3_M3_SHORT_H1_ADX25',
  exitStrategy: 'trend',
  trendTrailingAtrMult: 3.0,
  trendUseTP: false,
  trendTimeExitCandles: null,
  shortAdxFloor: 25,
  useTestnet: true,
  slPercent: 2.5,
  commissionRate: 0.001,
  forwardTest: {
    enabled: true,
    candidate: 'EXIT_B3_SHORT_H1_ADX25',
    minTrades: 20,
    preferredTrades: 30,
    logging: true,
    allowTuning: false,
  },
  rsiLength: 20,
  rsiMaLength: 20,
  bbLength: 30,
  bbStd: 2,
  executionTimeframe: '15m',
  higherTimeframe: '1h',
  regimeTimeframe: '4h',
  riskPerTrade: 0.5,
  maxLeverage: 5,
  maxDailyLoss: 2,
  maxDrawdown: 8,
  maxConsecutiveLosses: 3,
  cooldown: 60,
  maxTradesPerDay: 10,
  dryRun: true,
  tradingEnabled: true,
  volumeThreshold: 1.0,
  chopThreshold: 35,
  _lastChange: null,
  _changeLog: [],
};

// Production source of truth. Persistent runtime/trade memory lives in Google Sheets,
// but trading rules remain version-controlled so a Sheet edit cannot silently change risk.
const CANONICAL_CANDIDATE = {
  strategy: 'trend_capture_v3_a',
  strategyVersion: 'EXIT_B3_M3_SHORT_H1_ADX25',
  exitStrategy: 'trend',
  trendTrailingAtrMult: 3.0,
  trendUseTP: false,
  trendTimeExitCandles: null,
  shortAdxFloor: 25,
  useTestnet: true,
  riskPerTrade: 0.5,
  maxLeverage: 5,
  executionTimeframe: '15m',
  higherTimeframe: '1h',
  regimeTimeframe: '4h',
  bbLength: 30,
  bbStd: 2,
  slPercent: 2.5,
  commissionRate: 0.001,
  forwardTest: {
    enabled: true,
    candidate: 'EXIT_B3_SHORT_H1_ADX25',
    minTrades: 20,
    preferredTrades: 30,
    logging: true,
    allowTuning: false,
  },
  rsiLength: 20,
  rsiMaLength: 20,
  maxDailyLoss: 2,
  maxDrawdown: 8,
  maxConsecutiveLosses: 3,
  cooldown: 60,
  maxTradesPerDay: 10,
  dryRun: true,
  tradingEnabled: true,
  volumeThreshold: 1.0,
  chopThreshold: 35,
};

const CANDIDATE_KEYS = [
  'strategy', 'strategyVersion', 'riskPerTrade', 'executionTimeframe', 'higherTimeframe',
  'regimeTimeframe', 'bbLength', 'bbStd', 'shortAdxFloor', 'exitStrategy',
  'trendTrailingAtrMult', 'trendUseTP', 'trendTimeExitCandles', 'slPercent', 'maxLeverage', 'commissionRate',
];

function isDeployMode() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.RENDER === 'true' || process.env.DEPLOY_CONFIG === 'canonical';
}

const MAX_LOG_ENTRIES = 50;
let settings = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (isDeployMode()) return { ...CANONICAL_CANDIDATE };
  ensureDir();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(s) {
  if (isDeployMode()) {
    settings = { ...s };
    return;
  }
  ensureDir();
  if (s._changeLog && s._changeLog.length > MAX_LOG_ENTRIES) s._changeLog = s._changeLog.slice(-MAX_LOG_ENTRIES);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  settings = s;
}

function get() {
  if (!settings) settings = load();
  return settings;
}

function getCanonical() {
  return { ...CANONICAL_CANDIDATE };
}

async function initializeSettings() {
  settings = load();
  return settings;
}

// Legacy name kept so older callers do not crash; PostgreSQL is no longer used.
async function bootstrapDbSettings() {
  settings = load();
  return { ok: true, applied: false, reason: 'database-removed; canonical-settings-active' };
}

function assertConfigParity(effective) {
  const eff = effective || get();
  const mismatches = [];
  for (const k of CANDIDATE_KEYS) {
    const a = JSON.stringify(eff[k]);
    const b = JSON.stringify(CANONICAL_CANDIDATE[k]);
    if (a !== b) mismatches.push(`${k}=${a} (expected ${b})`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

function set(patch) {
  const s = { ...get() };
  const changes = [];
  for (const [key, newValue] of Object.entries(patch || {})) {
    const oldValue = s[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ setting: key, oldValue, newValue, timestamp: new Date().toISOString() });
    }
    s[key] = newValue;
  }
  s._lastChange = new Date().toISOString();
  s._changeLog = [...(s._changeLog || []), ...changes].slice(-MAX_LOG_ENTRIES);
  save(s);
  return { settings: s, changes };
}

function reset() {
  settings = { ...DEFAULT_SETTINGS };
  save(settings);
}

function getChangeLog() {
  return (get()._changeLog || []).slice();
}

function getOriginal(key) {
  return DEFAULT_SETTINGS[key];
}

function initOriginal() {
  return { ...DEFAULT_SETTINGS };
}

// Backward-compatible runtime-state helpers. Data is stored in the STATE tab.
async function getFullBotState() {
  if (!sheetStore.isConfigured()) return {};
  const value = await sheetStore.getState('runtime');
  return value && typeof value === 'object' ? value : {};
}

async function getBotState(key) {
  const state = await getFullBotState();
  return state[key];
}

async function updateBotState(key, value) {
  const state = await getFullBotState();
  state[key] = value;
  await sheetStore.setState('runtime', state);
  return value;
}

module.exports = {
  get,
  set,
  reset,
  getChangeLog,
  initOriginal,
  getOriginal,
  getCanonical,
  initializeSettings,
  bootstrapDbSettings,
  assertConfigParity,
  isDeployMode,
  CANONICAL_CANDIDATE,
  CANDIDATE_KEYS,
  DEFAULT_SETTINGS,
  getFullBotState,
  getBotState,
  updateBotState,
};
