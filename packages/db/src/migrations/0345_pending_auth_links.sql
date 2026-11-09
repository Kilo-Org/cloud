CREATE TABLE "pending_auth_links" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text NOT NULL,
	"display_name" text,
	"hosted_domain" text,
	"email_code_allowed" boolean NOT NULL,
	"email_code_challenge_id" uuid,
	"callback_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_pending_auth_links_kind" CHECK ("pending_auth_links"."kind" IN ('existing_account', 'explicit_link'))
);
--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "pending_link_secret_hash" text;--> statement-breakpoint
ALTER TABLE "pending_auth_links" ADD CONSTRAINT "pending_auth_links_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_pending_auth_links_secret_hash" ON "pending_auth_links" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "IDX_pending_auth_links_kilo_user_id" ON "pending_auth_links" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_pending_auth_links_expires_at" ON "pending_auth_links" USING btree ("expires_at");