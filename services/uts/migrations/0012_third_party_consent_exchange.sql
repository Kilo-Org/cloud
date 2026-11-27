-- Third-party clients, consent and the broker exchange (design sections 5.3 and 5.9).
--
-- * A third-party client registers by its Client ID Metadata Document. The Worker fetches the
--   document and caches it in `uts.third_party_clients` with plain statements of the app login,
--   which already holds the table's DML; a blocked client keeps its status through every refresh.
-- * Consent is a gated row (design 5.11, tier B "approve a third-party client"):
--   `uts.grant_third_party_consent` writes the consumed gate pass, the consent, the in-app notice
--   and the audit row in one statement, from the user's browser session.
-- * `uts.withdraw_third_party_consent` revokes a consent and ends every live grant family under
--   it, each with its `third_party_family` feed entry, which the caller reads back in the same
--   statement and publishes. It never writes a subject-wide `revoked_before`.
-- * `uts.exchange_delegated_token` is the store step of the RFC 8693 broker exchange: one
--   statement that checks the subject's grant (a consent family or a first-party grant), its
--   consent, the subject-wide and key revocations, and writes the `token.exchanged` audit row with
--   the new token's id. The success path takes no row lock; a refusal writes at most one denied
--   row per grant per minute.

SET LOCAL ROLE uts_owner;

-- The scopes a token of `p_scope` may be exchanged for (`delegatesTo` in `UTS_SCOPE_REGISTRY`). It
-- mirrors the registry, as `uts.scope_org_roles` does; `test/db/third-party.test.ts` checks that
-- both agree for every registered scope.
CREATE FUNCTION uts.delegated_scopes(p_scope text) RETURNS text[]
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE $1
    WHEN 'kilo-mcp:catalog.read' THEN ARRAY['kilo-api:mcp.read']
    ELSE '{}'::text[]
  END
$$;

-- As in 0005, with the 5-minute scopes of this migration: `pages-dev:tools.use` and the exchange
-- scope `kilo-api:mcp.read`.
CREATE OR REPLACE FUNCTION uts.token_lifetimes(p_scopes text[]) RETURNS jsonb
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT to_jsonb(ARRAY(
    SELECT CASE item.scope
      WHEN 'user-data-export:exports.dispatch' THEN '300'
      WHEN 'user-data-export:exports.download' THEN '300'
      WHEN 'git-token-service:github-user-authorizations.disconnect' THEN '300'
      WHEN 'pages-dev:tools.use' THEN '300'
      WHEN 'kilo-api:mcp.read' THEN '300'
      ELSE '600'
    END
    FROM unnest($1) WITH ORDINALITY AS item(scope, position)
    ORDER BY item.position
  ))
$$;

