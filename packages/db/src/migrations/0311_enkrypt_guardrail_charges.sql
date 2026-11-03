CREATE TABLE "enkrypt_guardrail_charges" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"session_id" text,
	"api_kind" text NOT NULL,
	"decision" text NOT NULL,
	"enkrypt_credits_cost" real,
	"charged_microdollars" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_enkrypt_guardrail_charges_organization_created_at" ON "enkrypt_guardrail_charges" USING btree ("organization_id","created_at");