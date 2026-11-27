ALTER TABLE "openai_chatgpt_connections" ALTER COLUMN "encrypted_connection" DROP NOT NULL;--> statement-breakpoint
UPDATE "openai_chatgpt_connections" SET "encrypted_connection" = NULL WHERE "encrypted_connection" IS NOT NULL;--> statement-breakpoint
UPDATE "coding_plan_key_inventory" SET "encrypted_api_key" = NULL WHERE "encrypted_api_key" IS NOT NULL;
