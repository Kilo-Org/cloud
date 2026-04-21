CREATE TABLE "kiloclaw_google_oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"account_email" text NOT NULL,
	"account_subject" text NOT NULL,
	"oauth_client_id" text NOT NULL,
	"oauth_client_secret_encrypted" text,
	"credential_profile" text DEFAULT 'kilo_owned' NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"grants_by_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_google_oauth_connections_status_check" CHECK ("kiloclaw_google_oauth_connections"."status" IN ('active', 'action_required', 'disconnected')),
	CONSTRAINT "kiloclaw_google_oauth_connections_credential_profile_check" CHECK ("kiloclaw_google_oauth_connections"."credential_profile" IN ('legacy', 'kilo_owned'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_google_oauth_connections" ADD CONSTRAINT "kiloclaw_google_oauth_connections_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_google_oauth_connections_instance" ON "kiloclaw_google_oauth_connections" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_google_oauth_connections_status" ON "kiloclaw_google_oauth_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_google_oauth_connections_provider" ON "kiloclaw_google_oauth_connections" USING btree ("provider");