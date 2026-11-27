-- The web BFF `kilo-web` manages the caller's own PATs and org bot keys through the account API,
-- and mints organization-bound access tokens from its browser session (design sections 5.5, 5.8
-- and 5.11).
--
-- * The account API accepts a `kilo-web` access token for `uts:pats.manage` and
--   `uts:bot-keys.manage`. Such a token names its browser session in `sid` (migration 0013), not a
--   refresh grant, so `uts.account_session` now also finds a live browser session of the account
--   that holds a BFF handle. The mint statement takes the token's `sub` and `sid` from the same
--   session row, and every account statement matches the session to `p_account_id`, so no token
--   acts through another account's session.
-- * A create's tier B gate, and a keep's, runs on that browser session: its sign-in within 10
--   minutes, or a passkey step-up of the same session (`uts.tier_b_checks`); the consumed pass
--   names the browser session. A browser session without a UTS sign-in cookie (one the legacy
--   bridge created, `token_hash` NULL) never counts as a recent sign-in: its sign-in time is the
--   web app's claim, not a sign-in at UTS (design 5.3, 5.5). A refusal writes at most one denied
--   row per session per minute, as a refusal on a grant does per grant.
-- * `grantId` in the account audit rows stays the caller token's `sid`: a refresh grant id for
--   the CLI, a browser session id for `kilo-web`. The create and keep rows, and their refusals,
--   also name the client (`clientId`).
-- * `uts.open_tier_a_gate_pass` stays for a grant's device session only: a browser session opens
--   its tier A pass through `uts.open_browser_tier_a_gate_pass` (migration 0020).
-- * `uts.mint_web_session_token` takes an optional organization. With one, the same statement
--   reads the account's membership and the organization's SSO policy, and mints only for an
--   active member that meets the SSO rule and holds a role the scope allows
--   (`uts.org_requirement_met`, `uts.role_allows_scopes`, as `uts.issue_authorization_code`
--   does); otherwise `org_denied`, and nothing but the assertion's `jti` is written. A member that
--   `uts.remove_org_member` removed is refused on the next mint. A token minted before the removal
--   is not revoked by it (a browser session holds no organization to revoke): it ends at its
--   expiry, at most 10 minutes after the mint.
--
-- Every file before this one is applied somewhere, so the changed functions are replaced here.

SET LOCAL ROLE uts_owner;

