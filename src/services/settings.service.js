const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  // Strategy
  strategy: 'rsi-bollinger',
  strategyVersion: '1.0.0',

  // RSI
  rsiLength: 20,
  rsiMaLength: 20,

  // Bollinger
  bbLength: 30,
  bbStd: 2,

  // Timeframes
  executionTimeframe: '15m',
  higherTimeframe: '1h',
  regimeTimeframe: '4h',

  // Risk
  riskPerTrade: 0.5,
  maxLeverage: 5,
  maxDailyLoss: 2,
  maxDrawdown: 8,
  maxConsecutiveLosses: 3,

  // Execution
  cooldown: 60,
  maxTradesPerDay: 10,

  // Safety
  dryRun: true,
  tradingEnabled: true,

  // Optional confirmations
  volumeThreshold: 1.0,
  chopThreshold: 35,

  // Audit
  _lastChange: null,
  _changeLog: [],
};

const MAX_LOG_ENTRIES = 50;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so missing keys always have values
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(settings) {
  ensureDir();
  // Trim audit log if too long
  if (settings._changeLog && settings._changeLog.length > MAX_LOG_ENTRIES) {
    settings._changeLog = settings._changeLog.slice(-MAX_LOG_ENTRIES);
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = null;

function get() {
  if (settings) return settings;
  settings = load();
  return settings;
}

function set(patch) {
  const s = load();
  const changes = [];

  // Deep merge patch into settings
  Object.assign(s, patch);

  // Audit logging: detect what changed
  for (const [key, newValue] of Object.entries(patch)) {
    const oldValue = s._original && s._original[key] !== undefined ? s._original[key] : DEFAULT_SETTINGS[key];
    if (s[key] !== oldValue) {
      changes.push({
        setting: key,
        oldValue,
        newValue,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Save timestamp and log
  s._lastChange = new Date().toISOString();
  if (changes.length > 0) {
    s._changeLog = s._changeLog || [];
    s._changeLog = [...s._changeLog, ...changes].slice(-MAX_LOG_ENTRIES);
  }

  save(s);
  return { settings: s, changes };
}

function reset() {
  settings = { ...DEFAULT_SETTINGS };
  save(settings);
}

function getChangeLog() {
  const s = load();
  return s._changeLog || [];
}

function getOriginal(key) {
  const s = load();
  return s._original && s._original[key] !== undefined ? s._original[key] : DEFAULT_SETTINGS[key];
}

// Initialize _original snapshot on first load
function initOriginal() {
  const s = load();
  s._original = { ...DEFAULT_SETTINGS };
  save(s);
}

module.exports = { get, set, reset, getChangeLog, initOriginal, DEFAULT_SETTINGS };

// Auto-initialize on first access
initOriginal();