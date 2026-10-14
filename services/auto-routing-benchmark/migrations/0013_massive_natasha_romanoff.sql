ALTER TABLE `profile_benchmark_admissions` ADD `recovery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_benchmark_admissions` ADD `recovery_next_at` text;