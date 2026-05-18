CREATE TABLE "model_experiment" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"public_model_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "model_experiment_status_valid" CHECK ("model_experiment"."status" IN ('draft', 'active', 'paused', 'completed')),
	CONSTRAINT "model_experiment_active_not_archived" CHECK ("model_experiment"."status" <> 'active' OR "model_experiment"."is_archived" = false)
);
--> statement-breakpoint
CREATE TABLE "model_experiment_request" (
	"usage_id" uuid PRIMARY KEY NOT NULL,
	"variant_version_id" uuid NOT NULL,
	"allocation_subject" text NOT NULL,
	"client_request_id" text,
	"system_prompt_sha256" text NOT NULL,
	"request_body_sha256" text NOT NULL,
	"was_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_experiment_request_allocation_subject_valid" CHECK ("model_experiment_request"."allocation_subject" IN ('user', 'machine', 'ip')),
	CONSTRAINT "model_experiment_request_system_prompt_sha256_format" CHECK ("model_experiment_request"."system_prompt_sha256" ~ '^[0-9a-f]{64}$' OR "model_experiment_request"."system_prompt_sha256" IN ('__absent__', '__failed__', '__deleted__')),
	CONSTRAINT "model_experiment_request_request_body_sha256_format" CHECK ("model_experiment_request"."request_body_sha256" ~ '^[0-9a-f]{64}$' OR "model_experiment_request"."request_body_sha256" IN ('__failed__', '__deleted__'))
);
--> statement-breakpoint
CREATE TABLE "model_experiment_variant" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"label" text NOT NULL,
	"weight" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_model_experiment_variant_experiment_label" UNIQUE("experiment_id","label"),
	CONSTRAINT "model_experiment_variant_weight_positive" CHECK ("model_experiment_variant"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_experiment_variant_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"upstream" jsonb NOT NULL,
	"encrypted_api_key" jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_experiment" ADD CONSTRAINT "model_experiment_created_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD CONSTRAINT "model_experiment_request_usage_id_microdollar_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."microdollar_usage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD CONSTRAINT "model_experiment_request_variant_version_id_model_experiment_variant_version_id_fk" FOREIGN KEY ("variant_version_id") REFERENCES "public"."model_experiment_variant_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_experiment_variant" ADD CONSTRAINT "model_experiment_variant_experiment_id_model_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."model_experiment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_experiment_variant_version" ADD CONSTRAINT "model_experiment_variant_version_variant_id_model_experiment_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."model_experiment_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_experiment_variant_version" ADD CONSTRAINT "model_experiment_variant_version_created_by_kilocode_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_model_experiment_public_model_id_routing" ON "model_experiment" USING btree ("public_model_id") WHERE "model_experiment"."status" IN ('active', 'paused');--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_status" ON "model_experiment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_request_variant_version_created_at" ON "model_experiment_request" USING btree ("variant_version_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_request_client_request_id" ON "model_experiment_request" USING btree ("client_request_id") WHERE "model_experiment_request"."client_request_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_variant_experiment_id" ON "model_experiment_variant" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "IDX_model_experiment_variant_version_variant_effective" ON "model_experiment_variant_version" USING btree ("variant_id","effective_at" DESC NULLS LAST);