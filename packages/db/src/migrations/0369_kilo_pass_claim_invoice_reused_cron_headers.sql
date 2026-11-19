-- Custom SQL migration file, put your code below! --

-- A paid Kilo Pass invoice reuses the issuance header for its month when the yearly
-- cron or a usage bonus created that header first. Before the invoice handler claimed
-- such headers, they kept source = 'cron' and no stripe_invoice_id. The yearly cron
-- reads the latest invoice-sourced header as the paid tier and as the start of the
-- prepaid year, so a paid yearly upgrade whose month was cron-owned stays held.
--
-- Give each reused header the invoice that the invoice handler recorded for it:
--
--   * the header is still cron-sourced and has no invoice;
--   * a successful kilo_pass_invoice_paid_handled audit row names the header and
--     records that the handler reused it (issuanceHeaderWasCreated = false);
--   * the invoice does not already own another header, and each invoice and each
--     header is used once, so UQ_kilo_pass_issuances_stripe_invoice_id holds.
WITH reused AS (
  SELECT
    issuance.id AS issuance_id,
    audit.stripe_invoice_id,
    audit.created_at
  FROM kilo_pass_issuances issuance
  JOIN kilo_pass_audit_log audit
    ON audit.related_monthly_issuance_id = issuance.id
  WHERE issuance.source = 'cron'
    AND issuance.stripe_invoice_id IS NULL
    AND audit.action = 'kilo_pass_invoice_paid_handled'
    AND audit.result = 'success'
    AND audit.stripe_invoice_id IS NOT NULL
    AND audit.payload_json->>'issuanceHeaderWasCreated' = 'false'
    AND NOT EXISTS (
      SELECT 1
      FROM kilo_pass_issuances owner
      WHERE owner.stripe_invoice_id = audit.stripe_invoice_id
    )
), first_invoice_per_header AS MATERIALIZED (
  SELECT DISTINCT ON (issuance_id)
    issuance_id,
    stripe_invoice_id,
    created_at
  FROM reused
  ORDER BY issuance_id, created_at, stripe_invoice_id
), first_header_per_invoice AS MATERIALIZED (
  SELECT DISTINCT ON (stripe_invoice_id)
    issuance_id,
    stripe_invoice_id
  FROM first_invoice_per_header
  ORDER BY stripe_invoice_id, created_at, issuance_id
)
UPDATE kilo_pass_issuances issuance
SET source = 'stripe_invoice',
    stripe_invoice_id = claim.stripe_invoice_id,
    updated_at = now()
FROM first_header_per_invoice claim
WHERE issuance.id = claim.issuance_id
  AND issuance.source = 'cron'
  AND issuance.stripe_invoice_id IS NULL;
