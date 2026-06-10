CREATE TABLE "kiloclaw_terminal_renewal_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"renewal_boundary" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"last_failure_code" text NOT NULL,
	"last_failure_message" text,
	"resolution_actor_type" text,
	"resolution_actor_id" text,
	"resolution_at" timestamp with time zone,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_terminal_renewal_failures_status_check" CHECK ("kiloclaw_terminal_renewal_failures"."status" IN ('unresolved', 'resolved', 'waived', 'superseded')),
	CONSTRAINT "kiloclaw_terminal_renewal_failures_last_failure_code_check" CHECK ("kiloclaw_terminal_renewal_failures"."last_failure_code" IN ('credit_balance_read_failed', 'renewal_transaction_failed', 'auto_top_up_marker_write_failed', 'worker_timeout', 'poison_payload', 'queue_delivery_exhausted')),
	CONSTRAINT "kiloclaw_terminal_renewal_failures_resolution_actor_type_check" CHECK ("kiloclaw_terminal_renewal_failures"."resolution_actor_type" IN ('operator', 'system'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_terminal_renewal_failures" ADD CONSTRAINT "kiloclaw_terminal_renewal_failures_subscription_id_kiloclaw_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."kiloclaw_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_terminal_renewal_failures_subscription_boundary" ON "kiloclaw_terminal_renewal_failures" USING btree ("subscription_id","renewal_boundary");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_terminal_renewal_failures_unresolved" ON "kiloclaw_terminal_renewal_failures" USING btree ("subscription_id","renewal_boundary") WHERE "kiloclaw_terminal_renewal_failures"."status" = 'unresolved';--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_terminal_renewal_failures_status_last_failure_at" ON "kiloclaw_terminal_renewal_failures" USING btree ("status","last_failure_at");