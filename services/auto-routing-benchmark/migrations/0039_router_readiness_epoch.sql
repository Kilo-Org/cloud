CREATE TABLE `benchmark_readiness_epoch` (
	`router` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);

--> statement-breakpoint
INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`) VALUES
	('efficient', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('frontier', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
-- A row "serves" when its status is `ready`: that is exactly what a published table ranks
-- (`listReadyCurrentProfilesForEntries` requires a ready row with a run). Only a write that moves
-- a serving row in or out of that set, or changes the measurement identity or provenance of a
-- serving row, can change a table. Claim, requeue and failure-retry churn between non-serving
-- states stays out, so a busy queue cannot invalidate every pool's cached table.
CREATE TRIGGER `benchmark_profiles_readiness_epoch`
AFTER UPDATE ON `benchmark_profiles`
WHEN (OLD.`status` = 'ready' OR NEW.`status` = 'ready')
	AND (
		OLD.`status` IS NOT NEW.`status`
		OR OLD.`run_id` IS NOT NEW.`run_id`
		OR OLD.`completed_at` IS NOT NEW.`completed_at`
		OR OLD.`invalidated_at` IS NOT NEW.`invalidated_at`
		OR OLD.`engine_identity` IS NOT NEW.`engine_identity`
		OR OLD.`repetitions` IS NOT NEW.`repetitions`
		OR OLD.`platform_requested` IS NOT NEW.`platform_requested`
		OR OLD.`router` IS NOT NEW.`router`
		-- `model` and `variant` are part of the primary key and no current writer sets them, but
		-- SQLite permits re-keying a row: these guards keep a future raw-SQL writer from changing
		-- a table without bumping, at no cost.
		OR OLD.`model` IS NOT NEW.`model`
		OR OLD.`variant` IS NOT NEW.`variant`
	)
BEGIN
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	VALUES (OLD.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
	-- A row can be re-keyed to another router; that other router's table changes too.
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	SELECT NEW.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE NEW.`router` IS NOT OLD.`router`
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- Effective policy is `policy_overrides[key] ?? policy_computed[key].value ?? <column>` for the
-- auto settings, and every one of those inputs is persisted on this row. A saved policy change
-- therefore alters which candidate wins a route without touching a single profile, so the epoch
-- must advance with it in the same transaction. Audit columns (`updated_at`, `updated_by`) and the
-- legacy/fixed columns that `replaceConfig` rewrites to their canonical value on every save are
-- deliberately excluded: an audit-only or no-op save invalidates nothing.
CREATE TRIGGER `benchmark_config_readiness_epoch`
AFTER UPDATE ON `benchmark_config`
WHEN OLD.`min_accuracy` IS NOT NEW.`min_accuracy`
	OR OLD.`accuracy_noise_band` IS NOT NEW.`accuracy_noise_band`
	OR OLD.`production_token_profile` IS NOT NEW.`production_token_profile`
	OR OLD.`switch_horizon_turns` IS NOT NEW.`switch_horizon_turns`
	OR OLD.`policy_overrides` IS NOT NEW.`policy_overrides`
	OR OLD.`policy_computed` IS NOT NEW.`policy_computed`
	-- A pure re-key moves the whole policy to another router, so both tables change even though
	-- no policy value did.
	OR OLD.`router` IS NOT NEW.`router`
BEGIN
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	VALUES (NEW.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
	-- A re-keyed config row moves that policy to another router.
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	SELECT OLD.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE OLD.`router` IS NOT NEW.`router`
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- The first saved config replaces the defaults every table was built from.
CREATE TRIGGER `benchmark_config_readiness_epoch_insert`
AFTER INSERT ON `benchmark_config`
BEGIN
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	VALUES (NEW.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- A row inserted already serving (a restore or an import) changes that router's table.
CREATE TRIGGER `benchmark_profiles_readiness_epoch_insert`
AFTER INSERT ON `benchmark_profiles`
WHEN NEW.`status` = 'ready'
BEGIN
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	VALUES (NEW.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- Deleting a serving row removes a candidate from that router's table.
CREATE TRIGGER `benchmark_profiles_readiness_epoch_delete`
AFTER DELETE ON `benchmark_profiles`
WHEN OLD.`status` = 'ready'
BEGIN
	INSERT INTO `benchmark_readiness_epoch` (`router`, `epoch`, `updated_at`)
	VALUES (OLD.`router`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT (`router`) DO UPDATE SET
		`epoch` = `benchmark_readiness_epoch`.`epoch` + 1,
		`updated_at` = excluded.`updated_at`;
END;
