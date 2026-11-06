CREATE TABLE "claude_billing_connections" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"user_profile_id" text NOT NULL,
	"connection_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_refusal_code" text,
	"last_refusal_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "UQ_claude_billing_connections_user_profile_id" UNIQUE("user_profile_id"),
	CONSTRAINT "claude_billing_connections_status_check" CHECK ("claude_billing_connections"."status" IN ('pending', 'connected', 'billing_unavailable', 'removed')),
	CONSTRAINT "claude_billing_connections_owner_check" CHECK ((
        ("claude_billing_connections"."kilo_user_id" IS NOT NULL AND "claude_billing_connections"."organization_id" IS NULL) OR
        ("claude_billing_connections"."kilo_user_id" IS NULL AND "claude_billing_connections"."organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "claude_billing_connections" ADD CONSTRAINT "claude_billing_connections_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_billing_connections" ADD CONSTRAINT "claude_billing_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_connections_personal" ON "claude_billing_connections" USING btree ("kilo_user_id") WHERE "claude_billing_connections"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_connections_organization" ON "claude_billing_connections" USING btree ("organization_id") WHERE "claude_billing_connections"."organization_id" IS NOT NULL;