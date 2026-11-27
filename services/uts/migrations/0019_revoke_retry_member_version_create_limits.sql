-- Fixes from the review of the PAT, bot key, membership and revocation statements (design sections
-- 5.2, 5.3, 5.6, 5.8 and 5.11). Every file before this one is applied somewhere, so the changed
-- functions are replaced here rather than edited in place.
--
-- * A revoke that finds its credential already revoked returns the credential's feed entry while
--   the entry lives (`uts.live_feed_entries`, `uts.live_feed_entries_of_refresh_token`). A client
--   retries a revoke that answered 503 because no feed object confirmed the entry; the retry now
--   publishes that entry again instead of answering success with nothing published.
-- * A membership removal that finds the row already removed still records the newer event
--   version, so an older added event that arrives later cannot bring the member back.
-- * An account creates at most 20 PATs, and an organization at most 20 bot keys, in any hour
--   (`rate_limited`). Each revoked PAT or bot key holds a feed entry for 15 minutes, so a
--   create-and-revoke loop could otherwise fill the revocation feed towards its entry cap, past
--   which no feed object signs a head. Each count is one range probe of a new
--   `(owner, created_at)` index, behind the same lock as the live-credential cap.
-- * A tier A code check treats a missing code as a wrong one. Before, a NULL code compared with
--   `<>` gave NULL, so the wrong-code branch was skipped and the pending code counted as matched.
-- * The app login loses direct INSERT, UPDATE and DELETE on the accounts, memberships and SSO
--   tables. Only SECURITY DEFINER functions write them, so none of them changes without the
--   function's checks and audit row.

SET LOCAL ROLE uts_owner;

-- The feed entry a revoking statement wrote for one credential, while it still lives, as a JSON
-- array in the shape of `uts.feed_entries_of_statement()`: empty once the entry expired, because
-- every cache that could still hold the credential has expired by then. VOLATILE, so a revoke that
-- waited for a concurrent revoke of the same credential reads the row that one committed. One
-- probe of `revocations_kind_subject_key`.
CREATE FUNCTION uts.live_feed_entries(p_kind uts.revocation_kind, p_subject_id text)
RETURNS jsonb
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', entry.kind,
        'id', entry.subject_id,
        'revoked_before', floor(extract(epoch FROM entry.revoked_before) * 1000),
        'revoked_at', floor(extract(epoch FROM entry.revoked_at) * 1000),
        'expires_at', floor(extract(epoch FROM entry.feed_expires_at) * 1000)
      )
    ),
    '[]'::jsonb
  )
  FROM uts.revocations AS entry
  WHERE entry.kind = p_kind AND entry.subject_id = p_subject_id AND entry.feed_expires_at > now()
$$;

-- The live feed entry of the grant a refresh token belongs to, for `/revoke` when the token was
-- revoked already: the first-party grant, or the third-party family of a current or replaced
-- token. Only for the client the token was issued to; any other client gets an empty array, as
-- `uts.revoke_refresh_token` changes nothing for it. SECURITY DEFINER, as that function is: it
-- reads the rotated-token tombstones through `uts.rotated_token_key`. One probe of the token's
-- unique index, then one of `revocations_kind_subject_key`.
CREATE FUNCTION uts.live_feed_entries_of_refresh_token(p_token_hash bytea, p_client_id text)
RETURNS jsonb
LANGUAGE sql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT uts.live_feed_entries(grant_ref.kind, grant_ref.id::text)
      FROM (
        SELECT 'grant'::uts.revocation_kind AS kind, grant_row.id, grant_row.client_id
        FROM uts.refresh_grants AS grant_row
        WHERE grant_row.token_hash = p_token_hash
        UNION ALL
        SELECT 'third_party_family', family.id, family.client_id
        FROM uts.third_party_refresh_tokens AS token
        JOIN uts.third_party_grant_families AS family ON family.id = token.family_id
        WHERE token.token_hash = p_token_hash
        UNION ALL
        SELECT 'third_party_family', family.id, family.client_id
        FROM uts.third_party_rotated_tokens AS rotated
        JOIN uts.third_party_grant_families AS family ON family.id = rotated.family_id
        WHERE rotated.token_key = uts.rotated_token_key(p_token_hash)
        LIMIT 1
      ) AS grant_ref
      WHERE grant_ref.client_id = p_client_id
    ),
    '[]'::jsonb
  )
