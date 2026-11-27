-- The per-network count of wrong email sign-in codes (design 5.3), which a mail sender needs
-- before it is wired: the count per address alone lets one client network guess codes across many
-- addresses.
--
-- * `uts.network_email_code_failures` counts the wrong sign-in codes entered from one client
--   network (an IPv4 /24 or an IPv6 /48, `uts.client_network`) in the hour that started with the
--   first of them. A network has 30 per hour over all addresses, as for wrong device user codes
--   (design 5.11). A code entry without a client address counts against no network.
-- * `uts.verify_email_code` refuses a code entry from a network at its limit before it reads any
--   code (`network_limited`): nothing is counted, no code moves, and no audit row is written, as
--   for every rate-limited refusal (decision Q56). A wrong code counts against the network first,
--   in one conditional upsert that refuses past 30, so concurrent guesses from one network wait on
--   its row and cannot go over the limit. The email's link still works, so a network that shares
--   the owner's address cannot lock the owner out.
-- * `uts.maintain_provider_sign_in_rows` also deletes network counts whose hour has passed.
-- * The app login reads nothing of the new table; only the two functions above reach it.

SET LOCAL ROLE uts_owner;

CREATE TABLE uts.network_email_code_failures (
  client_network inet PRIMARY KEY CHECK (client_network = network(client_network)::inet),
  failures smallint NOT NULL CHECK (failures BETWEEN 1 AND 30),
  window_started_at timestamptz NOT NULL
);
CREATE INDEX network_email_code_failures_window_idx
  ON uts.network_email_code_failures (window_started_at);

-- `uts.verify_email_code()` (migration 0009) with the per-network limit: a network with 30 wrong
-- codes in its hour gets `network_limited` (one primary-key probe), and every wrong code counts
-- against the network before it counts against the code, by an upsert that adds one only while
-- the network is under 30 (its row lock orders concurrent guesses). Everything else is as in 0009;
-- the grant stays.
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
  IF code.code_hash <> p_code_hash THEN
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

-- `uts.maintain_provider_sign_in_rows()` (migration 0009) with one more kind: network counts whose
-- hour has passed, at most 5,000 per call, through `network_email_code_failures_window_idx`.
-- Everything else is as in 0009; the grant stays.
CREATE OR REPLACE FUNCTION uts.maintain_provider_sign_in_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  batch CONSTANT integer := 5000;
BEGIN
  DELETE FROM uts.sign_in_flows AS flow
  WHERE flow.state_hash IN (
    SELECT stale.state_hash FROM uts.sign_in_flows AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'sign_in_flows';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.email_codes AS code
  WHERE code.id IN (
    SELECT stale.id FROM uts.email_codes AS stale
    WHERE stale.expires_at < now() - interval '1 hour' AND stale.purpose = 'sign_in'
    LIMIT batch
  );
  kind := 'sign_in_emails';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.email_code_limits AS limits
  WHERE (limits.purpose, limits.email_hash) IN (
    SELECT stale.purpose, stale.email_hash FROM uts.email_code_limits AS stale
    WHERE stale.purpose = 'sign_in'
      AND stale.hour_started_at < now() - interval '1 hour'
      AND stale.day_started_at < now() - interval '1 day'
      AND (stale.status = 'open' OR stale.stopped_until < now())
    LIMIT batch
  );
  kind := 'email_code_limits';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.network_email_code_failures AS counted
  WHERE counted.client_network IN (
    SELECT stale.client_network FROM uts.network_email_code_failures AS stale
    WHERE stale.window_started_at <= now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'network_email_code_failures';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;
