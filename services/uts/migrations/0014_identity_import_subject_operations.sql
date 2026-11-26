-- Identity import, authority sync, subject operations and the user-created event (design
-- sections 5.2, 5.6, 5.8 and 8.1).
--
-- * Import: `uts.import_account` makes an app user an account with the same id, its verified
--   provider identities, its passkeys (with the user handles they were created under) and its tie
--   to an organization's SSO, in one statement with its audit row. It is idempotent by the app user
--   id. An account a UTS sign-in creates keeps the `uts_` id format, which no app user id has.
-- * Subject operations: `uts.apply_subject_operation` runs one operation of the app's outbox
--   (revoke, unblock, end browser sessions, end device sessions, revoke API credentials) in one
--   statement with its audit row, and returns the feed entries it wrote. An `operation_id` is kept
--   7 days, so a repeat answers `already_applied` and hands its entries to the feed again.
-- * Tombstones: an operation for a subject UTS does not hold writes a tombstone. An import reads
--   them first: a deletion refuses the import for good; a block imports the account blocked; a
--   revoke sets the account's `revoked_before`; and an import older than any of them is stale.
-- * Source versions: every import and operation carries the app's per-subject authority version
--   (an organization's own version for its SSO setup). Each kind of authority keeps its own
--   high-water mark: `uts.accounts.status_version` for block and unblock, `email_version` for the
--   primary email, and each membership row's `event_version`. A block, unblock, email sync or
--   membership change older than its own mark is superseded and changes nothing; revocations and
--   session ends neither read nor raise a mark, because they only take access away.
-- * Feed: a block lists the account in `blocked_accounts` for 70 minutes (a deletion for 24
--   hours), beside the subject's `revoked_before`; an unblock writes an `unblocked_account` entry
--   that removes the block from every feed object's list (src/revocation/entries.ts).
-- * The user-created event: inserting a `uts_` account writes one `user.created` row of the app
--   outbox (`uts.app_account_events`), which the web app reads and acknowledges.
-- * Every write is a SECURITY DEFINER function; the app login reads none of the new tables.

SET LOCAL ROLE uts_owner;

-- PostgreSQL accepts the new values inside this transaction; the plpgsql bodies below use them
-- only when they run.
ALTER TYPE uts.revoke_reason ADD VALUE 'account_recovery';
ALTER TYPE uts.revoke_reason ADD VALUE 'account_reset';
ALTER TYPE uts.revoke_reason ADD VALUE 'account_deleted';
ALTER TYPE uts.revoke_reason ADD VALUE 'staff_signout';
ALTER TYPE uts.revoke_reason ADD VALUE 'workos_relink';
ALTER TYPE uts.revoke_reason ADD VALUE 'scim_mailbox_move';
ALTER TYPE uts.revoke_reason ADD VALUE 'apple_consent_revoked';
ALTER TYPE uts.revoke_reason ADD VALUE 'staff_api_reset';
ALTER TYPE uts.revocation_kind ADD VALUE 'unblocked_account';

CREATE TYPE uts.subject_operation AS ENUM (
  'revoke', 'unblock', 'end_browser_sessions', 'end_device_sessions', 'revoke_api_credentials',
  'email_sync', 'membership_sync', 'sso_organization_sync'
);

-- `imported_at`: when `uts.import_account` wrote the account. `revoked_before`: the latest
-- subject-wide revocation, which `uts.subject_revoked_since` reads after the feed row expired, so
-- a legacy session that signed in at or before it never bridges into a UTS session.
-- `status_version` and `email_version`: the newest app version applied to the status and to the
-- primary email. `event_version` of 0001 stays unused by these statements.
ALTER TABLE uts.accounts
  ADD COLUMN imported_at timestamptz,
  ADD COLUMN revoked_before timestamptz,
  ADD COLUMN status_version bigint NOT NULL DEFAULT 0
    CHECK (status_version BETWEEN 0 AND 9007199254740991),
  ADD COLUMN email_version bigint NOT NULL DEFAULT 0
    CHECK (email_version BETWEEN 0 AND 9007199254740991);

-- An imported passkey keeps no gate pass: the app registered it before UTS existed.
ALTER TABLE uts.passkey_credentials
  ALTER COLUMN gate_pass_id DROP NOT NULL,
  ADD COLUMN imported_at timestamptz,
  ADD CONSTRAINT passkey_credentials_origin CHECK ((gate_pass_id IS NULL) = (imported_at IS NOT NULL));

-- The WorkOS organization a connection belongs to; the app organization whose id is that WorkOS
-- organization's `externalId` is the row's `org_id`.
ALTER TABLE uts.sso_connections
  ADD COLUMN workos_organization_id text
    CHECK (length(workos_organization_id) BETWEEN 1 AND 255);

-- An unblock never restores what a block took (design 5.6): a revoked browser session, device
-- session, first-party grant or third-party family stays revoked, and an ended sandbox grant
-- stays ended, as a revoked PAT or CI trust policy already does (`uts.refuse_reopening`, 0001).
-- The user signs in again and gets new ones. CREATE OR REPLACE: migration 0013 creates the same
-- browser-session trigger, so this one applies whether or not 0013 ran first.
CREATE OR REPLACE TRIGGER browser_sessions_stay_revoked
  BEFORE UPDATE ON uts.browser_sessions
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  EXECUTE FUNCTION uts.refuse_reopening('status');
CREATE OR REPLACE TRIGGER device_sessions_stay_revoked
  BEFORE UPDATE ON uts.device_sessions
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  EXECUTE FUNCTION uts.refuse_reopening('status');
CREATE OR REPLACE TRIGGER refresh_grants_stay_revoked
  BEFORE UPDATE ON uts.refresh_grants
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  EXECUTE FUNCTION uts.refuse_reopening('status');
CREATE OR REPLACE TRIGGER third_party_grant_families_stay_revoked
  BEFORE UPDATE ON uts.third_party_grant_families
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  EXECUTE FUNCTION uts.refuse_reopening('status');
CREATE OR REPLACE TRIGGER sandbox_grants_stay_ended
  BEFORE UPDATE ON uts.sandbox_grants
  FOR EACH ROW WHEN (OLD.status = 'ended' AND NEW.status <> 'ended')
  EXECUTE FUNCTION uts.refuse_reopening('status');

-- Whether a subject-wide revocation covers a session issued at `p_issued_at`: the feed row while
-- it lives, and the account's `revoked_before` after it expired. Migration 0013 defines it with
-- the feed row only; this keeps its signature and kind, so 0013's callers read both.
CREATE OR REPLACE FUNCTION uts.subject_revoked_since(p_account_id text, p_issued_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM uts.revocations AS entry
    WHERE entry.kind = 'subject' AND entry.subject_id = $1 AND entry.revoked_before >= $2
  ) OR EXISTS (
    SELECT 1 FROM uts.accounts AS account
    WHERE account.id = $1 AND account.revoked_before >= $2
  )
$$;

-- The operations UTS applied, by `operation_id`, for 7 days, with the feed entries each wrote.
-- `target` is the subject, or the organization id of an SSO sync.
CREATE TABLE uts.subject_operations (
  operation_id uuid PRIMARY KEY,
  operation uts.subject_operation NOT NULL,
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 255),
  source_version bigint NOT NULL CHECK (source_version BETWEEN 0 AND 9007199254740991),
  feed_entries jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(feed_entries) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT subject_operations_retention CHECK (expires_at = created_at + interval '7 days')
);
CREATE INDEX subject_operations_expires_idx ON uts.subject_operations (expires_at);

