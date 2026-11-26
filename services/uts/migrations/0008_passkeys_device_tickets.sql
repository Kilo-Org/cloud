-- Passkeys, browser sign-in sessions, passkey step-ups, the RFC 8628 device grant and one-time
-- tickets (design sections 5.1, 5.3, 5.4, 5.11, 5.13, 5.14, 8.1 and 8.2).
--
-- * Every write is one call of a SECURITY DEFINER function that writes the rows and their audit
--   row in the same statement. The app role loses direct writes on the tables these functions
--   own, so no passkey, session, step-up, device code or ticket changes without its audit row.
-- * A WebAuthn challenge is 32 random bytes, stored as its SHA-256, accepted once within 5
--   minutes, and only for the ceremony, the relying-party id and the browser session it was made
--   for. The Worker verifies the WebAuthn signature; the statement that records the result
--   consumes the challenge and moves the signature counter only from the value the Worker read,
--   so two uses of one assertion cannot both succeed.
-- * A browser session is the sign-in session on the UTS origin (`__Host-` cookie, stored as its
--   SHA-256): 14 days idle, 30 days at most, `last_seen_at` moved at most once per 5 minutes.
-- * Adding a passkey is a tier A action (design 5.11): the registration consumes an open
--   `passkey_add` gate pass of the same browser session, which the gate slice opens.
-- * Approving a device sign-in is a tier B action: a sign-in of the browser session within 10
--   minutes, or a passkey step-up of that session within 10 minutes. The approval statement checks
--   it and records the gate pass as consumed by that device code.
-- * The device grant and the tickets mint through a first-party grant exactly as migration 0004
--   does: the DPoP proof's `jti` is recorded under the grant in the same statement.
-- * Unauthenticated writes (a sign-in challenge, a device authorization) write no audit row:
--   neither names an account yet, and an audit row per anonymous request would let anyone grow the
--   audit log. Every row they write expires within 10 minutes and `uts.maintain_sign_in_rows()`
--   deletes it.
-- * A refusal that a caller can repeat (a failed passkey assertion, a refused gate, a wrong ticket
--   audience, a second use of a ticket) writes at most one denied audit row per credential, session
--   or ticket per minute.

SET LOCAL ROLE uts_owner;

CREATE TYPE uts.webauthn_ceremony AS ENUM ('registration', 'sign_in', 'step_up');

-- A registration and a step-up belong to one browser session; a sign-in challenge belongs to no
-- one until the assertion names its credential.
CREATE TABLE uts.webauthn_challenges (
  challenge_hash uts.sha256 PRIMARY KEY,
  ceremony uts.webauthn_ceremony NOT NULL,
  rp_id text NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  account_id uts.account_id REFERENCES uts.accounts (id) ON DELETE CASCADE,
  browser_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE CASCADE,
  -- The WebAuthn user handle a registration creates its credential under.
  user_handle bytea CHECK (octet_length(user_handle) BETWEEN 16 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.code_status NOT NULL DEFAULT 'issued',
  consumed_at timestamptz,
  CONSTRAINT webauthn_challenges_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '5 minutes'
  ),
  CONSTRAINT webauthn_challenges_ceremony_shape CHECK (
    CASE ceremony
      WHEN 'sign_in' THEN account_id IS NULL AND browser_session_id IS NULL AND user_handle IS NULL
      WHEN 'registration' THEN account_id IS NOT NULL AND browser_session_id IS NOT NULL
        AND user_handle IS NOT NULL
      ELSE account_id IS NOT NULL AND browser_session_id IS NOT NULL AND user_handle IS NULL
    END
  ),
  CONSTRAINT webauthn_challenges_status_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX webauthn_challenges_expires_idx ON uts.webauthn_challenges (expires_at);
CREATE INDEX webauthn_challenges_session_idx ON uts.webauthn_challenges (browser_session_id)
  WHERE browser_session_id IS NOT NULL;

-- A passkey keeps the user handle it was created under, and the tier A gate pass that allowed it.
-- No row exists yet in any environment, so the new NOT NULL columns need no default.
ALTER TABLE uts.passkey_credentials
  ADD COLUMN user_handle bytea NOT NULL CHECK (octet_length(user_handle) BETWEEN 16 AND 64),
  ADD COLUMN gate_pass_id uuid NOT NULL,
  ADD COLUMN gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('passkey_add'::uts.gated_action) STORED,
  -- When the passkey's last denied sign-in row was written.
  ADD COLUMN denied_audited_at timestamptz,
  ADD CONSTRAINT passkey_credentials_gate_pass_key UNIQUE (gate_pass_id),
  ADD CONSTRAINT passkey_credentials_gate_pass_fkey
    FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action);

-- The client network whose anonymous writes and wrong user codes share one count: the address's
-- IPv4 /24 or IPv6 /48, or NULL without an address. One IPv6 subscriber holds a /64 or more, so
-- an exact address bounds nothing. `clientNetwork` in src/signin/network.ts computes the same
-- network for the Worker's limiter.
CREATE FUNCTION uts.client_network(p_client_ip inet) RETURNS inet
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
RETURN network(set_masklen(p_client_ip, CASE family(p_client_ip) WHEN 4 THEN 24 ELSE 48 END))::inet;

-- When the session's last denied audit row was written, and when the session cleanup last found
-- the ended session still kept by a credential (`uts.maintain_sign_in_rows`).
ALTER TABLE uts.browser_sessions
  ADD COLUMN denied_audited_at timestamptz,
  ADD COLUMN cleanup_kept_at timestamptz;

-- Wrong user codes entered on the device page in the hour that started with the first of them,
-- counted per account (over all its browser sessions) and per client network (an IPv4 /24 or an
-- IPv6 /48), so neither a new session nor another account on the same network adds guesses. An
-- account has 10 per hour and a network 30 (`uts.user_code_entries_left`). The first failure
-- after the hour starts a new one; `uts.maintain_sign_in_rows` deletes rows whose hour has passed.
CREATE TABLE uts.account_user_code_failures (
  account_id uts.account_id PRIMARY KEY REFERENCES uts.accounts (id) ON DELETE CASCADE,
  failures smallint NOT NULL CHECK (failures BETWEEN 1 AND 10),
  window_started_at timestamptz NOT NULL
);
CREATE INDEX account_user_code_failures_window_idx
  ON uts.account_user_code_failures (window_started_at);
CREATE TABLE uts.network_user_code_failures (
  client_network inet PRIMARY KEY CHECK (client_network = network(client_network)::inet),
  failures smallint NOT NULL CHECK (failures BETWEEN 1 AND 30),
  window_started_at timestamptz NOT NULL
);
CREATE INDEX network_user_code_failures_window_idx
  ON uts.network_user_code_failures (window_started_at);

