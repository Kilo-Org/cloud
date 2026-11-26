-- Personal access tokens, org bot keys and credential-change gates (design sections 5.3, 5.6, 5.8,
-- 5.11, 5.13, 8.1 and 8.2).
--
-- * Every write is one call of a SECURITY DEFINER function that writes the credential rows, the
--   gate pass, the notice and the audit row in the same statement. The app role loses direct
--   writes on PATs, org bot keys and gate passes, so none of them changes without its audit row.
-- * A caller names its session by the grant its access token names (`sid`); the grant's device
--   session holds the sign-in time and methods that the gates check (`uts.account_session`).
-- * Tier B (create a PAT or an org bot key): a sign-in within 10 minutes, or a passkey step-up of
--   the same session within 10 minutes. The create statement checks it and records the pass as
--   consumed by that one row.
-- * Tier A (add or remove a passkey or a sign-in method, change the primary email): a sign-in with
--   the account's strongest method within 10 minutes plus an emailed code, and for an email change
--   a code to the new address too. A method added in the last 24 hours blocks removing a method and
--   changing the email. `uts.open_tier_a_gate_pass` opens a pass that the action's own statement
--   consumes.
-- * A refused gate writes at most one denied audit row per grant per minute
--   (`uts.claim_denied_audit`), so a caller cannot grow the audit log at will.
-- * A revoked PAT or bot key gets a feed entry for 15 minutes, which outlasts every PAT cache layer
--   (design 5.6).
-- * An account holds at most 100 live PATs, and an organization at most 100 live bot keys.
-- * Audit rows name a PAT or a bot key by its id and by `uts.credential_reference` of its hash,
--   never by the value or the hash, and never carry the user-chosen name.

SET LOCAL ROLE uts_owner;

-- Org admins hear of the bot keys a removed member created (design 5.8). PostgreSQL accepts the
-- new value inside this transaction; the plpgsql bodies below use it only when they run.
ALTER TYPE uts.notice_kind ADD VALUE 'bot_key_flagged';

