COMMIT;--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_container_usage_interval_open_actor" ON "container_usage_interval" USING btree ("actor_type","actor_id") WHERE "container_usage_interval"."status" = 'open';--> statement-breakpoint
BEGIN;
