ALTER TABLE "mcp_gateway_configs" ADD COLUMN "provider_scopes" text[];--> statement-breakpoint
ALTER TABLE "mcp_gateway_configs" ADD COLUMN "provider_scope_source" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_gateway_configs" ADD COLUMN "provider_resource" text;--> statement-breakpoint
ALTER TABLE "mcp_gateway_configs" ADD CONSTRAINT "mcp_gateway_configs_provider_scope_source" CHECK ("mcp_gateway_configs"."provider_scope_source" IN ('none', 'discovered', 'override'));