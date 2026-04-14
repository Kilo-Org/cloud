CREATE TABLE "channel_badge_counts" (
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"badge_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_badge_counts_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "channel_badge_counts" ADD CONSTRAINT "channel_badge_counts_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;