ALTER TABLE "custom_llm" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "custom_llm" ADD COLUMN "included_tools" jsonb;--> statement-breakpoint
ALTER TABLE "custom_llm" ADD COLUMN "excluded_tools" jsonb;--> statement-breakpoint
ALTER TABLE "custom_llm" ADD COLUMN "supports_image_input" boolean;