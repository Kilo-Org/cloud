CREATE TABLE "quick_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD CONSTRAINT "quick_chat_messages_thread_id_quick_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."quick_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_chat_threads" ADD CONSTRAINT "quick_chat_threads_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_chat_threads" ADD CONSTRAINT "quick_chat_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_quick_chat_messages_thread_created_at" ON "quick_chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quick_chat_threads_user_personal_uidx" ON "quick_chat_threads" USING btree ("user_id") WHERE "quick_chat_threads"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quick_chat_threads_user_org_uidx" ON "quick_chat_threads" USING btree ("user_id","organization_id") WHERE "quick_chat_threads"."organization_id" IS NOT NULL;