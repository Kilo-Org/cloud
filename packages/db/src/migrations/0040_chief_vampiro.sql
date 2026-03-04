CREATE TABLE "kiloclaw_earlybird_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_charge_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_earlybird_purchases_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "kiloclaw_earlybird_purchases_stripe_charge_id_unique" UNIQUE("stripe_charge_id")
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_earlybird_purchases" ADD CONSTRAINT "kiloclaw_earlybird_purchases_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;