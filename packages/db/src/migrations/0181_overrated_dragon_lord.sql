DROP INDEX "idx_magic_link_tokens_email";--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "purpose" text DEFAULT 'magic_link' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_magic_link_tokens_email_purpose" ON "magic_link_tokens" USING btree ("email","purpose");