ALTER TABLE "cloud_agent_environments" ADD COLUMN "egress_mode" text;--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD COLUMN "egress_allowlist" text[];--> statement-breakpoint
ALTER TABLE "cloud_agent_environments" ADD CONSTRAINT "cloud_agent_environments_egress_policy_check" CHECK ((
        (
          ("cloud_agent_environments"."egress_mode" IS NULL AND "cloud_agent_environments"."egress_allowlist" IS NULL) OR
          ("cloud_agent_environments"."egress_mode" IS NOT NULL AND "cloud_agent_environments"."egress_mode" IN ('unrestricted', 'allowlist'))
        ) AND
        ("cloud_agent_environments"."egress_mode" IS DISTINCT FROM 'unrestricted' OR "cloud_agent_environments"."egress_allowlist" IS NULL) AND
        ("cloud_agent_environments"."egress_mode" IS DISTINCT FROM 'allowlist' OR "cloud_agent_environments"."egress_allowlist" IS NOT NULL)
      ));