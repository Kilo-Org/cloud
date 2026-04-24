ALTER TABLE "kilocode_users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "blocked_by_kilo_user_id" text;--> statement-breakpoint
CREATE INDEX "IDX_kilocode_users_blocked_at" ON "kilocode_users" USING btree ("blocked_at");--> statement-breakpoint
CREATE INDEX "IDX_kilocode_users_blocked_by_kilo_user_id" ON "kilocode_users" USING btree ("blocked_by_kilo_user_id");