ALTER TABLE "custom_llm" ADD COLUMN "extra_body" jsonb;--> statement-breakpoint
ALTER TABLE "custom_llm" DROP COLUMN "verbosity";--> statement-breakpoint
ALTER TABLE "custom_llm" DROP COLUMN "reasoning_effort";