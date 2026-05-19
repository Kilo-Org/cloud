ALTER TABLE `attachments` ADD `idempotency_key` text;--> statement-breakpoint
CREATE INDEX `attachments_uploader_idempotency` ON `attachments` (`uploader_id`,`idempotency_key`,`created_at`);