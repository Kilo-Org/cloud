-- Browser sessions of the web BFF `kilo-web` (design sections 5.1, 5.3, 5.5 and 5.6).
--
-- * A browser session is the UTS sign-in session (`uts.browser_sessions`). The BFF reaches it
--   through an opaque handle: the `kilo-web` code exchange stores the SHA-256 of a handle derived
--   from the code and the PKCE verifier (`handle_hash`), so a retry of the same exchange gets the
--   same handle and stored data does not give it. The session id is the `sid` of every access
--   token minted from the session and stays the same for the session's life.
-- * A later code exchange of the same session (a step-up, or any new authorization in it) puts a
--   new handle in place of the old one in the same statement, so the old handle stops at once and
--   the old code's retry no longer matches. `handle_issued_at` is when the current handle was
--   issued; `handle_auth_time` and `handle_amr` are the sign-in the handle carries: the code's
--   sign-in, raised by the newest passkey step-up of the session before the code was issued. The
--   session's own `auth_time` and `amr` stay the sign-in of the sign-in pages, which their gates
--   read.
-- * The legacy bridge creates a session without a sign-in cookie (`token_hash` NULL), with `amr`
--   `legacy_session` and the legacy session's sign-in time; it is never recorded as a sign-in.
-- * Each statement records the client assertion's `jti` under the RFC 7638 thumbprint of the
--   `kilo-web` key that signed it, in `uts.dpop_proofs` (migration 0004), which keeps a `jti`
--   under its key until it expires and refuses a second use; `uts.maintain_oauth_rows()` deletes
--   the expired rows.
-- * Ending a session writes one `session` feed entry, kept 20 minutes (the access-token lifetime
--   plus margin), and never the subject-wide `revoked_before`, so the subject's CLI and mobile
--   grants keep working. A repeat returns the entries that are still in the feed, so a caller
--   that got 503 can publish them again.
-- * An SSO sign-in records the WorkOS connection and organization of its verified profile on the
--   session; a bridged session carries them only when the bridge's authority check confirmed them.

SET LOCAL ROLE uts_owner;

-- Used only inside function bodies, which resolve it when they run, after this migration commits.
ALTER TYPE uts.auth_method ADD VALUE 'legacy_session';

