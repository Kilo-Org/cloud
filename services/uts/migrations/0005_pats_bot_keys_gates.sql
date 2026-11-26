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
--   consumes. Each tier A code row records which address it went to (`current` or `new`), and the
--   gate accepts each code only in its own role.
-- * A create that names an organization, and a keep of a flagged bot key, lock the caller's
--   membership row (`FOR SHARE`) in the role check, so a concurrent removal waits for the new row
--   and then revokes or flags it, or the create waits for the removal and is refused.
-- * A refused gate writes at most one denied audit row per grant per minute
--   (`uts.claim_denied_audit`), so a caller cannot grow the audit log at will.
-- * A revoked PAT or bot key gets a feed entry for 15 minutes, which outlasts every PAT cache layer
--   (design 5.6).
-- * An account holds at most 100 live PATs, and an organization at most 100 live bot keys. The
--   account's row lock (PATs) or a transaction advisory lock per organization (bot keys) puts
--   concurrent creates in order, so the count each create reads is final.
-- * Audit rows name a PAT or a bot key by its id and by `uts.credential_reference` of its hash,
--   never by the value or the hash, and never carry the user-chosen name.

SET LOCAL ROLE uts_owner;

-- Org admins hear of the bot keys a removed member created (design 5.8). PostgreSQL accepts the
-- new value inside this transaction; the plpgsql bodies below use it only when they run.
ALTER TYPE uts.notice_kind ADD VALUE 'bot_key_flagged';

-- Keeping a flagged bot key restores long-lived organization access, so it passes the tier B gate
-- like a create (design 5.8, 5.11).
ALTER TYPE uts.gated_action ADD VALUE 'bot_key_keep';

-- The address a tier A code went to: the account's primary address (`current`) or the new address
-- of an email change (`new`). The service that sends a `current` code, and the caller of
-- `uts.open_tier_a_gate_pass`, hash the account's primary address itself, never an address taken
-- from the request.
CREATE TYPE uts.email_code_address AS ENUM ('current', 'new');
ALTER TABLE uts.email_codes
  ADD COLUMN address uts.email_code_address,
  ADD CONSTRAINT email_codes_address_shape CHECK ((purpose = 'tier_a') = (address IS NOT NULL));

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
        'tier', CASE WHEN p_action IN ('pat_create', 'bot_key_create', 'bot_key_keep',
          'ci_policy_create', 'device_approve', 'third_party_approve') THEN 'b' ELSE 'a' END,
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

