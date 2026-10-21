ALTER TABLE "exa_usage_log" ADD COLUMN "charged_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "exa_usage_log" SET "charged_microdollars" = "cost_microdollars" WHERE "charged_to_balance" = true;
