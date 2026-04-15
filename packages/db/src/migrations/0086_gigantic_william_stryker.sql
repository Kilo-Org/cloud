CREATE TABLE "kiloclaw_providers" (
	"provider" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"personal_traffic_percent" integer DEFAULT 0 NOT NULL,
	"organization_traffic_percent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_providers_provider_check" CHECK ("kiloclaw_providers"."provider" IN ('fly', 'docker-local', 'northflank')),
	CONSTRAINT "kiloclaw_providers_personal_traffic_percent_check" CHECK ("kiloclaw_providers"."personal_traffic_percent" >= 0 AND "kiloclaw_providers"."personal_traffic_percent" <= 100),
	CONSTRAINT "kiloclaw_providers_organization_traffic_percent_check" CHECK ("kiloclaw_providers"."organization_traffic_percent" >= 0 AND "kiloclaw_providers"."organization_traffic_percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "provider" text DEFAULT 'fly' NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD CONSTRAINT "kiloclaw_instances_provider_check" CHECK ("kiloclaw_instances"."provider" IN ('fly', 'docker-local', 'northflank'));