-- `uts.org_role_met` for a statement that creates or restores a credential bound to the
-- organization: the membership row it finds stays locked `FOR SHARE` until the statement's
-- transaction ends. `uts.remove_org_member` updates that row first, so it waits until the new
-- credential is committed and then revokes or flags it; a create that comes second waits for the
-- removal, reads the row again, and finds no active membership.
CREATE FUNCTION uts.lock_org_role(
  p_org_id uuid,
  p_account_id text,
  p_amr uts.auth_method[],
  p_roles uts.org_role[]
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1
  FROM uts.org_memberships AS membership
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
  WHERE membership.org_id = p_org_id
    AND membership.account_id = p_account_id
    AND (p_roles IS NULL OR membership.role = ANY (p_roles))
    AND uts.org_requirement_met(p_org_id, membership.status, policy.enforcement, p_amr)
  FOR SHARE OF membership;
  RETURN FOUND;
END
$$;

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
  IF p_org_id IS NOT NULL AND NOT uts.lock_org_role(p_org_id, p_account_id, holder.amr, NULL) THEN
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
  IF NOT uts.lock_org_role(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
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
-- 7-day cutoff, so it works on until it expires (design 5.8). Keeping restores long-lived access,
-- so it passes the tier B gate as a create does. Outcomes: `kept`, `not_flagged` (the key is
-- active, kept or revoked), `lapsed` (past the cutoff or expired), `not_found`, `invalid_session`,
-- `not_org_admin`, `gate_required`.
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
  checks uts.gate_check[];
  found_key uts.org_bot_keys%ROWTYPE;
BEGIN
  SELECT * INTO holder FROM uts.account_session(p_account_id, p_grant_id);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.lock_org_role(p_org_id, p_account_id, holder.amr, ARRAY['owner', 'admin']::uts.org_role[]) THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  checks := uts.tier_b_checks(p_account_id, holder.device_session_id, holder.auth_time);
  IF cardinality(checks) = 0 THEN
    PERFORM uts.audit_gate_refusal(
      p_environment, p_account_id, p_grant_id, 'bot_key_keep', 'fresh sign-in required'
    );
    outcome := 'gate_required';
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
        'grantId', p_grant_id,
        'gateChecks', to_jsonb(checks::text[])
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

-- Consumes the newest pending tier A code of the account that went to the address in role
-- `p_address`, with the keyed address hash `p_email_hash`, when its keyed hash is `p_code_hash`; a
-- wrong code counts an attempt, and the fifth wrong attempt exhausts the code. Returns whether the
-- code matched. With `p_consume` false it only checks, so a caller can check two codes before it
-- consumes either.
CREATE FUNCTION uts.use_tier_a_code(
  p_account_id text,
  p_address uts.email_code_address,
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
    AND stored.address = p_address
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
-- any method) and the code emailed to the account's primary address; an email change also needs
-- the code sent to the new address, which must be another address. Each code counts only in its
-- own role: `p_email_hash` and `p_code_hash` match only a code sent to the primary address
-- (`current`), and the new pair only a code sent to the new address (`new`), so a code to the new
-- address never stands in for the primary one. A method added in the last 24 hours blocks removing
-- a method or a passkey and changing the email. Outcomes: `opened` with the pass;
-- `invalid_session`; `gate_required` (no recent strongest-method sign-in); `cooling_off`;
-- `code_invalid` (a missing, wrong, expired or exhausted code; a wrong code counts an attempt).
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
  IF p_action = 'email_change' AND p_email_hash IS NOT DISTINCT FROM p_new_email_hash THEN
    RAISE EXCEPTION 'an email change needs a new address' USING ERRCODE = '22023';
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

  old_ok := uts.use_tier_a_code(p_account_id, 'current', p_email_hash, p_code_hash, false);
  IF p_action = 'email_change' THEN
    new_ok := uts.use_tier_a_code(p_account_id, 'new', p_new_email_hash, p_new_code_hash, false);
    checks := checks || 'email_code_new'::uts.gate_check;
  END IF;
  IF NOT (old_ok AND new_ok) THEN
    PERFORM uts.audit_gate_refusal(p_environment, p_account_id, p_grant_id, p_action, 'email code invalid');
    outcome := 'code_invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM uts.use_tier_a_code(p_account_id, 'current', p_email_hash, p_code_hash, true);
  IF p_action = 'email_change' THEN
    PERFORM uts.use_tier_a_code(p_account_id, 'new', p_new_email_hash, p_new_code_hash, true);
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

-- The mint statements of 0004, changed in two ways and otherwise the same:
-- * They return the caller's membership role in the bound organization (`org_role`), from the
--   membership row they already read, so the Worker refuses, before signing, a scope that the
--   scope registry limits to other roles (`subjects.roles`, design 5.3). A third-party refresh
--   returns no role: no third-party-safe scope is limited to roles (`test/repo`), and a null role
--   refuses such a scope.
-- * The audit attribute `tokenLifetimeSeconds` lists each token's lifetime in seconds, in the
--   order of `tokenRefs`, instead of one fixed 10 minutes. An audit attribute array holds strings
--   only (`uts.is_audit_event`), so each lifetime is its decimal string.
-- Their parameters stay the same. A new output column changes the return type, which
-- `CREATE OR REPLACE` cannot do, so those functions are dropped and created again inside this
-- migration's transaction, with their grant.

-- The lifetime of each access token one mint signs, in seconds as decimal strings, in the order of
-- `p_scopes`: 10 minutes, or the scope's shorter registered maximum. It mirrors
-- `accessTokenLifetimeSeconds` and `UTS_SCOPE_REGISTRY`; `test/db/mint-roles.test.ts` checks that
-- both agree for every registered scope.
CREATE FUNCTION uts.token_lifetimes(p_scopes text[]) RETURNS jsonb
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT to_jsonb(ARRAY(
    SELECT CASE item.scope
      WHEN 'user-data-export:exports.dispatch' THEN '300'
      WHEN 'user-data-export:exports.download' THEN '300'
      WHEN 'git-token-service:github-user-authorizations.disconnect' THEN '300'
      ELSE '600'
    END
    FROM unnest($1) WITH ORDINALITY AS item(scope, position)
    ORDER BY item.position
  ))
$$;

DROP FUNCTION uts.issue_authorization_code(
  text, bytea, text, uts.client_kind, text, uuid, text, text[], text[], uuid, text, bytea,
  timestamptz, text[], uuid
);

-- GET /authorize, after the hand-off approved: stores a 60-second code (PKCE S256, and the DPoP
-- key thumbprint for a first-party client) and its audit row. Outcomes: `issued`, with the
-- membership role in `p_org_id` (`org_role`, null without an organization); `access_denied` for an
-- inactive account or an unmet org requirement; `consent_required` for a third-party client
-- without an active consent that covers the scopes.
CREATE FUNCTION uts.issue_authorization_code(
  p_environment text,
  p_code_hash bytea,
  p_client_id text,
  p_client_kind uts.client_kind,
  p_account_id text,
  p_browser_session_id uuid,
  p_redirect_uri text,
  p_resources text[],
  p_scopes text[],
  p_org_id uuid,
  p_code_challenge text,
  p_dpop_jkt bytea,
  p_auth_time timestamptz,
  p_amr text[],
  p_consent_id uuid
) RETURNS TABLE (outcome text, org_role uts.org_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_state uts.account_status;
  membership_state uts.membership_status;
  member_role uts.org_role;
  enforcement uts.sso_enforcement;
BEGIN
  PERFORM uts.require_inputs('uts.issue_authorization_code',
    p_environment IS NOT NULL AND p_code_hash IS NOT NULL AND p_client_id IS NOT NULL
    AND p_client_kind IS NOT NULL AND p_account_id IS NOT NULL AND p_redirect_uri IS NOT NULL
    AND p_resources IS NOT NULL AND p_scopes IS NOT NULL AND p_code_challenge IS NOT NULL
    AND p_auth_time IS NOT NULL AND p_amr IS NOT NULL
    AND (p_client_kind = 'first_party') = (p_dpop_jkt IS NOT NULL)
    AND (p_client_kind = 'third_party') = (p_consent_id IS NOT NULL));
  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = p_account_id;
  IF p_org_id IS NOT NULL THEN
    SELECT membership.status, membership.role, policy.enforcement
    INTO membership_state, member_role, enforcement
    FROM uts.org_memberships AS membership
    LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
    WHERE membership.org_id = p_org_id AND membership.account_id = p_account_id;
  END IF;
  IF account_state IS DISTINCT FROM 'active'
    OR uts.org_requirement_met(p_org_id, membership_state, enforcement, p_amr::uts.auth_method[]) IS NOT TRUE
  THEN
    outcome := 'access_denied';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_client_kind = 'third_party' AND NOT EXISTS (
    SELECT 1 FROM uts.third_party_consents AS consent
    WHERE consent.id = p_consent_id
      AND consent.account_id = p_account_id
      AND consent.client_id = p_client_id
      AND consent.org_id IS NOT DISTINCT FROM p_org_id
      AND consent.status = 'active'
      AND consent.scopes @> p_scopes
  ) THEN
    outcome := 'consent_required';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.authorization_codes (
    code_hash, client_id, client_kind, account_id, browser_session_id, redirect_uri, resources,
    scopes, org_id, code_challenge, dpop_jkt, auth_time, amr, expires_at, consent_id
  ) VALUES (
    p_code_hash, p_client_id, p_client_kind, p_account_id, p_browser_session_id, p_redirect_uri,
    p_resources, p_scopes, p_org_id, p_code_challenge, p_dpop_jkt, p_auth_time,
    p_amr::uts.auth_method[], now() + interval '60 seconds', p_consent_id
  );
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.authorization_code.issued', 6003, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'clientId', uts.audit_client_id(p_client_id),
      'clientKind', p_client_kind,
      'codeRef', uts.credential_reference(p_code_hash),
      'scopes', to_jsonb(p_scopes),
      'audiences', to_jsonb(uts.scope_audiences(p_scopes)),
      'org', p_org_id
    )
  );
  outcome := 'issued';
  org_role := member_role;
  RETURN NEXT;
END
$$;

DROP FUNCTION uts.exchange_authorization_code(
  text, bytea, text, text, text, bytea, text, uuid, bytea, uts.client_class, text, text, inet,
  integer, text, text, text[], text[]
);

-- POST /token with `authorization_code`: as in 0004 (consumes the code and creates the grant in
-- one statement, with the same retry and reuse rules), plus the membership role (`org_role`) and
-- each token's lifetime in the audit row.
-- Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `invalid_target`, `dpop_replay`.
CREATE FUNCTION uts.exchange_authorization_code(
  p_environment text,
  p_code_hash bytea,
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_dpop_jkt bytea,
  p_dpop_jti text,
  p_grant_id uuid,
  p_refresh_token_hash bytea,
  p_client_class uts.client_class,
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
  refresh_expires_at timestamptz,
  org_role uts.org_role
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.authorization_codes%ROWTYPE;
  same_request boolean;
  retry boolean;
  chosen record;
  account_state uts.account_status;
  membership_state uts.membership_status;
  member_role uts.org_role;
  enforcement uts.sso_enforcement;
  revoked_account text;
  new_session_id uuid;
  idle_window interval;
  grant_state uts.grant_status;
  stored_hash bytea;
BEGIN
  PERFORM uts.require_inputs('uts.exchange_authorization_code',
    p_environment IS NOT NULL AND p_code_hash IS NOT NULL AND p_client_id IS NOT NULL
    AND p_redirect_uri IS NOT NULL AND p_code_challenge IS NOT NULL AND p_grant_id IS NOT NULL
    AND p_refresh_token_hash IS NOT NULL
    -- A first-party exchange names its DPoP key, proof and client class; a third-party one none.
    AND (p_dpop_jkt IS NULL) = (p_dpop_jti IS NULL)
    AND (p_dpop_jkt IS NULL) = (p_client_class IS NULL));
  SELECT * INTO code FROM uts.authorization_codes AS stored WHERE stored.code_hash = p_code_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  same_request := code.expires_at > now()
    AND code.client_id = p_client_id
    AND code.redirect_uri = p_redirect_uri
    AND code.code_challenge = p_code_challenge
    AND code.dpop_jkt IS NOT DISTINCT FROM p_dpop_jkt
    AND (code.client_kind = 'first_party') = (p_client_class IS NOT NULL);
  retry := code.status = 'consumed';

  IF retry AND (
    same_request AND code.grant_id = p_grant_id AND code.client_kind = 'first_party'
  ) IS NOT TRUE THEN
    revoked_account := uts.end_grant(code.client_kind, code.grant_id, 'reuse_detected');
    IF revoked_account IS NOT NULL THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.authorization_code.reused', 6003, 99, 'denied',
        'grant revoked', revoked_account,
        jsonb_build_object(
          'clientId', uts.audit_client_id(code.client_id),
          'codeRef', uts.credential_reference(p_code_hash),
          'grantId', code.grant_id
        )
      );
    END IF;
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF same_request IS NOT TRUE THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF code.client_kind = 'first_party' THEN
    INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
    VALUES (p_dpop_jkt, p_dpop_jti, now() + interval '121 seconds')
    ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
    IF NOT FOUND THEN
      outcome := 'dpop_replay';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO chosen FROM uts.select_token_scopes(code.scopes, p_scopes, p_resources);
  IF chosen.outcome <> 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = code.account_id;
  IF code.org_id IS NOT NULL THEN
    SELECT membership.status, membership.role, policy.enforcement
    INTO membership_state, member_role, enforcement
    FROM uts.org_memberships AS membership
    LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
    WHERE membership.org_id = code.org_id AND membership.account_id = code.account_id;
  END IF;
  IF account_state IS DISTINCT FROM 'active'
    OR uts.org_requirement_met(code.org_id, membership_state, enforcement, code.amr) IS NOT TRUE
    OR (code.client_kind = 'third_party' AND NOT EXISTS (
      SELECT 1 FROM uts.third_party_consents AS consent
      JOIN uts.third_party_clients AS client ON client.client_id = consent.client_id
      WHERE consent.id = code.consent_id AND consent.status = 'active' AND consent.scopes @> code.scopes
        AND client.status = 'active'
    ))
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT retry THEN
    UPDATE uts.authorization_codes AS stored
    SET status = 'consumed', consumed_at = now(), grant_id = p_grant_id
    WHERE stored.code_hash = p_code_hash;
  END IF;

  IF NOT retry AND code.client_kind = 'first_party' THEN
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
      p_refresh_token_hash, p_dpop_jkt, code.scopes, code.org_id, now() + idle_window,
      now() + CASE p_client_class WHEN 'desktop' THEN interval '180 days' ELSE interval '365 days' END
    );
    refresh_expires_at := now() + idle_window;
  ELSIF NOT retry THEN
    INSERT INTO uts.third_party_grant_families (
      id, account_id, client_id, consent_id, scopes, org_id, auth_time, amr, expires_at
    ) VALUES (
      p_grant_id, code.account_id, code.client_id, code.consent_id, code.scopes, code.org_id,
      code.auth_time, code.amr, now() + interval '90 days'
    );
    INSERT INTO uts.third_party_refresh_tokens (family_id, token_hash, idle_expires_at)
    VALUES (p_grant_id, p_refresh_token_hash, now() + interval '30 days');
    refresh_expires_at := now() + interval '30 days';
  ELSE
    SELECT grant_row.status, grant_row.token_hash,
      least(grant_row.idle_expires_at, grant_row.expires_at)
    INTO grant_state, stored_hash, refresh_expires_at
    FROM uts.refresh_grants AS grant_row WHERE grant_row.id = p_grant_id;
    IF grant_state IS DISTINCT FROM 'active' OR stored_hash IS DISTINCT FROM p_refresh_token_hash THEN
      outcome := 'invalid_grant';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  IF retry THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'authorization_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', code.client_kind,
        'grantId', p_grant_id,
        'rotation', 'code_retry',
        'codeRef', uts.credential_reference(p_code_hash),
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', uts.token_lifetimes(chosen.scopes),
        'org', code.org_id
      )
    );
  ELSE
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.grant.created', 3002, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'authorization_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', code.client_kind,
        'grantId', p_grant_id,
        'codeRef', uts.credential_reference(p_code_hash),
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', uts.token_lifetimes(chosen.scopes),
        'org', code.org_id
      )
    );
  END IF;
  outcome := 'issued';
  subject_id := code.account_id;
  bound_org_id := code.org_id;
  signed_in_at := code.auth_time;
  sign_in_methods := code.amr::text[];
  token_scopes := chosen.scopes;
  org_role := member_role;
  RETURN NEXT;
