-- Migration: 001-create-tables.sql
-- Create initial tables for database persistence

-- Table: settings - persistent trading configuration
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by VARCHAR(100)
);

-- Comment: Settings table stores all trading configuration parameters
COMMENT ON TABLE settings IS 'Persistent storage for all trading configuration parameters. Single source of truth for strategy settings.';

-- Insert default settings
INSERT INTO settings (key, value, description) VALUES
  ('strategy', 'rsi-bollinger', 'Current strategy name'),
  ('strategy_version', '1.0.0', 'Current strategy version'),
  ('rsi_length', '20', 'RSI length parameter'),
  ('rsi_ma_length', '20', 'RSI Moving Average length parameter'),
  ('bb_length', '30', 'Bollinger Bands length parameter'),
  ('bb_stddev', '2', 'Bollinger Bands standard deviation multiplier'),
  ('execution_timeframe', '15m', 'Candle timeframe for signal execution'),
  ('higher_timeframe', '1h', 'Higher timeframe for regime analysis'),
  ('regime_timeframe', '4h', 'Timeframe for market regime detection'),
  ('risk_per_trade', '0.5', 'Risk percentage per trade'),
  ('max_leverage', '5', 'Maximum allowed leverage'),
  ('max_daily_loss', '2', 'Maximum daily loss percentage'),
  ('max_drawdown', '8', 'Maximum drawdown percentage'),
  ('max_consecutive_losses', '3', 'Maximum consecutive losses before halt'),
  ('cooldown_min', '60', 'Cooldown minutes between trades'),
  ('max_trades_per_day', '10', 'Maximum trades allowed per day'),
  ('dry_run', 'true', 'Trading mode: true = simulated, false = real testnet'),
  ('trading_enabled', 'true', 'Enable/disable autonomous trading'),
  ('volume_threshold', '1', 'Volume threshold for signal confirmation'),
  ('chop_threshold', '35', 'Chop market filter threshold'),
  ('min_signal_score', '75', 'Minimum signal score to execute trade'),
  ('long_enabled', 'true', 'Allow LONG positions'),
  ('short_enabled', 'true', 'Allow SHORT positions'),
  ('emergency_stop', 'false', 'Emergency stop kill switch'),
  ('database_url', '', 'Database connection string');

-- Table: bot_state - current bot runtime state
CREATE TABLE IF NOT EXISTS bot_state (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Comment: bot_state stores runtime state that needs to persist across restarts
COMMENT ON TABLE bot_state IS 'Runtime bot state persisted to database for restart recovery. Includes position, cooldown, dryRun balance.';

-- Insert initial bot state
INSERT INTO bot_state (key, value) VALUES
  ('position', '{"symbol": null, "side": null, "entryPrice": null, "quantity": null, "entryTime": null, "stopPrice": null, "tp1": null, "tp2": null, "highestSinceEntry": null, "tp1Done": false}'),
  ('dryRun', '{"USDT": 0, "BTC": 0}'),
  ('cooldownUntil', '0'),
  ('lastAnalyzedTs', null),
  ('lastCheck', NOW()),
  ('lastError', null),
  ('lastAnalysis', '{}');

-- Table: positions - open position tracking
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  entry_time TIMESTAMP NOT NULL,
  stop_price DOUBLE PRECISION,
  tp1 DOUBLE PRECISION,
  tp2 DOUBLE PRECISION,
  tp1_done BOOLEAN DEFAULT FALSE,
  highest_since_entry DOUBLE PRECISION,
  cost_usdt DOUBLE PRECISION,
  mode VARCHAR(20) DEFAULT 'TESTNET',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Comment: positions table tracks open positions with full state for reconciliation
COMMENT ON TABLE positions IS 'Open position tracking with full state for exchange reconciliation and restart recovery.';

-- Table: orders - order execution log
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(100) NOT NULL UNIQUE,
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  price DOUBLE PRECISION,
  filled_quantity DOUBLE PRECISION DEFAULT 0,
  filled_price DOUBLE PRECISION DEFAULT 0,
  status VARCHAR(50) DEFAULT 'OPEN',
  mode VARCHAR(20) DEFAULT 'TESTNET',
  fee_usdt DOUBLE PRECISION DEFAULT 0,
  pnl_usdt DOUBLE PRECISION DEFAULT 0,
  pnl_percent DOUBLE PRECISION DEFAULT 0,
  idempotency_key VARCHAR(255) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP
);

-- Unique constraint on idempotency_key to prevent duplicate orders
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders (idempotency_key);

-- Table: trades - closed trade records
CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  entry_time TIMESTAMP NOT NULL,
  exit_time TIMESTAMP NOT NULL,
  size_usdt DOUBLE PRECISION NOT NULL,
  leverage INTEGER DEFAULT 1,
  fee_usdt DOUBLE PRECISION DEFAULT 0,
  pnl_usdt DOUBLE PRECISION NOT NULL,
  pnl_percent DOUBLE PRECISION NOT NULL,
  signal_score INTEGER,
  market_regime VARCHAR(50),
  rsi_value DOUBLE PRECISION,
  bb_lower DOUBLE PRECISION,
  bb_upper DOUBLE PRECISION,
  exit_reason VARCHAR(100),
  mode VARCHAR(20) DEFAULT 'TESTNET',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comment: trades table stores closed trade records for performance reporting and journal
COMMENT ON TABLE trades IS 'Closed trade records for performance reporting, journal, and backtesting data.';

-- Table: trade_events - granular trade event log
CREATE TABLE IF NOT EXISTS trade_events (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

-- Comment: trade_events stores granular events within trade lifecycle (signal, entry, exit, etc.)
COMMENT ON TABLE trade_events IS 'Granular trade event log for strategy analysis and debugging.';

-- Table: strategy_decisions - strategy decision records
CREATE TABLE IF NOT EXISTS strategy_decisions (
  id SERIAL PRIMARY KEY,
  decision VARCHAR(50) NOT NULL,
  reasons JSONB,
  signal_score INTEGER,
  regime VARCHAR(50),
  chop BOOLEAN,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Comment: strategy_decisions records every decision (trade/no-trade) with full reasoning
COMMENT ON TABLE strategy_decisions 'Records every strategy decision (trade/no-trade) with full reasoning for audit and analysis.';

-- Table: system_events - system-level event log
CREATE TABLE IF NOT EXISTS system_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB,
  severity VARCHAR(20) DEFAULT 'INFO',
  occurred_at TIMESTAMP DEFAULT NOW()
);

-- Comment: system_events logs system-level events (startup, shutdown, errors, reconnections)
COMMENT ON TABLE system_events 'Logs system-level events including startup, shutdown, errors, reconnections, and emergency stop events.';