-- Writes one audit row whose actor is UTS itself, for an event no user started (a membership
-- event). The subject account, when there is one, is the row's account.
CREATE FUNCTION uts.write_system_audit_event(
  p_environment text,
  p_type text,
  p_class integer,
  p_activity integer,
  p_account_id text,
  p_attributes jsonb
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_event_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO uts.audit_events (event_id, event_type, account_id, event)
  VALUES (new_event_id, p_type, p_account_id, jsonb_build_object(
    'specversion', '1.0',
    'id', new_event_id,
    'source', 'kilo:uts:' || p_environment,
    'type', p_type,
    'time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'datacontenttype', 'application/json',
    'data', jsonb_build_object(
      'classUid', p_class,
      'activityId', p_activity,
      'outcome', 'success',
      'actor', jsonb_build_object('kind', 'system', 'id', 'uts'),
      'attributes', jsonb_strip_nulls(p_attributes)
    )
  ));
  RETURN new_event_id;
END
$$;

-- The live session of `p_account_id` that grant `p_grant_id` belongs to: the grant and its device
-- session are active, the grant is within its lifetime, and the account is active. One probe of
-- `refresh_grants_pkey`, then `device_sessions_pkey` and `accounts_pkey`.
CREATE FUNCTION uts.account_session(p_account_id text, p_grant_id uuid)
RETURNS TABLE (device_session_id uuid, auth_time timestamptz, amr uts.auth_method[])
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session.id, session.auth_time, session.amr
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  WHERE grant_row.id = $2
    AND grant_row.account_id = $1
    AND grant_row.status = 'active'
    AND grant_row.expires_at > now()
    AND grant_row.idle_expires_at > now()
    AND session.status = 'active'
    AND account.status = 'active'
$$;

-- The tier B checks the session meets (design 5.11): `recent_sign_in` for a sign-in within 10
-- minutes, `passkey` for a passkey step-up of this session within 10 minutes. Empty when neither.
CREATE FUNCTION uts.tier_b_checks(
  p_account_id text,
  p_device_session_id uuid,
  p_auth_time timestamptz
) RETURNS uts.gate_check[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
RETURN array_remove(ARRAY[
  CASE
    WHEN p_auth_time > now() - interval '10 minutes' AND p_auth_time <= now()
    THEN 'recent_sign_in'::uts.gate_check
  END,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM uts.step_ups AS step_up
      WHERE step_up.account_id = p_account_id
        AND step_up.completed_at > now() - interval '10 minutes'
        AND step_up.device_session_id = p_device_session_id
        AND step_up.purpose = 'gate'
        AND step_up.expires_at > now()
    )
    THEN 'passkey'::uts.gate_check
  END
], NULL);

-- A refused gate: one denied audit row per grant per minute at most.
CREATE FUNCTION uts.audit_gate_refusal(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_action uts.gated_action,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF uts.claim_denied_audit('first_party', p_grant_id) THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.gate.refused', 3001, 99, 'denied', p_reason, p_account_id,
      jsonb_build_object(
        'action', p_action,
        'tier', CASE WHEN p_action IN ('pat_create', 'bot_key_create', 'ci_policy_create',
          'device_approve', 'third_party_approve') THEN 'b' ELSE 'a' END,
        'grantId', p_grant_id
      )
    );
  END IF;
END
$$;

-- The organization requirement of a session (design 5.8): an active membership with one of
-- `p_roles` (any role when NULL), and a sign-in through SSO when the organization requires it.
CREATE FUNCTION uts.org_role_met(
  p_org_id uuid,
  p_account_id text,
  p_amr uts.auth_method[],
  p_roles uts.org_role[]
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
RETURN EXISTS (
  SELECT 1
  FROM uts.org_memberships AS membership
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
  WHERE membership.org_id = p_org_id
    AND membership.account_id = p_account_id
    AND (p_roles IS NULL OR membership.role = ANY (p_roles))
    AND uts.org_requirement_met(p_org_id, membership.status, policy.enforcement, p_amr)
);

-- POST /account/pats: a tier B gate, then the PAT, its consumed gate pass, the creator's notice and
-- the audit row. Outcomes: `created`; `invalid_session`; `gate_required` (no sign-in or passkey
-- step-up within 10 minutes); `org_denied` (the PAT names an organization the caller cannot act in);
-- `limit_reached` (100 live PATs). The audience is the scope's own (design 5.3).
CREATE FUNCTION uts.create_pat(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_name text,
  p_token_hash bytea,
  p_last_four text,
  p_scope text,
  p_org_id uuid,
  p_lifetime_days integer
) RETURNS TABLE (outcome text, new_pat_id uuid, pat_created_at timestamptz, pat_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  checks uts.gate_check[];
  pass_id uuid;
  event_id uuid;
BEGIN
  IF p_lifetime_days IS NULL OR p_lifetime_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'a PAT lives 1 to 365 days' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  checks := uts.tier_b_checks(p_account_id, holder.device_session_id, holder.auth_time);
  IF cardinality(checks) = 0 THEN
    PERFORM uts.audit_gate_refusal(
      p_environment, p_account_id, p_grant_id, 'pat_create', 'fresh sign-in required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_org_id IS NOT NULL AND NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, NULL) THEN
    outcome := 'org_denied';
    RETURN NEXT;
    RETURN;
  END IF;
  -- Concurrent creates of one account run one after another, so the cap holds.
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = p_account_id FOR NO KEY UPDATE;
  IF (
    SELECT count(*) FROM uts.personal_access_tokens AS pat
    WHERE pat.account_id = p_account_id AND pat.status = 'active' AND pat.expires_at > now()
  ) >= 100 THEN
    outcome := 'limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.gate_passes (
    account_id, device_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
  ) VALUES (
    p_account_id, holder.device_session_id, 'b', 'pat_create', checks,
    now() + interval '10 minutes', 'consumed', now()
  ) RETURNING id INTO pass_id;
  INSERT INTO uts.personal_access_tokens (
    account_id, name, token_hash, last_four, audience, scope, org_id, gate_pass_id, expires_at
  ) VALUES (
    p_account_id, p_name, p_token_hash, p_last_four, split_part(p_scope, ':', 1), p_scope,
    p_org_id, pass_id, now() + make_interval(days => p_lifetime_days)
  ) RETURNING id, created_at, expires_at INTO new_pat_id, pat_created_at, pat_expires_at;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.pat.created', 6003, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'patId', new_pat_id,
      'patRef', uts.credential_reference(p_token_hash),
      'audience', split_part(p_scope, ':', 1),
      'scope', p_scope,
      'org', p_org_id,
      'expiresAt', to_char(pat_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'lifetimeDays', p_lifetime_days,
      'grantId', p_grant_id,
      'gatePassId', pass_id,
      'gateChecks', to_jsonb(checks::text[])
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    p_account_id, 'credential_created',
    jsonb_build_object('credential', 'pat', 'patId', new_pat_id, 'scope', p_scope),
    event_id
  );
  outcome := 'created';
  RETURN NEXT;
END
$$;

-- GET /account/pats: the caller's live PATs (unexpired and not revoked), newest first, as one row.
-- Outcomes: `listed` with `pats`, or `invalid_session`.
CREATE FUNCTION uts.list_pats(p_account_id text, p_grant_id uuid)
RETURNS TABLE (outcome text, pats jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'listed';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', pat.id,
      'name', pat.name,
      'audience', pat.audience,
      'scope', pat.scope,
      'org', pat.org_id,
      'last_four', pat.last_four,
      'created_at', pat.created_at,
      'expires_at', pat.expires_at,
      'last_used_at', pat.last_used_at
    ) ORDER BY pat.created_at DESC), '[]'::jsonb)
  INTO pats
  FROM uts.personal_access_tokens AS pat
  WHERE pat.account_id = p_account_id AND pat.status = 'active' AND pat.expires_at > now();
  RETURN NEXT;
END
$$;

-- DELETE /account/pats/<id>: revokes one of the caller's PATs, writes its feed entry and the audit
-- row. Revoking needs no gate: it only takes access away. Outcomes: `revoked`, `already_revoked`,
-- `not_found` (no such PAT of this account), `invalid_session`.
CREATE FUNCTION uts.revoke_pat(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_pat_id uuid
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  revoked_hash bytea;
BEGIN
  PERFORM 1 FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.personal_access_tokens AS pat
  SET status = 'revoked', revoked_at = now(), revoke_reason = 'user_revoke'
  WHERE pat.id = p_pat_id AND pat.account_id = p_account_id AND pat.status = 'active'
  RETURNING pat.token_hash INTO revoked_hash;
  IF NOT FOUND THEN
    outcome := CASE
      WHEN EXISTS (
        SELECT 1 FROM uts.personal_access_tokens AS pat
        WHERE pat.id = p_pat_id AND pat.account_id = p_account_id
      ) THEN 'already_revoked'
      ELSE 'not_found'
    END;
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
  VALUES ('pat', p_pat_id::text, now() + interval '15 minutes')
  ON CONFLICT (kind, subject_id) DO NOTHING;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.pat.revoked', 6003, 4, 'success', NULL, p_account_id,
    jsonb_build_object(
      'patId', p_pat_id,
      'patRef', uts.credential_reference(revoked_hash),
      'reason', 'user_revoke',
      'grantId', p_grant_id
    )
  );
  outcome := 'revoked';
  RETURN NEXT;
END
$$;

-- POST /account/orgs/<org>/bot-keys: an owner or admin of the organization passes a tier B gate,
-- then the key, its consumed gate pass, the creator's notice and the audit row. The key belongs to
-- the organization and records its creator. Outcomes: `created`, `invalid_session`,
-- `gate_required`, `not_org_admin`, `limit_reached` (100 live keys in the organization).
CREATE FUNCTION uts.create_bot_key(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_org_id uuid,
  p_name text,
  p_token_hash bytea,
  p_last_four text,
  p_scope text,
  p_lifetime_days integer
) RETURNS TABLE (outcome text, new_key_id uuid, key_created_at timestamptz, key_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  checks uts.gate_check[];
  pass_id uuid;
  event_id uuid;
BEGIN
  IF p_lifetime_days IS NULL OR p_lifetime_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'an org bot key lives 1 to 365 days' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  checks := uts.tier_b_checks(p_account_id, holder.device_session_id, holder.auth_time);
  IF cardinality(checks) = 0 THEN
    PERFORM uts.audit_gate_refusal(
      p_environment, p_account_id, p_grant_id, 'bot_key_create', 'fresh sign-in required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  -- Concurrent creates in one organization run one after another, so the cap holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('uts.org_bot_keys:' || p_org_id::text, 0));
  IF (
    SELECT count(*) FROM uts.org_bot_keys AS bot_key
    WHERE bot_key.org_id = p_org_id
      AND bot_key.expires_at > now()
      AND (bot_key.status IN ('active', 'kept')
        OR (bot_key.status = 'flagged' AND bot_key.flagged_at > now() - interval '7 days'))
  ) >= 100 THEN
    outcome := 'limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.gate_passes (
    account_id, device_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
  ) VALUES (
    p_account_id, holder.device_session_id, 'b', 'bot_key_create', checks,
    now() + interval '10 minutes', 'consumed', now()
  ) RETURNING id INTO pass_id;
  INSERT INTO uts.org_bot_keys (
    org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at
  ) VALUES (
    p_org_id, p_account_id, p_name, p_token_hash, p_last_four, split_part(p_scope, ':', 1),
    p_scope, pass_id, now() + make_interval(days => p_lifetime_days)
  ) RETURNING id, created_at, expires_at INTO new_key_id, key_created_at, key_expires_at;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.bot_key.created', 6003, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'botKeyId', new_key_id,
      'botKeyRef', uts.credential_reference(p_token_hash),
      'org', p_org_id,
      'audience', split_part(p_scope, ':', 1),
      'scope', p_scope,
      'expiresAt', to_char(key_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'lifetimeDays', p_lifetime_days,
      'grantId', p_grant_id,
      'gatePassId', pass_id,
      'gateChecks', to_jsonb(checks::text[])
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    p_account_id, 'credential_created',
    jsonb_build_object('credential', 'bot_key', 'botKeyId', new_key_id, 'org', p_org_id),
    event_id
  );
  outcome := 'created';
  RETURN NEXT;
END
$$;

-- GET /account/orgs/<org>/bot-keys: the organization's live keys, newest first, for an owner or
-- admin. A flagged key is live until 7 days after it was flagged. Outcomes: `listed` with `keys`,
-- `invalid_session`, `not_org_admin`.
CREATE FUNCTION uts.list_bot_keys(p_account_id text, p_grant_id uuid, p_org_id uuid)
RETURNS TABLE (outcome text, keys jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
BEGIN
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'listed';
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', bot_key.id,
      'org', bot_key.org_id,
      'name', bot_key.name,
      'audience', bot_key.audience,
      'scope', bot_key.scope,
      'last_four', bot_key.last_four,
      'created_by', bot_key.created_by,
      'created_at', bot_key.created_at,
      'expires_at', bot_key.expires_at,
      'status', bot_key.status,
      'flagged_at', bot_key.flagged_at,
      'stops_at', CASE WHEN bot_key.status = 'flagged'
        THEN bot_key.flagged_at + interval '7 days' END,
      'kept_by', bot_key.kept_by,
      'kept_at', bot_key.kept_at
    )) || jsonb_build_object('last_used_at', bot_key.last_used_at)
    ORDER BY bot_key.created_at DESC), '[]'::jsonb)
  INTO keys
  FROM uts.org_bot_keys AS bot_key
  WHERE bot_key.org_id = p_org_id
    AND bot_key.expires_at > now()
    AND (bot_key.status IN ('active', 'kept')
      OR (bot_key.status = 'flagged' AND bot_key.flagged_at > now() - interval '7 days'));
  RETURN NEXT;
