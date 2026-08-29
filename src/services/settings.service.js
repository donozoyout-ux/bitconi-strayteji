const fs = require('fs');
const path = require('path');
const db = require('../db');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  // Strategy
  strategy: 'trend_capture_v3_a',
  strategyVersion: 'EXIT_B3_M3_SHORT_H1_ADX25',

  // Candidate / TESTNET forward-test config (EXIT_B3_SHORT_H1_ADX25)
  // Entry: V3-A unchanged; LONG unchanged; SHORT requires ADX >= 25.
  // Exit:  trend mode, ATR trailing mult 3.0, no TP, no time exit, hard SL 2.5%,
  //        trailing activates only after MFE >= 1%.
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

// ---------------------------------------------------------------------------
// CANONICAL_CANDIDATE: version-controlled source of truth for the TESTNET
// forward-test deployment (EXIT_B3_M3_SHORT_H1_ADX25). Frozen values — do not
// change. Deploy mode uses this directly; a stale data/settings.json can never
// override it. DB `settings` table (if readable) overlays on top but must match
// these values exactly or trading is BLOCKED (CONFIG_PARITY_FAIL), never auto-corrected.
// ---------------------------------------------------------------------------
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

// Candidate keys checked for parity against CANONICAL_CANDIDATE at startup.
const CANDIDATE_KEYS = [
  'strategy', 'strategyVersion', 'riskPerTrade', 'executionTimeframe', 'higherTimeframe',
  'regimeTimeframe', 'bbLength', 'bbStd', 'shortAdxFloor', 'exitStrategy',
  'trendTrailingAtrMult', 'trendUseTP', 'trendTimeExitCandles', 'slPercent', 'maxLeverage', 'commissionRate',
];

// Maps snake_case DB settings keys -> camelCase canonical keys.
const DB_KEY_MAP = {
  strategy: 'strategy',
  strategy_version: 'strategyVersion',
  exit_strategy: 'exitStrategy',
  trend_trailing_atr_mult: 'trendTrailingAtrMult',
  trend_use_tp: 'trendUseTP',
  trend_time_exit_candles: 'trendTimeExitCandles',
  short_adx_floor: 'shortAdxFloor',
  risk_per_trade: 'riskPerTrade',
  max_leverage: 'maxLeverage',
  execution_timeframe: 'executionTimeframe',
  higher_timeframe: 'higherTimeframe',
  regime_timeframe: 'regimeTimeframe',
  bb_length: 'bbLength',
  bb_stddev: 'bbStd',
  sl_percent: 'slPercent',
  commission_rate: 'commissionRate',
};

function isDeployMode() {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.DEPLOY_CONFIG === 'canonical';
}

function coerceDbValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}

const MAX_LOG_ENTRIES = 50;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  // Deployment uses the version-controlled canonical candidate as the source of truth.
  // The gitignored data/settings.json is intentionally ignored in deploy mode so a stale
  // local file can never override the deployed configuration.
  if (isDeployMode()) {
    return { ...CANONICAL_CANDIDATE };
  }
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

// In deploy mode, overlay the DB `settings` table (preferred source) on top of the
// canonical candidate. If the DB is unreadable, fall back to canonical (the order
// pipeline is separately blocked by the DB health check). Stale DB rows that differ
// from CANONICAL_CANDIDATE are intentionally NOT auto-corrected — they cause a
// CONFIG_PARITY_FAIL block in assertConfigParity().
async function bootstrapDbSettings() {
  if (!isDeployMode()) return { ok: true, applied: false, reason: 'dev-mode' };
  try {
    const res = await db.query('SELECT key, value FROM settings');
    const mapped = {};
    for (const row of res.rows) {
      const camel = DB_KEY_MAP[row.key] || row.key;
      // In deploy mode the canonical candidate is the source of truth. A stale
      // `strategy`/`strategy_version` row must NEVER override it — doing so both
      // fails config parity (blocking all trading) and silently switches strategy.
      if (camel === 'strategy' || camel === 'strategyVersion') continue;
      mapped[camel] = coerceDbValue(row.value);
    }
    settings = { ...CANONICAL_CANDIDATE, ...mapped };
    return { ok: true, applied: true, keys: Object.keys(mapped) };
  } catch (e) {
    settings = { ...CANONICAL_CANDIDATE };
    return { ok: false, applied: false, error: e.message };
  }
}

// Compare effective config against CANONICAL_CANDIDATE for the candidate keys.
// Returns { ok, mismatches:[...] }. No mutation — caller decides to block.
function assertConfigParity(effective) {
  const eff = effective || get();
  const mismatches = [];
  for (const k of CANDIDATE_KEYS) {
    const a = JSON.stringify(eff[k]);
    const b = JSON.stringify(CANONICAL_CANDIDATE[k]);
    if (a !== b) {
      mismatches.push(`${k}=${a} (expected ${b})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
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

function getCanonical() {
  return { ...CANONICAL_CANDIDATE };
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

module.exports = {
  get, set, reset, getChangeLog, initOriginal, getCanonical,
  bootstrapDbSettings, assertConfigParity, isDeployMode, CANONICAL_CANDIDATE, CANDIDATE_KEYS,
  DEFAULT_SETTINGS,
};

// Auto-initialize on first access
initOriginal();