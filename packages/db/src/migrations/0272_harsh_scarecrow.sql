COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_container_usage_interval_open_subject" ON "container_usage_interval" USING btree ("subject_type","subject_id") WHERE "container_usage_interval"."status" = 'open';--> statement-breakpoint
BEGIN;
