CREATE TABLE "top_up_email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_payment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "top_up_email_log" ADD CONSTRAINT "top_up_email_log_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_top_up_email_log_stripe_payment_id" ON "top_up_email_log" USING btree ("stripe_payment_id");