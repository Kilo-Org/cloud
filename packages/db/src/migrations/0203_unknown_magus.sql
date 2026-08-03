CREATE TABLE "github_install_states" (
	"token" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"github_app_type" text NOT NULL,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_install_states_owner_type_check" CHECK ("github_install_states"."owner_type" IN ('org', 'user'))
);
--> statement-breakpoint
ALTER TABLE "github_install_states" ADD CONSTRAINT "github_install_states_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_github_install_states_expires_at" ON "github_install_states" USING btree ("expires_at");