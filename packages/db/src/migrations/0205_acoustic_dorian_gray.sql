CREATE TABLE "native_admission_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_attested_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"platform" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"attested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_attested_keys_platform_check" CHECK ("native_attested_keys"."platform" IN ('ios', 'android'))
);
--> statement-breakpoint
ALTER TABLE "native_attested_keys" ADD CONSTRAINT "native_attested_keys_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_native_admission_challenges_expires_at" ON "native_admission_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_native_attested_keys_kilo_user_id" ON "native_attested_keys" USING btree ("kilo_user_id");