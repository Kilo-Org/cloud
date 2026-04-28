ALTER TABLE "channel_badge_counts" RENAME TO "badge_counts";--> statement-breakpoint
ALTER TABLE "badge_counts" RENAME COLUMN "channel_id" TO "badge_bucket";--> statement-breakpoint
ALTER TABLE "badge_counts" DROP CONSTRAINT "channel_badge_counts_user_id_kilocode_users_id_fk";
--> statement-breakpoint
ALTER TABLE "badge_counts" DROP CONSTRAINT "channel_badge_counts_user_id_channel_id_pk";--> statement-breakpoint
ALTER TABLE "badge_counts" ADD CONSTRAINT "badge_counts_user_id_badge_bucket_pk" PRIMARY KEY("user_id","badge_bucket");--> statement-breakpoint
ALTER TABLE "badge_counts" ADD CONSTRAINT "badge_counts_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DELETE FROM badge_counts;