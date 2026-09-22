DROP INDEX "UQ_platform_integrations_github_platform_inst";--> statement-breakpoint
DROP INDEX "UQ_platform_integrations_github_pending_target";--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_sharing_mode_check" CHECK ("github_app_installations"."sharing_mode" IN ('exclusive', 'web_cloud_agent'));