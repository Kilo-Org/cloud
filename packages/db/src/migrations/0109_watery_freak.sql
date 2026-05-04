CREATE TABLE "model_eval_ingest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bench_job_name" text NOT NULL,
	"bench_job_url" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_stats_id" uuid,
	"variant" text,
	"task_source" text NOT NULL,
	"task_source_display_name" text,
	"n_trials" integer NOT NULL,
	"success_rate" numeric(5, 4) NOT NULL,
	"avg_cost_usd" numeric(10, 6),
	"avg_input_tokens" integer,
	"avg_output_tokens" integer,
	"avg_cache_read_tokens" integer,
	"avg_execution_ms" integer,
	"review_note" text,
	"promoted_by_email" text NOT NULL,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_eval_ingest" ADD CONSTRAINT "model_eval_ingest_model_stats_id_model_stats_id_fk" FOREIGN KEY ("model_stats_id") REFERENCES "public"."model_stats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_model_eval_ingest_model" ON "model_eval_ingest" USING btree ("model");--> statement-breakpoint
CREATE INDEX "IDX_model_eval_ingest_model_stats" ON "model_eval_ingest" USING btree ("model_stats_id");--> statement-breakpoint
CREATE INDEX "IDX_model_eval_ingest_lookup" ON "model_eval_ingest" USING btree ("provider","model","variant","task_source","promoted_at");