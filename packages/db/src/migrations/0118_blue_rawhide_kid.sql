COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_platform_integrations_linear_platform_inst" ON "platform_integrations" USING btree ("platform","platform_installation_id") WHERE "platform_integrations"."platform" = 'linear' AND "platform_integrations"."platform_installation_id" IS NOT NULL;--> statement-breakpoint
BEGIN;
