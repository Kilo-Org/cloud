ALTER TABLE "custom_llm" ADD COLUMN "extra_headers" jsonb;--> statement-breakpoint
ALTER TABLE "custom_llm" DROP COLUMN "included_tools";--> statement-breakpoint
ALTER TABLE "custom_llm" DROP COLUMN "excluded_tools";