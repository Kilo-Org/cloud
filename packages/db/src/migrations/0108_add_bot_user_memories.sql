CREATE TABLE "bot_user_memories" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform_integration_id" uuid,
	"content" text NOT NULL,
	"importance" smallint DEFAULT 5 NOT NULL,
	"source_bot_request_id" uuid,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "bot_user_memories_importance_range" CHECK ("bot_user_memories"."importance" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "bot_user_memories" ADD CONSTRAINT "bot_user_memories_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_user_memories" ADD CONSTRAINT "bot_user_memories_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_user_memories" ADD CONSTRAINT "bot_user_memories_source_bot_request_id_bot_requests_id_fk" FOREIGN KEY ("source_bot_request_id") REFERENCES "public"."bot_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_user_memories" ADD CONSTRAINT "bot_user_memories_superseded_by_bot_user_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."bot_user_memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bot_user_memories_user_active" ON "bot_user_memories" USING btree ("user_id","platform_integration_id") WHERE "bot_user_memories"."superseded_by" is null;