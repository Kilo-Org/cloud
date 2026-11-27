-- The home-widget grant (design sections 5.5 and 9.3; `@kilocode/uts-contracts`, `home-widget.ts`).
-- Every file before this one is applied somewhere, so changed functions are replaced here rather
-- than edited in place.
--
-- * A widget grant is a first-party refresh grant that the mobile app's grant created through the
--   token endpoint's RFC 8693 exchange (`uts.exchange_home_widget_grant`). It names that grant in
--   `parent_grant_id`, shares its device session and DPoP key, holds only
--   `kilo-api:home-widget.use`, and expires no later than the app grant's idle expiry at the time
--   of the exchange. The widget refreshes it with the ordinary `uts.refresh_first_party`.
-- * One app grant holds at most one live widget grant: an exchange revokes the previous one
--   (reason `replaced`), and an app grant creates at most 10 widget grants in any hour, because
--   each revoked grant holds a feed entry for 20 minutes.
-- * `uts.end_grant` also ends the live widget grant of the grant it ends, so a sign-out, a device
--   revoke, a reuse detection, a member removal or a subject operation that ends the app grant
--   ends the widget with it, each with its own feed entry, and writes the widget's own
--   `grant.revoked` audit row (system actor, the app grant's reason) under the environment the
--   widget grant recorded at its exchange (`audit_environment`). Ending the widget grant alone
--   leaves the app grant and its device session as they are.
-- * A device revoke (`uts.revoke_web_device`) that names the app grant also names its widget
--   grants, and answers with the feed entries its statement wrote, the widget's included, so the
--   widget's entry is published before the call succeeds. A `/revoke` retry of an app grant that
--   is already revoked publishes its widget grants' live entries too
--   (`uts.live_feed_entries_of_refresh_token`).
-- * A widget grant records no device sign-in (no `uts.sign_ins` row, no new-device notice): the
--   device signed in when its app grant was created.
-- * `uts.issue_ticket` refuses a widget grant: a ticket carries no scope, so a ticket of a widget
--   grant could open more than the widget's one scope.
--
-- Locks: every path takes the account row before the membership row, the membership row before
-- the app grant, and the app grant before its widget grant. The exchange reads the app grant's
-- account and organization without a lock, then locks the account (`FOR KEY SHARE`, the lock the
-- widget grant's insert would take through its foreign key), then, for a personal app grant that
-- names an organization, the membership row (`FOR SHARE`), and only then the app grant
-- (`FOR NO KEY UPDATE`), which it checks again from scratch. A subject operation or a membership
-- sync locks the account (`FOR UPDATE`) and a member removal the membership row before either
-- reaches `uts.end_grant`; `uts.end_grant` of an app grant revokes it (its row lock) before its
-- widget, and of a widget grant locks the app grant (`FOR NO KEY UPDATE`) before the widget. So
-- no two of these, a device-revoke loop over both grants in either order included, wait on each
-- other in a cycle. An end of the app grant waits for an exchange in flight and then sees and
-- ends the new widget grant; a membership removal or subject operation that arrives while an
-- exchange holds its first lock waits for it and then revokes the new widget grant; two
-- exchanges of one app grant run one after the other (design 5.8).

SET LOCAL ROLE uts_owner;

ALTER TYPE uts.revoke_reason ADD VALUE 'replaced';

ALTER TABLE uts.refresh_grants
  ADD COLUMN parent_grant_id uuid REFERENCES uts.refresh_grants (id) ON DELETE CASCADE,
  ADD COLUMN audit_environment text
    CHECK (audit_environment IN ('development', 'staging', 'production')),
  ADD CONSTRAINT refresh_grants_widget_shape CHECK (
    (parent_grant_id IS NULL) = (audit_environment IS NULL)
    AND (
      parent_grant_id IS NULL
      OR (
        parent_grant_id <> id
        AND client_class = 'mobile'
        AND allowed_scopes = ARRAY['kilo-api:home-widget.use']::text[]
      )
    )
  );

-- At most one live widget grant per app grant; `uts.end_grant` finds it with one probe.
CREATE UNIQUE INDEX refresh_grants_live_widget_key ON uts.refresh_grants (parent_grant_id)
  WHERE parent_grant_id IS NOT NULL AND status = 'active';
-- The exchange's hourly count, one range probe; it also serves the foreign key's checks.
CREATE INDEX refresh_grants_parent_created_idx ON uts.refresh_grants (parent_grant_id, created_at)
  WHERE parent_grant_id IS NOT NULL;

CREATE OR REPLACE TRIGGER refresh_grants_record_sign_in
  AFTER INSERT ON uts.refresh_grants
  FOR EACH ROW WHEN (NEW.parent_grant_id IS NULL)
  EXECUTE FUNCTION uts.record_device_sign_in();

-- As in 0004, plus two steps. A widget grant first locks its app grant (see the lock order above).
-- A first-party grant's live widget grant ends with it, with its own feed entry and audit row,
-- after the grant itself is revoked and before its device session is checked, so the session ends
-- once neither grant is live.
CREATE OR REPLACE FUNCTION uts.end_grant(
  p_kind uts.client_kind,
  p_grant_id uuid,
  p_reason uts.revoke_reason
) RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  revoked_account text;
  session_id uuid;
  app_grant_id uuid;
  widget record;
BEGIN
  IF p_kind = 'first_party' THEN
    SELECT grant_row.parent_grant_id INTO app_grant_id
    FROM uts.refresh_grants AS grant_row WHERE grant_row.id = p_grant_id;
    IF app_grant_id IS NOT NULL THEN
      PERFORM 1 FROM uts.refresh_grants AS app_grant
      WHERE app_grant.id = app_grant_id
      FOR NO KEY UPDATE;
    END IF;
    UPDATE uts.refresh_grants AS grant_row
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE grant_row.id = p_grant_id AND grant_row.status = 'active'
    RETURNING grant_row.account_id, grant_row.device_session_id INTO revoked_account, session_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT widget_row.id, widget_row.account_id, widget_row.client_id, widget_row.audit_environment
    INTO widget
    FROM uts.refresh_grants AS widget_row
    WHERE widget_row.parent_grant_id = p_grant_id AND widget_row.status = 'active';
    IF FOUND THEN
      IF uts.end_grant('first_party', widget.id, p_reason) IS NOT NULL THEN
        PERFORM uts.write_system_audit_event(
          widget.audit_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, widget.account_id,
          jsonb_build_object(
            'clientId', uts.audit_client_id(widget.client_id),
            'clientKind', 'first_party',
            'grantId', widget.id,
            'parentGrantId', p_grant_id,
            'reason', p_reason
          )
        );
      END IF;
    END IF;
    UPDATE uts.device_sessions AS session
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE session.id = session_id
      AND session.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM uts.refresh_grants AS other
        WHERE other.device_session_id = session_id AND other.status = 'active'
      );
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    VALUES ('grant', p_grant_id::text, now() + interval '20 minutes')
    ON CONFLICT (kind, subject_id) DO NOTHING;
  ELSE
    UPDATE uts.third_party_grant_families AS family
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE family.id = p_grant_id AND family.status = 'active'
    RETURNING family.account_id INTO revoked_account;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    VALUES ('third_party_family', p_grant_id::text, now() + interval '20 minutes')
    ON CONFLICT (kind, subject_id) DO NOTHING;
  END IF;
  RETURN revoked_account;
END
$$;

-- `uts.issue_ticket()` as 0020 left it, plus one refusal: a widget grant mints no ticket
-- (`invalid_grant`), one primary-key probe of the grant row it already read. The return type and
-- the grant stay.
CREATE OR REPLACE FUNCTION uts.issue_ticket(
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
  PERFORM uts.require_inputs(
    'uts.issue_ticket',
    p_environment IS NOT NULL AND p_token_hash IS NOT NULL AND p_grant_id IS NOT NULL
      AND p_client_id IS NOT NULL AND p_dpop_jkt IS NOT NULL AND p_dpop_jti IS NOT NULL
      AND p_ticket_hash IS NOT NULL AND p_purpose IS NOT NULL AND p_audience IS NOT NULL
  );
  IF p_purpose = 'sign_in' THEN
    RAISE EXCEPTION 'a sign-in ticket is not minted from a grant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO grant_row FROM uts.read_refresh_grant(p_token_hash);
  IF NOT FOUND
    OR grant_row.id IS DISTINCT FROM p_grant_id
    OR grant_row.client_id IS DISTINCT FROM p_client_id
    OR grant_row.grant_status IS DISTINCT FROM 'active'
    OR grant_row.session_status IS DISTINCT FROM 'active'
    OR grant_row.account_status IS DISTINCT FROM 'active'
    OR NOT coalesce(grant_row.expires_at > now(), false)
    OR NOT coalesce(grant_row.idle_expires_at > now(), false)
    OR EXISTS (
      SELECT 1 FROM uts.refresh_grants AS widget
      WHERE widget.id = grant_row.id AND widget.parent_grant_id IS NOT NULL
    )
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF grant_row.dpop_jkt IS DISTINCT FROM p_dpop_jkt THEN
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
  INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
  VALUES (grant_row.dpop_jkt, p_dpop_jti, now() + interval '121 seconds')
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
  IF NOT coalesce(p_audience = ANY (uts.scope_audiences(grant_row.allowed_scopes)), false) THEN
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

-- POST /token, the home-widget exchange: the mobile app's grant (`p_parent_token_hash`, proven by a
-- DPoP proof of its key) creates the widget grant `p_widget_grant_id` and its first token.
-- Outcomes, checked in order:
-- * `invalid_grant`: no live `kilo-mobile` grant of an active account and device session with
--   this token, id and client; a widget grant as the subject; or the app grant's own organization
--   requirement no longer met;
-- * `dpop_mismatch`: the proof's key is not the grant's (one denied audit row per grant per
--   minute); `dpop_replay`: the proof's `jti` was recorded under the key before;
-- * `invalid_scope`: the scope is not `kilo-api:home-widget.use`, or the app grant does not list it;
-- * `rate_limited`: the app grant created 10 widget grants in the last hour; `retry_after_seconds`
--   is the wait until the oldest of them leaves the hour;
-- * `org_denied`: an organization other than the app grant's own, or, for a personal app grant,
--   an organization without an active membership or whose SSO requirement the device session's
--   sign-in does not meet;
-- * `issued`: the previous live widget grant of the app grant is revoked (`replaced`, with its
--   feed entry and one `grant.revoked` audit row), the widget grant is stored with one
--   `grant.created` audit row, and the row carries what the first token's claims need.
CREATE FUNCTION uts.exchange_home_widget_grant(
  p_environment text,
  p_parent_token_hash bytea,
  p_parent_grant_id uuid,
  p_client_id text,
  p_dpop_jkt bytea,
  p_dpop_jti text,
  p_widget_grant_id uuid,
  p_widget_token_hash bytea,
  p_scope text,
  p_org_id uuid
) RETURNS TABLE (
  outcome text,
  subject_id text,
  bound_org_id uuid,
  signed_in_at timestamptz,
  sign_in_methods text[],
  token_ids uuid[],
  token_scopes text[],
  refresh_expires_at timestamptz,
  org_role uts.org_role,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent record;
  widget_org uuid;
  member_state uts.membership_status;
  member_role uts.org_role;
  enforcement uts.sso_enforcement;
  created_in_hour integer;
  oldest_in_hour timestamptz;
  replaced_id uuid;
  located record;
BEGIN
  PERFORM uts.require_inputs('uts.exchange_home_widget_grant',
    p_environment IS NOT NULL AND p_parent_token_hash IS NOT NULL AND p_parent_grant_id IS NOT NULL
    AND p_client_id IS NOT NULL AND p_dpop_jkt IS NOT NULL AND p_dpop_jti IS NOT NULL
    AND p_widget_grant_id IS NOT NULL AND p_widget_token_hash IS NOT NULL AND p_scope IS NOT NULL);
  -- Locks in the order account, membership, app grant (see the header). The app grant's account
  -- and organization come first, read without a lock; every check below runs on the row read
  -- under the app grant's lock, since the grant may change before that lock is taken.
  SELECT grant_row.account_id, grant_row.org_id INTO located
  FROM uts.refresh_grants AS grant_row WHERE grant_row.token_hash = p_parent_token_hash;
  IF NOT FOUND THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = located.account_id FOR KEY SHARE;
  IF located.org_id IS NULL AND p_org_id IS NOT NULL THEN
    PERFORM 1 FROM uts.org_memberships AS membership
    WHERE membership.org_id = p_org_id AND membership.account_id = located.account_id
    FOR SHARE;
  END IF;
  SELECT grant_row.id, grant_row.account_id, grant_row.device_session_id, grant_row.client_id,
    grant_row.client_class, grant_row.dpop_jkt, grant_row.allowed_scopes, grant_row.org_id,
    grant_row.idle_expires_at, grant_row.expires_at, grant_row.status AS grant_status,
    grant_row.parent_grant_id, session.status AS session_status, session.auth_time, session.amr,
    account.status AS account_status, membership.status AS membership_status,
    policy.enforcement AS sso_enforcement, membership.role AS membership_role
  INTO parent
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = grant_row.org_id AND membership.account_id = grant_row.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = grant_row.org_id
  WHERE grant_row.token_hash = p_parent_token_hash
  FOR NO KEY UPDATE OF grant_row;
  IF NOT FOUND
    OR parent.id IS DISTINCT FROM p_parent_grant_id
    OR parent.client_id IS DISTINCT FROM p_client_id
    OR parent.client_id IS DISTINCT FROM 'kilo-mobile'
    OR parent.client_class IS DISTINCT FROM 'mobile'
    OR parent.parent_grant_id IS NOT NULL
    OR parent.grant_status IS DISTINCT FROM 'active'
    OR parent.session_status IS DISTINCT FROM 'active'
    OR parent.account_status IS DISTINCT FROM 'active'
    OR NOT coalesce(parent.expires_at > now(), false)
    OR NOT coalesce(parent.idle_expires_at > now(), false)
  THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF parent.dpop_jkt IS DISTINCT FROM p_dpop_jkt THEN
    IF uts.claim_denied_audit('first_party', parent.id) THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.token.denied', 6003, 1, 'denied', 'dpop key mismatch',
        parent.account_id,
        jsonb_build_object(
          'grantType', 'token_exchange',
          'clientId', uts.audit_client_id(parent.client_id),
          'grantId', parent.id
        )
      );
    END IF;
    outcome := 'dpop_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
  VALUES (parent.dpop_jkt, p_dpop_jti, now() + interval '121 seconds')
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  IF NOT FOUND THEN
    outcome := 'dpop_replay';
    RETURN NEXT;
    RETURN;
  END IF;

  IF uts.org_requirement_met(
    parent.org_id, parent.membership_status, parent.sso_enforcement, parent.amr
  ) IS NOT TRUE THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_scope IS DISTINCT FROM 'kilo-api:home-widget.use'
    OR NOT coalesce(p_scope = ANY (parent.allowed_scopes), false)
  THEN
    outcome := 'invalid_scope';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT count(*)::integer, min(widget.created_at) INTO created_in_hour, oldest_in_hour
  FROM uts.refresh_grants AS widget
  WHERE widget.parent_grant_id = parent.id AND widget.created_at > now() - interval '1 hour';
  IF created_in_hour >= 10 THEN
    outcome := 'rate_limited';
    retry_after_seconds := greatest(
      1, ceil(extract(epoch FROM oldest_in_hour + interval '1 hour' - now()))::integer
    );
    RETURN NEXT;
    RETURN;
  END IF;

  IF parent.org_id IS NOT NULL THEN
    IF p_org_id IS NOT NULL AND p_org_id IS DISTINCT FROM parent.org_id THEN
      outcome := 'org_denied';
      RETURN NEXT;
      RETURN;
    END IF;
    widget_org := parent.org_id;
    member_role := parent.membership_role;
  ELSIF p_org_id IS NOT NULL THEN
    SELECT membership.status, membership.role, policy.enforcement
    INTO member_state, member_role, enforcement
    FROM uts.org_memberships AS membership
    LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = membership.org_id
    WHERE membership.org_id = p_org_id AND membership.account_id = parent.account_id
    FOR SHARE OF membership;
    IF uts.org_requirement_met(p_org_id, member_state, enforcement, parent.amr) IS NOT TRUE THEN
      outcome := 'org_denied';
      RETURN NEXT;
      RETURN;
    END IF;
    widget_org := p_org_id;
  END IF;
  IF NOT uts.role_allows_scopes(ARRAY[p_scope], member_role) THEN
    outcome := 'invalid_scope';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT widget.id INTO replaced_id
  FROM uts.refresh_grants AS widget
  WHERE widget.parent_grant_id = parent.id AND widget.status = 'active';
  IF FOUND THEN
    IF uts.end_grant('first_party', replaced_id, 'replaced') IS NOT NULL THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, 'success', NULL, parent.account_id,
        jsonb_build_object(
          'clientId', uts.audit_client_id(parent.client_id),
          'clientKind', 'first_party',
          'grantId', replaced_id,
          'parentGrantId', parent.id,
          'reason', 'replaced'
        )
      );
    END IF;
  END IF;

  INSERT INTO uts.refresh_grants (
    id, account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt,
    allowed_scopes, org_id, idle_expires_at, expires_at, parent_grant_id, audit_environment
  ) VALUES (
    p_widget_grant_id, parent.account_id, parent.device_session_id, parent.client_id, 'mobile',
    p_widget_token_hash, parent.dpop_jkt, ARRAY[p_scope], widget_org, parent.idle_expires_at,
    parent.idle_expires_at, parent.id, p_environment
  );

  token_ids := ARRAY[gen_random_uuid()];
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.grant.created', 3002, 1, 'success', NULL, parent.account_id,
    jsonb_build_object(
      'grantType', 'token_exchange',
      'clientId', uts.audit_client_id(parent.client_id),
      'clientKind', 'first_party',
      'grantId', p_widget_grant_id,
      'parentGrantId', parent.id,
      'parentRefreshRef', uts.credential_reference(p_parent_token_hash),
      'refreshRef', uts.credential_reference(p_widget_token_hash),
      'tokenRefs', to_jsonb(token_ids::text[]),
      'scopes', to_jsonb(ARRAY[p_scope]),
      'audiences', to_jsonb(uts.scope_audiences(ARRAY[p_scope])),
      'tokenLifetimeSeconds', uts.token_lifetimes(ARRAY[p_scope]),
      'org', widget_org
    )
  );
  outcome := 'issued';
  subject_id := parent.account_id;
  bound_org_id := widget_org;
  signed_in_at := parent.auth_time;
  sign_in_methods := parent.amr::text[];
  token_scopes := ARRAY[p_scope];
  refresh_expires_at := parent.idle_expires_at;
  org_role := member_role;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION uts.exchange_home_widget_grant(
  text, bytea, uuid, text, bytea, text, uuid, bytea, text, uuid
) TO uts_app;

