CREATE TABLE "api_request_log_payload_deletions" (
	"object_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_request_log" ADD COLUMN "payload_object_key" text;--> statement-breakpoint
CREATE INDEX "idx_api_request_log_payload_deletions_created_at" ON "api_request_log_payload_deletions" USING btree ("created_at");