DROP TABLE "model_experiment_request";
--> statement-breakpoint
CREATE TABLE "model_experiment_request" (
	"usage_id" uuid NOT NULL,
	"variant_version_id" uuid NOT NULL,
	"allocation_subject" text NOT NULL,
	"client_request_id" text,
	"request_kind" text NOT NULL,
	"request_body_sha256" text NOT NULL,
	"was_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_experiment_request_usage_id_created_at_pk" PRIMARY KEY("usage_id","created_at"),
	CONSTRAINT "model_experiment_request_allocation_subject_valid" CHECK ("model_experiment_request"."allocation_subject" IN ('user', 'machine', 'ip')),
	CONSTRAINT "model_experiment_request_request_kind_valid" CHECK ("model_experiment_request"."request_kind" IN ('chat_completions', 'messages', 'responses')),
	CONSTRAINT "model_experiment_request_request_body_sha256_format" CHECK ("model_experiment_request"."request_body_sha256" ~ '^[0-9a-f]{64}$' OR "model_experiment_request"."request_body_sha256" IN ('__failed__', '__deleted__'))
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "model_experiment_request_2026_05" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
--> statement-breakpoint
CREATE TABLE "model_experiment_request_2026_06" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
--> statement-breakpoint
CREATE TABLE "model_experiment_request_2026_07" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD CONSTRAINT "model_experiment_request_usage_id_microdollar_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."microdollar_usage"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD CONSTRAINT "model_experiment_request_variant_version_id_model_experiment_variant_version_id_fk" FOREIGN KEY ("variant_version_id") REFERENCES "public"."model_experiment_variant_version"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_request_variant_version_created_at" ON "model_experiment_request" USING btree ("variant_version_id","created_at");
--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_request_client_request_id" ON "model_experiment_request" USING btree ("client_request_id") WHERE "model_experiment_request"."client_request_id" is not null;
