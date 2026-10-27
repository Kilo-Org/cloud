CREATE TABLE "enkrypt_guardrail_charges" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"api_kind" text NOT NULL,
	"decision" text NOT NULL,
	"enkrypt_credits_cost" real,
	"charged_microdollars" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enkrypt_guardrail_charges_api_kind_check" CHECK ("enkrypt_guardrail_charges"."api_kind" IN ('chat_completions', 'messages', 'responses')),
	CONSTRAINT "enkrypt_guardrail_charges_decision_check" CHECK ("enkrypt_guardrail_charges"."decision" IN ('allowed', 'blocked', 'error')),
	CONSTRAINT "enkrypt_guardrail_charges_charged_microdollars_non_negative_check" CHECK ("enkrypt_guardrail_charges"."charged_microdollars" >= 0)
);
--> statement-breakpoint
CREATE INDEX "IDX_enkrypt_guardrail_charges_organization_created_at" ON "enkrypt_guardrail_charges" USING btree ("organization_id","created_at");