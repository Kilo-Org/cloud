ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "total_tokens_in" integer;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "total_tokens_out" integer;--> statement-breakpoint
ALTER TABLE "cloud_agent_code_reviews" ADD COLUMN "total_cost_musd" integer;