END
$$;

-- DELETE /account/orgs/<org>/bot-keys/<id>: an owner or admin revokes a key of the organization,
-- with its feed entry and the audit row. Outcomes: `revoked`, `already_revoked`, `not_found`,
-- `invalid_session`, `not_org_admin`.
CREATE FUNCTION uts.revoke_bot_key(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_org_id uuid,
  p_key_id uuid
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  revoked_hash bytea;
BEGIN
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.org_bot_keys AS bot_key
  SET status = 'revoked', revoked_at = now(), revoked_by = p_account_id
  WHERE bot_key.id = p_key_id AND bot_key.org_id = p_org_id AND bot_key.status <> 'revoked'
  RETURNING bot_key.token_hash INTO revoked_hash;
  IF NOT FOUND THEN
    outcome := CASE
      WHEN EXISTS (
        SELECT 1 FROM uts.org_bot_keys AS bot_key
        WHERE bot_key.id = p_key_id AND bot_key.org_id = p_org_id
      ) THEN 'already_revoked'
      ELSE 'not_found'
    END;
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
  VALUES ('bot_key', p_key_id::text, now() + interval '15 minutes')
  ON CONFLICT (kind, subject_id) DO NOTHING;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.bot_key.revoked', 6003, 4, 'success', NULL, p_account_id,
    jsonb_build_object(
      'botKeyId', p_key_id,
      'botKeyRef', uts.credential_reference(revoked_hash),
      'org', p_org_id,
      'reason', 'org_admin_revoke',
      'grantId', p_grant_id
    )
  );
  outcome := 'revoked';
  RETURN NEXT;
