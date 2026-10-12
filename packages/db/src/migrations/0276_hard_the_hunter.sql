CREATE TABLE "todo_item_sessions" (
	"todo_item_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"kilo_user_id" text NOT NULL,
	"origin" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todo_item_sessions_session_id_kilo_user_id_pk" PRIMARY KEY("session_id","kilo_user_id"),
	CONSTRAINT "todo_item_sessions_origin_check" CHECK ("todo_item_sessions"."origin" IN ('started', 'linked'))
);
--> statement-breakpoint
CREATE TABLE "todo_items" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"kilo_user_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"done_at" timestamp with time zone,
	"position" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_todo_items_id_kilo_user_id" UNIQUE("id","kilo_user_id"),
	CONSTRAINT "todo_items_title_check" CHECK (char_length(btrim("todo_items"."title")) BETWEEN 1 AND 500 AND "todo_items"."title" = btrim("todo_items"."title")),
	CONSTRAINT "todo_items_notes_check" CHECK (char_length("todo_items"."notes") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "todo_lists" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"emoji" text,
	"git_url" text,
	"mode" text,
	"model" text,
	"variant" text,
	"position" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "UQ_todo_lists_id_kilo_user_id" UNIQUE("id","kilo_user_id"),
	CONSTRAINT "todo_lists_name_check" CHECK (char_length(btrim("todo_lists"."name")) BETWEEN 1 AND 100 AND "todo_lists"."name" = btrim("todo_lists"."name")),
	CONSTRAINT "todo_lists_emoji_check" CHECK (char_length("todo_lists"."emoji") <= 16)
);
--> statement-breakpoint
ALTER TABLE "todo_item_sessions" ADD CONSTRAINT "todo_item_sessions_todo_item_id_kilo_user_id_fk" FOREIGN KEY ("todo_item_id","kilo_user_id") REFERENCES "public"."todo_items"("id","kilo_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_item_sessions" ADD CONSTRAINT "todo_item_sessions_session_id_kilo_user_id_fk" FOREIGN KEY ("session_id","kilo_user_id") REFERENCES "public"."cli_sessions_v2"("session_id","kilo_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_list_id_kilo_user_id_fk" FOREIGN KEY ("list_id","kilo_user_id") REFERENCES "public"."todo_lists"("id","kilo_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_lists" ADD CONSTRAINT "todo_lists_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_lists" ADD CONSTRAINT "todo_lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_todo_item_sessions_todo_item_id" ON "todo_item_sessions" USING btree ("todo_item_id","kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_todo_items_list_position" ON "todo_items" USING btree ("list_id","position");--> statement-breakpoint
CREATE INDEX "IDX_todo_lists_owner_scope_position" ON "todo_lists" USING btree ("kilo_user_id","organization_id","position");