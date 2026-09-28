CREATE TABLE "passkey_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"kind" text NOT NULL,
	"kilo_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_passkey_challenges_kind" CHECK ("passkey_challenges"."kind" IN ('registration', 'authentication'))
);
--> statement-breakpoint
CREATE TABLE "passkey_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_count" integer DEFAULT 0 NOT NULL,
	"transports" text[],
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "passkey_sign_in_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_hash" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_passkey_challenges_expires_at" ON "passkey_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_passkey_challenges_kilo_user_id" ON "passkey_challenges" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_passkey_credentials_credential_id" ON "passkey_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "idx_passkey_credentials_kilo_user_id" ON "passkey_credentials" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_passkey_sign_in_tickets_ticket_hash" ON "passkey_sign_in_tickets" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "idx_passkey_sign_in_tickets_expires_at" ON "passkey_sign_in_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_passkey_sign_in_tickets_kilo_user_id" ON "passkey_sign_in_tickets" USING btree ("kilo_user_id");