DROP INDEX "IDX_device_auth_requests_user_code";--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "UQ_device_auth_requests_user_code" ON "device_auth_requests" USING btree ("user_code") WHERE "device_auth_requests"."user_code" IS NOT NULL;
--> statement-breakpoint
BEGIN;