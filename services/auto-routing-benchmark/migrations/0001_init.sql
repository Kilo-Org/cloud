CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('classifier', 'decider')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  config_json TEXT NOT NULL,
  error TEXT
);

CREATE TABLE case_results (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id),
  model TEXT NOT NULL,
  case_id TEXT NOT NULL,
  tier TEXT,
  score REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd REAL,
  detail_json TEXT,
  error TEXT,
  PRIMARY KEY (run_id, model, case_id)
);
CREATE INDEX idx_case_results_run ON case_results (run_id);

CREATE TABLE model_summaries (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id),
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  accuracy REAL NOT NULL,
  avg_cost_usd REAL,
  avg_latency_ms REAL NOT NULL,
  p50_latency_ms REAL,
  cases INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY (run_id, model, tier)
);

CREATE TABLE routing_tables (
  run_id TEXT PRIMARY KEY REFERENCES benchmark_runs(id),
  published_at TEXT NOT NULL,
  table_json TEXT NOT NULL
);

CREATE TABLE benchmark_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
