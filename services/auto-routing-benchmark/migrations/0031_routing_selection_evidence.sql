ALTER TABLE `routing_table_candidates` ADD `p50_latency_ms` real;--> statement-breakpoint
ALTER TABLE `routing_table_candidates` ADD `p50_ttft_ms` real;--> statement-breakpoint
ALTER TABLE `routing_tables` ADD `accuracy_noise_band` real;