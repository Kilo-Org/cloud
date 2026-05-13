CREATE TABLE "cloud_agent_code_review_attempts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code_review_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"retry_of_attempt_id" uuid,
	"retry_reason" text,
	"session_id" text,
	"cli_session_id" text,
	"execution_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"terminal_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_agent_code_review_attempts_attempt_number_check" CHECK ("cloud_agent_code_review_attempts"."attempt_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "cloud_agent_code_review_attempts_code_review_id_cloud_agent_code_reviews_id_fk" FOREIGN KEY ("code_review_id") REFERENCES "public"."cloud_agent_code_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_review_attempts" ADD CONSTRAINT "cloud_agent_code_review_attempts_retry_of_attempt_id_cloud_agent_code_review_attempts_id_fk" FOREIGN KEY ("retry_of_attempt_id") REFERENCES "public"."cloud_agent_code_review_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_cloud_agent_code_review_attempts_review_attempt_number" ON "cloud_agent_code_review_attempts" USING btree ("code_review_id","attempt_number");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_attempts_code_review_id" ON "cloud_agent_code_review_attempts" USING btree ("code_review_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_attempts_session_id" ON "cloud_agent_code_review_attempts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_attempts_cli_session_id" ON "cloud_agent_code_review_attempts" USING btree ("cli_session_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_attempts_status" ON "cloud_agent_code_review_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cloud_agent_code_review_attempts_retry_reason" ON "cloud_agent_code_review_attempts" USING btree ("retry_reason");