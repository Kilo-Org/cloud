-- Subject revocation reach, authority sync order and third-party client writes (design sections
-- 5.2, 5.6, 5.8 and 5.9).
--
-- * `uts.revoke_everything_of` also stops what is not a grant yet: an approved device code becomes
--   denied, an authorization code that was not exchanged is deleted (a web code included), and
--   every active third-party consent is revoked, so the next GET /authorize shows the consent
--   screen again. An exchange of either code therefore never creates a grant after
--   `revoked_before`.
-- * `uts.apply_subject_operation`: a `revoke` with `access_block`, `account_recovery` or
--   `account_reset` flags the active org bot keys the subject created, as member removal and
--   account deletion do. A key belongs to its organization, so it is not revoked: it stops 7 days
--   later unless an org admin keeps it, and each owner and admin gets a notice (design 5.8).
-- * `uts.sync_primary_email` deletes the subject's `email` sign-in methods of every other address,
--   so the old mailbox no longer signs in to the account. An address that another account still
--   holds, as its primary email or as an `email` method, answers `retry_later` with `email_taken`
--   and writes nothing: a mailbox move that arrives before the move that frees the address is
--   retried.
-- * `uts.sync_org_membership` raises `event_version` on a newer sync that changes nothing, so an
--   older event that arrives later stays superseded.
-- * Third-party client documents are written only through `uts.save_third_party_client` and
--   `uts.extend_third_party_client`; the app login loses its direct DML on
--   `uts.third_party_clients` and on `uts.third_party_consents`. The minute cron deletes an active
--   client without consents one day after its cache time ended
--   (`uts.maintain_third_party_client_rows`).

SET LOCAL ROLE uts_owner;

-- The reach of a subject revocation and of the client pruning, as index probes.
CREATE INDEX device_codes_approved_account_idx ON uts.device_codes (account_id)
  WHERE status = 'approved';
CREATE INDEX authorization_codes_issued_account_idx ON uts.authorization_codes (account_id)
  WHERE status = 'issued';
CREATE INDEX third_party_consents_client_idx ON uts.third_party_consents (client_id);
CREATE INDEX third_party_clients_stale_idx ON uts.third_party_clients (cache_expires_at)
  WHERE status = 'active';