$$;

GRANT EXECUTE ON FUNCTION
  uts.live_feed_entries(uts.revocation_kind, text),
  uts.live_feed_entries_of_refresh_token(bytea, text)
TO uts_app;

-- The creates' hourly counts (`uts.write_gated_pat`, `uts.write_gated_bot_key`). Each new index
-- leads with the column of the index it replaces, so it serves that index's lookups too.
CREATE INDEX personal_access_tokens_account_created_idx
  ON uts.personal_access_tokens (account_id, created_at);
DROP INDEX uts.personal_access_tokens_account_idx;
CREATE INDEX org_bot_keys_org_created_idx ON uts.org_bot_keys (org_id, created_at);
DROP INDEX uts.org_bot_keys_org_idx;

-- `uts.write_gated_pat` of 0001 with one more outcome after `limit_reached`:
-- * `rate_limited`: the account created 20 PATs in the last hour (revoked and expired ones count).
--   It is read behind the account row lock, so concurrent creates of one account count one at a
--   time.
CREATE OR REPLACE FUNCTION uts.write_gated_pat(
  p_account_id text,
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
  gate_checks := uts.tier_b_checks(p_account_id, NULL, p_device_session_id);
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
      account_id, device_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
    ) VALUES (
      p_account_id, p_device_session_id, 'b', 'pat_create', gate_checks,
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

-- `uts.write_gated_bot_key` of 0001 with one more outcome after `limit_reached`:
-- * `rate_limited`: the organization got 20 bot keys in the last hour (revoked and expired ones
--   count). It is read behind the organization's advisory lock, so concurrent creates in one
--   organization count one at a time.
CREATE OR REPLACE FUNCTION uts.write_gated_bot_key(
  p_account_id text,
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
  gate_checks := uts.tier_b_checks(p_account_id, NULL, p_device_session_id);
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
      account_id, device_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
    ) VALUES (
      p_account_id, p_device_session_id, 'b', 'bot_key_create', gate_checks,
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

-- `uts.remove_org_member` of 0005, except that a removal of a row that is already removed records
-- the newer event version (outcome `unchanged`, as before). Before, the version stayed at the
-- older removal's, so an added event older than this removal but newer than that one could
-- reactivate the member.
CREATE OR REPLACE FUNCTION uts.remove_org_member(
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
  stops_at timestamptz := now() + interval '168 hours';
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
    -- An already removed row still takes the newer version, so an older added event that arrives
    -- after this removal cannot bring the member back.
    UPDATE uts.org_memberships AS membership
    SET event_version = p_event_version, updated_at = now()
    WHERE membership.org_id = p_org_id
      AND membership.account_id = p_account_id
      AND membership.status = 'removed'
      AND membership.event_version < p_event_version;
    IF FOUND THEN
      outcome := 'unchanged';
      RETURN NEXT;
      RETURN;
    END IF;
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

-- `uts.use_tier_a_code` of 0005, with a NULL-safe comparison: a missing code is a wrong code, which
-- counts an attempt, and never a match.
CREATE OR REPLACE FUNCTION uts.use_tier_a_code(
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
  IF code.code_hash IS DISTINCT FROM p_code_hash THEN
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

-- Only the SECURITY DEFINER functions of these migrations write these tables; no Worker statement
-- does.
REVOKE INSERT, UPDATE, DELETE ON
  uts.accounts,
  uts.sso_connections,
  uts.sso_domains,
  uts.org_sso_policies,
  uts.org_memberships
FROM uts_app;
