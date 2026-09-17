CREATE TABLE "passkey_sign_in_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_hash" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_passkey_sign_in_tickets_ticket_hash" ON "passkey_sign_in_tickets" USING btree ("ticket_hash");