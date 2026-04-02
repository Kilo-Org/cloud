CREATE TABLE "coding_plan_key_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"encrypted_api_key" jsonb NOT NULL,
	"assigned_to_user_id" text,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coding_plan_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"byok_key_id" uuid,
	"status" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"billing_period_days" integer NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"credit_renewal_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"auto_top_up_triggered_for_period" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_plan_subscriptions_status_check" CHECK ("coding_plan_subscriptions"."status" IN ('active', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "coding_plan_key_inventory" ADD CONSTRAINT "coding_plan_key_inventory_assigned_to_user_id_kilocode_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_subscriptions" ADD CONSTRAINT "coding_plan_subscriptions_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_subscriptions" ADD CONSTRAINT "coding_plan_subscriptions_byok_key_id_byok_api_keys_id_fk" FOREIGN KEY ("byok_key_id") REFERENCES "public"."byok_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_key_inv_provider" ON "coding_plan_key_inventory" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_key_inv_unassigned" ON "coding_plan_key_inventory" USING btree ("provider_id") WHERE "coding_plan_key_inventory"."assigned_to_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_coding_plan_sub_user_provider" ON "coding_plan_subscriptions" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_sub_status" ON "coding_plan_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_sub_renewal" ON "coding_plan_subscriptions" USING btree ("credit_renewal_at");