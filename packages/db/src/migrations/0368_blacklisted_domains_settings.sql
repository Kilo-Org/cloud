CREATE TABLE "blacklisted_domains_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"blocked_signup_tlds" text[] NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"updated_by_email" text,
	CONSTRAINT "blacklisted_domains_settings_singleton" CHECK ("blacklisted_domains_settings"."id" = 1)
);
