CREATE TABLE "passkey_management_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text,
	"kilo_user_id" text NOT NULL,
	"device_session_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"sso_organization_id" text,
	"web_session_pepper" text,
	"passkey_challenge_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_passkey_management_authorizations_operation" CHECK ("passkey_management_authorizations"."operation" IN ('enroll', 'rename', 'remove')),
	CONSTRAINT "check_passkey_management_authorizations_state" CHECK ("passkey_management_authorizations"."state" IN ('pending', 'approved', 'issued')),
	CONSTRAINT "check_passkey_management_authorizations_issued_digest" CHECK (("passkey_management_authorizations"."state" = 'issued') = ("passkey_management_authorizations"."token_hash" IS NOT NULL)),
	CONSTRAINT "check_passkey_management_authorizations_pending_approved_at" CHECK ("passkey_management_authorizations"."state" <> 'pending' OR "passkey_management_authorizations"."approved_at" IS NULL),
	CONSTRAINT "check_passkey_management_authorizations_approved_approved_at" CHECK ("passkey_management_authorizations"."state" <> 'approved' OR "passkey_management_authorizations"."approved_at" IS NOT NULL),
	CONSTRAINT "check_passkey_management_authorizations_consumed_at" CHECK ("passkey_management_authorizations"."state" = 'issued' OR "passkey_management_authorizations"."consumed_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "passkey_management_authorizations" ADD CONSTRAINT "passkey_management_authorizations_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_management_authorizations" ADD CONSTRAINT "passkey_management_authorizations_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_passkey_management_authorizations_token_hash" ON "passkey_management_authorizations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "IDX_passkey_management_authorizations_kilo_user_id" ON "passkey_management_authorizations" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_passkey_management_authorizations_expires_at" ON "passkey_management_authorizations" USING btree ("expires_at");