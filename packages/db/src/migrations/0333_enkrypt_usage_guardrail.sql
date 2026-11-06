CREATE TABLE "enkrypt_usage_guardrail" (
	"guardrail_id" serial PRIMARY KEY NOT NULL,
	"guardrail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD COLUMN "guardrail_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_enkrypt_usage_guardrail" ON "enkrypt_usage_guardrail" USING btree ("guardrail");--> statement-breakpoint
ALTER TABLE "enkrypt_usage" ADD CONSTRAINT "enkrypt_usage_guardrail_id_enkrypt_usage_guardrail_guardrail_id_fk" FOREIGN KEY ("guardrail_id") REFERENCES "public"."enkrypt_usage_guardrail"("guardrail_id") ON DELETE no action ON UPDATE no action;