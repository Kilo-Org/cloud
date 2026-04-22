CREATE TABLE "credit_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"credit_category" text NOT NULL,
	"amount_microdollars" integer NOT NULL,
	"credit_expiry_hours" integer,
	"campaign_ends_at" timestamp with time zone,
	"total_redemptions_allowed" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"description" text NOT NULL,
	"created_by_kilo_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_campaigns_slug_format_check" CHECK ("credit_campaigns"."slug" ~ '^[a-z0-9-]{5,40}$'),
	CONSTRAINT "credit_campaigns_amount_positive_check" CHECK ("credit_campaigns"."amount_microdollars" > 0),
	CONSTRAINT "credit_campaigns_credit_expiry_hours_positive_check" CHECK ("credit_campaigns"."credit_expiry_hours" IS NULL OR "credit_campaigns"."credit_expiry_hours" > 0),
	CONSTRAINT "credit_campaigns_total_redemptions_allowed_positive_check" CHECK ("credit_campaigns"."total_redemptions_allowed" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_credit_campaigns_slug" ON "credit_campaigns" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_credit_campaigns_credit_category" ON "credit_campaigns" USING btree ("credit_category");