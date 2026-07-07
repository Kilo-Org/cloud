CREATE TABLE "user_model_preferences" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"favorites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_selected" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_model_preferences" ADD CONSTRAINT "user_model_preferences_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_user_model_preferences_user_id" ON "user_model_preferences" USING btree ("user_id");