-- An operation for a subject UTS did not hold. An import consumes them; a deletion tombstone
-- stays for good, independent of the app row, the app outbox and the operation-id window.
CREATE TABLE uts.subject_tombstones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  operation uts.subject_operation NOT NULL,
  reason text CHECK (reason ~ '^[a-z_]{1,64}$'),
  source_version bigint NOT NULL CHECK (source_version BETWEEN 0 AND 9007199254740991),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subject_tombstones_operation_key UNIQUE (operation_id)
);
CREATE INDEX subject_tombstones_subject_idx ON uts.subject_tombstones (subject);
CREATE UNIQUE INDEX subject_tombstones_deleted_key ON uts.subject_tombstones (subject)
  WHERE reason = 'account_deleted';

-- The app outbox: one `user.created` row per account a UTS sign-in creates. The web app reads the
-- oldest rows and acknowledges each one, which deletes it; a deleted account takes its row along.
CREATE TABLE uts.app_account_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type = 'user.created'),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  primary_email uts.email NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT app_account_events_account_key UNIQUE (account_id, event_type),
  CONSTRAINT app_account_events_created_id CHECK (account_id ~ '^uts_[a-z2-7]{26}$')
);
CREATE INDEX app_account_events_order_idx ON uts.app_account_events (occurred_at, event_id);

