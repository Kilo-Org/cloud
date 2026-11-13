CREATE TABLE "api_request_log_2" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generation_id" text,
	"kilo_user_id" text NOT NULL,
	"organization_id" text,
	"session_id" text,
	"requested_model" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_created_at" ON "api_request_log_2" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_generation_id" ON "api_request_log_2" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_session_id" ON "api_request_log_2" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_kilo_user_id_created_at" ON "api_request_log_2" USING btree ("kilo_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_request_log_2_organization_id_created_at" ON "api_request_log_2" USING btree ("organization_id","created_at");