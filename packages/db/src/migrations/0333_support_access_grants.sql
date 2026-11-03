CREATE TABLE "support_access_grant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"performed_by_kilo_user_id" text,
	"organization_id" uuid NOT NULL,
	"action_class" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_grant_events_event_type_check" CHECK ("support_access_grant_events"."event_type" IN (
        'requested', 'approved', 'denied', 'issued', 'emergency_issued',
        'cancelled', 'revoked', 'expired', 'reviewed', 'used_write'
      )),
	CONSTRAINT "support_access_grant_events_action_class_check" CHECK ("support_access_grant_events"."action_class" IN ('support_read', 'support_write'))
);
--> statement-breakpoint
CREATE TABLE "support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kilo_user_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"action_class" text NOT NULL,
	"grant_kind" text DEFAULT 'standard' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"ticket_reference" text,
	"requested_duration_seconds" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_expires_at" timestamp with time zone,
	"approved_by_kilo_user_id" text,
	"decided_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_kilo_user_id" text,
	"revoke_reason" text,
	"review_required" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_kilo_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_grants_action_class_check" CHECK ("support_access_grants"."action_class" IN ('support_read', 'support_write')),
	CONSTRAINT "support_access_grants_grant_kind_check" CHECK ("support_access_grants"."grant_kind" IN ('standard', 'emergency')),
	CONSTRAINT "support_access_grants_status_check" CHECK ("support_access_grants"."status" IN ('pending', 'active', 'expired', 'denied', 'revoked', 'cancelled')),
	CONSTRAINT "support_access_grants_reason_length_check" CHECK (length("support_access_grants"."reason") BETWEEN 10 AND 2000),
	CONSTRAINT "support_access_grants_ticket_length_check" CHECK ("support_access_grants"."ticket_reference" IS NULL OR length("support_access_grants"."ticket_reference") <= 200),
	CONSTRAINT "support_access_grants_requested_duration_positive_check" CHECK ("support_access_grants"."requested_duration_seconds" > 0),
	CONSTRAINT "support_access_grants_approver_not_actor_check" CHECK ("support_access_grants"."approved_by_kilo_user_id" IS NULL OR "support_access_grants"."approved_by_kilo_user_id" <> "support_access_grants"."actor_kilo_user_id"),
	CONSTRAINT "support_access_grants_reviewer_not_actor_check" CHECK ("support_access_grants"."reviewed_by_kilo_user_id" IS NULL OR "support_access_grants"."reviewed_by_kilo_user_id" <> "support_access_grants"."actor_kilo_user_id"),
	CONSTRAINT "support_access_grants_write_requires_approver_check" CHECK (NOT (
        "support_access_grants"."action_class" = 'support_write'
        AND "support_access_grants"."grant_kind" = 'standard'
        AND "support_access_grants"."issued_at" IS NOT NULL
        AND "support_access_grants"."approved_by_kilo_user_id" IS NULL
      )),
	CONSTRAINT "support_access_grants_emergency_review_required_check" CHECK (NOT ("support_access_grants"."grant_kind" = 'emergency' AND NOT "support_access_grants"."review_required")),
	CONSTRAINT "support_access_grants_issued_expires_pair_check" CHECK (("support_access_grants"."issued_at" IS NULL) = ("support_access_grants"."expires_at" IS NULL)),
	CONSTRAINT "support_access_grants_expires_after_issued_check" CHECK ("support_access_grants"."issued_at" IS NULL OR "support_access_grants"."expires_at" > "support_access_grants"."issued_at"),
	CONSTRAINT "support_access_grants_duration_cap_check" CHECK ("support_access_grants"."issued_at" IS NULL OR "support_access_grants"."expires_at" - "support_access_grants"."issued_at" <= CASE
        WHEN "support_access_grants"."action_class" = 'support_read' AND "support_access_grants"."grant_kind" = 'standard'
        THEN interval '60 minutes'
        ELSE interval '15 minutes'
      END),
	CONSTRAINT "support_access_grants_active_requires_issue_check" CHECK (NOT ("support_access_grants"."status" = 'active' AND "support_access_grants"."issued_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "support_access_grant_events" ADD CONSTRAINT "support_access_grant_events_grant_id_support_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_access_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grant_events" ADD CONSTRAINT "support_access_grant_events_performed_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("performed_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_actor_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("actor_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_approved_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("approved_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_revoked_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("revoked_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_reviewed_by_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("reviewed_by_kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_support_access_grant_events_grant_created" ON "support_access_grant_events" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_support_access_grant_events_organization_created" ON "support_access_grant_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_support_access_grant_events_actor_created" ON "support_access_grant_events" USING btree ("performed_by_kilo_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_support_access_grants_open" ON "support_access_grants" USING btree ("actor_kilo_user_id","organization_id","action_class") WHERE "support_access_grants"."status" IN ('pending', 'active');--> statement-breakpoint
CREATE INDEX "IDX_support_access_grants_actor_org_expires" ON "support_access_grants" USING btree ("actor_kilo_user_id","organization_id","expires_at") WHERE "support_access_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX "IDX_support_access_grants_organization_requested" ON "support_access_grants" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "IDX_support_access_grants_pending_requested" ON "support_access_grants" USING btree ("requested_at") WHERE "support_access_grants"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "IDX_support_access_grants_unreviewed_emergency" ON "support_access_grants" USING btree ("issued_at") WHERE "support_access_grants"."review_required" AND "support_access_grants"."reviewed_at" IS NULL;