ALTER TABLE "kilo_pass_store_events" ADD COLUMN "app_account_token" uuid;--> statement-breakpoint
ALTER TABLE "kilo_pass_store_purchases" ADD COLUMN "app_account_token" uuid;--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "app_store_account_token" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_events_app_account_token" ON "kilo_pass_store_events" USING btree ("app_account_token");--> statement-breakpoint
CREATE INDEX "IDX_kilo_pass_store_purchases_app_account_token" ON "kilo_pass_store_purchases" USING btree ("app_account_token");--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD CONSTRAINT "kilocode_users_app_store_account_token_unique" UNIQUE("app_store_account_token");