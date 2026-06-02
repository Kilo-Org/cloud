CREATE TABLE "user_github_app_tokens" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"github_app_type" text DEFAULT 'standard' NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_github_app_tokens_app_type_check" CHECK ("user_github_app_tokens"."github_app_type" IN ('standard', 'lite'))
);
--> statement-breakpoint
ALTER TABLE "user_github_app_tokens" ADD CONSTRAINT "user_github_app_tokens_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_github_app_tokens_user_app" ON "user_github_app_tokens" USING btree ("kilo_user_id","github_app_type");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_github_app_tokens_github_user_app" ON "user_github_app_tokens" USING btree ("github_user_id","github_app_type");