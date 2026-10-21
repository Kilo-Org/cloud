ALTER TABLE "model_eval_ingestions" ADD COLUMN "benchmark_release" text;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "benchmark_revision" text;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "benchmark_scope" text;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "included_task_count" integer;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "suite_task_count" integer;--> statement-breakpoint
ALTER TABLE "model_eval_ingestions" ADD COLUMN "dataset_digest" text;