ALTER TABLE `benchmark_config` ADD `best_accuracy_switch_threshold` real DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `best_accuracy_switch_threshold` real DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `best_accuracy_switch_threshold` real DEFAULT 0.05 NOT NULL;