CREATE TABLE "cost_insight_rollup_repairs" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"usage_id" uuid NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"hour_start" timestamp with time zone NOT NULL,
	"generation" bigint DEFAULT '1' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_insight_rollup_repairs_usage_id_unique" UNIQUE("usage_id"),
	CONSTRAINT "cost_insight_rollup_repairs_owner_check" CHECK (("cost_insight_rollup_repairs"."owned_by_user_id" IS NOT NULL AND "cost_insight_rollup_repairs"."owned_by_organization_id" IS NULL) OR ("cost_insight_rollup_repairs"."owned_by_user_id" IS NULL AND "cost_insight_rollup_repairs"."owned_by_organization_id" IS NOT NULL)),
	CONSTRAINT "cost_insight_rollup_repairs_hour_check" CHECK ("cost_insight_rollup_repairs"."hour_start" = date_trunc('hour', "cost_insight_rollup_repairs"."hour_start", 'UTC')),
	CONSTRAINT "cost_insight_rollup_repairs_generation_check" CHECK ("cost_insight_rollup_repairs"."generation" > 0 AND "cost_insight_rollup_repairs"."generation" <= 9007199254740991),
	CONSTRAINT "cost_insight_rollup_repairs_attempt_count_check" CHECK ("cost_insight_rollup_repairs"."attempt_count" >= 0),
	CONSTRAINT "cost_insight_rollup_repairs_claim_token_check" CHECK (("cost_insight_rollup_repairs"."claimed_at" IS NULL AND "cost_insight_rollup_repairs"."claim_token" IS NULL) OR ("cost_insight_rollup_repairs"."claimed_at" IS NOT NULL AND "cost_insight_rollup_repairs"."claim_token" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "cost_insight_rollup_repairs" ADD CONSTRAINT "cost_insight_rollup_repairs_usage_id_microdollar_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."microdollar_usage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_insight_rollup_repairs" ADD CONSTRAINT "cost_insight_rollup_repairs_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cost_insight_rollup_repairs" ADD CONSTRAINT "cost_insight_rollup_repairs_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_rollup_repairs_user_hour" ON "cost_insight_rollup_repairs" USING btree ("owned_by_user_id","hour_start");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_rollup_repairs_org_hour" ON "cost_insight_rollup_repairs" USING btree ("owned_by_organization_id","hour_start");--> statement-breakpoint
CREATE INDEX "IDX_cost_insight_rollup_repairs_claim" ON "cost_insight_rollup_repairs" USING btree ("attempt_count","next_attempt_at","claimed_at","hour_start","id");