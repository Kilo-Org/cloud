CREATE TABLE "kiloclaw_inbound_email_reserved_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_inbound_email_aliases" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "kiloclaw_inbound_email_aliases" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kiloclaw_instances" ADD COLUMN "inbound_email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "kiloclaw_inbound_email_aliases"
SET "retired_at" = now()
WHERE "alias" IN (
	SELECT "alias"
	FROM (
		SELECT
			"alias",
			row_number() OVER (PARTITION BY "instance_id" ORDER BY "alias") AS "alias_rank"
		FROM "kiloclaw_inbound_email_aliases"
	) "ranked_aliases"
	WHERE "alias_rank" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_inbound_email_aliases_active_instance" ON "kiloclaw_inbound_email_aliases" USING btree ("instance_id") WHERE "kiloclaw_inbound_email_aliases"."retired_at" is null;
--> statement-breakpoint
INSERT INTO "kiloclaw_inbound_email_reserved_aliases" ("alias") SELECT "alias" FROM "kiloclaw_inbound_email_aliases" ON CONFLICT DO NOTHING;