-- The user-created event, in the statement that creates the account, whatever path creates it.
-- SECURITY DEFINER: the app login inserts accounts but has no privilege on the outbox.
CREATE FUNCTION uts.write_user_created_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO uts.app_account_events (event_type, account_id, primary_email, occurred_at)
  VALUES ('user.created', NEW.id, NEW.primary_email, NEW.created_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER accounts_user_created
AFTER INSERT ON uts.accounts
FOR EACH ROW WHEN (NEW.id ~ '^uts_[a-z2-7]{26}$')
EXECUTE FUNCTION uts.write_user_created_event();

-- Writes one audit row whose actor is the calling workload, the STS token's subject or the
-- binding's caller. The app's own actor string travels in `requestedBy`.
CREATE FUNCTION uts.write_workload_audit_event(
  p_environment text,
  p_type text,
  p_class integer,
  p_activity integer,
  p_account_id text,
  p_workload text,
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
      'actor', jsonb_build_object('kind', 'workload', 'id', p_workload),
      'attributes', jsonb_strip_nulls(p_attributes)
    )
  ));
  RETURN new_event_id;
END
$$;

-- Imports, operations and syncs of one subject run one after another.
CREATE FUNCTION uts.lock_subject(p_subject text) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('uts.subject:' || $1, 0))
$$;