-- An approval records when and how the user authenticated, which become the device session's
-- `auth_time` and `amr`; a consumed code names the grant it created and the DPoP key that grant
-- is bound to, so a retry of the same poll gets that grant again. `client_network` keys the cap
-- on pending codes per network (`uts.create_device_code`).
ALTER TABLE uts.device_codes
  ADD COLUMN auth_time timestamptz,
  ADD COLUMN amr uts.auth_method[]
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  ADD COLUMN grant_id uuid,
  ADD COLUMN dpop_jkt uts.sha256,
  ADD COLUMN client_network inet GENERATED ALWAYS AS (uts.client_network(client_ip)) STORED,
  ADD CONSTRAINT device_codes_approval_shape CHECK (
    (status IN ('approved', 'consumed')) = (auth_time IS NOT NULL AND amr IS NOT NULL)
  ),
  ADD CONSTRAINT device_codes_grant_shape CHECK (
    (status = 'consumed') = (grant_id IS NOT NULL AND dpop_jkt IS NOT NULL)
  );

-- A ticket names the grant and client it was minted from, so its redemption fails once that grant
-- ends. No foreign key: its check would lock the grant row on every ticket. No row exists yet.
ALTER TABLE uts.tickets
  ADD COLUMN grant_id uuid NOT NULL,
  ADD COLUMN client_id uts.client_id NOT NULL,
  ADD COLUMN org_id uuid,
  ADD COLUMN denied_audited_at timestamptz;

GRANT SELECT ON
  uts.webauthn_challenges, uts.account_user_code_failures, uts.network_user_code_failures
TO uts_app;

