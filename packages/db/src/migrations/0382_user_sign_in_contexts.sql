CREATE TABLE "user_sign_in_contexts" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_sign_in_contexts_user_id_kind_key_hash_pk" PRIMARY KEY("user_id","kind","key_hash"),
	CONSTRAINT "user_sign_in_contexts_kind_check" CHECK ("user_sign_in_contexts"."kind" IN ('device', 'network', 'notice', 'history'))
);
--> statement-breakpoint
ALTER TABLE "user_sign_in_contexts" ADD CONSTRAINT "user_sign_in_contexts_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_user_sign_in_contexts_key_kind_last_seen" ON "user_sign_in_contexts" USING btree ("key_id","kind","last_seen_at");