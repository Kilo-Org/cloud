CREATE TABLE "kiloclaw_inbound_email_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_inbound_email_aliases" ADD CONSTRAINT "kiloclaw_inbound_email_aliases_instance_id_kiloclaw_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."kiloclaw_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_inbound_email_aliases_instance_id" ON "kiloclaw_inbound_email_aliases" USING btree ("instance_id");