-- Revokes everything the subject holds: `revoked_before` (kept `p_keep` in the feed), browser
-- sessions, device grants, third-party families, PATs, CI trust policies and sandbox grants; and
-- what is not a grant yet: approved device codes, authorization codes not yet exchanged and
-- third-party consents. Tokens of every kind name the subject in `sub`, so `revoked_before`
-- refuses each one issued before now; the per-grant and per-session entries also refuse a token a
-- mint signed while this statement ran. Returns the counts for the audit row.
CREATE OR REPLACE FUNCTION uts.revoke_everything_of(
  p_subject text,
  p_reason uts.revoke_reason,
  p_keep interval
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  browser integer;
  device integer;
  families integer := 0;
  pats integer;
  policies integer;
  sandboxes integer;
  denied_device_codes integer;
  codes integer;
  consents integer;
  item record;
BEGIN
  INSERT INTO uts.revocations (kind, subject_id, revoked_before, feed_expires_at)
  VALUES ('subject', p_subject, now(), now() + p_keep)
  ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO UPDATE
  SET revoked_before = greatest(uts.revocations.revoked_before, EXCLUDED.revoked_before),
    feed_expires_at = greatest(uts.revocations.feed_expires_at, EXCLUDED.feed_expires_at);
  UPDATE uts.accounts AS account SET revoked_before = now(), updated_at = now()
  WHERE account.id = p_subject;
  browser := uts.end_browser_sessions_of(p_subject, p_reason);
  device := uts.end_device_grants_of(p_subject, p_reason);
  FOR item IN
    SELECT family.id FROM uts.third_party_grant_families AS family
    WHERE family.account_id = p_subject AND family.status = 'active'
  LOOP
    IF uts.end_grant('third_party', item.id, p_reason) IS NOT NULL THEN
      families := families + 1;
    END IF;
  END LOOP;
  pats := uts.revoke_pats_of(p_subject, p_reason);
  UPDATE uts.ci_trust_policies AS policy
  SET status = 'revoked', revoked_at = now(), updated_at = now()
  WHERE policy.account_id = p_subject AND policy.status = 'active';
  GET DIAGNOSTICS policies = ROW_COUNT;
  UPDATE uts.sandbox_grants AS sandbox SET status = 'ended', ended_at = now()
  WHERE sandbox.account_id = p_subject AND sandbox.status = 'active';
  GET DIAGNOSTICS sandboxes = ROW_COUNT;
  -- The device polls `access_denied` (RFC 8628 section 3.5) and starts again.
  UPDATE uts.device_codes AS code
  SET status = 'denied', denied_at = now(), approved_at = NULL, gate_pass_id = NULL,
    auth_time = NULL, amr = NULL
  WHERE code.account_id = p_subject AND code.status = 'approved';
  GET DIAGNOSTICS denied_device_codes = ROW_COUNT;
  -- An exchange then finds no code (`invalid_grant`); a consumed code stays for reuse detection.
  DELETE FROM uts.authorization_codes AS code
  WHERE code.account_id = p_subject AND code.status = 'issued';
  GET DIAGNOSTICS codes = ROW_COUNT;
  UPDATE uts.third_party_consents AS consent SET status = 'revoked', revoked_at = now()
  WHERE consent.account_id = p_subject AND consent.status = 'active';
  GET DIAGNOSTICS consents = ROW_COUNT;
  RETURN jsonb_build_object(
    'browserSessions', browser,
    'deviceGrants', device,
    'thirdPartyFamilies', families,
    'pats', pats,
    'ciTrustPolicies', policies,
    'sandboxGrants', sandboxes,
    'deviceCodes', denied_device_codes,
    'authorizationCodes', codes,
    'consents', consents
  );
END
$$;

-- Flags the active org bot keys `p_subject` created, in every organization, as member removal does
-- for one (`uts.remove_org_member`, migration 0005): each flagged key writes its audit row, and each
-- active owner and admin of an organization with a flagged key, the subject aside, gets one notice.
-- Returns how many keys it flagged.
CREATE FUNCTION uts.flag_bot_keys_of(p_environment text, p_subject text, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item record;
  flagged integer := 0;
  per_org jsonb := '{}'::jsonb;
  stops_at text := to_char((now() + interval '168 hours') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  FOR item IN
    UPDATE uts.org_bot_keys AS bot_key
    SET status = 'flagged', flagged_at = now()
    WHERE bot_key.created_by = p_subject AND bot_key.status = 'active'
    RETURNING bot_key.id, bot_key.org_id, bot_key.token_hash
  LOOP
    PERFORM uts.write_system_audit_event(
      p_environment, 'ai.kilo.uts.bot_key.flagged', 6003, 3, p_subject,
      jsonb_build_object(
        'botKeyId', item.id,
        'botKeyRef', uts.credential_reference(item.token_hash),
        'org', item.org_id,
        'reason', p_reason,
        'stopsAt', stops_at
      )
    );
    per_org := jsonb_set(per_org, ARRAY[item.org_id::text],
      to_jsonb(coalesce((per_org ->> item.org_id::text)::integer, 0) + 1));
    flagged := flagged + 1;
  END LOOP;
  INSERT INTO uts.notices (account_id, kind, details)
  SELECT admin.account_id, 'bot_key_flagged', jsonb_build_object(
    'org', admin.org_id,
    'flaggedKeys', (keys.value)::integer,
    'stopsAt', stops_at
  )
  FROM jsonb_each_text(per_org) AS keys
  JOIN uts.org_memberships AS admin
    ON admin.org_id = keys.key::uuid AND admin.status = 'active' AND admin.role IN ('owner', 'admin')
  WHERE admin.account_id <> p_subject;
  RETURN flagged;
END
$$;

-- POST /internal/subjects/<op> and the `SubjectRevocation` entrypoint: one operation in one
-- statement with its audit row. Outcomes:
-- * `applied`, `already_applied` (the same `operation_id`; an effect that already holds; a block
--   or unblock older than the newest source version applied), `no_subject` (a tombstone);
-- * `retry_later` with `unblock_too_soon` while the block is under 60 seconds old, with the
--   seconds left (1 to 60);
-- * `refused` with `account_deleted` for an unblock of a deleted subject.
-- `feed_entries` are the entries this statement wrote, or for a repeat the entries the first run
-- wrote, which the caller hands to the feed objects before it answers 200. A revocation other than
-- a deletion also flags the subject's active org bot keys; a deletion flags them as it deletes the
-- account (`uts.delete_account`).
CREATE OR REPLACE FUNCTION uts.apply_subject_operation(
  p_environment text,
  p_operation_id uuid,
  p_operation uts.subject_operation,
  p_subject text,
  p_reason text,
  p_actor text,
  p_workload text,
  p_source_version bigint
) RETURNS TABLE (outcome text, error text, retry_after_seconds integer, feed_entries jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  repeated jsonb;
  holder record;
  absent record;
  counts jsonb := '{}'::jsonb;
  changed boolean := true;
  ended integer;
  event_type text;
  event_class integer;
  event_activity integer;
BEGIN
  PERFORM uts.require_inputs(
    'uts.apply_subject_operation',
    num_nulls(p_environment, p_operation_id, p_operation, p_subject, p_reason, p_actor,
      p_workload, p_source_version) = 0
  );
  IF p_operation NOT IN ('revoke', 'unblock', 'end_browser_sessions', 'end_device_sessions',
      'revoke_api_credentials')
    OR NOT uts.subject_reason_allowed(p_operation, p_reason)
  THEN
    RAISE EXCEPTION '% does not take the reason %', p_operation, p_reason USING ERRCODE = '22023';
  END IF;
  PERFORM uts.lock_subject(p_subject);
  repeated := uts.repeated_operation(p_operation_id, p_operation, p_subject);
  IF repeated IS NOT NULL THEN
    outcome := 'already_applied';
    feed_entries := repeated;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT account.status, account.blocked_at, account.status_version INTO holder
  FROM uts.accounts AS account WHERE account.id = p_subject FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO absent FROM uts.operation_without_account(
      p_environment, p_operation_id, p_operation, p_subject, p_reason, p_actor, p_workload,
      p_source_version
    );
    outcome := absent.outcome;
    error := absent.error;
    feed_entries := '[]'::jsonb;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_operation = 'unblock' THEN
    IF p_source_version < holder.status_version OR holder.status <> 'blocked' THEN
      changed := false;
    ELSIF holder.blocked_at > now() - interval '60 seconds' THEN
      outcome := 'retry_later';
      error := 'unblock_too_soon';
      retry_after_seconds := least(60, greatest(1,
        ceil(60 - extract(epoch FROM now() - holder.blocked_at))::integer));
      feed_entries := '[]'::jsonb;
      RETURN NEXT;
      RETURN;
    ELSE
      UPDATE uts.accounts AS account
      SET status = 'active', blocked_at = NULL, status_version = p_source_version, updated_at = now()
      WHERE account.id = p_subject;
      INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
      VALUES ('unblocked_account', p_subject, now() + interval '20 minutes')
      ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO UPDATE
      SET feed_expires_at = EXCLUDED.feed_expires_at;
      -- The block entry moves to this statement's time, so the unblock entry, which outlives it,
      -- covers it in every feed object, a restarted one included.
      UPDATE uts.revocations AS entry SET feed_expires_at = now() + interval '10 minutes'
      WHERE entry.kind = 'blocked_account' AND entry.subject_id = p_subject
        AND entry.feed_expires_at > now();
    END IF;
    event_type := 'ai.kilo.uts.subject.unblocked';
    event_class := 3001;
    event_activity := 99;
  ELSIF p_operation = 'revoke' THEN
    IF p_reason = 'access_block'
      AND (p_source_version < holder.status_version OR holder.status = 'blocked')
    THEN
      changed := false;
    ELSIF p_reason = 'account_deleted' THEN
      counts := uts.revoke_everything_of(p_subject, 'account_deleted', interval '24 hours');
      PERFORM uts.block_in_feed(p_subject, interval '24 hours');
    ELSE
      counts := uts.revoke_everything_of(
        p_subject,
        CASE p_reason WHEN 'access_block' THEN 'account_blocked' ELSE p_reason END::uts.revoke_reason,
        interval '70 minutes'
      ) || jsonb_build_object(
        'flaggedBotKeys', uts.flag_bot_keys_of(p_environment, p_subject, p_reason)
      );
      IF p_reason = 'access_block' THEN
        UPDATE uts.accounts AS account SET status = 'blocked', blocked_at = now(), updated_at = now()
        WHERE account.id = p_subject;
        PERFORM uts.block_in_feed(p_subject, interval '70 minutes');
      END IF;
    END IF;
    event_type := 'ai.kilo.uts.subject.revoked';
    event_class := 3001;
    event_activity := 99;
  ELSIF p_operation = 'end_browser_sessions' THEN
    ended := uts.end_browser_sessions_of(p_subject, p_reason::uts.revoke_reason);
    counts := jsonb_build_object('browserSessions', ended);
    changed := ended > 0;
    event_type := 'ai.kilo.uts.browser_sessions.ended';
    event_class := 3002;
    event_activity := 2;
  ELSIF p_operation = 'end_device_sessions' THEN
    ended := uts.end_device_grants_of(p_subject, p_reason::uts.revoke_reason);
    counts := jsonb_build_object('deviceGrants', ended);
    changed := ended > 0;
    event_type := 'ai.kilo.uts.device_sessions.ended';
    event_class := 3002;
    event_activity := 2;
  ELSE
    ended := uts.revoke_pats_of(p_subject, p_reason::uts.revoke_reason);
    counts := jsonb_build_object('pats', ended);
    changed := ended > 0;
    event_type := 'ai.kilo.uts.api_credentials.revoked';
    event_class := 6003;
    event_activity := 4;
  END IF;

  IF p_reason IN ('access_block', 'access_unblock') THEN
    UPDATE uts.accounts AS account SET status_version = p_source_version
    WHERE account.id = p_subject AND account.status_version < p_source_version;
  END IF;
  feed_entries := uts.feed_entries_of_statement();
  IF p_reason = 'account_deleted' THEN
    counts := counts || jsonb_build_object(
      'flaggedBotKeys', uts.delete_account(p_environment, p_subject, p_operation_id, p_source_version)
    );
  END IF;
  IF changed THEN
    PERFORM uts.write_workload_audit_event(
      p_environment, event_type, event_class, event_activity, p_subject, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'reason', p_reason,
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
      ) || counts
    );
  END IF;
  PERFORM uts.record_operation(p_operation_id, p_operation, p_subject, p_source_version, feed_entries);
  outcome := CASE WHEN changed THEN 'applied' ELSE 'already_applied' END;
  RETURN NEXT;
END
$$;

-- POST /internal/authority/email: the subject's primary email. Outcomes: `applied`;
-- `already_applied` (a repeat, the same address, or a version older than one applied);
-- `no_subject` (a tombstone, so an older import is stale); `retry_later` with `email_taken` while
-- another account holds the address as its primary email or as an `email` sign-in method, which
-- writes nothing. An applied change deletes the subject's `email` methods of other addresses. The
-- audit row names no address (design 8.2).
CREATE OR REPLACE FUNCTION uts.sync_primary_email(
  p_environment text,
  p_operation_id uuid,
  p_subject text,
  p_primary_email text,
  p_actor text,
  p_workload text,
  p_source_version bigint
) RETURNS TABLE (outcome text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  absent record;
  removed_methods integer;
BEGIN
  PERFORM uts.require_inputs(
    'uts.sync_primary_email',
    num_nulls(p_environment, p_operation_id, p_subject, p_primary_email, p_actor, p_workload,
      p_source_version) = 0
  );
  PERFORM uts.lock_subject(p_subject);
  IF uts.repeated_operation(p_operation_id, 'email_sync', p_subject) IS NOT NULL THEN
    outcome := 'already_applied';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.primary_email, account.email_version INTO holder
  FROM uts.accounts AS account WHERE account.id = p_subject FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO absent FROM uts.operation_without_account(
      p_environment, p_operation_id, 'email_sync', p_subject, NULL, p_actor, p_workload,
      p_source_version
    );
    outcome := absent.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_source_version < holder.email_version OR holder.primary_email = p_primary_email THEN
    outcome := 'already_applied';
  ELSE
    -- The lock an email sign-up takes on the address (`uts.settle_new_method`, migration 0009).
    PERFORM pg_advisory_xact_lock(hashtextextended('uts.primary_email:' || p_primary_email, 0));
    IF EXISTS (
      SELECT 1 FROM uts.accounts AS account
      WHERE account.primary_email = p_primary_email AND account.id <> p_subject
    ) OR EXISTS (
      SELECT 1 FROM uts.sign_in_methods AS method
      WHERE method.provider = 'email' AND method.provider_subject = p_primary_email
        AND method.account_id <> p_subject
    ) THEN
      outcome := 'retry_later';
      error := 'email_taken';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE uts.accounts AS account
    SET primary_email = p_primary_email, email_version = p_source_version, updated_at = now()
    WHERE account.id = p_subject;
    DELETE FROM uts.sign_in_methods AS method
    WHERE method.account_id = p_subject AND method.provider = 'email'
      AND method.provider_subject <> p_primary_email;
    GET DIAGNOSTICS removed_methods = ROW_COUNT;
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.primary_email.synced', 3001, 99, p_subject, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'requestedBy', p_actor,
        'sourceVersion', p_source_version,
        'removedEmailMethods', removed_methods
      )
    );
    outcome := 'applied';
  END IF;
  UPDATE uts.accounts AS account SET email_version = p_source_version
  WHERE account.id = p_subject AND account.email_version < p_source_version;
  PERFORM uts.record_operation(p_operation_id, 'email_sync', p_subject, p_source_version, '[]');
  RETURN NEXT;
END
$$;

-- POST /internal/authority/membership: a membership added or changed (`p_role`) or removed
-- (`p_role` NULL, through `uts.remove_org_member`, which revokes the member's org-bound
-- credentials with their feed entries). The subject's source version orders its membership
-- events: a newer sync that changes nothing still raises `event_version`, so an older event that
-- arrives after it stays superseded. Outcomes: `applied`, `already_applied`, `no_subject`.
CREATE OR REPLACE FUNCTION uts.sync_org_membership(
  p_environment text,
  p_operation_id uuid,
  p_subject text,
  p_org_id uuid,
  p_role uts.org_role,
  p_actor text,
  p_workload text,
  p_source_version bigint
) RETURNS TABLE (outcome text, feed_entries jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  repeated jsonb;
  absent record;
  removal record;
  held record;
BEGIN
  PERFORM uts.require_inputs(
    'uts.sync_org_membership',
    num_nulls(p_environment, p_operation_id, p_subject, p_org_id, p_actor, p_workload,
      p_source_version) = 0
  );
  PERFORM uts.lock_subject(p_subject);
  repeated := uts.repeated_operation(p_operation_id, 'membership_sync', p_subject);
  IF repeated IS NOT NULL THEN
    outcome := 'already_applied';
    feed_entries := repeated;
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = p_subject FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO absent FROM uts.operation_without_account(
      p_environment, p_operation_id, 'membership_sync', p_subject, NULL, p_actor, p_workload,
      p_source_version
    );
    outcome := absent.outcome;
    feed_entries := '[]'::jsonb;
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_role IS NULL THEN
    SELECT * INTO removal FROM uts.remove_org_member(p_environment, p_org_id, p_subject, p_source_version);
    outcome := CASE WHEN removal.outcome = 'unchanged' THEN 'already_applied' ELSE 'applied' END;
  ELSE
    -- Every membership write of the subject holds `uts.lock_subject`, so the row cannot appear
    -- between this read and the insert.
    SELECT membership.role, membership.status, membership.event_version INTO held
    FROM uts.org_memberships AS membership
    WHERE membership.org_id = p_org_id AND membership.account_id = p_subject
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
      VALUES (p_org_id, p_subject, p_role, p_source_version);
      outcome := 'applied';
    ELSIF held.event_version >= p_source_version THEN
      outcome := 'already_applied';
    ELSIF held.role = p_role AND held.status = 'active' THEN
      UPDATE uts.org_memberships AS membership SET event_version = p_source_version
      WHERE membership.org_id = p_org_id AND membership.account_id = p_subject;
      outcome := 'already_applied';
    ELSE
      UPDATE uts.org_memberships AS membership
      SET role = p_role, status = 'active', removed_at = NULL, event_version = p_source_version,
        updated_at = now()
      WHERE membership.org_id = p_org_id AND membership.account_id = p_subject;
      outcome := 'applied';
    END IF;
  END IF;
  IF outcome = 'applied' THEN
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.org_member.synced', 3001, 99, p_subject, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'org', p_org_id,
        'role', p_role,
        'removed', p_role IS NULL,
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
      )
    );
  END IF;
  feed_entries := uts.feed_entries_of_statement();
  PERFORM uts.record_operation(
    p_operation_id, 'membership_sync', p_subject, p_source_version, feed_entries
  );
  RETURN NEXT;
END
$$;

-- Stores a fetched Client ID Metadata Document (src/third-party/store.ts): inserts the client, or
-- refreshes an active client's copy for `p_cache_seconds` (5 minutes to 24 hours, the bounds of
-- src/third-party/metadata.ts). A blocked client keeps its status and its old copy, and the row
-- read back says `blocked`.
CREATE FUNCTION uts.save_third_party_client(
  p_client_id text,
  p_client_name text,
  p_redirect_uris text[],
  p_document jsonb,
  p_etag text,
  p_cache_seconds integer
) RETURNS TABLE (
  status uts.client_status,
  client_name text,
  redirect_uris text[],
  etag text,
  fresh boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM uts.require_inputs('uts.save_third_party_client',
    num_nulls(p_client_id, p_client_name, p_redirect_uris, p_document, p_cache_seconds) = 0);
  IF p_cache_seconds NOT BETWEEN 300 AND 86400 THEN
    RAISE EXCEPTION 'a client document is cached 300 to 86400 seconds' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH saved AS (
    INSERT INTO uts.third_party_clients AS client (
      client_id, client_name, redirect_uris, document, etag, fetched_at, cache_expires_at
    ) VALUES (
      p_client_id, p_client_name, p_redirect_uris, p_document, p_etag, now(),
      now() + make_interval(secs => p_cache_seconds)
    )
    ON CONFLICT ON CONSTRAINT third_party_clients_pkey DO UPDATE SET
      client_name = EXCLUDED.client_name,
      redirect_uris = EXCLUDED.redirect_uris,
      document = EXCLUDED.document,
      etag = EXCLUDED.etag,
      fetched_at = EXCLUDED.fetched_at,
      cache_expires_at = EXCLUDED.cache_expires_at
    WHERE client.status = 'active'
    RETURNING client.status, client.client_name, client.redirect_uris, client.etag, true
  )
  SELECT * FROM saved
  UNION ALL
  SELECT client.status, client.client_name, client.redirect_uris, client.etag, false
  FROM uts.third_party_clients AS client
  WHERE client.client_id = p_client_id AND NOT EXISTS (SELECT 1 FROM saved);
END
$$;

-- Moves the cache time of an active client whose host revalidated its document with `304`.
CREATE FUNCTION uts.extend_third_party_client(p_client_id text, p_cache_seconds integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM uts.require_inputs('uts.extend_third_party_client',
    num_nulls(p_client_id, p_cache_seconds) = 0);
  IF p_cache_seconds NOT BETWEEN 300 AND 86400 THEN
    RAISE EXCEPTION 'a client document is cached 300 to 86400 seconds' USING ERRCODE = '22023';
  END IF;
  UPDATE uts.third_party_clients AS client
  SET fetched_at = now(), cache_expires_at = now() + make_interval(secs => p_cache_seconds)
  WHERE client.client_id = p_client_id AND client.status = 'active';
END
$$;

-- The minute cron: active clients that no consent names, one day after their cache time ended.
-- Any GET /authorize of the client in that day refetched it and moved its cache time, so no
-- authorization of it is in flight; a client a consent statement is writing for holds its row
-- lock and is skipped. A blocked client stays for good, so its block outlives every refetch.
CREATE FUNCTION uts.maintain_third_party_client_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM uts.third_party_clients AS client
  WHERE client.client_id IN (
    SELECT stale.client_id FROM uts.third_party_clients AS stale
    WHERE stale.status = 'active' AND stale.cache_expires_at < now() - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM uts.third_party_consents AS consent WHERE consent.client_id = stale.client_id
      )
    LIMIT 5000
    FOR UPDATE OF stale SKIP LOCKED
  ) AND client.status = 'active' AND client.cache_expires_at < now() - interval '1 day';
  kind := 'third_party_clients';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;

REVOKE INSERT, UPDATE, DELETE ON uts.third_party_clients FROM uts_app;
REVOKE UPDATE, DELETE ON uts.third_party_consents FROM uts_app;

GRANT EXECUTE ON FUNCTION
  uts.save_third_party_client(text, text, text[], jsonb, text, integer),
  uts.extend_third_party_client(text, integer),
  uts.maintain_third_party_client_rows()
TO uts_app;
