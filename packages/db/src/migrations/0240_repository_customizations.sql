CREATE TABLE "repository_customizations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"platform_integration_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"bot_mention_model_slug" text,
	"pr_review_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_repository_customizations_integration_repository" UNIQUE("platform_integration_id","repository_id"),
	CONSTRAINT "repository_customizations_pr_review_mode_check" CHECK ("repository_customizations"."pr_review_mode" IN ('on', 'off'))
);
--> statement-breakpoint
ALTER TABLE "repository_customizations" ADD CONSTRAINT "repository_customizations_platform_integration_id_platform_integrations_id_fk" FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;