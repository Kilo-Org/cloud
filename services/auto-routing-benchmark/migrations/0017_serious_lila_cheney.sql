DROP TABLE `config_auto_decider_exclusions`;--> statement-breakpoint
DROP TABLE `config_auto_decider_models`;--> statement-breakpoint
ALTER TABLE `benchmark_config` DROP COLUMN `auto_decider_min_cost_usd`;--> statement-breakpoint
ALTER TABLE `benchmark_config` DROP COLUMN `auto_decider_max_cost_usd`;