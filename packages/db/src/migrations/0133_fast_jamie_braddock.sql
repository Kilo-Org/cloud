CREATE TYPE "public"."github_app_type" AS ENUM('standard', 'lite');--> statement-breakpoint
CREATE TYPE "public"."revocation_reason" AS ENUM('user_revoked', 'refresh_failed', 'admin');--> statement-breakpoint
CREATE TABLE "user_github_app_tokens" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"github_app_type" "github_app_type" DEFAULT 'standard' NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"github_email" text,
	"access_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" "revocation_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ADD CONSTRAINT "user_github_app_tokens_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_github_app_tokens_user_app_uidx" ON "user_github_app_tokens" USING btree ("kilo_user_id","github_app_type");--> statement-breakpoint
CREATE INDEX "user_github_app_tokens_github_user_id_idx" ON "user_github_app_tokens" USING btree ("github_user_id");