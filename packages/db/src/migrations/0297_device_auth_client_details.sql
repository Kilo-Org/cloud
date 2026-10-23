ALTER TABLE "device_auth_requests" ADD COLUMN "requesting_client_id" text;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "requesting_client_name" text;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "requesting_redirect_origin" text;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "client_confirmed_at" timestamp with time zone;