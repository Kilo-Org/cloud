CREATE TABLE "kiloclaw_cli_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_cli_runs" ADD CONSTRAINT "kiloclaw_cli_runs_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_cli_runs_user_id" ON "kiloclaw_cli_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_cli_runs_started_at" ON "kiloclaw_cli_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_free_model_usage_user_created_at" ON "free_model_usage" USING btree ("kilo_user_id","created_at") WHERE "free_model_usage"."kilo_user_id" is not null;