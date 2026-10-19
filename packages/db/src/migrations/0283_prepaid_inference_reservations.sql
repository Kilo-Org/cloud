CREATE TABLE "inference_reservations" (
	"request_id" text PRIMARY KEY NOT NULL,
	"kilo_user_id" text NOT NULL,
	"organization_id" uuid,
	"amount_microdollars" bigint NOT NULL,
	"actual_cost_microdollars" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "inference_reservations_amount_check" CHECK ("inference_reservations"."amount_microdollars" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "inference_reservations_actual_cost_check" CHECK ("inference_reservations"."actual_cost_microdollars" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "inference_reservations_state_check" CHECK ((
        "inference_reservations"."status" = 'reserved'
        AND "inference_reservations"."actual_cost_microdollars" IS NULL
        AND "inference_reservations"."finalized_at" IS NULL
      ) OR (
        "inference_reservations"."status" = 'settled'
        AND "inference_reservations"."actual_cost_microdollars" IS NOT NULL
        AND "inference_reservations"."finalized_at" IS NOT NULL
      ) OR (
        "inference_reservations"."status" = 'released'
        AND "inference_reservations"."actual_cost_microdollars" IS NULL
        AND "inference_reservations"."finalized_at" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "kilocode_users" ADD COLUMN "inference_microdollars_held" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "inference_microdollars_held" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_reservations" ADD CONSTRAINT "inference_reservations_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_reservations" ADD CONSTRAINT "inference_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_inference_reservations_user" ON "inference_reservations" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_inference_reservations_org_user_status" ON "inference_reservations" USING btree ("organization_id","kilo_user_id","status") WHERE "inference_reservations"."organization_id" IS NOT NULL;