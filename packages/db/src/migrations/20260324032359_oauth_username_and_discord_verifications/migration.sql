ALTER TABLE "kilocode_users" ADD COLUMN "discord_server_membership_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_auth_provider" ADD COLUMN "display_name" text;