ALTER TABLE uts.browser_sessions
  ALTER COLUMN token_hash DROP NOT NULL,
  ADD COLUMN handle_hash uts.sha256,
  ADD COLUMN handle_issued_at timestamptz,
  ADD COLUMN handle_auth_time timestamptz,
  ADD COLUMN handle_amr uts.auth_method[]
    CHECK (cardinality(handle_amr) BETWEEN 1 AND 8 AND array_position(handle_amr, NULL) IS NULL),
  ADD COLUMN sso_connection_id text CHECK (length(sso_connection_id) BETWEEN 1 AND 255),
  ADD COLUMN sso_organization_id text CHECK (length(sso_organization_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT browser_sessions_handle_hash_key UNIQUE (handle_hash),
  ADD CONSTRAINT browser_sessions_handle_shape CHECK (
    num_nulls(handle_hash, handle_issued_at, handle_auth_time, handle_amr) IN (0, 4)
  ),
  ADD CONSTRAINT browser_sessions_holder CHECK (token_hash IS NOT NULL OR handle_hash IS NOT NULL),
  ADD CONSTRAINT browser_sessions_sso_shape CHECK (
    (sso_connection_id IS NULL OR 'sso' = ANY (amr))
    AND (sso_organization_id IS NULL OR sso_connection_id IS NOT NULL)
  );

-- An ended session stays ended and keeps its handle.
CREATE TRIGGER browser_sessions_stay_revoked
  BEFORE UPDATE ON uts.browser_sessions
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  EXECUTE FUNCTION uts.refuse_reopening('status');
CREATE TRIGGER browser_sessions_handle_stays_ended
  BEFORE UPDATE ON uts.browser_sessions
  FOR EACH ROW WHEN (OLD.status = 'revoked' AND NEW.handle_hash IS DISTINCT FROM OLD.handle_hash)
  EXECUTE FUNCTION uts.refuse_reopening('handle_hash');

-- A bridged session is not a sign-in (design 5.13): only a session with a sign-in cookie records
-- one.
DROP TRIGGER browser_sessions_record_sign_in ON uts.browser_sessions;
CREATE TRIGGER browser_sessions_record_sign_in
  AFTER INSERT ON uts.browser_sessions
  FOR EACH ROW WHEN (NEW.token_hash IS NOT NULL)
  EXECUTE FUNCTION uts.record_browser_sign_in();

-- A `kilo-web` code is a first-party code without a DPoP key: the client authenticates with a
-- client assertion instead, and the code names the browser session it was approved in.
ALTER TABLE uts.authorization_codes
  DROP CONSTRAINT authorization_codes_dpop_shape,
  ADD CONSTRAINT authorization_codes_dpop_shape CHECK (
    CASE
      WHEN client_kind = 'third_party' THEN true
      WHEN client_id = 'kilo-web' THEN dpop_jkt IS NULL AND browser_session_id IS NOT NULL
      ELSE dpop_jkt IS NOT NULL
    END
  );

-- `uts.issue_authorization_code()` of migration 0005, with the `kilo-web` shape above in its input
-- check; everything else is as in 0005.
CREATE OR REPLACE FUNCTION uts.issue_authorization_code(
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
    AND CASE
      WHEN p_client_kind = 'third_party' THEN p_dpop_jkt IS NULL
      WHEN p_client_id = 'kilo-web' THEN p_dpop_jkt IS NULL AND p_browser_session_id IS NOT NULL
      ELSE p_dpop_jkt IS NOT NULL
    END
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
  IF NOT uts.role_allows_scopes(p_scopes, member_role) THEN
    outcome := 'invalid_scope';
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

-- Records a `kilo-web` assertion's `jti` under its key's thumbprint; false when it was used.
CREATE FUNCTION uts.accept_client_assertion(p_jkt bytea, p_jti text, p_expires_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
  VALUES (p_jkt, p_jti, p_expires_at)
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  RETURN FOUND;
END
$$;

-- The feed entries of `p_kind` for `p_ids` that are still in the feed, in the shape of
-- `uts.feed_entries_of_statement()`. One probe of `revocations_kind_subject_key` per id.
CREATE FUNCTION uts.live_feed_entries(p_kind uts.revocation_kind, p_ids text[]) RETURNS jsonb
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', entry.kind,
        'id', entry.subject_id,
        'revoked_before', NULL,
        'revoked_at', floor(extract(epoch FROM entry.revoked_at) * 1000),
        'expires_at', floor(extract(epoch FROM entry.feed_expires_at) * 1000)
      )
      ORDER BY entry.id
    ),
    '[]'::jsonb
  )
  FROM uts.revocations AS entry
  WHERE entry.kind = $1 AND entry.subject_id = ANY ($2) AND entry.feed_expires_at > now()
$$;

-- Whether any of `p_scopes` needs a passkey step-up (`stepUp` in `UTS_SCOPE_REGISTRY`; the list
-- here mirrors it, and `test/db/web-sessions.test.ts` holds both to every registered scope). The
-- registry has no such scope yet. A `kilo-web` session mints one only through
-- `uts.mint_web_session_token`, which checks the handle's passkey; the code exchange and the
-- legacy bridge refuse it.
CREATE FUNCTION uts.scopes_need_step_up(p_scopes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN p_scopes && '{}'::text[];

-- Whether a subject-wide revocation covers a session whose handle was issued at `p_issued_at`.
CREATE FUNCTION uts.subject_revoked_since(p_account_id text, p_issued_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM uts.revocations AS entry
    WHERE entry.kind = 'subject' AND entry.subject_id = $1 AND entry.revoked_before >= $2
  )
$$;

-- The live session a handle names: active, within its idle and maximum lifetime, of an active
-- account, and issued after any subject-wide revocation. One probe of
-- `browser_sessions_handle_hash_key`, then `accounts_pkey` and `revocations_kind_subject_key`.
CREATE FUNCTION uts.live_web_session(p_handle_hash bytea)
RETURNS SETOF uts.browser_sessions
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session.*
  FROM uts.browser_sessions AS session
  JOIN uts.accounts AS account ON account.id = session.account_id
  WHERE session.handle_hash = $1
    AND session.status = 'active'
    AND session.idle_expires_at > now()
    AND session.expires_at > now()
    AND account.status = 'active'
    AND NOT uts.subject_revoked_since(session.account_id, session.handle_issued_at)
$$;

-- POST /token with `authorization_code` for `kilo-web`: consumes the code and puts the handle on
-- the browser session the code was approved in, in one statement with its audit row. A retry
-- with the same code, redirect URI and PKCE verifier (the same handle) inside the code's
-- 60-second lifetime answers the same session and handle again; any other second use, or a retry
-- after a later exchange replaced the handle, is `invalid_grant` and changes nothing, so no retry
-- signs the user out. Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `invalid_target`,
-- `assertion_replay`.
CREATE FUNCTION uts.exchange_web_code(
  p_environment text,
  p_code_hash bytea,
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz,
  p_handle_hash bytea,
  p_scopes text[],
  p_resources text[]
) RETURNS TABLE (
  outcome text,
  subject_id text,
  web_session_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  sso_connection text,
  sso_organization text,
  handle_issued timestamptz,
  idle_end timestamptz,
  session_end timestamptz,
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
  code uts.authorization_codes%ROWTYPE;
  live uts.browser_sessions%ROWTYPE;
  chosen record;
  retry boolean;
  account_state uts.account_status;
  membership_state uts.membership_status;
  member_role uts.org_role;
  enforcement uts.sso_enforcement;
  stepped_up_at timestamptz;
  methods uts.auth_method[];
BEGIN
  PERFORM uts.require_inputs('uts.exchange_web_code',
    p_environment IS NOT NULL AND p_code_hash IS NOT NULL AND p_client_id IS NOT NULL
    AND p_redirect_uri IS NOT NULL AND p_code_challenge IS NOT NULL
    AND p_assertion_jkt IS NOT NULL AND p_assertion_jti IS NOT NULL
    AND p_assertion_expires_at IS NOT NULL AND p_handle_hash IS NOT NULL);
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO code FROM uts.authorization_codes AS stored WHERE stored.code_hash = p_code_hash
  FOR UPDATE;
  IF NOT FOUND
    OR code.expires_at <= now()
    OR code.client_id IS DISTINCT FROM p_client_id
    OR code.client_kind IS DISTINCT FROM 'first_party'
    OR code.dpop_jkt IS NOT NULL
    OR code.browser_session_id IS NULL
    OR code.redirect_uri IS DISTINCT FROM p_redirect_uri
    OR code.code_challenge IS DISTINCT FROM p_code_challenge
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  retry := code.status = 'consumed';

  SELECT * INTO chosen FROM uts.select_token_scopes(code.scopes, p_scopes, p_resources);
  IF chosen.outcome <> 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  IF uts.scopes_need_step_up(chosen.scopes) THEN
    outcome := 'invalid_scope';
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
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.role_allows_scopes(chosen.scopes, member_role) THEN
    outcome := 'invalid_scope';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO live FROM uts.browser_sessions AS session
  WHERE session.id = code.browser_session_id AND session.account_id = code.account_id
  FOR UPDATE;
  IF NOT FOUND
    OR live.status <> 'active'
    OR live.idle_expires_at <= now()
    OR live.expires_at <= now()
    OR uts.subject_revoked_since(live.account_id, live.created_at)
    OR (retry AND live.handle_hash IS DISTINCT FROM p_handle_hash)
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT retry THEN
    UPDATE uts.authorization_codes AS stored
    SET status = 'consumed', consumed_at = now(), grant_id = live.id
    WHERE stored.code_hash = p_code_hash;
    SELECT max(step.completed_at) INTO stepped_up_at
    FROM uts.step_ups AS step
    WHERE step.account_id = code.account_id
      AND step.browser_session_id = live.id
      AND step.completed_at > code.auth_time
      AND step.completed_at <= code.created_at;
    methods := CASE
      WHEN stepped_up_at IS NULL OR 'passkey' = ANY (code.amr) THEN code.amr
      ELSE code.amr || 'passkey'::uts.auth_method
    END;
    UPDATE uts.browser_sessions AS session
    SET handle_hash = p_handle_hash,
      handle_issued_at = now(),
      handle_auth_time = greatest(code.auth_time, stepped_up_at),
      handle_amr = methods,
      last_seen_at = now(),
      idle_expires_at = least(session.expires_at, now() + interval '14 days')
    WHERE session.id = live.id
    RETURNING * INTO live;
  END IF;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, code.account_id,
    jsonb_build_object(
      'grantType', 'authorization_code',
      'clientId', uts.audit_client_id(code.client_id),
      'clientKind', 'confidential_web',
      'sessionId', live.id,
      'rotation', CASE WHEN retry THEN 'code_retry' ELSE 'session_handle' END,
      'codeRef', uts.credential_reference(p_code_hash),
      'handleRef', uts.credential_reference(p_handle_hash),
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(chosen.scopes),
      'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
      'tokenLifetimeSeconds', uts.token_lifetimes(chosen.scopes),
      'org', code.org_id
    )
  );
  outcome := 'issued';
  subject_id := code.account_id;
  web_session_id := live.id;
  signed_in_at := live.handle_auth_time;
  sign_in_methods := live.handle_amr::text[];
  sso_connection := live.sso_connection_id;
  sso_organization := live.sso_organization_id;
  handle_issued := live.handle_issued_at;
  idle_end := least(live.idle_expires_at, live.expires_at);
  session_end := live.expires_at;
  token_scopes := chosen.scopes;
  bound_org_id := code.org_id;
  org_role := member_role;
  RETURN NEXT;
END
$$;

-- POST /account/browser-sessions/read: the live session a handle names. It moves no clock and
-- writes no audit row. Outcomes: `active`, `invalid_session`, `assertion_replay`.
CREATE FUNCTION uts.read_web_session(
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz
) RETURNS TABLE (
  outcome text,
  subject_id text,
  web_session_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  sso_connection text,
  sso_organization text,
  handle_issued timestamptz,
  idle_end timestamptz,
  session_end timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live uts.browser_sessions%ROWTYPE;
BEGIN
  PERFORM uts.require_inputs('uts.read_web_session',
    p_handle_hash IS NOT NULL AND p_assertion_jkt IS NOT NULL AND p_assertion_jti IS NOT NULL
    AND p_assertion_expires_at IS NOT NULL);
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
  outcome := 'active';
  subject_id := live.account_id;
  web_session_id := live.id;
  signed_in_at := live.handle_auth_time;
  sign_in_methods := live.handle_amr::text[];
  sso_connection := live.sso_connection_id;
  sso_organization := live.sso_organization_id;
  handle_issued := live.handle_issued_at;
  idle_end := least(live.idle_expires_at, live.expires_at);
  session_end := live.expires_at;
  RETURN NEXT;
END
$$;

-- POST /account/browser-sessions/token: one access token for `p_scope` from the live session,
-- with its audit row; the idle clock moves forward at most once per 5 minutes. A scope that needs
-- a step-up (`p_step_up`) needs a passkey in the handle's sign-in within the last 10 minutes,
-- else `step_up_required` and nothing is written. Outcomes: `issued`, `invalid_session`,
-- `step_up_required`, `assertion_replay`.
CREATE FUNCTION uts.mint_web_session_token(
  p_environment text,
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz,
  p_scope text,
  p_step_up boolean
) RETURNS TABLE (
  outcome text,
  subject_id text,
  web_session_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  token_ids uuid[],
  token_scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live uts.browser_sessions%ROWTYPE;
  scope uts.scope := p_scope;
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
      'tokenLifetimeSeconds', uts.token_lifetimes(token_scopes)
    )
  );
  outcome := 'issued';
  subject_id := live.account_id;
  web_session_id := live.id;
  signed_in_at := live.handle_auth_time;
  sign_in_methods := live.handle_amr::text[];
  RETURN NEXT;
END
$$;

-- POST /account/browser-sessions/end: ends the session a handle names, with its `session` feed
-- entry and audit row; never another session and never `revoked_before`. A repeat, or a stored
-- handle of a session that ended, answers `already_ended`; both return the session's entries
-- still in the feed. A handle that names no stored session (never issued, or replaced by a later
-- exchange of its session) answers `invalid_session`, so a sign-out with a stale handle is never
-- told the session ended while it lives on under its new handle. Outcomes: `ended`,
-- `already_ended`, `invalid_session`, `assertion_replay`.
CREATE FUNCTION uts.end_web_session(
  p_environment text,
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz
) RETURNS TABLE (outcome text, web_session_id uuid, feed_entries jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  named uts.browser_sessions%ROWTYPE;
BEGIN
  PERFORM uts.require_inputs('uts.end_web_session',
    p_environment IS NOT NULL AND p_handle_hash IS NOT NULL AND p_assertion_jkt IS NOT NULL
    AND p_assertion_jti IS NOT NULL AND p_assertion_expires_at IS NOT NULL);
  feed_entries := '[]'::jsonb;
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO named FROM uts.browser_sessions AS session WHERE session.handle_hash = p_handle_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF named.status = 'active' THEN
    UPDATE uts.browser_sessions AS session
    SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
    WHERE session.id = named.id;
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    VALUES ('session', named.id::text, now() + interval '20 minutes')
    ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO NOTHING;
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.session.revoked', 3002, 2, 'success', NULL, named.account_id,
      jsonb_build_object(
        'clientId', 'kilo-web',
        'sessionKind', 'browser',
        'sessionId', named.id,
        'reason', 'sign_out',
        'extent', 'current_session',
        'ended', 1
      )
    );
    outcome := 'ended';
    web_session_id := named.id;
  ELSE
    outcome := 'already_ended';
  END IF;
  feed_entries := uts.live_feed_entries('session', ARRAY[named.id::text]);
  RETURN NEXT;
END
$$;

-- POST /account/browser-sessions/end-all: ends every active browser session of the subject whose
-- live handle the call names, the current one included, with one `session` feed entry each and
-- one audit row; never `revoked_before`, so CLI and mobile grants stay. A handle that is no
-- longer live ends nothing (`ended` 0) and returns the entries of the batch that ended its
-- session, when one did, so a caller that got 503 can publish them again. Outcomes: `ended`,
-- `assertion_replay`.
CREATE FUNCTION uts.end_all_web_sessions(
  p_environment text,
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz
) RETURNS TABLE (outcome text, ended integer, feed_entries jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  named uts.browser_sessions%ROWTYPE;
  ended_ids uuid[];
BEGIN
  PERFORM uts.require_inputs('uts.end_all_web_sessions',
    p_environment IS NOT NULL AND p_handle_hash IS NOT NULL AND p_assertion_jkt IS NOT NULL
    AND p_assertion_jti IS NOT NULL AND p_assertion_expires_at IS NOT NULL);
  ended := 0;
  feed_entries := '[]'::jsonb;
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'ended';
  SELECT * INTO named FROM uts.live_web_session(p_handle_hash);
  IF FOUND THEN
    WITH ended_rows AS (
      UPDATE uts.browser_sessions AS session
      SET status = 'revoked', revoked_at = now(), revoke_reason = 'sign_out'
      WHERE session.account_id = named.account_id AND session.status = 'active'
      RETURNING session.id
    ), fed AS (
      INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
      SELECT 'session', ended_rows.id::text, now() + interval '20 minutes' FROM ended_rows
      ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO NOTHING
    )
    SELECT coalesce(array_agg(ended_rows.id), '{}') INTO ended_ids FROM ended_rows;
    ended := cardinality(ended_ids);
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.session.revoked', 3002, 2, 'success', NULL, named.account_id,
      jsonb_build_object(
        'clientId', 'kilo-web',
        'sessionKind', 'browser',
        'sessionId', named.id,
        'reason', 'sign_out',
        'extent', 'all_browser_sessions',
        'ended', ended
      )
    );
  ELSE
    -- The batch that ended this handle's session: the session entries written at its end time
    -- (one probe of `revocations_revoked_at_idx`), kept to this subject's sessions.
    SELECT * INTO named FROM uts.browser_sessions AS session
    WHERE session.handle_hash = p_handle_hash AND session.status = 'revoked';
    IF FOUND THEN
      ended_ids := ARRAY(
        SELECT other.id
        FROM uts.revocations AS entry
        JOIN uts.browser_sessions AS other ON other.id = entry.subject_id::uuid
        WHERE entry.kind = 'session'
          AND entry.revoked_at = named.revoked_at
          AND other.account_id = named.account_id
      );
    END IF;
  END IF;
  IF ended_ids IS NOT NULL THEN
    feed_entries := uts.live_feed_entries('session', ended_ids::text[]);
  END IF;
  RETURN NEXT;
END
$$;

-- POST /account/devices/revoke: ends one first-party (CLI or mobile) grant of the caller's
-- subject, named by its grant id or its device session id, with its `grant` feed entry and an
-- audit row; other grants, browser sessions and PATs stay, and `revoked_before` is never written.
-- A `sid` of another subject, or of nothing, changes nothing. Outcomes: `ended`,
-- `invalid_session`, `assertion_replay`; `ended` returns the grants' entries still in the feed.
CREATE FUNCTION uts.revoke_web_device(
  p_environment text,
  p_handle_hash bytea,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz,
  p_sid uuid
) RETURNS TABLE (outcome text, feed_entries jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  caller uts.browser_sessions%ROWTYPE;
  grant_ids uuid[];
  revoked_ids uuid[] := '{}';
  grant_id uuid;
BEGIN
  PERFORM uts.require_inputs('uts.revoke_web_device',
    p_environment IS NOT NULL AND p_handle_hash IS NOT NULL AND p_assertion_jkt IS NOT NULL
    AND p_assertion_jti IS NOT NULL AND p_assertion_expires_at IS NOT NULL AND p_sid IS NOT NULL);
  feed_entries := '[]'::jsonb;
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO caller FROM uts.live_web_session(p_handle_hash);
  IF NOT FOUND THEN
    outcome := 'invalid_session';
    RETURN NEXT;
    RETURN;
  END IF;
  grant_ids := ARRAY(
    SELECT grant_row.id FROM uts.refresh_grants AS grant_row
    WHERE grant_row.account_id = caller.account_id
      AND (grant_row.id = p_sid OR grant_row.device_session_id = p_sid)
    ORDER BY grant_row.id
  );
  FOREACH grant_id IN ARRAY grant_ids LOOP
    IF uts.end_grant('first_party', grant_id, 'user_revoke') IS NOT NULL THEN
      revoked_ids := revoked_ids || grant_id;
    END IF;
  END LOOP;
  IF cardinality(revoked_ids) > 0 THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, 'success', NULL, caller.account_id,
      jsonb_build_object(
        'clientId', 'kilo-web',
        'clientKind', 'first_party',
        'grantIds', to_jsonb(revoked_ids::text[]),
        'sessionId', caller.id,
        'reason', 'user_revoke'
      )
    );
  END IF;
  outcome := 'ended';
  feed_entries := uts.live_feed_entries('grant', grant_ids::text[]);
  RETURN NEXT;
END
$$;

-- The RFC 8693 legacy bridge for `kilo-web`: a browser session for an existing account, with the
-- legacy session's sign-in time and `amr` `legacy_session` (plus `sso` only when the bridge's
-- authority check confirmed the WorkOS ids), never a fresh sign-in. The subject token's `jti` is
-- recorded like the assertion's, so it is accepted once. Refused (`invalid_grant`) for a replayed
-- subject token, an unknown or blocked account, or a subject-wide revocation at or after the
-- legacy sign-in. Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `assertion_replay`.
CREATE FUNCTION uts.bridge_legacy_session(
  p_environment text,
  p_account_id text,
  p_auth_time timestamptz,
  p_sso_connection text,
  p_sso_organization text,
  p_assertion_jkt bytea,
  p_assertion_jti text,
  p_assertion_expires_at timestamptz,
  p_subject_jkt bytea,
  p_subject_jti text,
  p_subject_expires_at timestamptz,
  p_handle_hash bytea,
  p_scopes text[]
) RETURNS TABLE (
  outcome text,
  subject_id text,
  web_session_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  sso_connection text,
  sso_organization text,
  handle_issued timestamptz,
  idle_end timestamptz,
  session_end timestamptz,
  token_ids uuid[],
  token_scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_state uts.account_status;
  methods uts.auth_method[];
  legacy_time timestamptz := least(p_auth_time, now());
  created uts.browser_sessions%ROWTYPE;
BEGIN
  PERFORM uts.require_inputs('uts.bridge_legacy_session',
    p_environment IS NOT NULL AND p_account_id IS NOT NULL AND p_auth_time IS NOT NULL
    AND p_assertion_jkt IS NOT NULL AND p_assertion_jti IS NOT NULL
    AND p_assertion_expires_at IS NOT NULL AND p_subject_jkt IS NOT NULL AND p_subject_jti IS NOT NULL
    AND p_subject_expires_at IS NOT NULL AND p_handle_hash IS NOT NULL AND p_scopes IS NOT NULL
    AND (p_sso_organization IS NULL OR p_sso_connection IS NOT NULL));
  IF NOT uts.accept_client_assertion(p_assertion_jkt, p_assertion_jti, p_assertion_expires_at) THEN
    outcome := 'assertion_replay';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.accept_client_assertion(p_subject_jkt, p_subject_jti, p_subject_expires_at) THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = p_account_id;
  IF account_state IS DISTINCT FROM 'active'
    OR uts.subject_revoked_since(p_account_id, legacy_time)
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.is_scope_set(p_scopes) OR NOT uts.role_allows_scopes(p_scopes, NULL)
    OR uts.scopes_need_step_up(p_scopes)
  THEN
    outcome := 'invalid_scope';
    RETURN NEXT;
    RETURN;
  END IF;
  methods := CASE
    WHEN p_sso_connection IS NULL THEN ARRAY['legacy_session']::uts.auth_method[]
    ELSE ARRAY['legacy_session', 'sso']::uts.auth_method[]
  END;
  -- The BFF calls from its own servers, so the request's address is not the browser's: the row
  -- keeps no network.
  INSERT INTO uts.browser_sessions (
    account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, handle_hash,
    handle_issued_at, handle_auth_time, handle_amr, sso_connection_id, sso_organization_id
  ) VALUES (
    p_account_id, NULL, legacy_time, methods, now() + interval '14 days', now() + interval '30 days',
    p_handle_hash, now(), legacy_time, methods, p_sso_connection, p_sso_organization
  ) RETURNING * INTO created;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(p_scopes)));
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.session.created', 3002, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'method', 'legacy_session',
      'sessionKind', 'browser',
      'sessionId', created.id,
      'clientId', 'kilo-web',
      'ssoVerified', p_sso_connection IS NOT NULL,
      'handleRef', uts.credential_reference(p_handle_hash),
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(p_scopes),
      'audiences', to_jsonb(uts.scope_audiences(p_scopes)),
      'tokenLifetimeSeconds', uts.token_lifetimes(p_scopes)
    )
  );
  outcome := 'issued';
  subject_id := p_account_id;
  web_session_id := created.id;
  signed_in_at := created.handle_auth_time;
  sign_in_methods := created.handle_amr::text[];
  sso_connection := created.sso_connection_id;
  sso_organization := created.sso_organization_id;
  handle_issued := created.handle_issued_at;
  idle_end := least(created.idle_expires_at, created.expires_at);
  session_end := created.expires_at;
  token_scopes := p_scopes;
  RETURN NEXT;
