ALTER TABLE "user_activity_tokens" ADD COLUMN "superseded_at" timestamp with time zone;
-->  statement-breakpoint
UPDATE "user_activity_tokens" AS "t"
SET "superseded_at" = now()
WHERE "t"."kind" = 'ios_activity'
  AND "t"."superseded_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "user_activity_tokens" AS "newer"
    WHERE "newer"."kind" = 'ios_activity'
      AND "newer"."superseded_at" IS NULL
      AND "newer"."user_id" = "t"."user_id"
      AND COALESCE("newer"."organization_id", '') = COALESCE("t"."organization_id", '')
      AND ("newer"."updated_at", "newer"."id") > ("t"."updated_at", "t"."id")
  );
