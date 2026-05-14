ALTER TABLE "model_eval_ingest" ALTER COLUMN "avg_input_tokens" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_eval_ingest" ALTER COLUMN "avg_output_tokens" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_eval_ingest" ALTER COLUMN "avg_cache_read_tokens" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_eval_ingest" ALTER COLUMN "avg_execution_ms" SET DATA TYPE numeric(14, 6);