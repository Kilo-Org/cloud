DROP INDEX "UQ_openai_chatgpt_connections_org_member";--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD COLUMN "is_shared_services" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD COLUMN "usage_limit_reached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD COLUMN "usage_limit_resets_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_openai_chatgpt_connections_org_shared_services" ON "openai_chatgpt_connections" USING btree ("organization_id") WHERE "openai_chatgpt_connections"."is_shared_services" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_openai_chatgpt_connections_org_member" ON "openai_chatgpt_connections" USING btree ("kilo_user_id","organization_id") WHERE "openai_chatgpt_connections"."organization_id" IS NOT NULL AND "openai_chatgpt_connections"."is_shared_services" = false;