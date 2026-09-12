CREATE TABLE "provider_installation_aliases" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_installation_aliases_generation_check" CHECK ("provider_installation_aliases"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_installation_aliases" ADD CONSTRAINT "provider_installation_aliases_reservation_id_provider_installation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."provider_installation_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_provider_installation_aliases_reservation" ON "provider_installation_aliases" USING btree ("reservation_id");