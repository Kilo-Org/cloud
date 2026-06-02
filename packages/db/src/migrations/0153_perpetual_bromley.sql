CREATE TABLE "coding_plan_availability_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coding_plan_key_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_plan_id" text NOT NULL,
	"encrypted_api_key" jsonb,
	"credential_fingerprint" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"assigned_to_user_id" text,
	"assigned_at" timestamp with time zone,
	"revocation_requested_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_revocation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_plan_key_inventory_status_check" CHECK ("coding_plan_key_inventory"."status" IN ('available', 'assigned', 'revocation_pending', 'revoked', 'revocation_failed'))
);
--> statement-breakpoint
CREATE TABLE "coding_plan_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"key_inventory_id" uuid,
	"installed_byok_key_id" uuid,
	"status" text NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"billing_period_days" integer NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"credit_renewal_at" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_started_at" timestamp with time zone,
	"payment_grace_expires_at" timestamp with time zone,
	"auto_top_up_attempted_for_due" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_plan_subscriptions_status_check" CHECK ("coding_plan_subscriptions"."status" IN ('active', 'past_due', 'canceled')),
	CONSTRAINT "coding_plan_subscriptions_live_access_check" CHECK ("coding_plan_subscriptions"."status" = 'canceled' OR "coding_plan_subscriptions"."key_inventory_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "coding_plan_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"cost_microdollars" bigint NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_plan_terms_kind_check" CHECK ("coding_plan_terms"."kind" IN ('activation', 'extension', 'renewal'))
);
--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD COLUMN "management_source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "coding_plan_availability_intents" ADD CONSTRAINT "coding_plan_availability_intents_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_key_inventory" ADD CONSTRAINT "coding_plan_key_inventory_assigned_to_user_id_kilocode_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_subscriptions" ADD CONSTRAINT "coding_plan_subscriptions_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_subscriptions" ADD CONSTRAINT "coding_plan_subscriptions_key_inventory_id_coding_plan_key_inventory_id_fk" FOREIGN KEY ("key_inventory_id") REFERENCES "public"."coding_plan_key_inventory"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_subscriptions" ADD CONSTRAINT "coding_plan_subscriptions_installed_byok_key_id_byok_api_keys_id_fk" FOREIGN KEY ("installed_byok_key_id") REFERENCES "public"."byok_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_terms" ADD CONSTRAINT "coding_plan_terms_subscription_id_coding_plan_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."coding_plan_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_terms" ADD CONSTRAINT "coding_plan_terms_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_plan_terms" ADD CONSTRAINT "coding_plan_terms_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_coding_plan_availability_intents_user_plan" ON "coding_plan_availability_intents" USING btree ("user_id","plan_id");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_availability_intents_plan" ON "coding_plan_availability_intents" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_coding_plan_key_inv_fingerprint" ON "coding_plan_key_inventory" USING btree ("credential_fingerprint");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_key_inv_plan_status" ON "coding_plan_key_inventory" USING btree ("plan_id","status");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_key_inv_available" ON "coding_plan_key_inventory" USING btree ("plan_id") WHERE "coding_plan_key_inventory"."status" = 'available';--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_coding_plan_sub_live_user_plan" ON "coding_plan_subscriptions" USING btree ("user_id","plan_id") WHERE "coding_plan_subscriptions"."status" IN ('active', 'past_due');--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_sub_status" ON "coding_plan_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_sub_renewal" ON "coding_plan_subscriptions" USING btree ("credit_renewal_at");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_sub_inventory" ON "coding_plan_subscriptions" USING btree ("key_inventory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_coding_plan_terms_request" ON "coding_plan_terms" USING btree ("user_id","plan_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "IDX_coding_plan_terms_subscription" ON "coding_plan_terms" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD CONSTRAINT "byok_api_keys_management_source_check" CHECK ("byok_api_keys"."management_source" IN ('user', 'coding_plan'));