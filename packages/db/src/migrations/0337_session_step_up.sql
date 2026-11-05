CREATE TABLE "session_step_up_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"session_id_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"action_binding_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_session_step_up_challenges_purpose" CHECK ("session_step_up_challenges"."purpose" IN ('session', 'operation')),
	CONSTRAINT "check_session_step_up_challenges_action_binding" CHECK (("session_step_up_challenges"."purpose" = 'operation') = ("session_step_up_challenges"."action_binding_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "session_step_up_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"session_id_hash" text NOT NULL,
	"method" text NOT NULL,
	"passkey_credential_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"action_binding_hash" text,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_session_step_up_proofs_method" CHECK ("session_step_up_proofs"."method" IN ('webauthn_uv')),
	CONSTRAINT "check_session_step_up_proofs_purpose" CHECK ("session_step_up_proofs"."purpose" IN ('session', 'operation')),
	CONSTRAINT "check_session_step_up_proofs_action_binding" CHECK (("session_step_up_proofs"."purpose" = 'operation') = ("session_step_up_proofs"."action_binding_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "session_step_up_challenges" ADD CONSTRAINT "session_step_up_challenges_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD CONSTRAINT "session_step_up_proofs_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD CONSTRAINT "session_step_up_proofs_passkey_credential_id_passkey_credentials_id_fk" FOREIGN KEY ("passkey_credential_id") REFERENCES "public"."passkey_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_step_up_challenges_expires_at" ON "session_step_up_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_session_step_up_challenges_kilo_user_id" ON "session_step_up_challenges" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "idx_session_step_up_proofs_user_session_expires" ON "session_step_up_proofs" USING btree ("kilo_user_id","session_id_hash","expires_at");--> statement-breakpoint
CREATE INDEX "idx_session_step_up_proofs_expires_at" ON "session_step_up_proofs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_session_step_up_proofs_passkey_credential_id" ON "session_step_up_proofs" USING btree ("passkey_credential_id");