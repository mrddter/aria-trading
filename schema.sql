-- Esegui con: wrangler d1 execute trading-bot --file=./schema.sql

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  position_side TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,         -- 'PENDING', 'OPEN', 'CLOSED', 'CANCELLED'
  pnl REAL DEFAULT 0,
  binance_order_id TEXT,
  signal_source TEXT,           -- 'technical', 'llm', 'manual'
  notes TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  strength REAL NOT NULL,
  indicators TEXT NOT NULL,
  action TEXT,
  executed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_pnl REAL DEFAULT 0,
  max_drawdown REAL DEFAULT 0,
  balance_snapshot REAL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_symbol_status ON trades(symbol, status);
CREATE INDEX idx_signals_created ON signals(created_at);
CREATE INDEX idx_daily_stats_date ON daily_stats(date);

-- Sentiment tables
CREATE TABLE IF NOT EXISTS sentiment_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT NOT NULL,
  sentiment_score REAL NOT NULL,
  confidence REAL NOT NULL,
  magnitude REAL NOT NULL,
  direction TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  raw_text_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT NOT NULL,
  composite_score REAL NOT NULL,
  signal_count INTEGER NOT NULL,
  freshness_hours REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sentiment_asset_time ON sentiment_signals(asset, created_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_asset_time ON sentiment_snapshots(asset, created_at);

-- ============================================================
-- Experience Database: Long-term memory for the trading bot
-- ============================================================

-- News events with LLM classification and actual outcomes
CREATE TABLE IF NOT EXISTS news_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  asset TEXT,
  sentiment_score REAL,
  confidence REAL,
  magnitude REAL,
  category TEXT,
  impact_level TEXT DEFAULT 'NORMAL',
  price_1h_change REAL,
  price_4h_change REAL,
  price_24h_change REAL,
  was_correct BOOLEAN,
  published_at TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily performance snapshots
CREATE TABLE IF NOT EXISTS daily_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  starting_balance REAL,
  ending_balance REAL,
  realized_pnl REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,
  fees REAL DEFAULT 0,
  trades_opened INTEGER DEFAULT 0,
  trades_closed INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  regime TEXT,
  fear_greed_avg INTEGER,
  btc_change_percent REAL,
  llm_cost REAL DEFAULT 0,
  llm_calls INTEGER DEFAULT 0,
  net_pnl REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Learned patterns: what works and what doesn't
CREATE TABLE IF NOT EXISTS patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  asset TEXT,
  category TEXT,
  regime TEXT,
  direction TEXT,
  occurrences INTEGER DEFAULT 1,
  successes INTEGER DEFAULT 0,
  avg_pnl_percent REAL DEFAULT 0,
  win_rate REAL DEFAULT 0,
  last_seen TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add experience context columns to existing trades table
-- (run these separately if trades table already exists)
-- ALTER TABLE trades ADD COLUMN regime TEXT;
-- ALTER TABLE trades ADD COLUMN fear_greed INTEGER;
-- ALTER TABLE trades ADD COLUMN btc_price REAL;
-- ALTER TABLE trades ADD COLUMN sentiment_score REAL;
-- ALTER TABLE trades ADD COLUMN confidence REAL;
-- ALTER TABLE trades ADD COLUMN reasoning TEXT;
-- ALTER TABLE trades ADD COLUMN rsi REAL;
-- ALTER TABLE trades ADD COLUMN adx REAL;
-- ALTER TABLE trades ADD COLUMN atr REAL;
-- ALTER TABLE trades ADD COLUMN volume_ratio REAL;
-- ALTER TABLE trades ADD COLUMN holding_hours REAL;
-- ALTER TABLE trades ADD COLUMN strategy TEXT;
-- ALTER TABLE trades ADD COLUMN direction TEXT;
-- ALTER TABLE trades ADD COLUMN leverage INTEGER DEFAULT 3;

CREATE INDEX IF NOT EXISTS idx_news_asset ON news_events(asset);
CREATE INDEX IF NOT EXISTS idx_news_processed_at ON news_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_news_category ON news_events(category);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_patterns_asset ON patterns(asset);
