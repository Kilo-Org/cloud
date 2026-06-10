ALTER TABLE "model_eval_ingestions" ADD COLUMN "n_attempts" integer;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "total_cost_microdollars" bigint;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "total_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "total_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "total_cache_read_tokens" bigint;