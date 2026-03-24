-- v1: cancelled billing reviews should be failed with terminal_reason='billing'
-- These are from the cloud-agent callback path where payment_required_prompt
-- was reported as 'interrupted' → normalized to 'cancelled'.
UPDATE cloud_agent_code_reviews
SET status = 'failed', terminal_reason = 'billing'
WHERE status = 'cancelled'
  AND terminal_reason IS NULL
  AND (
    COALESCE(error_message, '') ILIKE '%Insufficient credits%'
    OR COALESCE(error_message, '') ILIKE '%paid model%'
    OR COALESCE(error_message, '') ILIKE '%add credits%'
    OR COALESCE(error_message, '') ILIKE '%Credits Required%'
  );

-- v2: wrapper terminal error path stored generic event type as error_message.
-- The only path that produces error_message='session.error' is isTerminalError()
-- in the wrapper, which exclusively triggers for billing/payment events.
UPDATE cloud_agent_code_reviews
SET terminal_reason = 'billing'
WHERE status = 'failed'
  AND terminal_reason IS NULL
  AND agent_version = 'v2'
  AND error_message = 'session.error';
