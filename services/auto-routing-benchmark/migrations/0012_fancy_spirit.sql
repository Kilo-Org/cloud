ALTER TABLE `benchmark_config` ADD `production_token_profile` text;--> statement-breakpoint
ALTER TABLE `benchmark_config` ADD `switch_horizon_turns` integer;--> statement-breakpoint
ALTER TABLE `routing_table_candidates` ADD `pricing` text;--> statement-breakpoint
ALTER TABLE `routing_table_candidates` ADD `estimated_request_cost_usd` real;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `production_token_profile` text;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `switch_horizon_turns` integer;