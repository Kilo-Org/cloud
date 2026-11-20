ALTER TABLE "openai_chatgpt_connections" ALTER COLUMN "encrypted_connection" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openai_chatgpt_connections" ADD COLUMN "chatgpt_account_fingerprint" text;--> statement-breakpoint
CREATE INDEX "IDX_openai_chatgpt_connections_account_fingerprint" ON "openai_chatgpt_connections" USING btree ("chatgpt_account_fingerprint");