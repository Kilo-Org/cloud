CREATE TABLE "cloud_agent_pending_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"object_key" text NOT NULL,
	"message_uuid" text NOT NULL,
	"attachment_id" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cloud_agent_pending_uploads_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "cloud_agent_pending_uploads_status_check" CHECK ("cloud_agent_pending_uploads"."status" IN ('pending', 'linked', 'reaped'))
);
--> statement-breakpoint
CREATE INDEX "IDX_cloud_agent_pending_uploads_user_message_status" ON "cloud_agent_pending_uploads" USING btree ("kilo_user_id","message_uuid","status");