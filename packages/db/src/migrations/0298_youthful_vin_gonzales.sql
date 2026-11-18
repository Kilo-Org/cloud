CREATE TABLE "user_notification_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category" text,
	"push_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"i18n_key" text,
	"i18n_params" jsonb,
	"fallback_title" text NOT NULL,
	"fallback_body" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"dedupe_bucket" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_notification_history" ADD CONSTRAINT "user_notification_history_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_notification_history_user_idempotency" ON "user_notification_history" USING btree ("user_id","idempotency_key","dedupe_bucket");--> statement-breakpoint
CREATE INDEX "IDX_user_notification_history_user_created" ON "user_notification_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_user_notification_history_user_category_created" ON "user_notification_history" USING btree ("user_id","category","created_at");--> statement-breakpoint
CREATE INDEX "IDX_user_notification_history_created_at" ON "user_notification_history" USING btree ("created_at");