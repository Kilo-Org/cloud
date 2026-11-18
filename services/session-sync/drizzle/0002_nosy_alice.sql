ALTER TABLE `session` ADD `tenant_lease` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `entities_blob_hash_idx` ON `entities` (`blob_hash`) WHERE "entities"."blob_hash" IS NOT NULL;
--> statement-breakpoint
UPDATE `blobs` SET `state` = 'unreferenced', `deadline` = unixepoch() * 1000 + 900000 WHERE `state` = 'ready' AND NOT EXISTS (SELECT 1 FROM `entities` WHERE `entities`.`blob_hash` = `blobs`.`hash`);