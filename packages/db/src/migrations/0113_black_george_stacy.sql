CREATE TABLE "transactional_email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactional_email_log" ADD CONSTRAINT "transactional_email_log_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_transactional_email_log_type_idempotency_key" ON "transactional_email_log" USING btree ("email_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "IDX_transactional_email_log_user_id" ON "transactional_email_log" USING btree ("user_id");