-- The reasons each operation accepts (`UTS_SUBJECT_OPERATIONS` in `@kilocode/uts-contracts`).
CREATE FUNCTION uts.subject_reason_allowed(p_operation uts.subject_operation, p_reason text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
RETURN CASE p_operation
  WHEN 'revoke' THEN p_reason IN ('access_block', 'account_recovery', 'account_reset', 'account_deleted')
  WHEN 'unblock' THEN p_reason = 'access_unblock'
  WHEN 'end_browser_sessions'
    THEN p_reason IN ('staff_signout', 'workos_relink', 'scim_mailbox_move', 'apple_consent_revoked')
  WHEN 'end_device_sessions' THEN p_reason = 'apple_consent_revoked'
  WHEN 'revoke_api_credentials' THEN p_reason = 'staff_api_reset'
  ELSE p_reason IS NULL
END;

-- The answer to a repeated `operation_id`: the stored row, or nothing. A reused id with another
-- operation or target is a caller error.
CREATE FUNCTION uts.repeated_operation(
  p_operation_id uuid,
  p_operation uts.subject_operation,
  p_target text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  held record;
BEGIN
  SELECT * INTO held FROM uts.subject_operations AS stored WHERE stored.operation_id = p_operation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF held.operation <> p_operation OR held.target <> p_target THEN
    RAISE EXCEPTION 'operation_id % names another operation', p_operation_id USING ERRCODE = '22023';
  END IF;
  RETURN held.feed_entries;
END
$$;

CREATE FUNCTION uts.record_operation(
  p_operation_id uuid,
  p_operation uts.subject_operation,
  p_target text,
  p_source_version bigint,
  p_feed_entries jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO uts.subject_operations (operation_id, operation, target, source_version, feed_entries, expires_at)
  VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
$$;

-- An operation for a subject UTS does not hold. Outcomes: `no_subject` with a tombstone;
-- `already_applied` for a deletion repeated after the account left; `refused` for an unblock of a
-- deleted subject (no record). Anything else after a deletion is `no_subject` with no new
-- tombstone.
CREATE FUNCTION uts.operation_without_account(
  p_environment text,
  p_operation_id uuid,
  p_operation uts.subject_operation,
  p_subject text,
  p_reason text,
  p_actor text,
  p_workload text,
  p_source_version bigint,
  OUT outcome text,
  OUT error text
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM uts.subject_tombstones AS tombstone
    WHERE tombstone.subject = p_subject AND tombstone.reason = 'account_deleted'
  ) THEN
    IF p_operation = 'unblock' THEN
      outcome := 'refused';
      error := 'account_deleted';
      RETURN;
    END IF;
    outcome := CASE WHEN p_reason = 'account_deleted' THEN 'already_applied' ELSE 'no_subject' END;
  ELSE
    INSERT INTO uts.subject_tombstones (subject, operation, reason, source_version, operation_id)
    VALUES (p_subject, p_operation, p_reason, p_source_version, p_operation_id);
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.subject.tombstoned', 3001, 99, p_subject, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'operation', p_operation,
        'reason', p_reason,
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
      )
    );
    outcome := 'no_subject';
  END IF;
  PERFORM uts.record_operation(p_operation_id, p_operation, p_subject, p_source_version, '[]');
END
$$;

-- Ends the subject's browser sessions, and its `kilo-web` refresh grants if it holds any, each
-- with its `revoked_sids` entry. Returns how many it ended.
CREATE FUNCTION uts.end_browser_sessions_of(p_subject text, p_reason uts.revoke_reason)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ended integer;
  item record;
BEGIN
  WITH revoked AS (
    UPDATE uts.browser_sessions AS session
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE session.account_id = p_subject AND session.status = 'active'
    RETURNING session.id
  ), fed AS (
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    SELECT 'session', revoked.id::text, now() + interval '20 minutes' FROM revoked
    ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO NOTHING
  )
  SELECT count(*)::integer INTO ended FROM revoked;
  FOR item IN
    SELECT grant_row.id FROM uts.refresh_grants AS grant_row
    WHERE grant_row.account_id = p_subject AND grant_row.status = 'active'
      AND grant_row.client_id = 'kilo-web'
  LOOP
    IF uts.end_grant('first_party', item.id, p_reason) IS NOT NULL THEN
      ended := ended + 1;
    END IF;
  END LOOP;
  RETURN ended;
END
$$;

-- Ends the subject's first-party device grants (CLI, IDE, extension, mobile) with their
-- `revoked_sids` entries; each device session ends with its last grant. Returns how many.
CREATE FUNCTION uts.end_device_grants_of(p_subject text, p_reason uts.revoke_reason)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ended integer := 0;
  item record;
BEGIN
  FOR item IN
    SELECT grant_row.id FROM uts.refresh_grants AS grant_row
    WHERE grant_row.account_id = p_subject AND grant_row.status = 'active'
      AND grant_row.client_id <> 'kilo-web'
  LOOP
    IF uts.end_grant('first_party', item.id, p_reason) IS NOT NULL THEN
      ended := ended + 1;
    END IF;
  END LOOP;
  RETURN ended;
END
$$;

-- Revokes the subject's live PATs, each with its 15-minute `revoked_pat_ids` entry.
CREATE FUNCTION uts.revoke_pats_of(p_subject text, p_reason uts.revoke_reason)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  revoked_count integer;
BEGIN
  WITH revoked AS (
    UPDATE uts.personal_access_tokens AS pat
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE pat.account_id = p_subject AND pat.status = 'active'
    RETURNING pat.id
  ), fed AS (
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    SELECT 'pat', revoked.id::text, now() + interval '15 minutes' FROM revoked
    ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO NOTHING
  )
  SELECT count(*)::integer INTO revoked_count FROM revoked;
  RETURN revoked_count;
END
$$;

-- Revokes everything the subject holds: `revoked_before` (kept `p_keep` in the feed), browser
-- sessions, device grants, third-party families, PATs, CI trust policies and sandbox grants.
-- Tokens of every kind name the subject in `sub`, so `revoked_before` refuses each one issued
-- before now; the per-grant and per-session entries also refuse a token a mint signed while this
-- statement ran. Returns the counts for the audit row.
CREATE FUNCTION uts.revoke_everything_of(
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
  RETURN jsonb_build_object(
    'browserSessions', browser,
    'deviceGrants', device,
    'thirdPartyFamilies', families,
    'pats', pats,
    'ciTrustPolicies', policies,
    'sandboxGrants', sandboxes
  );
END
$$;

-- Lists the subject in `blocked_accounts` for `p_keep`, from now.
CREATE FUNCTION uts.block_in_feed(p_subject text, p_keep interval) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
  VALUES ('blocked_account', $1, now() + $2)
  ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO UPDATE
  SET feed_expires_at = greatest(uts.revocations.feed_expires_at, EXCLUDED.feed_expires_at)
$$;

-- Deletes the account after its revocation: first the bot-key-flagged audit rows and the org
-- admins' notices for the active keys it created (`uts.flag_bot_keys_of_deleted_account` flags
-- them on the delete), then the deletion tombstone and the row, which takes the account's
-- sessions, grants, methods, passkeys and pending app event with it.
CREATE FUNCTION uts.delete_account(
  p_environment text,
  p_subject text,
  p_operation_id uuid,
  p_source_version bigint
) RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item record;
  flagged integer := 0;
  stops_at timestamptz := now() + interval '168 hours';
BEGIN
  FOR item IN
    SELECT bot_key.id, bot_key.org_id, bot_key.token_hash FROM uts.org_bot_keys AS bot_key
    WHERE bot_key.created_by = p_subject AND bot_key.status = 'active'
  LOOP
    PERFORM uts.write_system_audit_event(
      p_environment, 'ai.kilo.uts.bot_key.flagged', 6003, 3, p_subject,
      jsonb_build_object(
        'botKeyId', item.id,
        'botKeyRef', uts.credential_reference(item.token_hash),
        'org', item.org_id,
        'reason', 'account_deleted',
        'stopsAt', to_char(stops_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );
    flagged := flagged + 1;
  END LOOP;
  INSERT INTO uts.notices (account_id, kind, details)
  SELECT admin.account_id, 'bot_key_flagged', jsonb_build_object(
    'org', keys.org_id,
    'flaggedKeys', keys.flagged,
    'stopsAt', to_char(stops_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )
  FROM (
    SELECT bot_key.org_id, count(*)::integer AS flagged FROM uts.org_bot_keys AS bot_key
    WHERE bot_key.created_by = p_subject AND bot_key.status = 'active'
    GROUP BY bot_key.org_id
  ) AS keys
  JOIN uts.org_memberships AS admin
    ON admin.org_id = keys.org_id AND admin.status = 'active' AND admin.role IN ('owner', 'admin')
  WHERE admin.account_id <> p_subject;
  INSERT INTO uts.subject_tombstones (subject, operation, reason, source_version, operation_id)
  VALUES (p_subject, 'revoke', 'account_deleted', p_source_version, p_operation_id);
  DELETE FROM uts.accounts AS account WHERE account.id = p_subject;
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
-- wrote, which the caller hands to the feed objects before it answers 200.
CREATE FUNCTION uts.apply_subject_operation(
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

-- Decodes RFC 4648 base64url without padding.
CREATE FUNCTION uts.base64url_decode(p_value text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN decode(
  rpad(translate(p_value, '-_', '+/'), ((length(p_value) + 3) / 4) * 4, '='),
  'base64'
);

-- POST /internal/accounts/import: one app user, with the same id, in one statement with its
-- audit row. Every check runs before the first write, so a refusal writes nothing. Outcomes:
-- `imported`; `already_imported`; `retry_later` with `sso_connection_unknown` (an SSO connection
-- the import names is not synced yet); `refused` with `deleted`, `stale`, `identity_taken`,
-- `email_taken`, `passkey_taken` or `sso_authority_mismatch`. The relying-party id of the
-- passkeys is the mint Worker's configuration, never the caller's.
CREATE FUNCTION uts.import_account(
  p_environment text,
  p_workload text,
  p_app_user_id text,
  p_primary_email text,
  p_status uts.account_status,
  p_identities jsonb,
  p_sso_authority jsonb,
  p_passkeys jsonb,
  p_rp_id text,
  p_source_version bigint
) RETURNS TABLE (outcome text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  newest_version bigint;
  last_status record;
  revoked_at_time timestamptz;
  blocked boolean;
  sso_connection record;
  tombstones integer;
BEGIN
  PERFORM uts.require_inputs(
    'uts.import_account',
    num_nulls(p_environment, p_workload, p_app_user_id, p_primary_email, p_status, p_identities,
      p_passkeys, p_rp_id, p_source_version) = 0
  );
  IF p_app_user_id ~ '^uts_' THEN
    RAISE EXCEPTION 'an app user id never takes the uts_ prefix' USING ERRCODE = '22023';
  END IF;
  PERFORM uts.lock_subject(p_app_user_id);
  IF EXISTS (SELECT 1 FROM uts.accounts AS account WHERE account.id = p_app_user_id) THEN
    outcome := 'already_imported';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM uts.subject_tombstones AS tombstone
    WHERE tombstone.subject = p_app_user_id AND tombstone.reason = 'account_deleted'
  ) THEN
    outcome := 'refused';
    error := 'deleted';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT max(tombstone.source_version) INTO newest_version
  FROM uts.subject_tombstones AS tombstone WHERE tombstone.subject = p_app_user_id;
  IF newest_version > p_source_version THEN
    outcome := 'refused';
    error := 'stale';
    RETURN NEXT;
    RETURN;
  END IF;

  -- The address lock that sign-in takes, so a sign-up of the same address waits for the import.
  PERFORM pg_advisory_xact_lock(hashtextextended('uts.primary_email:' || p_primary_email, 0));
  IF EXISTS (SELECT 1 FROM uts.accounts AS account WHERE account.primary_email = p_primary_email) THEN
    outcome := 'refused';
    error := 'email_taken';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_identities) AS identity
    JOIN uts.sign_in_methods AS method
      ON method.provider = (identity ->> 'provider')::uts.sign_in_provider
      AND method.provider_subject = identity ->> 'provider_subject'
  ) THEN
    outcome := 'refused';
    error := 'identity_taken';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_passkeys) AS passkey
    JOIN uts.passkey_credentials AS held
      ON held.credential_id = uts.base64url_decode(passkey ->> 'credential_id')
  ) THEN
    outcome := 'refused';
    error := 'passkey_taken';
    RETURN NEXT;
    RETURN;
  END IF;
  -- A WorkOS identity needs a synced connection (else retry), an active one in the organization
  -- of the SSO tie, which the import must name.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_identities) AS identity
    WHERE identity ->> 'provider' = 'workos'
      AND NOT EXISTS (
        SELECT 1 FROM uts.sso_connections AS connection
        WHERE connection.workos_connection_id = identity ->> 'workos_connection_id'
      )
  ) OR (
    p_sso_authority IS NOT NULL AND jsonb_typeof(p_sso_authority) = 'object' AND NOT EXISTS (
      SELECT 1 FROM uts.sso_connections AS connection
      WHERE connection.workos_connection_id = p_sso_authority ->> 'workos_connection_id'
    )
  ) THEN
    outcome := 'retry_later';
    error := 'sso_connection_unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_sso_authority IS NOT NULL AND jsonb_typeof(p_sso_authority) = 'object' THEN
    SELECT connection.org_id, connection.workos_organization_id, connection.status
    INTO sso_connection
    FROM uts.sso_connections AS connection
    WHERE connection.workos_connection_id = p_sso_authority ->> 'workos_connection_id';
    IF sso_connection.status <> 'active'
      OR sso_connection.org_id <> (p_sso_authority ->> 'app_organization_id')::uuid
      OR sso_connection.workos_organization_id IS DISTINCT FROM
        p_sso_authority ->> 'workos_organization_id'
    THEN
      outcome := 'refused';
      error := 'sso_authority_mismatch';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_identities) AS identity
    JOIN uts.sso_connections AS connection
      ON connection.workos_connection_id = identity ->> 'workos_connection_id'
    WHERE identity ->> 'provider' = 'workos'
      AND (
        p_sso_authority IS NULL OR jsonb_typeof(p_sso_authority) <> 'object'
        OR connection.status <> 'active'
        OR connection.org_id <> (p_sso_authority ->> 'app_organization_id')::uuid
      )
  ) THEN
    outcome := 'refused';
    error := 'sso_authority_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  -- The tombstones: a revoke dates `revoked_before`; the newest block or unblock decides the
  -- status, and the app's own status can only add a block.
  SELECT max(tombstone.created_at) INTO revoked_at_time
  FROM uts.subject_tombstones AS tombstone
  WHERE tombstone.subject = p_app_user_id AND tombstone.operation = 'revoke';
  SELECT tombstone.operation, tombstone.reason, tombstone.created_at INTO last_status
  FROM uts.subject_tombstones AS tombstone
  WHERE tombstone.subject = p_app_user_id
    AND (tombstone.operation = 'unblock' OR tombstone.reason = 'access_block')
  ORDER BY tombstone.source_version DESC, tombstone.id DESC
  LIMIT 1;
  blocked := p_status = 'blocked' OR coalesce(last_status.reason = 'access_block', false);

  INSERT INTO uts.accounts (
    id, primary_email, status, blocked_at, status_version, email_version, imported_at,
    revoked_before
  ) VALUES (
    p_app_user_id, p_primary_email,
    CASE WHEN blocked THEN 'blocked' ELSE 'active' END::uts.account_status,
    CASE WHEN blocked THEN coalesce(
      CASE WHEN last_status.reason = 'access_block' THEN last_status.created_at END, now()
    ) END,
    p_source_version, p_source_version, now(), revoked_at_time
  );
  INSERT INTO uts.sign_in_methods (
    account_id, provider, provider_subject, verified_email, sso_connection_id, added_at
  )
  SELECT p_app_user_id, (identity ->> 'provider')::uts.sign_in_provider,
    identity ->> 'provider_subject', identity ->> 'verified_email',
    (SELECT connection.id FROM uts.sso_connections AS connection
     WHERE connection.workos_connection_id = identity ->> 'workos_connection_id'),
    least((identity ->> 'linked_at')::timestamptz, now())
  FROM jsonb_array_elements(p_identities) AS identity;
  INSERT INTO uts.passkey_credentials (
    account_id, credential_id, public_key, sign_count, aaguid, transports, backup_eligible,
    backed_up, rp_id, name, added_at, user_handle, imported_at
  )
  SELECT p_app_user_id, uts.base64url_decode(passkey ->> 'credential_id'),
    uts.base64url_decode(passkey ->> 'public_key'), (passkey ->> 'sign_count')::bigint,
    (passkey ->> 'aaguid')::uuid,
    ARRAY(SELECT jsonb_array_elements_text(passkey -> 'transports')),
    (passkey ->> 'backup_eligible')::boolean, (passkey ->> 'backed_up')::boolean, p_rp_id,
    passkey ->> 'name', least((passkey ->> 'created_at')::timestamptz, now()),
    uts.base64url_decode(passkey ->> 'user_handle'), now()
  FROM jsonb_array_elements(p_passkeys) AS passkey;
  IF p_sso_authority IS NOT NULL AND jsonb_typeof(p_sso_authority) = 'object' THEN
    INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
    VALUES (
      (p_sso_authority ->> 'app_organization_id')::uuid, p_app_user_id,
      (p_sso_authority ->> 'role')::uts.org_role, p_source_version
    );
  END IF;
  DELETE FROM uts.subject_tombstones AS tombstone WHERE tombstone.subject = p_app_user_id;
  GET DIAGNOSTICS tombstones = ROW_COUNT;
  PERFORM uts.write_workload_audit_event(
    p_environment, 'ai.kilo.uts.account.imported', 3001, 1, p_app_user_id, p_workload,
    jsonb_build_object(
      'status', CASE WHEN blocked THEN 'blocked' ELSE 'active' END,
      'identities', jsonb_array_length(p_identities),
      'passkeys', jsonb_array_length(p_passkeys),
      'ssoOrganization', p_sso_authority ->> 'app_organization_id',
      'tombstonesApplied', tombstones,
      'sourceVersion', p_source_version
    )
  );
  outcome := 'imported';
  RETURN NEXT;