-- The consent page's approval (design 5.9, 5.11). The user signed in to the browser session the
-- cookie names; approving a third-party client is a tier B action: a sign-in of this session within
-- 10 minutes, or a passkey step-up of it within 10 minutes. Outcomes, checked in order:
-- * `no_session`: the cookie names no live session of an active account;
-- * `unknown_client`: the client is not cached or is blocked;
-- * `org_denied`: the request names an organization in which the account has no active
--   membership;
-- * `granted`: an active consent of the account for this client, organization and exactly this
--   scope set existed already (a second submit of the page), or this call wrote one;
-- * `gate_required`: the session meets no tier B check (one denied row per session per minute).
-- The account row is locked first, so two submits of one account run one after the other and the
-- second finds the first one's consent.
CREATE FUNCTION uts.grant_third_party_consent(
  p_environment text,
  p_session_token_hash bytea,
  p_client_id text,
  p_org_id uuid,
  p_scopes text[]
) RETURNS TABLE (outcome text, consent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  checks uts.gate_check[];
  pass_id uuid;
  event_id uuid;
BEGIN
  PERFORM uts.require_inputs(
    'uts.grant_third_party_consent',
    num_nulls(p_environment, p_session_token_hash, p_client_id, p_scopes) = 0
  );
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM uts.third_party_clients AS client
    WHERE client.client_id = p_client_id AND client.status = 'active'
  ) THEN
    outcome := 'unknown_client';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM 1 FROM uts.accounts AS account WHERE account.id = live.account_id FOR NO KEY UPDATE;
  IF p_org_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM uts.org_memberships AS membership
    WHERE membership.org_id = p_org_id
      AND membership.account_id = live.account_id
      AND membership.status = 'active'
  ) THEN
    outcome := 'org_denied';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT consent.id INTO consent_id
  FROM uts.third_party_consents AS consent
  WHERE consent.account_id = live.account_id
    AND consent.client_id = p_client_id
    AND consent.org_id IS NOT DISTINCT FROM p_org_id
    AND consent.scopes = p_scopes
    AND consent.status = 'active';
  IF FOUND THEN
    outcome := 'granted';
    RETURN NEXT;
    RETURN;
  END IF;

  checks := uts.tier_b_checks(live.account_id, live.id, NULL);
  IF checks IS NULL OR cardinality(checks) = 0 THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, 'third_party_approve',
      'sign-in or passkey check required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.gate_passes (
    account_id, browser_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
  ) VALUES (
    live.account_id, live.id, 'b', 'third_party_approve', checks, now() + interval '10 minutes',
    'consumed', now()
  ) RETURNING id INTO pass_id;
  INSERT INTO uts.third_party_consents (account_id, client_id, org_id, scopes, gate_pass_id)
  VALUES (live.account_id, p_client_id, p_org_id, p_scopes, pass_id)
  RETURNING id INTO consent_id;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.consent.granted', 3002, 1, 'success', NULL, live.account_id,
    jsonb_build_object(
      'clientId', uts.audit_client_id(p_client_id),
      'clientKind', 'third_party',
      'consentId', consent_id,
      'gatePassId', pass_id,
      'gateChecks', to_jsonb(checks::text[]),
      'scopes', to_jsonb(p_scopes),
      'org', p_org_id,
      'sessionId', live.id
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    live.account_id, 'third_party_client_approved',
    jsonb_build_object('clientId', uts.audit_client_id(p_client_id)),
    event_id
  );
  outcome := 'granted';
  RETURN NEXT;
END
$$;

