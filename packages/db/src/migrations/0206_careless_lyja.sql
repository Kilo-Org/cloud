CREATE TABLE "device_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"device_session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"device_auth_request_id" uuid,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "device_refresh_tokens" ADD CONSTRAINT "device_refresh_tokens_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_device_refresh_tokens_device_session_id" ON "device_refresh_tokens" USING btree ("device_session_id");--> statement-breakpoint
CREATE INDEX "IDX_device_refresh_tokens_expires_at" ON "device_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_device_sessions_kilo_user_id" ON "device_sessions" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_device_sessions_revoked_at" ON "device_sessions" USING btree ("revoked_at");