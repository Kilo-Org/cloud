CREATE TABLE "app_shell_handoff_tokens" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"target_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_shell_handoff_tokens" ADD CONSTRAINT "app_shell_handoff_tokens_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_app_shell_handoff_tokens_token_hash" ON "app_shell_handoff_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "IDX_app_shell_handoff_tokens_expires_at" ON "app_shell_handoff_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_app_shell_handoff_tokens_kilo_user_id" ON "app_shell_handoff_tokens" USING btree ("kilo_user_id");