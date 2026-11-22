COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "IDX_auto_routing_custom_routers_entries";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "IDX_auto_routing_custom_routers_entries" ON "auto_routing_custom_routers" USING gin ("entries" jsonb_path_ops);--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;--> statement-breakpoint
BEGIN;