END
$$;

DROP FUNCTION uts.refresh_first_party(text, bytea, uuid, text, bytea, text, text[], text[]);
DROP FUNCTION uts.read_refresh_grant(bytea);

-- The mint and first-party refresh read of 0004, plus the membership role from the membership row
-- it already joins: one probe of `refresh_grants_token_hash_key`, then primary-key probes of the
-- device session, the account, the membership and the SSO policy.
CREATE FUNCTION uts.read_refresh_grant(p_token_hash bytea)
RETURNS TABLE (
  id uuid,
  account_id text,
  device_session_id uuid,
  client_id text,
  client_class uts.client_class,
  dpop_jkt bytea,
  allowed_scopes text[],
  org_id uuid,
  created_at timestamptz,
  last_used_at timestamptz,
  idle_expires_at timestamptz,
  expires_at timestamptz,
  grant_status uts.grant_status,
  session_status uts.session_status,
  auth_time timestamptz,
  amr uts.auth_method[],
  account_status uts.account_status,
  membership_status uts.membership_status,
  sso_enforcement uts.sso_enforcement,
  membership_role uts.org_role
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT grant_row.id, grant_row.account_id, grant_row.device_session_id, grant_row.client_id,
    grant_row.client_class, grant_row.dpop_jkt, grant_row.allowed_scopes, grant_row.org_id,
    grant_row.created_at, grant_row.last_used_at, grant_row.idle_expires_at, grant_row.expires_at,
    grant_row.status,
    session.status, session.auth_time, session.amr, account.status, membership.status,
    policy.enforcement, membership.role
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = grant_row.org_id AND membership.account_id = grant_row.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = grant_row.org_id
  WHERE grant_row.token_hash = $1
$$;

-- POST /token with `refresh_token` for a first-party client: as in 0004, plus the membership role
-- (`org_role`) and each token's lifetime in the audit row.
-- Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `invalid_target`, `dpop_mismatch`,
-- `dpop_replay`.
CREATE FUNCTION uts.refresh_first_party(
  p_environment text,
  p_token_hash bytea,
  p_grant_id uuid,
  p_client_id text,
  p_dpop_jkt bytea,
  p_dpop_jti text,
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
  org_role uts.org_role
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_row record;
  chosen record;
BEGIN
  PERFORM uts.require_inputs('uts.refresh_first_party',
    p_environment IS NOT NULL AND p_token_hash IS NOT NULL AND p_grant_id IS NOT NULL
    AND p_client_id IS NOT NULL AND p_dpop_jkt IS NOT NULL AND p_dpop_jti IS NOT NULL);
  SELECT * INTO grant_row FROM uts.read_refresh_grant(p_token_hash);
  IF NOT FOUND
    OR grant_row.id IS DISTINCT FROM p_grant_id
    OR grant_row.client_id IS DISTINCT FROM p_client_id
    OR grant_row.grant_status IS DISTINCT FROM 'active'
    OR grant_row.session_status IS DISTINCT FROM 'active'
    OR grant_row.account_status IS DISTINCT FROM 'active'
    OR grant_row.expires_at <= now()
    OR grant_row.idle_expires_at <= now()
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF grant_row.dpop_jkt IS DISTINCT FROM p_dpop_jkt THEN
    IF uts.claim_denied_audit('first_party', grant_row.id) THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.token.denied', 6003, 1, 'denied', 'dpop key mismatch',
        grant_row.account_id,
        jsonb_build_object(
          'grantType', 'refresh_token',
          'clientId', uts.audit_client_id(grant_row.client_id),
          'grantId', grant_row.id
        )
      );
    END IF;
    outcome := 'dpop_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
  VALUES (grant_row.dpop_jkt, p_dpop_jti, now() + interval '121 seconds')
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  IF NOT FOUND THEN
    outcome := 'dpop_replay';
    RETURN NEXT;
    RETURN;
  END IF;

  IF uts.org_requirement_met(
    grant_row.org_id, grant_row.membership_status, grant_row.sso_enforcement, grant_row.amr
  ) IS NOT TRUE THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO chosen FROM uts.select_token_scopes(grant_row.allowed_scopes, p_scopes, p_resources);
  IF chosen.outcome <> 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;

  -- At most once per grant per hour (fillfactor 90 keeps the update on its page).
  IF grant_row.last_used_at < now() - interval '1 hour' THEN
    UPDATE uts.refresh_grants AS stored
    SET last_used_at = now(),
      idle_expires_at = least(
        stored.expires_at,
        now() + CASE stored.client_class WHEN 'desktop' THEN interval '30 days' ELSE interval '60 days' END
      )
    WHERE stored.id = grant_row.id AND stored.last_used_at < now() - interval '1 hour';
    UPDATE uts.device_sessions AS session
    SET last_seen_at = now()
    WHERE session.id = grant_row.device_session_id;
  END IF;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, grant_row.account_id,
    jsonb_build_object(
      'grantType', 'refresh_token',
      'clientId', uts.audit_client_id(grant_row.client_id),
      'clientKind', 'first_party',
      'grantId', grant_row.id,
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(chosen.scopes),
      'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
      'tokenLifetimeSeconds', uts.token_lifetimes(chosen.scopes),
      'org', grant_row.org_id
    )
  );
  outcome := 'issued';
  subject_id := grant_row.account_id;
  bound_org_id := grant_row.org_id;
  signed_in_at := grant_row.auth_time;
  sign_in_methods := grant_row.amr::text[];
  token_scopes := chosen.scopes;
  org_role := grant_row.membership_role;
  RETURN NEXT;
