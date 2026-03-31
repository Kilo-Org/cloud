UPDATE "cloud_agent_code_reviews"
SET "terminal_reason" = 'billing'
WHERE "terminal_reason" IS NULL
  AND "status" = 'failed'
  AND (
    COALESCE("error_message", '') ILIKE '%Insufficient credits%'
    OR COALESCE("error_message", '') ILIKE '%paid model%'
    OR COALESCE("error_message", '') ILIKE '%add credits%'
    OR COALESCE("error_message", '') ILIKE '%Credits Required%'
  );
