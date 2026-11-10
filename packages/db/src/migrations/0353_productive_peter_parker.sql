CREATE TABLE "claude_billing_connection_grants" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"payer_connection_id" uuid NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "claude_billing_grants_owner_check" CHECK ("claude_billing_connection_grants"."kilo_user_id" IS NOT NULL OR "claude_billing_connection_grants"."organization_id" IS NOT NULL)
);
--> statement-breakpoint
DROP INDEX "UQ_claude_billing_connections_personal";--> statement-breakpoint
DROP INDEX "UQ_claude_billing_connections_org_member";--> statement-breakpoint
DROP INDEX "UQ_claude_billing_connections_shared_services";--> statement-breakpoint
ALTER TABLE "claude_billing_connection_grants" ADD CONSTRAINT "claude_billing_connection_grants_payer_connection_id_claude_billing_connections_id_fk" FOREIGN KEY ("payer_connection_id") REFERENCES "public"."claude_billing_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_billing_connection_grants" ADD CONSTRAINT "claude_billing_connection_grants_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_billing_connection_grants" ADD CONSTRAINT "claude_billing_connection_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_claude_billing_grants_payer_connection_id" ON "claude_billing_connection_grants" USING btree ("payer_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_grants_personal" ON "claude_billing_connection_grants" USING btree ("kilo_user_id") WHERE "claude_billing_connection_grants"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_grants_org_member" ON "claude_billing_connection_grants" USING btree ("kilo_user_id","organization_id") WHERE "claude_billing_connection_grants"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_grants_shared_services" ON "claude_billing_connection_grants" USING btree ("organization_id") WHERE "claude_billing_connection_grants"."organization_id" IS NOT NULL AND "claude_billing_connection_grants"."kilo_user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_connections_personal" ON "claude_billing_connections" USING btree ("kilo_user_id") WHERE "claude_billing_connections"."organization_id" IS NULL AND "claude_billing_connections"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_connections_org_member" ON "claude_billing_connections" USING btree ("kilo_user_id","organization_id") WHERE "claude_billing_connections"."organization_id" IS NOT NULL AND "claude_billing_connections"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_claude_billing_connections_shared_services" ON "claude_billing_connections" USING btree ("organization_id") WHERE "claude_billing_connections"."organization_id" IS NOT NULL AND "claude_billing_connections"."kilo_user_id" IS NULL AND "claude_billing_connections"."status" <> 'removed';
-->  statement-breakpoint
INSERT INTO "claude_billing_connection_grants" ("payer_connection_id", "kilo_user_id", "organization_id", "created_by", "created_at")
SELECT "id", "kilo_user_id", "organization_id", "created_by", "created_at"
FROM "claude_billing_connections"
WHERE "status" <> 'removed'
ON CONFLICT DO NOTHING;