END
$$;

-- POST /token with `refresh_token` for a third-party client: as in 0004, with each token's
-- lifetime in the audit row. The return type is unchanged.
-- Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `invalid_target`, `reuse_detected`.
CREATE OR REPLACE FUNCTION uts.refresh_third_party(
  p_environment text,
  p_token_hash bytea,
  p_client_id text,
  p_new_token_hash bytea,
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
  family_id uuid,
  refresh_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  presented record;
  replaced record;
  chosen record;
BEGIN
  PERFORM uts.require_inputs('uts.refresh_third_party',
    p_environment IS NOT NULL AND p_token_hash IS NOT NULL AND p_client_id IS NOT NULL
    AND p_new_token_hash IS NOT NULL);
  SELECT * INTO presented FROM uts.read_third_party_refresh_token(p_token_hash);
  IF NOT FOUND THEN
    SELECT * INTO replaced FROM uts.read_rotated_third_party_token(p_token_hash);
    IF FOUND
      AND replaced.client_id IS NOT DISTINCT FROM p_client_id
      AND replaced.family_status IS NOT DISTINCT FROM 'active'
      AND replaced.family_expires_at > now()
    THEN
      PERFORM uts.end_grant('third_party', replaced.family_id, 'reuse_detected');
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.refresh_token.reuse_detected', 6003, 99, 'denied',
        'family revoked', replaced.account_id,
        jsonb_build_object(
          'clientId', uts.audit_client_id(replaced.client_id),
          'grantId', replaced.family_id,
          'refreshRef', uts.credential_reference(p_token_hash)
        )
      );
      outcome := 'reuse_detected';
      RETURN NEXT;
      RETURN;
    END IF;
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF presented.client_id IS DISTINCT FROM p_client_id
    OR presented.family_status IS DISTINCT FROM 'active'
    OR presented.family_expires_at <= now()
    OR presented.token_idle_expires_at <= now()
    OR presented.client_status IS DISTINCT FROM 'active'
    OR presented.consent_status IS DISTINCT FROM 'active'
    OR presented.account_status IS DISTINCT FROM 'active'
    OR uts.org_requirement_met(
      presented.org_id, presented.membership_status, presented.sso_enforcement, presented.amr
    ) IS NOT TRUE
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO chosen FROM uts.select_token_scopes(presented.scopes, p_scopes, p_resources);
  IF chosen.outcome <> 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.third_party_rotated_tokens (token_key, family_id, family_expires_at)
  VALUES (uts.rotated_token_key(p_token_hash), presented.family_id, presented.family_expires_at);
  refresh_expires_at := least(now() + interval '30 days', presented.family_expires_at);
  UPDATE uts.third_party_refresh_tokens AS token
  SET token_hash = p_new_token_hash, issued_at = now(), idle_expires_at = refresh_expires_at
  WHERE token.family_id = presented.family_id;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, presented.account_id,
    jsonb_build_object(
      'grantType', 'refresh_token',
      'clientId', uts.audit_client_id(presented.client_id),
      'clientKind', 'third_party',
      'grantId', presented.family_id,
      'rotation', 'rotated',
      'previousRefreshRef', uts.credential_reference(p_token_hash),
      'refreshRef', uts.credential_reference(p_new_token_hash),
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(chosen.scopes),
      'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
      'tokenLifetimeSeconds', uts.token_lifetimes(chosen.scopes),
      'org', presented.org_id
    )
  );
  outcome := 'issued';
  subject_id := presented.account_id;
  bound_org_id := presented.org_id;
  signed_in_at := presented.auth_time;
  sign_in_methods := presented.amr::text[];
  token_scopes := chosen.scopes;
  family_id := presented.family_id;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.issue_authorization_code(
    text, bytea, text, uts.client_kind, text, uuid, text, text[], text[], uuid, text, bytea,
    timestamptz, text[], uuid
  ),
  uts.exchange_authorization_code(
    text, bytea, text, text, text, bytea, text, uuid, bytea, uts.client_class, text, text, inet,
    integer, text, text, text[], text[]
  ),
  uts.refresh_first_party(text, bytea, uuid, text, bytea, text, text[], text[])
TO uts_app;
