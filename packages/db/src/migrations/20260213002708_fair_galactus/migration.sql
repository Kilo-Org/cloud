CREATE TABLE "kiloclaw_access_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_access_codes" ADD CONSTRAINT "kiloclaw_access_codes_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_access_codes_code" ON "kiloclaw_access_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_access_codes_user_status" ON "kiloclaw_access_codes" USING btree ("kilo_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_access_codes_one_active_per_user" ON "kiloclaw_access_codes" USING btree ("kilo_user_id") WHERE status = 'active';