END
$$;

-- The provider sign-in of migration 0009 plus the WorkOS organization of the verified profile:
-- an SSO sign-in records the profile's connection and organization on its new browser session in
-- the same statement. The 0009 signature stays for the migration's own tests and is no longer
-- granted to the app login.
CREATE FUNCTION uts.complete_provider_sign_in(
  p_environment text,
  p_state_hash bytea,
  p_binder_hash bytea,
  p_provider uts.sign_in_provider,
  p_subject text,
  p_email text,
  p_email_proven boolean,
  p_workos_connection_id text,
  p_workos_organization_id text,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text,
  p_new_account_id text
) RETURNS TABLE (
  outcome text,
  flow_return_to text,
  session_id uuid,
  session_account text,
  signed_in_at timestamptz,
  account_created boolean,
  method_linked boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  completed record;
BEGIN
  SELECT * INTO completed FROM uts.complete_provider_sign_in(
    p_environment, p_state_hash, p_binder_hash, p_provider, p_subject, p_email, p_email_proven,
    p_workos_connection_id, p_session_token_hash, p_user_agent, p_client_ip, p_asn, p_country,
    p_city, p_new_account_id
  );
  IF completed.outcome = 'signed_in' AND p_provider = 'workos' THEN
    UPDATE uts.browser_sessions AS session
    SET sso_connection_id = p_workos_connection_id, sso_organization_id = p_workos_organization_id
    WHERE session.id = completed.session_id;
  END IF;
  outcome := completed.outcome;
  flow_return_to := completed.flow_return_to;
  session_id := completed.session_id;
  session_account := completed.session_account;
  signed_in_at := completed.signed_in_at;
  account_created := completed.account_created;
  method_linked := completed.method_linked;
  RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION uts.complete_provider_sign_in(
  text, bytea, bytea, uts.sign_in_provider, text, text, boolean, text, bytea, text, inet, integer,
  text, text, text
) FROM uts_app;

GRANT EXECUTE ON FUNCTION
  uts.exchange_web_code(
    text, bytea, text, text, text, bytea, text, timestamptz, bytea, text[], text[]
  ),
  uts.read_web_session(bytea, bytea, text, timestamptz),
  uts.mint_web_session_token(text, bytea, bytea, text, timestamptz, text, boolean),
  uts.end_web_session(text, bytea, bytea, text, timestamptz),
  uts.end_all_web_sessions(text, bytea, bytea, text, timestamptz),
  uts.revoke_web_device(text, bytea, bytea, text, timestamptz, uuid),
  uts.bridge_legacy_session(
    text, text, timestamptz, text, text, bytea, text, timestamptz, bytea, text, timestamptz, bytea,
    text[]
  ),
  uts.complete_provider_sign_in(
    text, bytea, bytea, uts.sign_in_provider, text, text, boolean, text, text, bytea, text, inet,
    integer, text, text, text
  )
TO uts_app;
