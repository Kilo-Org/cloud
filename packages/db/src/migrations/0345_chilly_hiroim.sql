CREATE TABLE "domain_blacklist_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"use_env_fallback" boolean NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_blacklist_state_singleton" CHECK ("domain_blacklist_state"."id" = 1)
);
-->  statement-breakpoint
INSERT INTO "domain_blacklist_state" ("id", "use_env_fallback")
SELECT 1, NOT EXISTS (SELECT 1 FROM "blacklisted_domains" LIMIT 1)
ON CONFLICT ("id") DO NOTHING;
