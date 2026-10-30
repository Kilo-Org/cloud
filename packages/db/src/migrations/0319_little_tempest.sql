DROP INDEX "UQ_code_review_memory_proposals_org_active_scope";--> statement-breakpoint
DROP INDEX "UQ_code_review_memory_proposals_user_active_scope";--> statement-breakpoint
-- `change_request_failed` is an active proposal in the application's status
-- model (`ACTIVE_PROPOSAL_STATUSES`), but the old index predicates left it out,
-- so a failed proposal could sit beside another active proposal for one scope
-- and the next status change into the active set failed with a unique
-- violation. Keep exactly one active proposal per scope, preferring, in order:
-- an approval already in flight (`opening_change_request`), because its
-- pull-request URL can only be recorded while the row still holds that status
-- and a superseded row would drop it; then a proposal the user can act on
-- (`open` and `edited` rank equally); then the most recently updated row.
-- `updated_at` stays untouched so the superseded duplicates keep their place in
-- the list and reach retention instead of jumping to the top.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "owned_by_organization_id", "owned_by_user_id", "platform", "repo_full_name"
      ORDER BY ("status" = 'opening_change_request') DESC,
        ("status" IN ('open', 'edited')) DESC,
        "updated_at" DESC,
        "id" DESC
    ) AS active_rank
  FROM code_review_memory_proposals
  WHERE "status" IN ('open', 'edited', 'opening_change_request', 'change_request_failed')
)
UPDATE code_review_memory_proposals AS proposal
SET "status" = 'superseded'
FROM ranked
WHERE ranked.active_rank > 1
  AND proposal."id" = ranked.id;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_org_active_scope" ON "code_review_memory_proposals" USING btree ("owned_by_organization_id","platform","repo_full_name") WHERE "code_review_memory_proposals"."owned_by_organization_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'opening_change_request', 'change_request_failed');--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_code_review_memory_proposals_user_active_scope" ON "code_review_memory_proposals" USING btree ("owned_by_user_id","platform","repo_full_name") WHERE "code_review_memory_proposals"."owned_by_user_id" IS NOT NULL AND "code_review_memory_proposals"."status" IN ('open', 'edited', 'opening_change_request', 'change_request_failed');