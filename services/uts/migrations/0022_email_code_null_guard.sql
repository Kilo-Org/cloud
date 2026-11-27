-- NULL-safe email code check (review of the sign-in guards, design 5.3). Every file before this
-- one is applied somewhere, so the function is replaced here rather than edited in place.
--
-- * `uts.verify_email_code` as 0018 left it, with two changes: a missing environment, address
--   hash, code hash, session token hash or new account id raises 22004 (`uts.require_inputs`)
--   before it reads anything, and the code comparison is `IS DISTINCT FROM`. Before, a NULL code
--   hash compared with `<>` gave NULL, so the wrong-code branch was skipped and the pending code
--   was consumed and signed in. Migration 0020 fixed the other sign-in guards; this function is
--   replaced here because 0018 redefined it after 0009, and replacing it in 0020 would have
--   dropped the per-network limit.
-- * Everything else, the grant included, stays as in 0018.

SET LOCAL ROLE uts_owner;

CREATE OR REPLACE FUNCTION uts.verify_email_code(
  p_environment text,
  p_email_hash bytea,
  p_code_hash bytea,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text,
  p_new_account_id text
) RETURNS TABLE (
  outcome text,
  code_return_to text,
  entries_left integer,
  session_id uuid,
  session_account text,
  signed_in_at timestamptz,
  account_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  entry_network inet := uts.client_network(p_client_ip);
  code uts.email_codes%ROWTYPE;
  holder record;
  finished record;
  network_failures smallint;
BEGIN
  PERFORM uts.require_inputs('uts.verify_email_code',
    p_environment IS NOT NULL AND p_email_hash IS NOT NULL AND p_code_hash IS NOT NULL
    AND p_session_token_hash IS NOT NULL AND p_new_account_id IS NOT NULL);
  IF EXISTS (
    SELECT 1 FROM uts.network_email_code_failures AS counted
    WHERE counted.client_network = entry_network
      AND counted.failures >= 30
      AND counted.window_started_at > now() - interval '1 hour'
  ) THEN
    outcome := 'network_limited';
    entries_left := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM uts.email_code_limits AS limits
    WHERE limits.purpose = 'sign_in'
      AND limits.email_hash = p_email_hash
      AND limits.status = 'stopped'
      AND limits.stopped_until > now()
  ) THEN
    outcome := 'codes_stopped';
    entries_left := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO code FROM uts.email_codes AS stored
  WHERE stored.email_hash = p_email_hash
    AND stored.purpose = 'sign_in'
    AND stored.status = 'pending'
    AND stored.expires_at > now()
  ORDER BY stored.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND OR code.code_hash IS NULL THEN
    outcome := 'invalid_code';
    entries_left := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  code_return_to := code.return_to;
  IF code.code_hash IS DISTINCT FROM p_code_hash THEN
    IF entry_network IS NOT NULL THEN
      INSERT INTO uts.network_email_code_failures AS counted (
        client_network, failures, window_started_at
      ) VALUES (entry_network, 1, now())
      ON CONFLICT (client_network) DO UPDATE
      SET failures = CASE WHEN counted.window_started_at <= now() - interval '1 hour' THEN 1
          ELSE counted.failures + 1 END,
        window_started_at = CASE WHEN counted.window_started_at <= now() - interval '1 hour'
          THEN now() ELSE counted.window_started_at END
      WHERE counted.window_started_at <= now() - interval '1 hour' OR counted.failures < 30
      RETURNING counted.failures INTO network_failures;
      -- No row back: another entry took the network's 30th wrong code since the probe above.
      IF network_failures IS NULL THEN
        outcome := 'network_limited';
        code_return_to := NULL;
        entries_left := 0;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
    UPDATE uts.email_codes AS stored
    SET attempts = stored.attempts + 1,
      status = CASE WHEN stored.attempts + 1 >= 5 THEN 'exhausted'::uts.email_code_status
        ELSE stored.status END
    WHERE stored.id = code.id
    RETURNING 5 - stored.attempts INTO entries_left;
    PERFORM uts.count_email_code_failure(code.email, p_email_hash);
    SELECT * INTO holder FROM uts.account_of_email(code.email);
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.sign_in.denied', 3002, 1, 'denied',
        CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'wrong_code' END, holder.id,
        jsonb_build_object(
          'method', 'email_code',
          'reason', CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'wrong_code' END,
          'entriesLeft', entries_left
        )
      );
    END IF;
    outcome := CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'invalid_code' END;
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.email_codes AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.id = code.id;
  SELECT * INTO finished
  FROM uts.finish_email_sign_in(
    p_environment, code.email, 'email_code', p_session_token_hash, p_user_agent, p_client_ip,
    p_asn, p_country, p_city, p_new_account_id
  );
  outcome := finished.outcome;
  session_id := finished.session_id;
  session_account := finished.session_account;
  signed_in_at := finished.signed_in_at;
  account_created := finished.account_created;
  RETURN NEXT;
END
$$;