END
$$;

-- POST /account/orgs/<org>/bot-keys/<id>/keep: an owner or admin keeps a flagged key before its
-- 7-day cutoff, so it works on until it expires (design 5.8). Outcomes: `kept`, `not_flagged` (the
-- key is active, kept or revoked), `lapsed` (past the cutoff or expired), `not_found`,
-- `invalid_session`, `not_org_admin`.
CREATE FUNCTION uts.keep_bot_key(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_org_id uuid,
  p_key_id uuid
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  found_key uts.org_bot_keys%ROWTYPE;
BEGIN
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO found_key FROM uts.org_bot_keys AS bot_key
  WHERE bot_key.id = p_key_id AND bot_key.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'not_found';
  ELSIF found_key.status <> 'flagged' THEN
    outcome := 'not_flagged';
  ELSIF found_key.flagged_at <= now() - interval '7 days' OR found_key.expires_at <= now() THEN
    outcome := 'lapsed';
  ELSE
    UPDATE uts.org_bot_keys AS bot_key
    SET status = 'kept', kept_by = p_account_id, kept_at = now()
    WHERE bot_key.id = p_key_id;
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.bot_key.kept', 6003, 3, 'success', NULL, p_account_id,
      jsonb_build_object(
        'botKeyId', p_key_id,
        'botKeyRef', uts.credential_reference(found_key.token_hash),
        'org', p_org_id,
        'createdBy', found_key.created_by,
        'grantId', p_grant_id
      )
    );
    outcome := 'kept';
  END IF;
  RETURN NEXT;
