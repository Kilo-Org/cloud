CREATE TABLE "classification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer NOT NULL,
	"filters" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"excluded_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_materializations" (
	"rule_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"materialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_materializations_rule_id_user_id_pk" PRIMARY KEY("rule_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "rule_materializations" ADD CONSTRAINT "rule_materializations_rule_id_classification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."classification_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rule_materializations_rule_id" ON "rule_materializations" USING btree ("rule_id");