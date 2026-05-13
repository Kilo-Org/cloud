ALTER TABLE "kiloclaw_subscriptions" ADD COLUMN "kiloclaw_price_version" text;--> statement-breakpoint
UPDATE "kiloclaw_subscriptions" SET "kiloclaw_price_version" = '2026-03-19' WHERE "kiloclaw_price_version" IS NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_subscriptions" ALTER COLUMN "kiloclaw_price_version" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_subscriptions_price_version" ON "kiloclaw_subscriptions" USING btree ("kiloclaw_price_version");