-- The live browser session a cookie names: active, within its idle and maximum lifetime, of an
-- active account. One probe of `browser_sessions_token_hash_key`, then `accounts_pkey`.
CREATE FUNCTION uts.live_browser_session(p_token_hash bytea)
RETURNS TABLE (
  id uuid,
  account_id text,
  auth_time timestamptz,
  amr uts.auth_method[],
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session.id, session.account_id, session.auth_time, session.amr, session.last_seen_at
  FROM uts.browser_sessions AS session
  JOIN uts.accounts AS account ON account.id = session.account_id
  WHERE session.token_hash = $1
    AND session.status = 'active'
    AND session.idle_expires_at > now()
    AND session.expires_at > now()
    AND account.status = 'active'
$$;

-- Whether a refused attempt on a session writes its denied audit row: true for the first refusal
-- in a minute, as `uts.claim_denied_audit` does for a grant.
CREATE FUNCTION uts.claim_session_denied_audit(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE uts.browser_sessions AS session SET denied_audited_at = now()
  WHERE session.id = p_session_id
    AND (session.denied_audited_at IS NULL OR session.denied_audited_at <= now() - interval '1 minute');
  RETURN FOUND;
END
$$;

-- A refused tier A or tier B gate of a browser session: one denied audit row per session per
-- minute at most.
CREATE FUNCTION uts.audit_session_gate_refusal(
  p_environment text,
  p_account_id text,
  p_session_id uuid,
  p_action uts.gated_action,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF uts.claim_session_denied_audit(p_session_id) THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.gate.refused', 3001, 99, 'denied', p_reason, p_account_id,
      jsonb_build_object(
        'action', p_action,
        'tier', CASE WHEN p_action IN ('passkey_add', 'passkey_remove', 'method_add',
          'method_remove', 'email_change') THEN 'a' ELSE 'b' END,
        'sessionId', p_session_id
      )
    );
  END IF;
END
$$;

-- Moves the signature counter of a passkey from the value the Worker read to the value the
-- assertion carries, and records its use. False when the counter moved in between (another use of
-- the passkey won) or the passkey is not the account's.
CREATE FUNCTION uts.use_passkey(
  p_passkey_id uuid,
  p_account_id text,
  p_previous_count bigint,
  p_new_count bigint,
  p_backed_up boolean
) RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner_account text;
BEGIN
  UPDATE uts.passkey_credentials AS passkey
  SET sign_count = p_new_count,
    backed_up = p_backed_up AND passkey.backup_eligible,
    last_used_at = now()
  WHERE passkey.id = p_passkey_id
    AND passkey.sign_count = p_previous_count
    AND (p_account_id IS NULL OR passkey.account_id = p_account_id)
  RETURNING passkey.account_id INTO owner_account;
  RETURN owner_account;
END
$$;

-- GET /authorize and every sign-in page: the session a cookie names, or no row. It moves
-- `last_seen_at` and the idle end at most once per 5 minutes.
CREATE FUNCTION uts.read_browser_session(p_token_hash bytea)
RETURNS TABLE (
  session_id uuid,
  session_account text,
  session_auth_time timestamptz,
  session_amr text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
BEGIN
  SELECT * INTO live FROM uts.live_browser_session(p_token_hash);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF live.last_seen_at < now() - interval '5 minutes' THEN
    UPDATE uts.browser_sessions AS session
    SET last_seen_at = now(), idle_expires_at = least(session.expires_at, now() + interval '14 days')
    WHERE session.id = live.id AND session.last_seen_at < now() - interval '5 minutes';
  END IF;
  session_id := live.id;
  session_account := live.account_id;
  session_auth_time := live.auth_time;
  session_amr := live.amr::text[];
  RETURN NEXT;
END
$$;

-- POST /signin/passkey/options: stores a 5-minute challenge. A sign-in challenge needs no
-- session. A registration or a step-up needs the live session `p_session_token_hash` names; a
-- registration returns the account's address (the authenticator shows it as the user name), the
-- user handle (the account's newest passkey's, else `p_new_user_handle`) and the passkeys to
-- exclude, and a step-up returns the passkeys it allows. At most 20 passkeys per account.
-- Outcomes: `created`; `no_session`; `no_passkey` (a step-up for an account without one);
-- `limit_reached` (a registration for an account with 20).
CREATE FUNCTION uts.create_webauthn_challenge(
  p_ceremony uts.webauthn_ceremony,
  p_challenge_hash bytea,
  p_rp_id text,
  p_session_token_hash bytea,
  p_new_user_handle bytea
) RETURNS TABLE (
  outcome text,
  account_email text,
  user_handle bytea,
  credential_ids bytea[],
  credential_transports text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  passkey_count integer;
BEGIN
  IF p_ceremony = 'sign_in' THEN
    INSERT INTO uts.webauthn_challenges (challenge_hash, ceremony, rp_id, expires_at)
    VALUES (p_challenge_hash, 'sign_in', p_rp_id, now() + interval '5 minutes');
    outcome := 'created';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  -- The limit counts every passkey of the account; the lists hold those of this relying party.
  SELECT count(*),
    array_agg(passkey.credential_id ORDER BY passkey.added_at) FILTER (WHERE passkey.rp_id = p_rp_id),
    array_agg(array_to_string(passkey.transports, ',') ORDER BY passkey.added_at)
      FILTER (WHERE passkey.rp_id = p_rp_id)
  INTO passkey_count, credential_ids, credential_transports
  FROM uts.passkey_credentials AS passkey
  WHERE passkey.account_id = live.account_id;

  IF p_ceremony = 'step_up' THEN
    IF credential_ids IS NULL THEN
      outcome := 'no_passkey';
      RETURN NEXT;
      RETURN;
    END IF;
    INSERT INTO uts.webauthn_challenges (
      challenge_hash, ceremony, rp_id, account_id, browser_session_id, expires_at
    ) VALUES (
      p_challenge_hash, 'step_up', p_rp_id, live.account_id, live.id, now() + interval '5 minutes'
    );
    outcome := 'created';
    RETURN NEXT;
    RETURN;
  END IF;

  IF passkey_count >= 20 THEN
    outcome := 'limit_reached';
    credential_ids := NULL;
    credential_transports := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.primary_email INTO account_email FROM uts.accounts AS account
  WHERE account.id = live.account_id;
  SELECT passkey.user_handle INTO user_handle FROM uts.passkey_credentials AS passkey
  WHERE passkey.account_id = live.account_id
  ORDER BY passkey.added_at DESC
  LIMIT 1;
  user_handle := coalesce(user_handle, p_new_user_handle);
  INSERT INTO uts.webauthn_challenges (
    challenge_hash, ceremony, rp_id, account_id, browser_session_id, user_handle, expires_at
  ) VALUES (
    p_challenge_hash, 'registration', p_rp_id, live.account_id, live.id, user_handle,
    now() + interval '5 minutes'
  );
  outcome := 'created';
  RETURN NEXT;
END
$$;

-- POST /signin/passkey/verify, before the Worker checks the signature: the challenge must be
-- unused, unexpired and of this ceremony (and, for a step-up, of the live session), and the
-- passkey must exist for the challenge's relying-party id (and, for a step-up, belong to the
-- session's account). Outcomes: `ok` with the passkey; `unknown_challenge`; `unknown_passkey`.
CREATE FUNCTION uts.read_passkey_assertion(
  p_ceremony uts.webauthn_ceremony,
  p_challenge_hash bytea,
  p_credential_id bytea,
  p_session_token_hash bytea
) RETURNS TABLE (
  outcome text,
  passkey_id uuid,
  passkey_account text,
  public_key bytea,
  sign_count bigint,
  user_handle bytea,
  transports text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  challenge uts.webauthn_challenges%ROWTYPE;
  session_id uuid;
BEGIN
  IF p_ceremony = 'registration' THEN
    RAISE EXCEPTION 'a registration has no assertion' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO challenge FROM uts.webauthn_challenges AS stored
  WHERE stored.challenge_hash = p_challenge_hash
    AND stored.ceremony = p_ceremony
    AND stored.status = 'issued'
    AND stored.expires_at > now();
  IF FOUND AND p_ceremony = 'step_up' THEN
    SELECT live.id INTO session_id FROM uts.live_browser_session(p_session_token_hash) AS live;
  END IF;
  IF challenge.challenge_hash IS NULL
    OR (p_ceremony = 'step_up' AND session_id IS DISTINCT FROM challenge.browser_session_id)
  THEN
    outcome := 'unknown_challenge';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT passkey.id, passkey.account_id, passkey.public_key, passkey.sign_count,
    passkey.user_handle, passkey.transports
  INTO passkey_id, passkey_account, public_key, sign_count, user_handle, transports
  FROM uts.passkey_credentials AS passkey
  WHERE passkey.credential_id = p_credential_id
    AND passkey.rp_id = challenge.rp_id
    AND (p_ceremony = 'sign_in' OR passkey.account_id = challenge.account_id);
  outcome := CASE WHEN passkey_id IS NULL THEN 'unknown_passkey' ELSE 'ok' END;
  RETURN NEXT;
END
$$;

-- POST /signin/passkey/verify after a valid sign-in assertion: consumes the challenge, moves the
-- passkey's counter from `p_previous_count`, creates the browser session (`amr` passkey) and
-- writes its audit row. Outcomes: `signed_in` with the session; `challenge_used`;
-- `counter_conflict`; `account_inactive`.
CREATE FUNCTION uts.complete_passkey_sign_in(
  p_environment text,
  p_challenge_hash bytea,
  p_passkey_id uuid,
  p_previous_count bigint,
  p_new_count bigint,
  p_backed_up boolean,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS TABLE (outcome text, session_id uuid, session_account text, signed_in_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner_account text;
  account_state uts.account_status;
BEGIN
  UPDATE uts.webauthn_challenges AS challenge SET status = 'consumed', consumed_at = now()
  WHERE challenge.challenge_hash = p_challenge_hash
    AND challenge.ceremony = 'sign_in'
    AND challenge.status = 'issued'
    AND challenge.expires_at > now();
  IF NOT FOUND THEN
    outcome := 'challenge_used';
    RETURN NEXT;
    RETURN;
  END IF;
  owner_account := uts.use_passkey(p_passkey_id, NULL, p_previous_count, p_new_count, p_backed_up);
  IF owner_account IS NULL THEN
    outcome := 'counter_conflict';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = owner_account;
  IF account_state IS DISTINCT FROM 'active' THEN
    outcome := 'account_inactive';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.browser_sessions (
    account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, user_agent, client_ip,
    asn, country, city
  ) VALUES (
    owner_account, p_session_token_hash, now(), '{passkey}', now() + interval '14 days',
    now() + interval '30 days', p_user_agent, p_client_ip, p_asn, p_country, p_city
  ) RETURNING id INTO session_id;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.session.created', 3002, 1, 'success', NULL, owner_account,
    jsonb_build_object(
      'method', 'passkey',
      'sessionKind', 'browser',
      'sessionId', session_id,
      'passkeyId', p_passkey_id,
      'country', p_country,
      'asn', p_asn
    )
  );
  outcome := 'signed_in';
  session_account := owner_account;
  signed_in_at := now();
  RETURN NEXT;
END
$$;

-- A passkey assertion that failed the Worker's check: one denied audit row per passkey per minute
-- at most. `p_reason` is one of the Worker's fixed reason strings.
CREATE FUNCTION uts.record_passkey_failure(
  p_environment text,
  p_passkey_id uuid,
  p_ceremony uts.webauthn_ceremony,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner_account text;
BEGIN
  UPDATE uts.passkey_credentials AS passkey SET denied_audited_at = now()
  WHERE passkey.id = p_passkey_id
    AND (passkey.denied_audited_at IS NULL OR passkey.denied_audited_at <= now() - interval '1 minute')
  RETURNING passkey.account_id INTO owner_account;
  IF owner_account IS NOT NULL THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.passkey.assertion_refused', 3002, 1, 'denied', p_reason,
      owner_account,
      jsonb_build_object('passkeyId', p_passkey_id, 'ceremony', p_ceremony)
    );
  END IF;
END
$$;

-- POST /signin/passkey/verify after a valid registration: consumes the challenge and the open
-- `passkey_add` gate pass of the same session (tier A, design 5.11), stores the passkey under the
-- challenge's user handle and relying-party id, and writes the notice and the audit row.
-- Outcomes: `registered` with the passkey id; `no_session`; `challenge_used`; `gate_required` (no
-- open pass; a denied audit row at most once per session per minute); `already_registered`;
-- `limit_reached`.
CREATE FUNCTION uts.register_passkey(
  p_environment text,
  p_challenge_hash bytea,
  p_session_token_hash bytea,
  p_credential_id bytea,
  p_public_key bytea,
  p_sign_count bigint,
  p_aaguid uuid,
  p_transports text[],
  p_backup_eligible boolean,
  p_backed_up boolean,
  p_name text
) RETURNS TABLE (outcome text, passkey_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  challenge uts.webauthn_challenges%ROWTYPE;
  pass_id uuid;
  event_id uuid;
BEGIN
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO challenge FROM uts.webauthn_challenges AS stored
  WHERE stored.challenge_hash = p_challenge_hash
    AND stored.ceremony = 'registration'
    AND stored.status = 'issued'
    AND stored.expires_at > now()
    AND stored.browser_session_id = live.id
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'challenge_used';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM uts.passkey_credentials AS passkey WHERE passkey.credential_id = p_credential_id) THEN
    outcome := 'already_registered';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM uts.passkey_credentials AS passkey WHERE passkey.account_id = live.account_id) >= 20 THEN
    outcome := 'limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT pass.id INTO pass_id FROM uts.gate_passes AS pass
  WHERE pass.account_id = live.account_id
    AND pass.browser_session_id = live.id
    AND pass.action = 'passkey_add'
    AND pass.status = 'open'
    AND pass.expires_at > now()
  ORDER BY pass.passed_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, 'passkey_add', 'tier A gate pass required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE uts.webauthn_challenges AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.challenge_hash = p_challenge_hash;
  UPDATE uts.gate_passes AS pass SET status = 'consumed', consumed_at = now() WHERE pass.id = pass_id;
  INSERT INTO uts.passkey_credentials (
    account_id, credential_id, public_key, sign_count, aaguid, transports, backup_eligible,
    backed_up, rp_id, name, user_handle, gate_pass_id
  ) VALUES (
    live.account_id, p_credential_id, p_public_key, p_sign_count, p_aaguid, p_transports,
    p_backup_eligible, p_backed_up AND p_backup_eligible, challenge.rp_id, p_name,
    challenge.user_handle, pass_id
  ) RETURNING id INTO passkey_id;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.passkey.registered', 3001, 1, 'success', NULL, live.account_id,
    jsonb_build_object(
      'passkeyId', passkey_id,
      'aaguid', p_aaguid,
      'backupEligible', p_backup_eligible,
      'rpId', challenge.rp_id,
      'gatePassId', pass_id,
      'sessionId', live.id
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    live.account_id, 'sign_in_method_changed',
    jsonb_build_object('change', 'passkey_added', 'passkeyId', passkey_id), event_id
  );
  outcome := 'registered';
  RETURN NEXT;
END
$$;

-- POST /signin/passkey/verify after a valid step-up assertion: consumes the challenge of the live
-- session, moves the counter of the account's passkey, and records a 10-minute gate step-up of
-- that session (design 5.11), which a tier B approval accepts. Outcomes: `completed`;
-- `no_session`; `challenge_used`; `counter_conflict`.
CREATE FUNCTION uts.complete_passkey_step_up(
  p_environment text,
  p_challenge_hash bytea,
  p_session_token_hash bytea,
  p_passkey_id uuid,
  p_previous_count bigint,
  p_new_count bigint,
  p_backed_up boolean
) RETURNS TABLE (outcome text, step_up_id uuid, step_up_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
BEGIN
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.webauthn_challenges AS challenge SET status = 'consumed', consumed_at = now()
  WHERE challenge.challenge_hash = p_challenge_hash
    AND challenge.ceremony = 'step_up'
    AND challenge.status = 'issued'
    AND challenge.expires_at > now()
    AND challenge.browser_session_id = live.id;
  IF NOT FOUND THEN
    outcome := 'challenge_used';
    RETURN NEXT;
    RETURN;
  END IF;
  IF uts.use_passkey(p_passkey_id, live.account_id, p_previous_count, p_new_count, p_backed_up) IS NULL THEN
    outcome := 'counter_conflict';
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.step_ups (account_id, browser_session_id, purpose, passkey_credential_id, expires_at)
  VALUES (live.account_id, live.id, 'gate', p_passkey_id, now() + interval '10 minutes')
  RETURNING id, expires_at INTO step_up_id, step_up_expires_at;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.step_up.completed', 3002, 99, 'success', NULL, live.account_id,
    jsonb_build_object(
      'stepUpId', step_up_id,
      'purpose', 'gate',
      'passkeyId', p_passkey_id,
      'sessionId', live.id
    )
  );
  outcome := 'completed';
  RETURN NEXT;
END
$$;

-- POST /device_authorization (RFC 8628 section 3.1): a pending 10-minute device code. It names
-- no account, so it writes no audit row. One client network (`uts.client_network`) holds at most
-- 5 pending codes, so an anonymous caller cannot fill the table (design 3, "Anonymous sign-in
-- writes"). Outcomes: `created`; `user_code_taken` (the caller draws another user code);
-- `too_many_pending`.
CREATE FUNCTION uts.create_device_code(
  p_device_code_hash bytea,
  p_user_code_hash bytea,
  p_client_id text,
  p_scopes text[],
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS TABLE (outcome text, code_expires_at timestamptz, interval_seconds smallint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_client_ip IS NOT NULL AND (
    SELECT count(*) FROM uts.device_codes AS pending
    WHERE pending.client_network = uts.client_network(p_client_ip)
      AND pending.status = 'pending'
      AND pending.expires_at > now()
  ) >= 5 THEN
    outcome := 'too_many_pending';
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.device_codes (
    device_code_hash, user_code_hash, client_id, scopes, expires_at, user_agent, client_ip, asn,
    country, city
  ) VALUES (
    p_device_code_hash, p_user_code_hash, p_client_id, p_scopes, now() + interval '10 minutes',
    p_user_agent, p_client_ip, p_asn, p_country, p_city
  )
  ON CONFLICT ON CONSTRAINT device_codes_user_code_hash_key DO NOTHING
  RETURNING expires_at, poll_interval_seconds INTO code_expires_at, interval_seconds;
  outcome := CASE WHEN FOUND THEN 'created' ELSE 'user_code_taken' END;
  RETURN NEXT;
END
$$;

-- Counts one wrong user code against the account and the client network; the first failure after
-- an hour starts a new one.
CREATE FUNCTION uts.count_user_code_failure(p_account_id text, p_network inet) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO uts.account_user_code_failures AS counted (account_id, failures, window_started_at)
  VALUES (p_account_id, 1, now())
  ON CONFLICT (account_id) DO UPDATE
  SET failures = CASE WHEN counted.window_started_at <= now() - interval '1 hour' THEN 1
      ELSE least(10, counted.failures + 1) END,
    window_started_at = CASE WHEN counted.window_started_at <= now() - interval '1 hour' THEN now()
      ELSE counted.window_started_at END;
  IF p_network IS NOT NULL THEN
    INSERT INTO uts.network_user_code_failures AS counted (client_network, failures, window_started_at)
    VALUES (p_network, 1, now())
    ON CONFLICT (client_network) DO UPDATE
    SET failures = CASE WHEN counted.window_started_at <= now() - interval '1 hour' THEN 1
        ELSE least(30, counted.failures + 1) END,
      window_started_at = CASE WHEN counted.window_started_at <= now() - interval '1 hour' THEN now()
        ELSE counted.window_started_at END;
  END IF;
END
$$;

-- True while the account and the client network may enter another user code: the account has
-- fewer than 10 wrong codes in its hour and the network fewer than 30. One primary-key probe each.
CREATE FUNCTION uts.user_code_entries_left(p_account_id text, p_network inet) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
RETURN NOT EXISTS (
    SELECT 1 FROM uts.account_user_code_failures AS counted
    WHERE counted.account_id = p_account_id
      AND counted.failures >= 10
      AND counted.window_started_at > now() - interval '1 hour'
  )
  AND NOT EXISTS (
    SELECT 1 FROM uts.network_user_code_failures AS counted
    WHERE counted.client_network = p_network
      AND counted.failures >= 30
      AND counted.window_started_at > now() - interval '1 hour'
  );

-- POST /device with a user code: the pending device code and the context the approval page
-- shows, for a live session only. An unknown code counts against the account's 10 and the client
-- network's 30 wrong codes per hour. Outcomes: `pending` with the context; `no_session`;
-- `unknown_code`; `too_many_attempts`.
CREATE FUNCTION uts.read_device_code(
  p_user_code_hash bytea,
  p_session_token_hash bytea,
  p_client_ip inet
)
RETURNS TABLE (
  outcome text,
  code_client_id text,
  code_scopes text[],
  code_created_at timestamptz,
  code_expires_at timestamptz,
  code_user_agent text,
  code_country text,
  code_city text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  entry_network inet := uts.client_network(p_client_ip);
BEGIN
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.user_code_entries_left(live.account_id, entry_network) THEN
    outcome := 'too_many_attempts';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT code.client_id, code.scopes, code.created_at, code.expires_at, code.user_agent,
    code.country, code.city
  INTO code_client_id, code_scopes, code_created_at, code_expires_at, code_user_agent,
    code_country, code_city
  FROM uts.device_codes AS code
  WHERE code.user_code_hash = p_user_code_hash
    AND code.status = 'pending'
    AND code.expires_at > now();
  IF NOT FOUND THEN
    PERFORM uts.count_user_code_failure(live.account_id, entry_network);
    outcome := 'unknown_code';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'pending';
  RETURN NEXT;
END
$$;

-- POST /device/decision: the signed-in user approves or denies a pending device code. An approval
-- is a tier B action (design 5.4 and 5.11): a passkey step-up of this session within 10 minutes,
-- or, when the user typed the code (`p_typed`), a sign-in of this session within 10 minutes. A
-- code that came filled in from a link (`verification_uri_complete`) needs the step-up: whoever
-- sent the link chose the code, and the sign-in the link led to proves nothing about it. It
-- records a consumed gate pass with the checks met, the time and methods of the user's
-- authentication (they become the device session's `auth_time` and `amr`, with `device_grant`
-- added), the notice and the audit row. Outcomes: `approved`; `denied`; `no_session`;
-- `unknown_code`; `too_many_attempts`; `gate_required`.
CREATE FUNCTION uts.decide_device_code(
  p_environment text,
  p_user_code_hash bytea,
  p_session_token_hash bytea,
  p_client_ip inet,
  p_typed boolean,
  p_approve boolean
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  entry_network inet := uts.client_network(p_client_ip);
  code uts.device_codes%ROWTYPE;
  step_up_time timestamptz;
  checks uts.gate_check[];
  pass_id uuid;
  methods uts.auth_method[];
  event_id uuid;
BEGIN
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.user_code_entries_left(live.account_id, entry_network) THEN
    outcome := 'too_many_attempts';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO code FROM uts.device_codes AS stored
  WHERE stored.user_code_hash = p_user_code_hash
    AND stored.status = 'pending'
    AND stored.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM uts.count_user_code_failure(live.account_id, entry_network);
    outcome := 'unknown_code';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT p_approve THEN
    UPDATE uts.device_codes AS stored
    SET status = 'denied', account_id = live.account_id, denied_at = now()
    WHERE stored.id = code.id;
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.device_code.denied', 3002, 99, 'success', NULL, live.account_id,
      jsonb_build_object(
        'clientId', uts.audit_client_id(code.client_id),
        'deviceCodeId', code.id,
        'sessionId', live.id
      )
    );
    outcome := 'denied';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT max(step_up.completed_at) INTO step_up_time
  FROM uts.step_ups AS step_up
  WHERE step_up.account_id = live.account_id
    AND step_up.browser_session_id = live.id
    AND step_up.purpose = 'gate'
    AND step_up.completed_at > now() - interval '10 minutes'
    AND step_up.expires_at > now();
  checks := array_remove(ARRAY[
    CASE WHEN p_typed AND live.auth_time > now() - interval '10 minutes' AND live.auth_time <= now()
      THEN 'recent_sign_in'::uts.gate_check END,
    CASE WHEN step_up_time IS NOT NULL THEN 'passkey'::uts.gate_check END
  ], NULL);
  IF cardinality(checks) = 0 THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, 'device_approve',
      CASE WHEN p_typed THEN 'sign-in or passkey check required'
        ELSE 'passkey check required for a linked code' END
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.gate_passes (
    account_id, browser_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
  ) VALUES (
    live.account_id, live.id, 'b', 'device_approve', checks, now() + interval '10 minutes',
    'consumed', now()
  ) RETURNING id INTO pass_id;
  methods := ARRAY(
    SELECT DISTINCT method
    FROM unnest(
      live.amr
      || CASE WHEN step_up_time IS NULL THEN '{}'::uts.auth_method[] ELSE '{passkey}'::uts.auth_method[] END
      || '{device_grant}'::uts.auth_method[]
    ) AS method
    ORDER BY method
  );
  UPDATE uts.device_codes AS stored
  SET status = 'approved', account_id = live.account_id, gate_pass_id = pass_id,
    approved_at = now(),
    auth_time = greatest(live.auth_time, coalesce(step_up_time, live.auth_time)),
    amr = methods
  WHERE stored.id = code.id;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.device_code.approved', 3002, 99, 'success', NULL, live.account_id,
    jsonb_build_object(
      'clientId', uts.audit_client_id(code.client_id),
      'deviceCodeId', code.id,
      'gatePassId', pass_id,
      'gateChecks', to_jsonb(checks::text[]),
      'scopes', to_jsonb(code.scopes),
      'sessionId', live.id,
      'deviceCountry', code.country
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    live.account_id, 'device_sign_in_approved',
    jsonb_strip_nulls(jsonb_build_object(
      'clientId', uts.audit_client_id(code.client_id),
      'country', code.country,
      'city', code.city
    )),
    event_id
  );
  outcome := 'approved';
  RETURN NEXT;
END
$$;

-- POST /token with the RFC 8628 device grant (section 3.4). A pending code answers
-- `authorization_pending`, or `slow_down` when the client polls faster than the code's interval,
-- which then grows by 5 seconds (RFC 8628 section 3.5, at most 60). An approved code is consumed:
-- the DPoP proof's `jti` is recorded under the new grant, a device session and a DPoP-bound
-- refresh grant are created (the grant id comes from the device code), and the audit row lists
-- the token ids. A retry of the poll that consumed the code (same client and DPoP key, while the
-- code's 10-minute lifetime lasts) gets the same grant with a new refresh token; any other use of
-- a consumed code revokes that grant. Outcomes: `issued`, `authorization_pending`, `slow_down`,
-- `access_denied`, `expired_token`, `invalid_grant`, `invalid_scope`, `invalid_target`,
-- `dpop_replay`.
CREATE FUNCTION uts.exchange_device_code(
  p_environment text,
  p_device_code_hash bytea,
  p_client_id text,
  p_client_class uts.client_class,
  p_dpop_jkt bytea,
  p_dpop_jti text,
  p_grant_id uuid,
  p_refresh_token_hash bytea,
  p_device_label text,
  p_device_platform text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text,
  p_scopes text[],
  p_resources text[]
) RETURNS TABLE (
  outcome text,
  subject_id text,
  bound_org_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  token_ids uuid[],
  token_scopes text[],
  refresh_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.device_codes%ROWTYPE;
  retry boolean := false;
  revoked_account text;
  chosen record;
  account_state uts.account_status;
  new_session_id uuid;
  idle_window interval;
  grant_state uts.grant_status;
  previous_hash bytea;
BEGIN
  SELECT * INTO code FROM uts.device_codes AS stored WHERE stored.device_code_hash = p_device_code_hash
  FOR UPDATE;
  IF NOT FOUND OR code.client_id <> p_client_id THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF code.status = 'consumed' THEN
    IF code.expires_at > now() AND code.dpop_jkt = p_dpop_jkt AND code.grant_id = p_grant_id THEN
      retry := true;
    ELSE
      revoked_account := uts.end_grant('first_party', code.grant_id, 'reuse_detected');
      IF revoked_account IS NOT NULL THEN
        PERFORM uts.write_audit_event(
          p_environment, 'ai.kilo.uts.device_code.reused', 6003, 99, 'denied', 'grant revoked',
          revoked_account,
          jsonb_build_object(
            'clientId', uts.audit_client_id(code.client_id),
            'deviceCodeId', code.id,
            'grantId', code.grant_id
          )
        );
      END IF;
      outcome := 'invalid_grant';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF NOT retry THEN
    IF code.expires_at <= now() THEN
      outcome := 'expired_token';
      RETURN NEXT;
      RETURN;
    END IF;
    IF code.status = 'denied' THEN
      outcome := 'access_denied';
      RETURN NEXT;
      RETURN;
    END IF;
    IF code.status = 'pending' THEN
      IF code.last_polled_at IS NOT NULL
        AND code.last_polled_at > now() - make_interval(secs => code.poll_interval_seconds)
      THEN
        UPDATE uts.device_codes AS stored
        SET poll_interval_seconds = least(60, stored.poll_interval_seconds + 5), last_polled_at = now()
        WHERE stored.id = code.id;
        outcome := 'slow_down';
      ELSE
        UPDATE uts.device_codes AS stored SET last_polled_at = now() WHERE stored.id = code.id;
        outcome := 'authorization_pending';
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  INSERT INTO uts.dpop_proofs (grant_id, jti, expires_at)
  VALUES (p_grant_id, p_dpop_jti, now() + interval '121 seconds')
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  IF NOT FOUND THEN
    outcome := 'dpop_replay';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO chosen FROM uts.select_token_scopes(code.scopes, p_scopes, p_resources);
  IF chosen.outcome <> 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = code.account_id;
  IF account_state IS DISTINCT FROM 'active' THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT retry THEN
    UPDATE uts.device_codes AS stored
    SET status = 'consumed', consumed_at = now(), grant_id = p_grant_id, dpop_jkt = p_dpop_jkt
    WHERE stored.id = code.id;
    idle_window := CASE p_client_class WHEN 'desktop' THEN interval '30 days' ELSE interval '60 days' END;
    INSERT INTO uts.device_sessions (
      account_id, client_class, device_label, platform, auth_time, amr, client_ip, asn, country, city
    ) VALUES (
      code.account_id, p_client_class, p_device_label, p_device_platform, code.auth_time, code.amr,
      p_client_ip, p_asn, p_country, p_city
    ) RETURNING id INTO new_session_id;
    INSERT INTO uts.refresh_grants (
      id, account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
      allowed_scopes, org_id, idle_expires_at, expires_at
    ) VALUES (
      p_grant_id, code.account_id, new_session_id, code.client_id, p_client_class,
      p_refresh_token_hash, p_dpop_jkt, code.scopes, NULL, now() + idle_window,
      now() + CASE p_client_class WHEN 'desktop' THEN interval '180 days' ELSE interval '365 days' END
    );
    refresh_expires_at := now() + idle_window;
  ELSE
    SELECT grant_row.status, grant_row.token_hash, least(grant_row.idle_expires_at, grant_row.expires_at)
    INTO grant_state, previous_hash, refresh_expires_at
    FROM uts.refresh_grants AS grant_row WHERE grant_row.id = p_grant_id
    FOR UPDATE;
    IF grant_state IS DISTINCT FROM 'active' THEN
      outcome := 'invalid_grant';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE uts.refresh_grants AS grant_row SET token_hash = p_refresh_token_hash
    WHERE grant_row.id = p_grant_id;
  END IF;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  IF retry THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'device_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', 'first_party',
        'grantId', p_grant_id,
        'rotation', 'device_code_retry',
        'deviceCodeId', code.id,
        'previousRefreshRef', uts.credential_reference(previous_hash),
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', 600
      )
    );
  ELSE
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.grant.created', 3002, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'device_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', 'first_party',
        'grantId', p_grant_id,
        'deviceCodeId', code.id,
        'gatePassId', code.gate_pass_id,
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', 600
      )
    );
  END IF;
  outcome := 'issued';
  subject_id := code.account_id;
  bound_org_id := NULL;
  signed_in_at := code.auth_time;
  sign_in_methods := code.amr::text[];
  token_scopes := chosen.scopes;
  RETURN NEXT;
END
$$;

-- POST /tickets: a 60-second single-use ticket for one audience, minted from a first-party grant
-- as a refresh is (the grant read, the DPoP key check, the proof `jti` recorded under the grant,
-- the organization requirement). The audience must be one the grant's scopes name. Outcomes:
-- `issued`; `invalid_grant`; `invalid_target`; `dpop_mismatch` (a denied audit row at most once
-- per grant per minute); `dpop_replay`.
CREATE FUNCTION uts.issue_ticket(
  p_environment text,
  p_token_hash bytea,
  p_grant_id uuid,
  p_client_id text,
  p_dpop_jkt bytea,
  p_dpop_jti text,
  p_ticket_hash bytea,
  p_purpose uts.ticket_purpose,
  p_audience text,
  p_resource text
) RETURNS TABLE (outcome text, ticket_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_row record;
BEGIN
  IF p_purpose = 'sign_in' THEN
    RAISE EXCEPTION 'a sign-in ticket is not minted from a grant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO grant_row FROM uts.read_refresh_grant(p_token_hash);
  IF NOT FOUND
    OR grant_row.id <> p_grant_id
    OR grant_row.client_id <> p_client_id
    OR grant_row.grant_status <> 'active'
    OR grant_row.session_status <> 'active'
    OR grant_row.account_status <> 'active'
    OR grant_row.expires_at <= now()
    OR grant_row.idle_expires_at <= now()
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF grant_row.dpop_jkt <> p_dpop_jkt THEN
    IF uts.claim_denied_audit('first_party', grant_row.id) THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.ticket.denied', 6003, 1, 'denied', 'dpop key mismatch',
        grant_row.account_id,
        jsonb_build_object('clientId', uts.audit_client_id(grant_row.client_id), 'grantId', grant_row.id)
      );
    END IF;
    outcome := 'dpop_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.dpop_proofs (grant_id, jti, expires_at)
  VALUES (grant_row.id, p_dpop_jti, now() + interval '121 seconds')
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  IF NOT FOUND THEN
    outcome := 'dpop_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.org_requirement_met(
    grant_row.org_id, grant_row.membership_status, grant_row.sso_enforcement, grant_row.amr
  ) THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT p_audience = ANY (uts.scope_audiences(grant_row.allowed_scopes)) THEN
    outcome := 'invalid_target';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.tickets (
    ticket_hash, purpose, audience, account_id, resource, expires_at, grant_id, client_id, org_id
  ) VALUES (
    p_ticket_hash, p_purpose, p_audience, grant_row.account_id, p_resource,
    now() + interval '60 seconds', grant_row.id, grant_row.client_id, grant_row.org_id
  ) RETURNING expires_at INTO ticket_expires_at;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.ticket.issued', 6003, 1, 'success', NULL, grant_row.account_id,
    jsonb_build_object(
      'ticketRef', uts.credential_reference(p_ticket_hash),
      'purpose', p_purpose,
      'audience', p_audience,
      'clientId', uts.audit_client_id(grant_row.client_id),
      'grantId', grant_row.id,
      'org', grant_row.org_id
    )
  );
  outcome := 'issued';
  RETURN NEXT;
END
$$;

-- POST /tickets/redeem by the ticket's audience: consumes the ticket once, while it is unexpired
-- and its grant, the grant's device session and the account are live. Every other answer is
-- `unknown`, so a caller learns nothing about a ticket it cannot redeem. A second use writes one
-- denied `ticket.reused` row; a wrong audience leaves the ticket usable and writes a denied row at
-- most once per ticket per minute. Outcomes: `redeemed` with the ticket's subject; `unknown`.
CREATE FUNCTION uts.redeem_ticket(p_environment text, p_ticket_hash bytea, p_audience text)
RETURNS TABLE (
  outcome text,
  ticket_account text,
  ticket_purpose uts.ticket_purpose,
  ticket_resource text,
  ticket_org uuid,
  ticket_grant uuid,
  ticket_client text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ticket uts.tickets%ROWTYPE;
  live boolean;
BEGIN
  SELECT * INTO ticket FROM uts.tickets AS stored WHERE stored.ticket_hash = p_ticket_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF ticket.status = 'consumed' THEN
    UPDATE uts.tickets AS stored SET denied_audited_at = now()
    -- The first use after the consumption writes the row; a wrong-audience row before it does not
    -- count.
    WHERE stored.ticket_hash = p_ticket_hash
      AND (stored.denied_audited_at IS NULL OR stored.denied_audited_at < stored.consumed_at);
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.ticket.reused', 6003, 2, 'denied', 'ticket used before',
        ticket.account_id,
        jsonb_build_object(
          'ticketRef', uts.credential_reference(p_ticket_hash),
          'purpose', ticket.purpose,
          'audience', ticket.audience,
          'grantId', ticket.grant_id
        )
      );
    END IF;
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF ticket.expires_at <= now() THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF ticket.audience <> p_audience THEN
    UPDATE uts.tickets AS stored SET denied_audited_at = now()
    WHERE stored.ticket_hash = p_ticket_hash
      AND (stored.denied_audited_at IS NULL OR stored.denied_audited_at <= now() - interval '1 minute');
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.ticket.denied', 6003, 2, 'denied', 'audience mismatch',
        ticket.account_id,
        jsonb_build_object(
          'ticketRef', uts.credential_reference(p_ticket_hash),
          'purpose', ticket.purpose,
          'audience', ticket.audience,
          'grantId', ticket.grant_id
        )
      );
    END IF;
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  -- The grant, its device session and the account must be live, and an organization ticket needs
  -- the membership and SSO requirement it was minted under (design 5.8).
  SELECT true INTO live
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = ticket.org_id AND membership.account_id = ticket.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = ticket.org_id
  WHERE grant_row.id = ticket.grant_id
    AND grant_row.status = 'active'
    AND grant_row.expires_at > now()
    AND grant_row.idle_expires_at > now()
    AND session.status = 'active'
    AND account.status = 'active'
    AND uts.org_requirement_met(ticket.org_id, membership.status, policy.enforcement, session.amr);
  IF live IS NULL THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE uts.tickets AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.ticket_hash = p_ticket_hash;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.ticket.redeemed', 6003, 2, 'success', NULL, ticket.account_id,
    jsonb_build_object(
      'ticketRef', uts.credential_reference(p_ticket_hash),
      'purpose', ticket.purpose,
      'audience', ticket.audience,
      'grantId', ticket.grant_id
    )
  );
  outcome := 'redeemed';
  ticket_account := ticket.account_id;
  ticket_purpose := ticket.purpose;
  ticket_resource := ticket.resource;
  ticket_org := ticket.org_id;
  ticket_grant := ticket.grant_id;
  ticket_client := ticket.client_id;
  RETURN NEXT;
END
$$;

-- Deletes sign-in rows that no statement reads again, at most 5,000 of each kind per call, as
-- `uts.maintain_oauth_rows()` does: WebAuthn challenges, device codes, tickets and step-ups 1
-- hour past their lifetime, used or not, wrong user-code counts whose hour has passed, and
-- browser sessions 1 day after they ended (idle, absolute or revoked). Deleting a session
-- cascades to its challenges, codes, step-ups and gate passes. A session stays while a row still
-- refers to one of its passes (a passkey, PAT, bot key, CI trust policy, third-party consent or
-- device code), whose foreign key would refuse the cascade: at most one session per such
-- credential. A pass nothing refers to, such as that of a device approval whose code is gone,
-- keeps nothing. A kept session is stamped `cleanup_kept_at` and looked at again a day later, so
-- a call reads the newly ended sessions and about a 1,440th of the kept ones, not every kept one.
-- Each look is a unique-index probe per referring table. The UTS cron calls both functions until
-- every count is under 5,000.
CREATE FUNCTION uts.maintain_sign_in_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  batch CONSTANT integer := 5000;
BEGIN
  DELETE FROM uts.webauthn_challenges AS challenge
  WHERE challenge.challenge_hash IN (
    SELECT stale.challenge_hash FROM uts.webauthn_challenges AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'webauthn_challenges';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.device_codes AS code
  WHERE code.id IN (
    SELECT stale.id FROM uts.device_codes AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'device_codes';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.tickets AS ticket
  WHERE ticket.ticket_hash IN (
    SELECT stale.ticket_hash FROM uts.tickets AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'tickets';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.step_ups AS step_up
  WHERE step_up.id IN (
    SELECT stale.id FROM uts.step_ups AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'step_ups';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.account_user_code_failures AS counted
  WHERE counted.account_id IN (
    SELECT stale.account_id FROM uts.account_user_code_failures AS stale
    WHERE stale.window_started_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'account_user_code_failures';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.network_user_code_failures AS counted
  WHERE counted.client_network IN (
    SELECT stale.client_network FROM uts.network_user_code_failures AS stale
    WHERE stale.window_started_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'network_user_code_failures';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  WITH due AS (
    SELECT ended.id,
      EXISTS (
        SELECT 1 FROM uts.gate_passes AS pass
        WHERE pass.browser_session_id = ended.id
          AND (
            EXISTS (SELECT 1 FROM uts.passkey_credentials AS r WHERE r.gate_pass_id = pass.id)
            OR EXISTS (SELECT 1 FROM uts.personal_access_tokens AS r WHERE r.gate_pass_id = pass.id)
            OR EXISTS (SELECT 1 FROM uts.org_bot_keys AS r WHERE r.gate_pass_id = pass.id)
            OR EXISTS (SELECT 1 FROM uts.ci_trust_policies AS r WHERE r.gate_pass_id = pass.id)
            OR EXISTS (SELECT 1 FROM uts.third_party_consents AS r WHERE r.gate_pass_id = pass.id)
            OR EXISTS (SELECT 1 FROM uts.device_codes AS r WHERE r.gate_pass_id = pass.id)
          )
      ) AS kept
    FROM uts.browser_sessions AS ended
    WHERE greatest(
        least(ended.idle_expires_at, ended.expires_at, coalesce(ended.revoked_at, 'infinity')),
        coalesce(ended.cleanup_kept_at, '-infinity')
      ) < now() - interval '1 day'
    LIMIT batch
  ),
  stamped AS (
    UPDATE uts.browser_sessions AS session SET cleanup_kept_at = now()
    FROM due WHERE session.id = due.id AND due.kept
  )
  DELETE FROM uts.browser_sessions AS session
  USING due WHERE session.id = due.id AND NOT due.kept;
  kind := 'browser_sessions';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;
CREATE INDEX step_ups_expires_idx ON uts.step_ups (expires_at);
-- The session cleanup reads sessions due a look (ended, and not found kept, a day ago), and its
-- cascades find a session's rows.
CREATE INDEX browser_sessions_cleanup_idx ON uts.browser_sessions (
  greatest(
    least(idle_expires_at, expires_at, coalesce(revoked_at, 'infinity')),
    coalesce(cleanup_kept_at, '-infinity')
  )
);
CREATE INDEX gate_passes_browser_session_idx ON uts.gate_passes (browser_session_id)
  WHERE browser_session_id IS NOT NULL;
CREATE INDEX step_ups_browser_session_idx ON uts.step_ups (browser_session_id)
  WHERE browser_session_id IS NOT NULL;
CREATE INDEX authorization_codes_browser_session_idx ON uts.authorization_codes (browser_session_id)
  WHERE browser_session_id IS NOT NULL;
-- The pending-code cap of `uts.create_device_code`.
CREATE INDEX device_codes_pending_network_idx ON uts.device_codes (client_network)
  WHERE status = 'pending';

GRANT EXECUTE ON FUNCTION
  uts.read_browser_session(bytea),
  uts.create_webauthn_challenge(uts.webauthn_ceremony, bytea, text, bytea, bytea),
  uts.read_passkey_assertion(uts.webauthn_ceremony, bytea, bytea, bytea),
  uts.complete_passkey_sign_in(
    text, bytea, uuid, bigint, bigint, boolean, bytea, text, inet, integer, text, text
  ),
  uts.record_passkey_failure(text, uuid, uts.webauthn_ceremony, text),
  uts.register_passkey(
    text, bytea, bytea, bytea, bytea, bigint, uuid, text[], boolean, boolean, text
  ),
  uts.complete_passkey_step_up(text, bytea, bytea, uuid, bigint, bigint, boolean),
  uts.create_device_code(bytea, bytea, text, text[], text, inet, integer, text, text),
  uts.read_device_code(bytea, bytea, inet),
  uts.decide_device_code(text, bytea, bytea, inet, boolean, boolean),
  uts.exchange_device_code(
    text, bytea, text, uts.client_class, bytea, text, uuid, bytea, text, text, inet, integer, text,
    text, text[], text[]
  ),
  uts.issue_ticket(text, bytea, uuid, text, bytea, text, bytea, uts.ticket_purpose, text, text),
  uts.redeem_ticket(text, bytea, text),
  uts.maintain_sign_in_rows()
TO uts_app;

-- The functions above are now the only writers of these tables (README, "Rules for statements").
REVOKE INSERT, UPDATE, DELETE ON
  uts.passkey_credentials,
  uts.browser_sessions,
  uts.step_ups,
  uts.device_codes,
  uts.tickets
FROM uts_app;
