CREATE TABLE "gateway_custom_upstreams" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"kilo_user_id" text,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" jsonb NOT NULL,
	"encrypted_extra_headers" jsonb,
	"model_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "UQ_gateway_custom_upstreams_org_provider" UNIQUE("organization_id","provider_id"),
	CONSTRAINT "UQ_gateway_custom_upstreams_user_provider" UNIQUE("kilo_user_id","provider_id"),
	CONSTRAINT "gateway_custom_upstreams_owner_check" CHECK ((( "gateway_custom_upstreams"."kilo_user_id" IS NOT NULL AND "gateway_custom_upstreams"."organization_id" IS NULL) OR ( "gateway_custom_upstreams"."kilo_user_id" IS NULL AND "gateway_custom_upstreams"."organization_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "gateway_custom_upstreams" ADD CONSTRAINT "gateway_custom_upstreams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_custom_upstreams" ADD CONSTRAINT "gateway_custom_upstreams_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_gateway_custom_upstreams_organization_id" ON "gateway_custom_upstreams" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_gateway_custom_upstreams_kilo_user_id" ON "gateway_custom_upstreams" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_gateway_custom_upstreams_provider_id" ON "gateway_custom_upstreams" USING btree ("provider_id");