END
$$;

-- Applies a membership-removed event from the app database (design 5.2, 5.6, 5.8) in one
-- statement: the replica row becomes `removed` unless a newer event already arrived; the member's
-- org-bound PATs, first-party grants and third-party families are revoked with their feed entries;
-- the member's active bot keys of that organization are flagged and stop 7 days later unless an
-- org admin keeps them; every active owner and admin of the organization gets one notice. Each
-- revoked credential and each flagged key writes its own audit row. Outcomes: `removed`;
-- `recorded` (no membership row existed; a removed row now holds the version, so a late `added`
-- event cannot bring it back); `unchanged` (the stored version is the same or newer, the
-- membership is already removed, or UTS holds no such account).
CREATE FUNCTION uts.remove_org_member(
  p_environment text,
  p_org_id uuid,
  p_account_id text,
  p_event_version bigint
) RETURNS TABLE (outcome text, flagged_keys integer, revoked_pats integer, revoked_grants integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item record;
  stops_at timestamptz := now() + interval '7 days';
BEGIN
  flagged_keys := 0;
  revoked_pats := 0;
  revoked_grants := 0;
  UPDATE uts.org_memberships AS membership
  SET status = 'removed', removed_at = now(), event_version = p_event_version, updated_at = now()
  WHERE membership.org_id = p_org_id
    AND membership.account_id = p_account_id
    AND membership.status = 'active'
    AND membership.event_version < p_event_version;
  IF NOT FOUND THEN
    INSERT INTO uts.org_memberships (org_id, account_id, role, status, removed_at, event_version)
    SELECT p_org_id, account.id, 'member', 'removed', now(), p_event_version
    FROM uts.accounts AS account WHERE account.id = p_account_id
    ON CONFLICT (org_id, account_id) DO NOTHING;
    outcome := CASE WHEN FOUND THEN 'recorded' ELSE 'unchanged' END;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR item IN
    UPDATE uts.personal_access_tokens AS pat
    SET status = 'revoked', revoked_at = now(), revoke_reason = 'member_removed'
    WHERE pat.account_id = p_account_id AND pat.org_id = p_org_id AND pat.status = 'active'
    RETURNING pat.id, pat.token_hash
  LOOP
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    VALUES ('pat', item.id::text, now() + interval '15 minutes')
    ON CONFLICT (kind, subject_id) DO NOTHING;
    PERFORM uts.write_system_audit_event(
      p_environment, 'ai.kilo.uts.pat.revoked', 6003, 4, p_account_id,
      jsonb_build_object(
        'patId', item.id,
        'patRef', uts.credential_reference(item.token_hash),
        'reason', 'member_removed',
        'org', p_org_id
      )
    );
    revoked_pats := revoked_pats + 1;
  END LOOP;

  FOR item IN
    SELECT 'first_party'::uts.client_kind AS kind, grant_row.id
    FROM uts.refresh_grants AS grant_row
    WHERE grant_row.org_id = p_org_id AND grant_row.account_id = p_account_id
      AND grant_row.status = 'active'
    UNION ALL
    SELECT 'third_party'::uts.client_kind, family.id
    FROM uts.third_party_grant_families AS family
    WHERE family.account_id = p_account_id AND family.org_id = p_org_id
      AND family.status = 'active'
  LOOP
    IF uts.end_grant(item.kind, item.id, 'member_removed') IS NOT NULL THEN
      PERFORM uts.write_system_audit_event(
        p_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, p_account_id,
        jsonb_build_object(
          'grantId', item.id,
          'clientKind', item.kind,
          'reason', 'member_removed',
          'org', p_org_id
        )
      );
      revoked_grants := revoked_grants + 1;
    END IF;
  END LOOP;

  FOR item IN
    UPDATE uts.org_bot_keys AS bot_key
    SET status = 'flagged', flagged_at = now()
    WHERE bot_key.org_id = p_org_id AND bot_key.created_by = p_account_id
      AND bot_key.status = 'active'
    RETURNING bot_key.id, bot_key.token_hash
  LOOP
    PERFORM uts.write_system_audit_event(
      p_environment, 'ai.kilo.uts.bot_key.flagged', 6003, 3, p_account_id,
      jsonb_build_object(
        'botKeyId', item.id,
        'botKeyRef', uts.credential_reference(item.token_hash),
        'org', p_org_id,
        'reason', 'member_removed',
        'stopsAt', to_char(stops_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );
    flagged_keys := flagged_keys + 1;
  END LOOP;

  IF flagged_keys > 0 THEN
    INSERT INTO uts.notices (account_id, kind, details)
    SELECT admin.account_id, 'bot_key_flagged', jsonb_build_object(
      'org', p_org_id,
      'flaggedKeys', flagged_keys,
      'stopsAt', to_char(stops_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
    FROM uts.org_memberships AS admin
    WHERE admin.org_id = p_org_id AND admin.status = 'active' AND admin.role IN ('owner', 'admin');
  END IF;

  PERFORM uts.write_system_audit_event(
    p_environment, 'ai.kilo.uts.org_member.removed', 3001, 99, p_account_id,
    jsonb_build_object(
      'org', p_org_id,
      'eventVersion', p_event_version,
      'flaggedKeys', flagged_keys,
      'revokedPats', revoked_pats,
      'revokedGrants', revoked_grants
    )
  );
  outcome := 'removed';
  RETURN NEXT;
END
$$;

-- Consumes the newest pending tier A code sent to `p_email_hash` for the account when its keyed
-- hash is `p_code_hash`; a wrong code counts an attempt, and the fifth wrong attempt exhausts the
-- code. Returns whether the code matched. With `p_consume` false it only checks, so a caller can
-- check two codes before it consumes either.
CREATE FUNCTION uts.use_tier_a_code(
  p_account_id text,
  p_email_hash bytea,
  p_code_hash bytea,
  p_consume boolean
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.email_codes%ROWTYPE;
BEGIN
  SELECT * INTO code FROM uts.email_codes AS stored
  WHERE stored.email_hash = p_email_hash
    AND stored.purpose = 'tier_a'
    AND stored.status = 'pending'
    AND stored.account_id = p_account_id
    AND stored.expires_at > now()
  ORDER BY stored.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF code.code_hash <> p_code_hash THEN
    UPDATE uts.email_codes AS stored
    SET attempts = stored.attempts + 1,
      status = CASE WHEN stored.attempts + 1 >= 5 THEN 'exhausted'::uts.email_code_status
        ELSE stored.status END
    WHERE stored.id = code.id;
    RETURN false;
  END IF;
  IF p_consume THEN
    UPDATE uts.email_codes AS stored SET status = 'consumed', consumed_at = now()
    WHERE stored.id = code.id;
  END IF;
  RETURN true;
END
$$;

-- Opens a tier A gate pass (design 5.11) for one action of the caller's own session; the action's
-- statement consumes it within 10 minutes. It needs a sign-in within 10 minutes with the account's
-- strongest method (a passkey when the account holds one, else SSO when it has an SSO link, else
-- any method) and the code emailed to the account's address; an email change also needs the code
-- sent to the new address. A method added in the last 24 hours blocks removing a method or a
-- passkey and changing the email. Outcomes: `opened` with the pass; `invalid_session`;
-- `gate_required` (no recent strongest-method sign-in); `cooling_off`; `code_invalid` (a missing,
-- wrong, expired or exhausted code; a wrong code counts an attempt).
CREATE FUNCTION uts.open_tier_a_gate_pass(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_action uts.gated_action,
  p_email_hash bytea,
  p_code_hash bytea,
  p_new_email_hash bytea,
  p_new_code_hash bytea
) RETURNS TABLE (outcome text, gate_pass_id uuid, pass_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  strongest uts.auth_method;
  checks uts.gate_check[] := ARRAY['recent_sign_in', 'email_code']::uts.gate_check[];
  old_ok boolean;
  new_ok boolean := true;
BEGIN
  IF p_action NOT IN ('passkey_add', 'passkey_remove', 'method_add', 'method_remove', 'email_change') THEN
    RAISE EXCEPTION 'not a tier A action' USING ERRCODE = '22023';
  END IF;
  IF (p_action = 'email_change') <> (p_new_email_hash IS NOT NULL AND p_new_code_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'an email change, and only an email change, names the new address and its code'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  strongest := CASE
    WHEN EXISTS (SELECT 1 FROM uts.passkey_credentials AS passkey WHERE passkey.account_id = p_account_id)
      THEN 'passkey'::uts.auth_method
    WHEN EXISTS (
      SELECT 1 FROM uts.sign_in_methods AS method
      WHERE method.account_id = p_account_id AND method.provider = 'workos'
    ) THEN 'sso'::uts.auth_method
  END;
  IF NOT (holder.auth_time > now() - interval '10 minutes' AND holder.auth_time <= now())
    OR (strongest IS NOT NULL AND NOT strongest = ANY (holder.amr))
  THEN
    PERFORM uts.audit_gate_refusal(
      p_environment, p_account_id, p_grant_id, p_action, 'strongest-method sign-in required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_action IN ('passkey_remove', 'method_remove', 'email_change') AND (
    EXISTS (
      SELECT 1 FROM uts.sign_in_methods AS method
      WHERE method.account_id = p_account_id AND method.added_at > now() - interval '24 hours'
    )
    OR EXISTS (
      SELECT 1 FROM uts.passkey_credentials AS passkey
      WHERE passkey.account_id = p_account_id AND passkey.added_at > now() - interval '24 hours'
    )
  ) THEN
    PERFORM uts.audit_gate_refusal(
      p_environment, p_account_id, p_grant_id, p_action, 'method added in the last 24 hours'
    );
    outcome := 'cooling_off';
    RETURN NEXT;
    RETURN;
  END IF;

  old_ok := uts.use_tier_a_code(p_account_id, p_email_hash, p_code_hash, false);
  IF p_action = 'email_change' THEN
    new_ok := uts.use_tier_a_code(p_account_id, p_new_email_hash, p_new_code_hash, false);
    checks := checks || 'email_code_new'::uts.gate_check;
  END IF;
  IF NOT (old_ok AND new_ok) THEN
    PERFORM uts.audit_gate_refusal(p_environment, p_account_id, p_grant_id, p_action, 'email code invalid');
    outcome := 'code_invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM uts.use_tier_a_code(p_account_id, p_email_hash, p_code_hash, true);
  IF p_action = 'email_change' THEN
    PERFORM uts.use_tier_a_code(p_account_id, p_new_email_hash, p_new_code_hash, true);
  END IF;

  INSERT INTO uts.gate_passes (account_id, device_session_id, tier, action, satisfied_by, expires_at)
  VALUES (p_account_id, holder.device_session_id, 'a', p_action, checks, now() + interval '10 minutes')
  RETURNING id, expires_at INTO gate_pass_id, pass_expires_at;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.gate.passed', 3001, 99, 'success', NULL, p_account_id,
    jsonb_build_object(
      'action', p_action,
      'tier', 'a',
      'gatePassId', gate_pass_id,
      'gateChecks', to_jsonb(checks::text[]),
      'grantId', p_grant_id
    )
  );
  outcome := 'opened';
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.create_pat(text, text, uuid, text, bytea, text, text, uuid, integer),
  uts.list_pats(text, uuid),
  uts.revoke_pat(text, text, uuid, uuid),
  uts.create_bot_key(text, text, uuid, uuid, text, bytea, text, text, integer),
  uts.list_bot_keys(text, uuid, uuid),
  uts.revoke_bot_key(text, text, uuid, uuid, uuid),
  uts.keep_bot_key(text, text, uuid, uuid, uuid),
  uts.remove_org_member(text, uuid, text, bigint),
  uts.open_tier_a_gate_pass(text, text, uuid, uts.gated_action, bytea, bytea, bytea, bytea)
TO uts_app;

-- The functions above are now the only writers of these tables (README, "Rules for statements").
REVOKE INSERT, UPDATE, DELETE ON
  uts.personal_access_tokens,
  uts.org_bot_keys,
  uts.gate_passes
FROM uts_app;
