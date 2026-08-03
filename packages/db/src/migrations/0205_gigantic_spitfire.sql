ALTER TABLE "device_auth_requests" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "user_code" text;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "device_code_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_device_auth_requests_device_code_hash" ON "device_auth_requests" USING btree ("device_code_hash") WHERE "device_auth_requests"."device_code_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_device_auth_requests_user_code" ON "device_auth_requests" USING btree ("user_code") WHERE "device_auth_requests"."user_code" IS NOT NULL;