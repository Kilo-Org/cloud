CREATE TABLE "provider_installation_aliases" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"event_time" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_installation_aliases_generation_check" CHECK ("provider_installation_aliases"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_installation_pending_credentials" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"platform_integration_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"bot_user_id" text,
	"team_name" text,
	"slack_enterprise_id" text,
	"is_enterprise_install" boolean DEFAULT false NOT NULL,
	"granted_scopes" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_installation_pending_credentials_generation_check" CHECK ("provider_installation_pending_credentials"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_installation_reservations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_installation_id" text NOT NULL,
	"owned_by_user_id" text,
	"owned_by_organization_id" uuid,
	"platform_integration_id" uuid,
	"oauth_attempt_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"active_generation" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"cleanup_requires_revoke" boolean DEFAULT false NOT NULL,
	"cleanup_stage" text DEFAULT 'sdk' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_installation_reservations_owner_check" CHECK (num_nonnulls("provider_installation_reservations"."owned_by_user_id", "provider_installation_reservations"."owned_by_organization_id") = 1),
	CONSTRAINT "provider_installation_reservations_provider_check" CHECK ("provider_installation_reservations"."provider" = 'slack'),
	CONSTRAINT "provider_installation_reservations_status_check" CHECK ("provider_installation_reservations"."status" IN ('pending', 'active', 'deleting')),
	CONSTRAINT "provider_installation_reservations_cleanup_stage_check" CHECK ("provider_installation_reservations"."cleanup_stage" IN ('revoke', 'sdk', 'identity')),
	CONSTRAINT "provider_installation_reservations_generation_check" CHECK ("provider_installation_reservations"."generation" > 0),
	CONSTRAINT "provider_installation_reservations_active_generation_check" CHECK ("provider_installation_reservations"."active_generation" IS NULL OR "provider_installation_reservations"."active_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" DROP CONSTRAINT "provider_oauth_attempts_status_check";--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD COLUMN "provider_installation_id" text;--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD COLUMN "generation" integer;--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD COLUMN "completed_integration_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_installation_aliases" ADD CONSTRAINT "provider_installation_aliases_reservation_id_provider_installation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."provider_installation_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_pending_credentials" ADD CONSTRAINT "provider_installation_pending_credentials_reservation_id_provider_installation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."provider_installation_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_pending_credentials" ADD CONSTRAINT "provider_installation_pending_credentials_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_reservations" ADD CONSTRAINT "provider_installation_reservations_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_reservations" ADD CONSTRAINT "provider_installation_reservations_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_reservations" ADD CONSTRAINT "provider_installation_reservations_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installation_reservations" ADD CONSTRAINT "provider_installation_reservations_oauth_attempt_id_provider_oauth_attempts_id_fk" FOREIGN KEY ("oauth_attempt_id") REFERENCES "public"."provider_oauth_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_aliases_reservation" ON "provider_installation_aliases" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_pending_credentials_integration" ON "provider_installation_pending_credentials" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_provider_installation_reservations_identity" ON "provider_installation_reservations" USING btree ("provider","provider_installation_id");--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_reservations_owner_user" ON "provider_installation_reservations" USING btree ("owned_by_user_id");--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_reservations_owner_org" ON "provider_installation_reservations" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_reservations_integration" ON "provider_installation_reservations" USING btree ("platform_integration_id");--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_reservations_expires" ON "provider_installation_reservations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD CONSTRAINT "provider_oauth_attempts_completed_integration_id_platform_integrations_id_fk" FOREIGN KEY ("completed_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_provider_oauth_attempts_provider_installation" ON "provider_oauth_attempts" USING btree ("provider","provider_installation_id");--> statement-breakpoint
ALTER TABLE "provider_oauth_attempts" ADD CONSTRAINT "provider_oauth_attempts_status_check" CHECK ("provider_oauth_attempts"."status" IN ('pending', 'captured', 'consumed', 'expired'));
-->  statement-breakpoint
INSERT INTO "provider_installation_reservations" ("provider", "provider_installation_id", "owned_by_user_id", "owned_by_organization_id", "platform_integration_id", "generation", "active_generation", "status", "expires_at")
SELECT 'slack', "platform_installation_id", "owned_by_user_id", "owned_by_organization_id", "id", 1, 1, 'active', '9999-12-31 23:59:59.999+00'
FROM "platform_integrations"
WHERE "platform" = 'slack' AND "integration_status" = 'active' AND "platform_installation_id" IS NOT NULL
ON CONFLICT ("provider", "provider_installation_id") DO NOTHING;