-- The live session of `p_account_id` that the token's `sid` (`p_grant_id`) names: a first-party
-- grant and its device session as in 0005 (`browser_session_id` NULL), or a live browser session
-- that holds a BFF handle, within its idle and maximum lifetime and issued after any subject-wide
-- revocation, as `uts.live_web_session` reads it (`device_session_id` NULL). `client_id` is the
-- grant's client, or `kilo-web` for a browser session. For a browser session, `auth_time` and
-- `amr` are the handle's sign-in, the one its tokens carry. One probe of `refresh_grants_pkey` and
-- one of `browser_sessions_pkey`, then `accounts_pkey` (and `device_sessions_pkey` or
-- `revocations_kind_subject_key`).
DROP FUNCTION uts.account_session(text, uuid);
CREATE FUNCTION uts.account_session(p_account_id text, p_grant_id uuid)
RETURNS TABLE (
  device_session_id uuid,
  browser_session_id uuid,
  client_id text,
  auth_time timestamptz,
  amr uts.auth_method[]
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session.id, NULL::uuid, grant_row.client_id::text, session.auth_time, session.amr
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
  UNION ALL
  SELECT NULL::uuid, browser.id, 'kilo-web', browser.handle_auth_time, browser.handle_amr
  FROM uts.browser_sessions AS browser
  JOIN uts.accounts AS account ON account.id = browser.account_id
  WHERE browser.id = $2
    AND browser.account_id = $1
    AND browser.handle_hash IS NOT NULL
    AND browser.status = 'active'
    AND browser.idle_expires_at > now()
    AND browser.expires_at > now()
    AND account.status = 'active'
    AND NOT uts.subject_revoked_since(browser.account_id, browser.handle_issued_at)
$$;

-- `uts.tier_b_checks` of 0001, except that a browser session without a UTS sign-in cookie
-- (`token_hash` NULL: the legacy bridge created it with the web app's sign-in time) never meets
-- `recent_sign_in`; only a passkey step-up of that session could pass its gate.
CREATE OR REPLACE FUNCTION uts.tier_b_checks(
  p_account_id text,
  p_browser_session_id uuid,
  p_device_session_id uuid
) RETURNS uts.gate_check[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
RETURN (
  SELECT array_remove(ARRAY[
    CASE
      WHEN session.auth_time > now() - interval '10 minutes' AND session.auth_time <= now()
      THEN 'recent_sign_in'::uts.gate_check
    END,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM uts.step_ups AS step_up
        WHERE step_up.account_id = p_account_id
          AND step_up.completed_at > now() - interval '10 minutes'
          AND step_up.purpose = 'gate'
          AND step_up.browser_session_id IS NOT DISTINCT FROM p_browser_session_id
          AND step_up.device_session_id IS NOT DISTINCT FROM p_device_session_id
          AND step_up.expires_at > now()
      )
      THEN 'passkey'::uts.gate_check
    END
  ], NULL)
  FROM (
    SELECT CASE WHEN browser.token_hash IS NOT NULL THEN browser.auth_time END AS auth_time
    FROM uts.browser_sessions AS browser
    WHERE browser.id = p_browser_session_id
      AND browser.account_id = p_account_id
      AND browser.status = 'active'
      AND browser.idle_expires_at > now()
      AND browser.expires_at > now()
    UNION ALL
    SELECT device.auth_time FROM uts.device_sessions AS device
    WHERE device.id = p_device_session_id
      AND device.account_id = p_account_id
      AND device.status = 'active'
  ) AS session
  WHERE num_nonnulls(p_browser_session_id, p_device_session_id) = 1
);

-- A refused tier B gate of an account statement, with the caller's client: one denied audit row
-- per minute per grant (`grantId`), or per browser session for a `kilo-web` caller (`sessionId`).
CREATE FUNCTION uts.audit_account_gate_refusal(
  p_environment text,
  p_account_id text,
  p_grant_id uuid,
  p_browser_session_id uuid,
  p_client_id text,
  p_action uts.gated_action
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  claimed boolean;
  caller_ref jsonb;
BEGIN
  IF p_browser_session_id IS NULL THEN
    claimed := uts.claim_denied_audit('first_party', p_grant_id);
    caller_ref := jsonb_build_object('grantId', p_grant_id);
  ELSE
    claimed := uts.claim_session_denied_audit(p_browser_session_id);
    caller_ref := jsonb_build_object('sessionId', p_browser_session_id);
  END IF;
  IF claimed THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.gate.refused', 3001, 99, 'denied', 'fresh sign-in required',
      p_account_id,
      jsonb_build_object('action', p_action, 'tier', 'b', 'clientId', uts.audit_client_id(p_client_id))
        || caller_ref
    );
  END IF;
END
$$;

-- `uts.write_gated_pat` of 0019 for a browser session or a device session (exactly one; the other
-- is NULL): the tier B checks and the consumed pass name that session. Otherwise as in 0019.
DROP FUNCTION uts.write_gated_pat(text, uuid, text, bytea, text, text, uuid, integer);
CREATE FUNCTION uts.write_gated_pat(
  p_account_id text,
  p_browser_session_id uuid,
  p_device_session_id uuid,
  p_name text,
  p_token_hash bytea,
  p_last_four text,
  p_scope text,
  p_org_id uuid,
  p_lifetime_days integer
) RETURNS TABLE (
  outcome text,
  new_pat_id uuid,
  new_gate_pass_id uuid,
  gate_checks uts.gate_check[],
  pat_created_at timestamptz,
  pat_expires_at timestamptz
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_lifetime_days IS NULL OR p_lifetime_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'a PAT lives 1 to 365 days' USING ERRCODE = '22023';
  END IF;
  gate_checks := uts.tier_b_checks(p_account_id, p_browser_session_id, p_device_session_id);
  IF gate_checks IS NULL THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = p_account_id FOR NO KEY UPDATE;
  IF p_org_id IS NOT NULL THEN
    PERFORM 1 FROM uts.org_memberships AS membership
    WHERE membership.org_id = p_org_id
      AND membership.account_id = p_account_id
      AND membership.status = 'active'
    FOR SHARE;
    IF NOT FOUND THEN
      outcome := 'org_denied';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF cardinality(gate_checks) = 0 THEN
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  -- The account row is locked above, so concurrent creates of one account count one at a time.
  IF (
    SELECT count(*) FROM uts.personal_access_tokens AS pat
    WHERE pat.account_id = p_account_id AND pat.status = 'active' AND pat.expires_at > now()
  ) >= 100 THEN
    outcome := 'limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (
    SELECT count(*) FROM uts.personal_access_tokens AS pat
    WHERE pat.account_id = p_account_id AND pat.created_at > now() - interval '1 hour'
  ) >= 20 THEN
    outcome := 'rate_limited';
    RETURN NEXT;
    RETURN;
  END IF;

  WITH pass AS (
    INSERT INTO uts.gate_passes (
      account_id, browser_session_id, device_session_id, tier, action, satisfied_by, expires_at,
      status, consumed_at
    ) VALUES (
      p_account_id, p_browser_session_id, p_device_session_id, 'b', 'pat_create', gate_checks,
      now() + interval '10 minutes', 'consumed', now()
    )
    RETURNING id
  )
  INSERT INTO uts.personal_access_tokens (
    account_id, name, token_hash, last_four, audience, scope, org_id, gate_pass_id, expires_at
  )
  SELECT p_account_id, p_name, p_token_hash, p_last_four, split_part(p_scope, ':', 1), p_scope,
    p_org_id, pass.id, now() + make_interval(days => p_lifetime_days)
  FROM pass
  RETURNING id, gate_pass_id, created_at, expires_at
  INTO new_pat_id, new_gate_pass_id, pat_created_at, pat_expires_at;
  outcome := 'created';
  RETURN NEXT;
END
$$;

-- `uts.write_gated_bot_key` of 0019 for a browser session or a device session (exactly one; the
-- other is NULL), as `uts.write_gated_pat` above. Otherwise as in 0019.
DROP FUNCTION uts.write_gated_bot_key(text, uuid, uuid, text, bytea, text, text, integer);
CREATE FUNCTION uts.write_gated_bot_key(
  p_account_id text,
  p_browser_session_id uuid,
  p_device_session_id uuid,
  p_org_id uuid,
  p_name text,
  p_token_hash bytea,
  p_last_four text,
  p_scope text,
  p_lifetime_days integer
) RETURNS TABLE (
  outcome text,
  new_key_id uuid,
  new_gate_pass_id uuid,
  gate_checks uts.gate_check[],
  key_created_at timestamptz,
  key_expires_at timestamptz
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_lifetime_days IS NULL OR p_lifetime_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'an org bot key lives 1 to 365 days' USING ERRCODE = '22023';
  END IF;
  gate_checks := uts.tier_b_checks(p_account_id, p_browser_session_id, p_device_session_id);
  IF gate_checks IS NULL THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = p_account_id FOR KEY SHARE;
  PERFORM 1 FROM uts.org_memberships AS membership
  WHERE membership.org_id = p_org_id
    AND membership.account_id = p_account_id
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'admin')
  FOR SHARE;
  IF NOT FOUND THEN
    outcome := 'not_org_admin';
    RETURN NEXT;
    RETURN;
  END IF;
  IF cardinality(gate_checks) = 0 THEN
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('uts.org_bot_keys:' || p_org_id::text, 0));
  IF (
    SELECT count(*) FROM uts.org_bot_keys AS bot_key
    WHERE bot_key.org_id = p_org_id
      AND bot_key.expires_at > now()
      AND (bot_key.status IN ('active', 'kept')
        OR (bot_key.status = 'flagged' AND bot_key.flagged_at > now() - interval '168 hours'))
  ) >= 100 THEN
    outcome := 'limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (
    SELECT count(*) FROM uts.org_bot_keys AS bot_key
    WHERE bot_key.org_id = p_org_id AND bot_key.created_at > now() - interval '1 hour'
  ) >= 20 THEN
    outcome := 'rate_limited';
    RETURN NEXT;
    RETURN;
  END IF;

  WITH pass AS (
    INSERT INTO uts.gate_passes (
      account_id, browser_session_id, device_session_id, tier, action, satisfied_by, expires_at,
      status, consumed_at
    ) VALUES (
      p_account_id, p_browser_session_id, p_device_session_id, 'b', 'bot_key_create', gate_checks,
      now() + interval '10 minutes', 'consumed', now()
    )
    RETURNING id
  )
  INSERT INTO uts.org_bot_keys (
    org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at
  )
  SELECT p_org_id, p_account_id, p_name, p_token_hash, p_last_four, split_part(p_scope, ':', 1),
    p_scope, pass.id, now() + make_interval(days => p_lifetime_days)
  FROM pass
  RETURNING id, gate_pass_id, created_at, expires_at
  INTO new_key_id, new_gate_pass_id, key_created_at, key_expires_at;
  outcome := 'created';
  RETURN NEXT;