END
$$;

-- POST /internal/authority/email: the subject's primary email. Outcomes: `applied`;
-- `already_applied` (a repeat, the same address, or a version older than one applied);
-- `no_subject` (a tombstone, so an older import is stale); `refused` with `email_taken`. The
-- audit row names no address (design 8.2).
CREATE FUNCTION uts.sync_primary_email(
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
    PERFORM pg_advisory_xact_lock(hashtextextended('uts.primary_email:' || p_primary_email, 0));
    IF EXISTS (
      SELECT 1 FROM uts.accounts AS account
      WHERE account.primary_email = p_primary_email AND account.id <> p_subject
    ) THEN
      outcome := 'refused';
      error := 'email_taken';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE uts.accounts AS account
    SET primary_email = p_primary_email, email_version = p_source_version, updated_at = now()
    WHERE account.id = p_subject;
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.primary_email.synced', 3001, 99, p_subject, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
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
-- events. Outcomes: `applied`, `already_applied`, `no_subject`.
CREATE FUNCTION uts.sync_org_membership(
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
    INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
    VALUES (p_org_id, p_subject, p_role, p_source_version)
    ON CONFLICT (org_id, account_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'active', removed_at = NULL,
      event_version = EXCLUDED.event_version, updated_at = now()
    WHERE uts.org_memberships.event_version < EXCLUDED.event_version
      AND (uts.org_memberships.role <> EXCLUDED.role OR uts.org_memberships.status <> 'active');
    outcome := CASE WHEN FOUND THEN 'applied' ELSE 'already_applied' END;
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

-- POST /internal/authority/sso-organization: an organization's SSO setup, ordered by the
-- organization's own source version (`uts.org_sso_policies.event_version`): the policy, the
-- WorkOS organization whose `externalId` is this organization, and its connections; a connection
-- of the organization left out becomes inactive. A connection never moves from another
-- organization while it is active there. Outcomes: `applied`, `already_applied`, `refused` with
-- `connection_conflict`.
CREATE FUNCTION uts.sync_sso_organization(
  p_environment text,
  p_operation_id uuid,
  p_org_id uuid,
  p_workos_organization_id text,
  p_workos_connection_ids text[],
  p_enforcement uts.sso_enforcement,
  p_actor text,
  p_workload text,
  p_source_version bigint
) RETURNS TABLE (outcome text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  stored_version bigint;
  touched integer;
  changed integer := 0;
BEGIN
  PERFORM uts.require_inputs(
    'uts.sync_sso_organization',
    num_nulls(p_environment, p_operation_id, p_org_id, p_workos_organization_id,
      p_workos_connection_ids, p_enforcement, p_actor, p_workload, p_source_version) = 0
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('uts.organization:' || p_org_id::text, 0));
  IF uts.repeated_operation(p_operation_id, 'sso_organization_sync', p_org_id::text) IS NOT NULL THEN
    outcome := 'already_applied';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT policy.event_version INTO stored_version
  FROM uts.org_sso_policies AS policy WHERE policy.org_id = p_org_id;
  IF EXISTS (
    SELECT 1 FROM uts.sso_connections AS connection
    WHERE connection.workos_connection_id = ANY (p_workos_connection_ids)
      AND connection.org_id <> p_org_id AND connection.status = 'active'
  ) THEN
    outcome := 'refused';
    error := 'connection_conflict';
    RETURN NEXT;
    RETURN;
  END IF;
  IF stored_version IS NULL OR stored_version <= p_source_version THEN
    INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version)
    VALUES (p_org_id, p_enforcement, p_source_version)
    ON CONFLICT (org_id) DO UPDATE
    SET enforcement = EXCLUDED.enforcement, event_version = EXCLUDED.event_version, updated_at = now()
    WHERE uts.org_sso_policies.enforcement <> EXCLUDED.enforcement
      OR uts.org_sso_policies.event_version <> EXCLUDED.event_version;
    GET DIAGNOSTICS touched = ROW_COUNT;
    changed := changed + touched;
    INSERT INTO uts.sso_connections (org_id, workos_connection_id, workos_organization_id)
    SELECT p_org_id, connection_id, p_workos_organization_id
    FROM unnest(p_workos_connection_ids) AS connection_id
    ON CONFLICT (workos_connection_id) DO UPDATE
    SET org_id = EXCLUDED.org_id, workos_organization_id = EXCLUDED.workos_organization_id,
      status = 'active', updated_at = now()
    WHERE uts.sso_connections.org_id <> EXCLUDED.org_id
      OR uts.sso_connections.workos_organization_id IS DISTINCT FROM EXCLUDED.workos_organization_id
      OR uts.sso_connections.status <> 'active';
    GET DIAGNOSTICS touched = ROW_COUNT;
    changed := changed + touched;
    UPDATE uts.sso_connections AS connection SET status = 'inactive', updated_at = now()
    WHERE connection.org_id = p_org_id AND connection.status = 'active'
      AND connection.workos_connection_id <> ALL (p_workos_connection_ids);
    GET DIAGNOSTICS touched = ROW_COUNT;
    changed := changed + touched;
  END IF;
  IF changed > 0 THEN
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.sso_organization.synced', 3001, 99, NULL, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'org', p_org_id,
        'enforcement', p_enforcement,
        'connections', cardinality(p_workos_connection_ids),
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
      )
    );
  END IF;
  PERFORM uts.record_operation(
    p_operation_id, 'sso_organization_sync', p_org_id::text, p_source_version, '[]'
  );
  outcome := CASE WHEN changed > 0 THEN 'applied' ELSE 'already_applied' END;
  RETURN NEXT;
END
$$;

-- The authority check of the legacy bridge and the browser replies (`sso_app_organization`):
-- the app organization of a verified WorkOS sign-in, when the connection is active, belongs to
-- that WorkOS organization, maps to that app organization, and the active account holds an active
-- membership there. NULL otherwise. Primary-key probes only.
CREATE FUNCTION uts.sso_app_organization(
  p_account_id text,
  p_workos_connection_id text,
  p_workos_organization_id text
) RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT connection.org_id
  FROM uts.sso_connections AS connection
  JOIN uts.org_memberships AS membership
    ON membership.org_id = connection.org_id AND membership.account_id = $1
  JOIN uts.accounts AS account ON account.id = membership.account_id
  WHERE connection.workos_connection_id = $2
    AND connection.workos_organization_id = $3
    AND connection.status = 'active'
    AND membership.status = 'active'
    AND account.status = 'active'
$$;

-- POST /internal/app-events/read: the oldest unacknowledged app events.
CREATE FUNCTION uts.read_app_account_events(p_limit integer)
RETURNS TABLE (event_id uuid, account_id text, primary_email text, occurred_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT event.event_id, event.account_id, event.primary_email, event.occurred_at
  FROM uts.app_account_events AS event
  ORDER BY event.occurred_at, event.event_id
  LIMIT least(greatest($1, 1), 100)
$$;

-- POST /internal/app-events/ack: deletes the acknowledged events; returns how many it found.
CREATE FUNCTION uts.ack_app_account_events(p_event_ids uuid[]) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  acknowledged integer;
BEGIN
  IF cardinality(p_event_ids) > 100 THEN
    RAISE EXCEPTION 'at most 100 events per acknowledgement' USING ERRCODE = '22023';
  END IF;
  DELETE FROM uts.app_account_events AS event WHERE event.event_id = ANY (p_event_ids);
  GET DIAGNOSTICS acknowledged = ROW_COUNT;
  RETURN acknowledged;
END
$$;

-- The minute cron: operation ids past their 7 days.
CREATE FUNCTION uts.maintain_subject_operation_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM uts.subject_operations AS stored
  WHERE stored.operation_id IN (
    SELECT stale.operation_id FROM uts.subject_operations AS stale
    WHERE stale.expires_at < now()
    LIMIT 5000
  );
  kind := 'subject_operations';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.apply_subject_operation(text, uuid, uts.subject_operation, text, text, text, text, bigint),
  uts.import_account(text, text, text, text, uts.account_status, jsonb, jsonb, jsonb, text, bigint),
  uts.sync_primary_email(text, uuid, text, text, text, text, bigint),
  uts.sync_org_membership(text, uuid, text, uuid, uts.org_role, text, text, bigint),
  uts.sync_sso_organization(text, uuid, uuid, text, text[], uts.sso_enforcement, text, text, bigint),
  uts.sso_app_organization(text, text, text),
  uts.read_app_account_events(integer),
  uts.ack_app_account_events(uuid[]),
  uts.maintain_subject_operation_rows()
TO uts_app;
