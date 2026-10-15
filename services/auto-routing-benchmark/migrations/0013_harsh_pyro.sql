ALTER TABLE `benchmark_config` ADD `low_confidence_threshold` real;--> statement-breakpoint
ALTER TABLE `routing_table_candidates` ADD `cases` integer;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `low_confidence_threshold` real;