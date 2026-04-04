CREATE TABLE "user_affiliate_attributions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"tracking_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_user_affiliate_attributions_user_provider" UNIQUE("user_id","provider"),
	CONSTRAINT "user_affiliate_attributions_provider_check" CHECK ("user_affiliate_attributions"."provider" IN ('impact'))
);
--> statement-breakpoint
ALTER TABLE "user_affiliate_attributions" ADD CONSTRAINT "user_affiliate_attributions_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "IDX_user_affiliate_attributions_user_id" ON "user_affiliate_attributions" USING btree ("user_id");