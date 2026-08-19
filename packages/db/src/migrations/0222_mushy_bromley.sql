CREATE TABLE "cloud_agent_attachment_uploads" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text,
	"r2_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "cloud_agent_attachment_uploads_r2_key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_attachment_uploads" ADD CONSTRAINT "cloud_agent_attachment_uploads_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_attachment_uploads_consumed_created" ON "cloud_agent_attachment_uploads" USING btree ("consumed_at","created_at");