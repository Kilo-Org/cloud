CREATE TABLE "bot_requests" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"created_by" text NOT NULL,
	"organization_id" uuid,
	"platform_integration_id" uuid,
	"platform" text NOT NULL,
	"platform_thread_id" text NOT NULL,
	"platform_message_id" text,
	"user_message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"model_used" text,
	"steps" jsonb,
	"cloud_agent_session_id" text,
	"response_time_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_created_by_kilocode_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_bot_requests_created_at" ON "bot_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_bot_requests_created_by" ON "bot_requests" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_bot_requests_organization_id" ON "bot_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_requests_platform_integration_id" ON "bot_requests" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE INDEX "IDX_bot_requests_status" ON "bot_requests" USING btree ("status");