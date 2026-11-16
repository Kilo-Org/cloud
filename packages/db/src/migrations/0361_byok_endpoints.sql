ALTER TABLE "byok_api_keys" ADD COLUMN "endpoint" jsonb;--> statement-breakpoint
ALTER TABLE "byok_api_keys" ADD CONSTRAINT "byok_api_keys_endpoint_check" CHECK (("byok_api_keys"."endpoint" IS NOT NULL) = ("byok_api_keys"."provider_id" LIKE 'endpoint-%')
        AND ("byok_api_keys"."endpoint" IS NULL OR "byok_api_keys"."organization_id" IS NOT NULL));