-- Price-dominance pruning (lever 1 of the benchmark cost work).
--
-- Before a `(model, variant, route)` pair is measured, the drain now checks whether it
-- could win that route in any pool that would be served by measuring it: the platform
-- decider list, or one owner's custom pool. Two tables hold that decision.
--
-- `benchmark_pool_memberships` is the index that makes the question cheap: one row per
-- (pool, exact pair) written when a pool's subscription admits the pair, so a drain reads
-- the pools of its batch by primary-key prefix instead of scanning every owner snapshot.
-- `pool_kind` is the pool type the console names (`platform`, `user_subscription`,
-- `custom`); `pool_id` is the internal owner key and is never shown in public text.
--
-- `benchmark_price_verdicts` is the visible per-pair, per-route state. A row exists only
-- for a pair the drain decided to skip; `leader_version` and `pair_price_fingerprint` let
-- the next drain recognise an unchanged decision (same published table, same price) and
-- re-evaluate the moment either moves — a new publish, a catalog price change, or a pool
-- whose own ready set changed.
CREATE TABLE `benchmark_pool_memberships` (
  `router` text NOT NULL,
  `pool_kind` text NOT NULL,
  `pool_id` text NOT NULL,
  `model` text NOT NULL,
  `variant` text NOT NULL DEFAULT '',
  PRIMARY KEY (`router`, `model`, `variant`, `pool_kind`, `pool_id`)
);
--> statement-breakpoint
CREATE INDEX `IX_benchmark_pool_memberships_pool` ON `benchmark_pool_memberships` (`router`,`pool_kind`,`pool_id`);
--> statement-breakpoint
CREATE TABLE `benchmark_price_verdicts` (
  `router` text NOT NULL,
  `model` text NOT NULL,
  `variant` text NOT NULL DEFAULT '',
  `engine_identity` text NOT NULL,
  `repetitions` integer NOT NULL,
  `route_key` text NOT NULL,
  `pool_kind` text NOT NULL,
  `pool_id` text NOT NULL,
  `pair_request_cost_usd` real,
  `leader_model` text,
  `leader_variant` text,
  `leader_request_cost_usd` real,
  `leader_value` real,
  `leader_accuracy` real,
  `budget_usd` real,
  `pair_best_value` real,
  `leader_version` text NOT NULL,
  `pair_price_fingerprint` text NOT NULL,
  `evaluated_at` text NOT NULL,
  PRIMARY KEY (`router`, `model`, `variant`, `engine_identity`, `repetitions`, `route_key`)
);
--> statement-breakpoint
CREATE INDEX `IX_benchmark_price_verdicts_run` ON `benchmark_price_verdicts` (`engine_identity`,`repetitions`);
