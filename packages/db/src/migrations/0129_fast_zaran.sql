CREATE TABLE "model_eval_ingest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bench_eval_name" text NOT NULL,
	"bench_eval_url" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_stats_id" uuid,
	"variant" text,
	"task_source" text NOT NULL,
	"n_total_trials" integer NOT NULL,
	"total_score" numeric(14, 6) NOT NULL,
	"overall_score" numeric(12, 8) NOT NULL,
	"n_errored" integer NOT NULL,
	"avg_cost_usd" numeric(14, 8),
	"avg_input_tokens" numeric(16, 6),
	"avg_output_tokens" numeric(16, 6),
	"avg_cache_read_tokens" numeric(16, 6),
	"avg_execution_ms" numeric(16, 6),
	"promoted_at" timestamp with time zone NOT NULL,
	"promoted_by_email" text NOT NULL,
	"promotion_note" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_eval_ingest_bench_eval_name_unique" UNIQUE("bench_eval_name")
);
--> statement-breakpoint
ALTER TABLE "model_eval_ingest" ADD CONSTRAINT "model_eval_ingest_model_stats_id_model_stats_id_fk" FOREIGN KEY ("model_stats_id") REFERENCES "public"."model_stats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_model_eval_ingest_lookup" ON "model_eval_ingest" USING btree ("provider","model","variant","task_source","promoted_at");--> statement-breakpoint
CREATE INDEX "IDX_model_eval_ingest_model_stats" ON "model_eval_ingest" USING btree ("model_stats_id");