-- `uts.revoke_web_device()` as 0013 left it, with two changes: a `sid` that names an app grant
-- also names its widget grants, and the answer carries the feed entries the statement wrote
-- (`uts.feed_entries_of_statement()`), a widget grant that ended with its app grant included, so
-- the caller publishes every entry before it answers. A repeat that revokes nothing answers the
-- entries still in the feed, as before. The return type and the grant stay.
CREATE OR REPLACE FUNCTION uts.revoke_web_device(
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
      AND (
        grant_row.id = p_sid
        OR grant_row.device_session_id = p_sid
        OR grant_row.parent_grant_id = p_sid
      )
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
  feed_entries := CASE
    WHEN cardinality(revoked_ids) > 0 THEN uts.feed_entries_of_statement()
    ELSE uts.live_feed_entries('grant', grant_ids::text[])
  END;
  RETURN NEXT;
END
$$;

-- `uts.live_feed_entries_of_refresh_token()` as 0019 left it, plus the live entries of the widget
-- grants of a first-party grant (one probe of `refresh_grants_parent_created_idx`), so a `/revoke`
-- retry of an app grant republishes its widget's entry too. The grant stays.
CREATE OR REPLACE FUNCTION uts.live_feed_entries_of_refresh_token(p_token_hash bytea, p_client_id text)
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
  ) || coalesce(
    (
      SELECT uts.live_feed_entries('grant', array_agg(widget.id::text))
      FROM uts.refresh_grants AS app_grant
      JOIN uts.refresh_grants AS widget ON widget.parent_grant_id = app_grant.id
      WHERE app_grant.token_hash = p_token_hash AND app_grant.client_id = p_client_id
    ),
    '[]'::jsonb
  )
$$;
