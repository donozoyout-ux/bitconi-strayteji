-- Adaptive Strategy Learning Engine V1
-- Stores durable trade memory and 7-trade learning checkpoints.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS trade_key VARCHAR(64);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy_version VARCHAR(120);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS setup_type VARCHAR(100);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS adx_value DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS atr_value DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS bb_basis DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pct_b DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS news_score DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fear_greed DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS mfe_percent DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS mae_percent DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_reason VARCHAR(160);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_key ON trades(trade_key);
CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time);
CREATE INDEX IF NOT EXISTS idx_trades_strategy_version ON trades(strategy_version);

CREATE TABLE IF NOT EXISTS learning_checkpoints (
  id SERIAL PRIMARY KEY,
  checkpoint_number INTEGER NOT NULL UNIQUE,
  trade_count INTEGER NOT NULL,
  batch_start_trade_id INTEGER,
  batch_end_trade_id INTEGER,
  active_strategy_version VARCHAR(120),
  batch_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  global_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_pattern BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(40) NOT NULL DEFAULT 'OBSERVE',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_checkpoints_created_at
  ON learning_checkpoints(created_at DESC);

COMMENT ON TABLE learning_checkpoints IS
  'Every 7 closed trades: performance review, error classification and non-self-applying strategy candidate.';
