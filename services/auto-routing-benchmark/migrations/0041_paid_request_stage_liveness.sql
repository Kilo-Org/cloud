ALTER TABLE `paid_benchmark_requests` ADD `last_staged_at` text;--> statement-breakpoint
-- Liveness now reads the last slot actually staged, so a request already staging in
-- production starts from its last row update instead of its creation time: without this an
-- in-flight large plan older than the inactivity window would be closed by its first pass.
UPDATE `paid_benchmark_requests` SET `last_staged_at` = `updated_at` WHERE `status` = 'preparing' AND `last_staged_at` IS NULL;
