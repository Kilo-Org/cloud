ALTER TABLE "organization_invitations" ADD COLUMN "authentication_requirement" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD COLUMN "sso_source_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_sso_source_organization_id_organizations_id_fk" FOREIGN KEY ("sso_source_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "kilocode_users"
SET
  "api_token_pepper" = pg_catalog.gen_random_uuid()::text,
  "web_session_pepper" = pg_catalog.gen_random_uuid()::text
WHERE
  "is_bot" = false
  AND EXISTS (
    SELECT 1
    FROM "organizations"
    WHERE
      "organizations"."deleted_at" IS NULL
      AND lower("organizations"."sso_domain") = lower(split_part("kilocode_users"."google_user_email", '@', 2))
  );