CREATE TABLE "user_data_export_object_deletions" (
	"object_key" text PRIMARY KEY NOT NULL,
	"reason" text DEFAULT 'account_deletion' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_data_export_object_deletions_reason_check" CHECK ("user_data_export_object_deletions"."reason" = 'account_deletion'),
	CONSTRAINT "user_data_export_object_deletions_attempt_count_nonnegative" CHECK ("user_data_export_object_deletions"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_data_export_outbox" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"export_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"operation" text DEFAULT 'generate' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_user_data_export_outbox_generation_operation" UNIQUE("export_id","generation","operation"),
	CONSTRAINT "user_data_export_outbox_operation_check" CHECK ("user_data_export_outbox"."operation" = 'generate'),
	CONSTRAINT "user_data_export_outbox_generation_nonnegative" CHECK ("user_data_export_outbox"."generation" >= 0),
	CONSTRAINT "user_data_export_outbox_attempt_count_nonnegative" CHECK ("user_data_export_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_data_export_parts" (
	"export_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_data_export_parts_export_id_part_number_pk" PRIMARY KEY("export_id","part_number"),
	CONSTRAINT "user_data_export_parts_part_number_positive" CHECK ("user_data_export_parts"."part_number" > 0),
	CONSTRAINT "user_data_export_parts_size_bytes_nonnegative" CHECK ("user_data_export_parts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_data_exports" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"current_source" text,
	"source_cursor" jsonb,
	"multipart_upload_id" text,
	"next_part_number" integer DEFAULT 1 NOT NULL,
	"dispatch_generation" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"size_bytes" bigint,
	"r2_object_key" text,
	"r2_etag" text,
	"sha256" text,
	"failure_code" text,
	"last_error_redacted" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"email_attempt_count" integer DEFAULT 0 NOT NULL,
	"email_lease_token" uuid,
	"email_lease_expires_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_data_exports_status_check" CHECK ("user_data_exports"."status" IN ('queued', 'processing', 'finalizing', 'ready', 'failed', 'expired')),
	CONSTRAINT "user_data_exports_schema_version_positive" CHECK ("user_data_exports"."schema_version" > 0),
	CONSTRAINT "user_data_exports_next_part_number_positive" CHECK ("user_data_exports"."next_part_number" > 0),
	CONSTRAINT "user_data_exports_dispatch_generation_nonnegative" CHECK ("user_data_exports"."dispatch_generation" >= 0),
	CONSTRAINT "user_data_exports_attempt_count_nonnegative" CHECK ("user_data_exports"."attempt_count" >= 0),
	CONSTRAINT "user_data_exports_row_count_nonnegative" CHECK ("user_data_exports"."row_count" >= 0),
	CONSTRAINT "user_data_exports_size_bytes_nonnegative" CHECK ("user_data_exports"."size_bytes" IS NULL OR "user_data_exports"."size_bytes" >= 0),
	CONSTRAINT "user_data_exports_multipart_checkpoint_shape" CHECK ("user_data_exports"."multipart_upload_id" IS NULL OR "user_data_exports"."next_part_number" > 1),
	CONSTRAINT "user_data_exports_lease_shape" CHECK (("user_data_exports"."lease_token" IS NULL) = ("user_data_exports"."lease_expires_at" IS NULL)),
	CONSTRAINT "user_data_exports_ready_shape" CHECK ("user_data_exports"."status" <> 'ready' OR ("user_data_exports"."r2_object_key" IS NOT NULL AND "user_data_exports"."size_bytes" IS NOT NULL AND "user_data_exports"."completed_at" IS NOT NULL AND "user_data_exports"."expires_at" IS NOT NULL)),
	CONSTRAINT "user_data_exports_sha256_shape" CHECK ("user_data_exports"."sha256" IS NULL OR "user_data_exports"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "user_data_exports_last_error_redacted_length" CHECK ("user_data_exports"."last_error_redacted" IS NULL OR length("user_data_exports"."last_error_redacted") <= 500),
	CONSTRAINT "user_data_exports_email_attempt_count_nonnegative" CHECK ("user_data_exports"."email_attempt_count" >= 0),
	CONSTRAINT "user_data_exports_email_status_check" CHECK ("user_data_exports"."email_status" IN ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "user_data_exports_email_lease_shape" CHECK (("user_data_exports"."email_status" = 'sending') = ("user_data_exports"."email_lease_token" IS NOT NULL AND "user_data_exports"."email_lease_expires_at" IS NOT NULL)),
	CONSTRAINT "user_data_exports_email_sent_shape" CHECK (("user_data_exports"."email_status" = 'sent') = ("user_data_exports"."email_sent_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "user_data_export_outbox" ADD CONSTRAINT "user_data_export_outbox_export_id_user_data_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."user_data_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_export_parts" ADD CONSTRAINT "user_data_export_parts_export_id_user_data_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."user_data_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_exports" ADD CONSTRAINT "user_data_exports_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_user_data_export_outbox_pending" ON "user_data_export_outbox" USING btree ("available_at","created_at","id") WHERE "user_data_export_outbox"."sent_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_data_exports_single_active" ON "user_data_exports" USING btree ("kilo_user_id") WHERE "user_data_exports"."status" IN ('queued', 'processing', 'finalizing');--> statement-breakpoint
CREATE INDEX "IDX_user_data_exports_user_created" ON "user_data_exports" USING btree ("kilo_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "IDX_user_data_exports_lease_expiry" ON "user_data_exports" USING btree ("lease_expires_at","id") WHERE "user_data_exports"."status" IN ('processing', 'finalizing');--> statement-breakpoint
CREATE INDEX "IDX_user_data_exports_ready_expiry" ON "user_data_exports" USING btree ("expires_at","id") WHERE "user_data_exports"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "IDX_user_data_exports_email_lease_expiry" ON "user_data_exports" USING btree ("email_lease_expires_at","id") WHERE "user_data_exports"."email_status" = 'sending';