END
$$;

-- `uts.create_pat` of 0005, with the gate on the session `uts.account_session` found.
CREATE OR REPLACE FUNCTION uts.create_pat(
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
  written record;
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
  IF p_org_id IS NOT NULL AND NOT uts.org_role_met(p_org_id, p_account_id, holder.amr, NULL) THEN
    outcome := 'org_denied';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO written FROM uts.write_gated_pat(
    p_account_id, holder.browser_session_id, holder.device_session_id, p_name, p_token_hash,
    p_last_four, p_scope, p_org_id, p_lifetime_days
  );
  IF written.outcome = 'gate_required' THEN
    PERFORM uts.audit_account_gate_refusal(
      p_environment, p_account_id, p_grant_id, holder.browser_session_id, holder.client_id,
      'pat_create'
    );
  END IF;
  IF written.outcome <> 'created' THEN
    outcome := written.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  new_pat_id := written.new_pat_id;
  pat_created_at := written.pat_created_at;
  pat_expires_at := written.pat_expires_at;
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
      'clientId', uts.audit_client_id(holder.client_id),
      'gatePassId', written.new_gate_pass_id,
      'gateChecks', to_jsonb(written.gate_checks::text[])
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

-- `uts.create_bot_key` of 0005, with the gate on the session `uts.account_session` found.
CREATE OR REPLACE FUNCTION uts.create_bot_key(
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
  written record;
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
  SELECT * INTO written FROM uts.write_gated_bot_key(
    p_account_id, holder.browser_session_id, holder.device_session_id, p_org_id, p_name,
    p_token_hash, p_last_four, p_scope, p_lifetime_days
  );
  IF written.outcome = 'gate_required' THEN
    PERFORM uts.audit_account_gate_refusal(
      p_environment, p_account_id, p_grant_id, holder.browser_session_id, holder.client_id,
      'bot_key_create'
    );
  END IF;
  IF written.outcome <> 'created' THEN
    outcome := written.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  new_key_id := written.new_key_id;
  key_created_at := written.key_created_at;
  key_expires_at := written.key_expires_at;
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
      'clientId', uts.audit_client_id(holder.client_id),
      'gatePassId', written.new_gate_pass_id,
      'gateChecks', to_jsonb(written.gate_checks::text[])
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

-- `uts.keep_bot_key` of 0005, with the gate on the session `uts.account_session` found.
CREATE OR REPLACE FUNCTION uts.keep_bot_key(
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
  checks := uts.tier_b_checks(p_account_id, holder.browser_session_id, holder.device_session_id);
  IF coalesce(cardinality(checks), 0) = 0 THEN
    PERFORM uts.audit_account_gate_refusal(
      p_environment, p_account_id, p_grant_id, holder.browser_session_id, holder.client_id,
      'bot_key_keep'
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
  ELSIF found_key.flagged_at <= now() - interval '168 hours' OR found_key.expires_at <= now() THEN
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
        'clientId', uts.audit_client_id(holder.client_id),
        'gateChecks', to_jsonb(checks::text[])
      )
    );
    outcome := 'kept';
  END IF;
  RETURN NEXT;
END
$$;

-- `uts.open_tier_a_gate_pass` of 0005 for a grant's device session only: now that
-- `uts.account_session` also finds a `kilo-web` browser session, that session answers
-- `invalid_session` here (it opens its pass through `uts.open_browser_tier_a_gate_pass`, migration
-- 0020). Otherwise as in 0005.
CREATE OR REPLACE FUNCTION uts.open_tier_a_gate_pass(
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
  IF NOT FOUND OR holder.device_session_id IS NULL THEN
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

-- POST /account/browser-sessions/token (0013) with an optional organization `p_org_id`. With one,
-- this statement reads the account's membership and the organization's SSO policy and refuses
-- (`org_denied`) unless the membership is active, the handle's sign-in meets the SSO rule, and the
-- member's role may hold the scope; the token then carries the organization (`bound_org_id`) and
-- the role. Without one, a scope limited to listed roles is `org_denied` too. A refusal writes
-- nothing but the assertion's `jti`. Outcomes: `issued`, `invalid_session`, `org_denied`,
-- `step_up_required`, `assertion_replay`. `p_org_id` defaults to NULL, so the 7-argument call of
-- a Worker deployed before this migration still resolves here (to a token with no organization)
-- until the new Worker ships.
DROP FUNCTION uts.mint_web_session_token(text, bytea, bytea, text, timestamptz, text, boolean);
CREATE FUNCTION uts.mint_web_session_token(
  p_environment text,
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz,
  p_scope text,
  p_step_up boolean,
  p_org_id uuid DEFAULT NULL
) RETURNS TABLE (
  outcome text,
  subject_id text,
  web_session_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  token_ids uuid[],
  token_scopes text[],
  bound_org_id uuid,
  org_role uts.org_role
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live uts.browser_sessions%ROWTYPE;
  scope uts.scope := p_scope;
  membership_state uts.membership_status;
  member_role uts.org_role;
  enforcement uts.sso_enforcement;
BEGIN
  PERFORM uts.require_inputs('uts.mint_web_session_token',
    p_environment IS NOT NULL AND p_handle_hash IS NOT NULL AND p_assertion_jkt IS NOT NULL
    AND p_assertion_jti IS NOT NULL AND p_assertion_expires_at IS NOT NULL AND p_scope IS NOT NULL
    AND p_step_up IS NOT NULL);
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO live FROM uts.live_web_session(p_handle_hash);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_org_id IS NOT NULL THEN
    SELECT membership.status, membership.role, policy.enforcement
    INTO membership_state, member_role, enforcement
    FROM uts.org_memberships AS membership
    LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
    WHERE membership.org_id = p_org_id AND membership.account_id = live.account_id;
  END IF;
  IF uts.org_requirement_met(p_org_id, membership_state, enforcement, live.handle_amr) IS NOT TRUE
    OR NOT uts.role_allows_scopes(ARRAY[scope::text], member_role)
  THEN
    outcome := 'org_denied';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_step_up AND NOT (
    'passkey' = ANY (live.handle_amr) AND live.handle_auth_time > now() - interval '10 minutes'
  ) THEN
    outcome := 'step_up_required';
    RETURN NEXT;
    RETURN;
  END IF;
  IF live.last_seen_at < now() - interval '5 minutes' THEN
    UPDATE uts.browser_sessions AS session
    SET last_seen_at = now(), idle_expires_at = least(session.expires_at, now() + interval '14 days')
    WHERE session.id = live.id AND session.last_seen_at < now() - interval '5 minutes';
  END IF;
  token_ids := ARRAY[gen_random_uuid()];
  token_scopes := ARRAY[scope::text];
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, live.account_id,
    jsonb_build_object(
      'grantType', 'browser_session',
      'clientId', 'kilo-web',
      'clientKind', 'confidential_web',
      'sessionId', live.id,
      'handleRef', uts.credential_reference(p_handle_hash),
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(token_scopes),
      'audiences', to_jsonb(uts.scope_audiences(token_scopes)),
      'tokenLifetimeSeconds', uts.token_lifetimes(token_scopes),
      'org', p_org_id
    )
  );
  outcome := 'issued';
  subject_id := live.account_id;
  web_session_id := live.id;
  signed_in_at := live.handle_auth_time;
  sign_in_methods := live.handle_amr::text[];
  bound_org_id := p_org_id;
  org_role := member_role;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.mint_web_session_token(text, bytea, bytea, text, timestamptz, text, boolean, uuid)
TO uts_app;
