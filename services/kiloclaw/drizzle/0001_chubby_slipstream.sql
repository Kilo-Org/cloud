CREATE TABLE `provision_reservations` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`do_key` text NOT NULL,
	`assigned_user_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`failure_code` text,
	`resolution_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_provision_reservations_unresolved_user` ON `provision_reservations` (`assigned_user_id`) WHERE "provision_reservations"."status" IN ('in_progress', 'failed_requires_reconciliation');