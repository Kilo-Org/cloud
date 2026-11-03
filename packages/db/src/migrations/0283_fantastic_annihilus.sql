CREATE TABLE "auto_routing_custom_routers" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"owned_by_organization_id" uuid,
	"owned_by_user_id" text,
	"created_by_user_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"base_router" text NOT NULL,
	"mode" text NOT NULL,
	"entries" jsonb NOT NULL,
	"default_entry_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_routing_custom_routers_owner_check" CHECK ((
        ("auto_routing_custom_routers"."owned_by_user_id" IS NOT NULL AND "auto_routing_custom_routers"."owned_by_organization_id" IS NULL) OR
        ("auto_routing_custom_routers"."owned_by_user_id" IS NULL AND "auto_routing_custom_routers"."owned_by_organization_id" IS NOT NULL)
      )),
	CONSTRAINT "auto_routing_custom_routers_base_router_check" CHECK ("auto_routing_custom_routers"."base_router" IN ('efficient', 'frontier')),
	CONSTRAINT "auto_routing_custom_routers_mode_check" CHECK ("auto_routing_custom_routers"."mode" IN ('cost_per_accuracy', 'best_accuracy'))
);
--> statement-breakpoint
ALTER TABLE "auto_routing_custom_routers" ADD CONSTRAINT "auto_routing_custom_routers_owned_by_organization_id_organizations_id_fk" FOREIGN KEY ("owned_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routing_custom_routers" ADD CONSTRAINT "auto_routing_custom_routers_owned_by_user_id_kilocode_users_id_fk" FOREIGN KEY ("owned_by_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_routing_custom_routers_org_slug" ON "auto_routing_custom_routers" USING btree ("owned_by_organization_id","slug") WHERE "auto_routing_custom_routers"."owned_by_organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_auto_routing_custom_routers_user_slug" ON "auto_routing_custom_routers" USING btree ("owned_by_user_id","slug") WHERE "auto_routing_custom_routers"."owned_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_auto_routing_custom_routers_org_id" ON "auto_routing_custom_routers" USING btree ("owned_by_organization_id");--> statement-breakpoint
CREATE INDEX "IDX_auto_routing_custom_routers_user_id" ON "auto_routing_custom_routers" USING btree ("owned_by_user_id");