CREATE TABLE "openai_chatgpt_connections" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"encrypted_connection" jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD CONSTRAINT "openai_chatgpt_connections_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD CONSTRAINT "openai_chatgpt_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_openai_chatgpt_connections_personal" ON "openai_chatgpt_connections" USING btree ("kilo_user_id") WHERE "openai_chatgpt_connections"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_openai_chatgpt_connections_org_member" ON "openai_chatgpt_connections" USING btree ("kilo_user_id","organization_id") WHERE "openai_chatgpt_connections"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_openai_chatgpt_connections_organization_id" ON "openai_chatgpt_connections" USING btree ("organization_id");