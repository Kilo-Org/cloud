ALTER TABLE "organizations" ADD COLUMN "total_microdollars_acquired" bigint DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "next_credit_expiration_at" timestamp with time zone;--> statement-breakpoint
UPDATE "organizations" SET "total_microdollars_acquired" = "microdollars_balance" + "microdollars_used";