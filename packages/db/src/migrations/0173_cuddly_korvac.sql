CREATE TABLE "kiloclaw_agentcard_oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"provider" text DEFAULT 'agentcard' NOT NULL,
	"account_email" text,
	"oauth_client_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_agentcard_oauth_connections_status_check" CHECK ("kiloclaw_agentcard_oauth_connections"."status" IN ('active', 'action_required', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_agentcard_oauth_connections" ADD CONSTRAINT "kiloclaw_agentcard_oauth_connections_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_agentcard_oauth_connections_instance" ON "kiloclaw_agentcard_oauth_connections" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_agentcard_oauth_connections_status" ON "kiloclaw_agentcard_oauth_connections" USING btree ("status");