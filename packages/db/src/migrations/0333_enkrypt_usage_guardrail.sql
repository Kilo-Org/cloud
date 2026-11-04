CREATE TABLE "enkrypt_usage_guardrail" (
	"guardrail_id" serial PRIMARY KEY NOT NULL,
	"guardrail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD COLUMN "guardrail_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_enkrypt_usage_guardrail" ON "enkrypt_usage_guardrail" USING btree ("guardrail");