-- The consents page: the active consents of the account the cookie names, newest first, with the
-- client's name. No row when the cookie names no live session; one row with every column null
-- when the account holds no active consent. One probe of `browser_sessions_token_hash_key`, then
-- the account's consents.
CREATE FUNCTION uts.list_third_party_consents(p_session_token_hash bytea)
RETURNS TABLE (
  consent_id uuid,
  client_id text,
  client_name text,
  scopes text[],
  org_id uuid,
  granted_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT consent.id, consent.client_id, client.client_name, consent.scopes, consent.org_id,
    consent.granted_at
  FROM uts.live_browser_session($1) AS live
  LEFT JOIN (
    uts.third_party_consents AS consent
    JOIN uts.third_party_clients AS client ON client.client_id = consent.client_id
  ) ON consent.account_id = live.account_id AND consent.status = 'active'
  ORDER BY consent.granted_at DESC NULLS LAST, consent.id
  LIMIT 200
$$;

CREATE INDEX third_party_consents_account_idx ON uts.third_party_consents (account_id)
  WHERE status = 'active';

-- Withdraws one consent of the account the cookie names (design 5.9): the consent is revoked and
-- every live grant family under it ends (`uts.end_grant`, reason `user_revoke`), each with its
-- `third_party_family` feed entry, so every access token of those families stops at the verifiers
-- within the feed bound. Outcomes: `withdrawn` with the number of families it ended; `not_found`
-- when the consent is not an active consent of that account (already withdrawn, another
-- account's, unknown); `no_session`.
CREATE FUNCTION uts.withdraw_third_party_consent(
  p_environment text,
  p_session_token_hash bytea,
  p_consent_id uuid
) RETURNS TABLE (outcome text, ended_families integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  withdrawn_client text;
  family_id uuid;
BEGIN
  PERFORM uts.require_inputs(
    'uts.withdraw_third_party_consent',
    num_nulls(p_environment, p_session_token_hash, p_consent_id) = 0
  );
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.third_party_consents AS consent
  SET status = 'revoked', revoked_at = now()
  WHERE consent.id = p_consent_id
    AND consent.account_id = live.account_id
    AND consent.status = 'active'
  RETURNING consent.client_id INTO withdrawn_client;
  IF NOT FOUND THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;
  ended_families := 0;
  FOR family_id IN
    SELECT family.id FROM uts.third_party_grant_families AS family
    WHERE family.consent_id = p_consent_id AND family.status = 'active'
    ORDER BY family.id
    FOR UPDATE
  LOOP
    IF uts.end_grant('third_party', family_id, 'user_revoke') IS NOT NULL THEN
      ended_families := ended_families + 1;
    END IF;
  END LOOP;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.consent.withdrawn', 3002, 4, 'success', NULL, live.account_id,
    jsonb_build_object(
      'clientId', uts.audit_client_id(withdrawn_client),
      'clientKind', 'third_party',
      'consentId', p_consent_id,
      'endedFamilies', ended_families,
      'sessionId', live.id
    )
  );
  outcome := 'withdrawn';
  RETURN NEXT;
END
$$;

-- POST /token with the RFC 8693 token exchange, after the Worker verified the caller's STS token,
-- the subject token's signature, audience, lifetime and claims, and the requested scope against
-- the registry. One statement, no row lock on success. The subject's grant is `p_grant_id` (the
-- token's `sid`): a third-party consent family of `p_client_id`, or a first-party refresh grant of
-- `p_client_id`. Outcomes:
-- * `issued`, with the id of the one token the caller signs, after the `token.exchanged` audit
--   row that names it, the actor and the subject token;
-- * `invalid_grant`: the grant is not a live grant of this account and client with this
--   organization (ended, expired, its device session ended, its client blocked, the account not
--   active), the subject was revoked at or after the subject token's `iat`, or its signing key was
--   revoked;
-- * `invalid_scope`: the grant does not hold the subject scope, the requested scope is not one the
--   subject scope delegates to (`uts.delegated_scopes`), or, for a third-party client, the grant's
--   consent is not active or does not hold the subject scope.
-- A refusal writes one denied audit row per grant per minute at most (`uts.claim_denied_audit`).
CREATE FUNCTION uts.exchange_delegated_token(
  p_environment text,
  p_client_kind uts.client_kind,
  p_account_id text,
  p_client_id text,
  p_grant_id uuid,
  p_org_id uuid,
  p_subject_scope text,
  p_subject_issued_at timestamptz,
  p_subject_token_id uuid,
  p_subject_kid text,
  p_scope text,
  p_actor text,
  p_lifetime_seconds integer
) RETURNS TABLE (outcome text, token_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_live boolean;
  scope_held boolean;
  consented boolean;
  refusal text;
BEGIN
  PERFORM uts.require_inputs(
    'uts.exchange_delegated_token',
    num_nulls(
      p_environment, p_client_kind, p_account_id, p_client_id, p_grant_id, p_subject_scope,
      p_subject_issued_at, p_subject_token_id, p_subject_kid, p_scope, p_actor,
      p_lifetime_seconds
    ) = 0
  );
  IF p_lifetime_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'a delegated token lives 1 to 300 seconds' USING ERRCODE = '22023';
  END IF;

  IF p_client_kind = 'third_party' THEN
    SELECT
      family.status = 'active' AND family.expires_at > now()
        AND client.status = 'active' AND account.status = 'active'
        AND family.org_id IS NOT DISTINCT FROM p_org_id,
      family.scopes @> ARRAY[p_subject_scope],
      consent.status = 'active' AND consent.scopes @> ARRAY[p_subject_scope]
    INTO grant_live, scope_held, consented
    FROM uts.third_party_grant_families AS family
    JOIN uts.third_party_consents AS consent ON consent.id = family.consent_id
    JOIN uts.third_party_clients AS client ON client.client_id = family.client_id
    JOIN uts.accounts AS account ON account.id = family.account_id
    WHERE family.id = p_grant_id
      AND family.account_id = p_account_id
      AND family.client_id = p_client_id;
  ELSE
    -- A first-party scope needs no consent (design 5.9).
    SELECT
      grant_row.status = 'active' AND grant_row.expires_at > now()
        AND grant_row.idle_expires_at > now() AND session.status = 'active'
        AND account.status = 'active' AND grant_row.org_id IS NOT DISTINCT FROM p_org_id,
      grant_row.allowed_scopes @> ARRAY[p_subject_scope],
      true
    INTO grant_live, scope_held, consented
    FROM uts.refresh_grants AS grant_row
    JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
    JOIN uts.accounts AS account ON account.id = grant_row.account_id
    WHERE grant_row.id = p_grant_id
      AND grant_row.account_id = p_account_id
      AND grant_row.client_id = p_client_id;
  END IF;

  refusal := CASE
    WHEN grant_live IS NOT TRUE THEN 'invalid_grant'
    -- The feed's `revoked_before` holds whole seconds; a token issued in that second or before
    -- is revoked, as the verifiers decide.
    WHEN EXISTS (
      SELECT 1 FROM uts.revocations AS entry
      WHERE entry.kind = 'subject'
        AND entry.subject_id = p_account_id
        AND date_trunc('second', entry.revoked_before) >= p_subject_issued_at
    ) THEN 'invalid_grant'
    WHEN EXISTS (
      SELECT 1 FROM uts.revocations AS entry
      WHERE entry.kind = 'kid' AND entry.subject_id = p_subject_kid
    ) THEN 'invalid_grant'
    WHEN scope_held IS NOT TRUE
      OR consented IS NOT TRUE
      OR NOT (p_scope = ANY (uts.delegated_scopes(p_subject_scope)))
    THEN 'invalid_scope'
  END;

  IF refusal IS NOT NULL THEN
    IF uts.claim_denied_audit(p_client_kind, p_grant_id) THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.token.exchange_refused', 6003, 1, 'denied', refusal,
        p_account_id,
        jsonb_build_object(
          'grantType', 'token_exchange',
          'clientId', uts.audit_client_id(p_client_id),
          'clientKind', p_client_kind,
          'grantId', p_grant_id,
          'actor', p_actor,
          'subjectTokenRef', p_subject_token_id::text,
          'scopes', to_jsonb(ARRAY[p_scope])
        )
      );
    END IF;
    outcome := refusal;
    RETURN NEXT;
    RETURN;
  END IF;

  token_id := gen_random_uuid();
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.exchanged', 6003, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'grantType', 'token_exchange',
      'clientId', uts.audit_client_id(p_client_id),
      'clientKind', p_client_kind,
      'grantId', p_grant_id,
      'actor', p_actor,
      'subjectTokenRef', p_subject_token_id::text,
      'subjectScope', p_subject_scope,
      'tokenRefs', to_jsonb(ARRAY[token_id::text]),
      'scopes', to_jsonb(ARRAY[p_scope]),
      'audiences', to_jsonb(uts.scope_audiences(ARRAY[p_scope])),
      'tokenLifetimeSeconds', to_jsonb(ARRAY[p_lifetime_seconds::text]),
      'org', p_org_id
    )
  );
  outcome := 'issued';
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.grant_third_party_consent(text, bytea, text, uuid, text[]),
  uts.list_third_party_consents(bytea),
  uts.withdraw_third_party_consent(text, bytea, uuid),
  uts.exchange_delegated_token(
    text, uts.client_kind, text, text, uuid, uuid, text, timestamptz, uuid, text, text, text,
    integer
  )
TO uts_app;
