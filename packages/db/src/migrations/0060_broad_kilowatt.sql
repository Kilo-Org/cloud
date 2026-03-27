CREATE TABLE "kiloclaw_trial_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"trial_days" integer NOT NULL,
	"granted_by_user_id" text,
	"granted_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "kiloclaw_trial_grants_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_trial_grants" ADD CONSTRAINT "kiloclaw_trial_grants_granted_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_trial_grants_email" ON "kiloclaw_trial_grants" USING btree ("email");