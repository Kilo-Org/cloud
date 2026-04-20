CREATE TABLE "email_verification_state" (
	"email" text PRIMARY KEY NOT NULL,
	"verification_result" text,
	"checked_at" timestamp with time zone,
	"override_state" text,
	"override_reason" text,
	"override_actor_user_id" text,
	"override_at" timestamp with time zone,
	CONSTRAINT "email_verification_state_email_canonical_check" CHECK ("email_verification_state"."email" = lower(btrim("email_verification_state"."email"))),
	CONSTRAINT "email_verification_state_verification_result_check" CHECK ("email_verification_state"."verification_result" IN ('valid', 'invalid', 'disposable', 'catchall', 'unknown')),
	CONSTRAINT "email_verification_state_override_state_check" CHECK ("email_verification_state"."override_state" IN ('force_allow', 'force_block'))
);
--> statement-breakpoint
CREATE INDEX "IDX_email_verification_state_checked_at" ON "email_verification_state" USING btree ("checked_at");