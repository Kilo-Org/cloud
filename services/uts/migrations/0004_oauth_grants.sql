-- OAuth grants (design sections 5.2 to 5.6, 8.1 and 8.2): authorization codes, first-party refresh
-- grants, third-party refresh rotation with reuse detection, revocation and introspection.
--
-- * Every credential write is one call of a SECURITY DEFINER function, and each call writes the
--   credential rows and their audit row in the same statement, so they commit together. The app
--   role loses direct writes on the tables these functions own, so no grant, code, device session
--   or revocation can change without its audit row.
-- * The functions read a grant through one unique-index probe on its hash plus primary-key probes
--   (`uts.read_refresh_grant`, `uts.read_third_party_refresh_token`,
--   `uts.read_rotated_third_party_token`; `test/db/index-probes.test.ts` plans their bodies).
-- * `refresh_grants.last_used_at` and `idle_expires_at` move at most once per grant per hour.
-- * Each statement that accepts a DPoP proof records the proof's `jti` under the proof's key
--   (`uts.dpop_proofs`), so a proof is accepted once (RFC 9449 section 11.1, design 5.7).
-- * An audit row never holds a token value: a JWT is named by its `jti`, an opaque value by the
--   first 8 characters of the base64url SHA-256 hash (`uts.credential_reference`).
-- * A refused attempt on a grant (a DPoP key that is not the grant's, a revoke by another client)
--   writes at most one denied audit row per grant per minute (`uts.claim_denied_audit`, design
--   8.1), so a caller that holds a token cannot grow the audit log at will.
-- * A revocation writes its feed entry (`uts.revocations`) in the same statement. A `grant` or
--   `third_party_family` entry stays 20 minutes: the last access token of the grant expires at
--   most 10 minutes after the revocation, and the feed keeps an entry 10 minutes past that.

SET LOCAL ROLE uts_owner;

-- A third-party code carries the consent it was approved under; a consumed code names the grant
-- or family it created, so a second use of the code can revoke that grant (RFC 6749, 4.1.2).
ALTER TABLE uts.authorization_codes
  ADD COLUMN consent_id uuid REFERENCES uts.third_party_consents (id) ON DELETE CASCADE,
  ADD COLUMN grant_id uuid,
  ADD CONSTRAINT authorization_codes_consent_shape
    CHECK ((client_kind = 'third_party') = (consent_id IS NOT NULL)),
  ADD CONSTRAINT authorization_codes_grant_shape
    CHECK ((status = 'consumed') = (grant_id IS NOT NULL));
CREATE INDEX authorization_codes_consent_idx ON uts.authorization_codes (consent_id)
  WHERE consent_id IS NOT NULL;

-- The `jti` of every DPoP proof a statement accepted, under the RFC 7638 thumbprint of the
-- proof's key. A token-endpoint proof names its key, its method and its URL (`htm`, `htu`), not a
-- grant, so the key is the scope of its `jti`: one device key can hold several grants, and a proof
-- accepted for one of them must not be accepted for another. The Worker accepts a proof only at
-- the endpoint its `htu` names, so the key and the `jti` identify one proof at one endpoint. The
-- primary key refuses a second use of a proof. A proof's `iat` is at most 60 seconds ahead of the
-- Worker clock and is accepted until 60 seconds after it, so no clock accepts a proof 2 minutes
-- after the statement that took it; the row stays 1 second longer.
CREATE TABLE uts.dpop_proofs (
  jkt uts.sha256 NOT NULL,
  jti text NOT NULL CHECK (length(jti) BETWEEN 16 AND 128),
  expires_at timestamptz NOT NULL,
  CONSTRAINT dpop_proofs_pkey PRIMARY KEY (jkt, jti)
);
GRANT SELECT ON uts.dpop_proofs TO uts_app;

-- The tokens a third-party rotation replaced (design 5.4): the evidence that a replaced token
-- comes back, which revokes its family. A row stays until its family can no longer issue tokens
-- (`family_expires_at`, at most 90 days after the family began), so a client that returns late
-- with a token a thief replaced still revokes the thief's chain. A revoked family's rows stay
-- until then too; its tokens already fail on the family's status. The key is the first 16 bytes
-- of the token's SHA-256 (`uts.rotated_token_key`), so a row with its two index entries takes
-- about 120 bytes, and 128 bits keep the chance that an unknown token matches a stored key
-- negligible; a live token is always found first, by its whole hash, in
-- `third_party_refresh_tokens`. No foreign key: a cascade from the family would need an index on
-- `family_id` beside every row, and a row whose family was deleted with its account names nothing
-- and goes at its expiry.
CREATE TABLE uts.third_party_rotated_tokens (
  token_key uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  family_expires_at timestamptz NOT NULL
);
CREATE INDEX third_party_rotated_tokens_expires_idx
  ON uts.third_party_rotated_tokens (family_expires_at);
GRANT SELECT ON uts.third_party_rotated_tokens TO uts_app;

-- The tombstone key of a third-party refresh token hash: its first 16 bytes as a uuid.
CREATE FUNCTION uts.rotated_token_key(p_hash bytea) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN encode(substring(p_hash FROM 1 FOR 16), 'hex')::uuid;

-- When the grant's last denied audit row was written (`uts.claim_denied_audit`).
ALTER TABLE uts.refresh_grants ADD COLUMN denied_audited_at timestamptz;
ALTER TABLE uts.third_party_grant_families ADD COLUMN denied_audited_at timestamptz;

-- The audit reference of an opaque credential: the first 8 characters of the base64url SHA-256
-- hash (design section 8.2). It is never a lookup key.
CREATE FUNCTION uts.credential_reference(p_hash bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN left(translate(encode(p_hash, 'base64'), '+/', '-_'), 8);

-- A client id as an audit attribute, which holds at most 512 bytes. A longer metadata URL is
-- named by its base64url SHA-256 instead.
CREATE FUNCTION uts.audit_client_id(p_client_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN CASE
  WHEN octet_length(p_client_id) <= 512 THEN p_client_id
  ELSE 'sha256:' || rtrim(translate(encode(sha256(convert_to(p_client_id, 'UTF8')), 'base64'), '+/', '-_'), '=')
END;

-- Refuses a call whose required inputs are not all present. In SQL a comparison with NULL is
-- NULL, and `IF NOT <comparison>` treats NULL like false, so a guard would let a NULL input
-- through. Each grant function below calls this before its first read, with every input it
-- needs; its guards also accept only a TRUE match (`IS DISTINCT FROM`, `IS NOT TRUE`).
CREATE FUNCTION uts.require_inputs(p_function text, p_present boolean) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_present IS NOT TRUE THEN
    RAISE EXCEPTION '%: a required input is missing', p_function
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
END
$$;

-- The audience of each scope, in the same order (a scope is `<audience>:<permission>`).
CREATE FUNCTION uts.scope_audiences(p_scopes text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN ARRAY(
  SELECT split_part(scope.name, ':', 1)
  FROM unnest(p_scopes) WITH ORDINALITY AS scope(name, position)
  ORDER BY scope.position
);

-- Writes one UTS audit row: a CloudEvents 1.0 envelope with an OCSF payload, as
-- `uts.is_audit_event` and `AuditEventSchema` accept it. The actor is the subject account.
-- Attributes with a NULL value are left out.
CREATE FUNCTION uts.write_audit_event(
  p_environment text,
  p_type text,
  p_class integer,
  p_activity integer,
  p_outcome text,
  p_outcome_detail text,
  p_account_id text,
  p_attributes jsonb
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_event_id uuid := gen_random_uuid();
  envelope jsonb;
BEGIN
  envelope := jsonb_build_object(
    'specversion', '1.0',
    'id', new_event_id,
    'source', 'kilo:uts:' || p_environment,
    'type', p_type,
    'time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'datacontenttype', 'application/json',
    'data', jsonb_build_object(
      'classUid', p_class,
      'activityId', p_activity,
      'outcome', p_outcome,
      'actor', jsonb_build_object('kind', 'user', 'id', p_account_id),
      'attributes', jsonb_strip_nulls(p_attributes)
    ) || CASE
      WHEN p_outcome_detail IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('outcomeDetail', p_outcome_detail)
    END
  );
  INSERT INTO uts.audit_events (event_id, event_type, account_id, event)
  VALUES (new_event_id, p_type, p_account_id, envelope);
  RETURN new_event_id;
END
$$;

-- Picks the scopes of the tokens one call mints, one token per scope. `p_requested` NULL means
-- every granted scope (RFC 6749, section 6); `p_resources` (RFC 8707 audiences) NULL means no
-- audience filter. `invalid_target` when a resource names no chosen scope or a chosen scope's
-- audience is not a named resource; `invalid_scope` when the choice is empty, over 8 tokens,
-- repeats a scope, or holds a scope outside the grant.
CREATE FUNCTION uts.select_token_scopes(p_granted text[], p_requested text[], p_resources text[])
RETURNS TABLE (outcome text, scopes text[])
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH chosen AS (
    SELECT coalesce(
      $2,
      ARRAY(
        SELECT granted.name
        FROM unnest($1) WITH ORDINALITY AS granted(name, position)
        WHERE $3 IS NULL OR split_part(granted.name, ':', 1) = ANY ($3)
        ORDER BY granted.position
      )
    ) AS names
  )
  SELECT
    CASE
      WHEN $3 IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM unnest(chosen.names) AS scope(name)
          WHERE split_part(scope.name, ':', 1) <> ALL ($3)
        )
        OR EXISTS (
          SELECT 1 FROM unnest($3) AS resource(audience)
          WHERE resource.audience <> ALL (uts.scope_audiences(chosen.names))
        )
      ) THEN 'invalid_target'
      WHEN cardinality(chosen.names) NOT BETWEEN 1 AND 8
        OR NOT (chosen.names <@ $1)
        OR cardinality(chosen.names) <> (SELECT count(DISTINCT scope.name) FROM unnest(chosen.names) AS scope(name))
      THEN 'invalid_scope'
      ELSE 'ok'
    END,
    chosen.names
  FROM chosen
$$;

-- Design section 5.8: an org-bound grant needs an active membership, and an org that requires SSO
-- needs a sign-in through SSO.
CREATE FUNCTION uts.org_requirement_met(
  p_org_id uuid,
  p_membership uts.membership_status,
  p_enforcement uts.sso_enforcement,
  p_amr uts.auth_method[]
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN p_org_id IS NULL
  OR (p_membership IS NOT DISTINCT FROM 'active'
    AND (p_enforcement IS DISTINCT FROM 'required' OR 'sso' = ANY (p_amr)));

-- The mint and first-party refresh read: one probe of `refresh_grants_token_hash_key`, then
-- primary-key probes of the device session, the account, the membership and the SSO policy.
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
  sso_enforcement uts.sso_enforcement
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
    policy.enforcement
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = grant_row.org_id AND membership.account_id = grant_row.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = grant_row.org_id
  WHERE grant_row.token_hash = $1
$$;

-- The third-party refresh read: one probe of `third_party_refresh_tokens_token_hash_key`, then
-- primary-key probes. It locks the token and its family, so the rotations of one family run one
-- after another.
CREATE FUNCTION uts.read_third_party_refresh_token(p_token_hash bytea)
RETURNS TABLE (
  token_idle_expires_at timestamptz,
  family_id uuid,
  account_id text,
  client_id text,
  scopes text[],
  org_id uuid,
  auth_time timestamptz,
  amr uts.auth_method[],
  family_expires_at timestamptz,
  family_status uts.grant_status,
  client_status uts.client_status,
  consent_status uts.credential_status,
  account_status uts.account_status,
  membership_status uts.membership_status,
  sso_enforcement uts.sso_enforcement
)
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  -- The client, the membership and the policy are scalar subqueries, so each is one primary-key
  -- probe with its keys known; as outer joins beside the locked rows the planner may pick another
  -- index.
  SELECT token.idle_expires_at, family.id,
    family.account_id, family.client_id, family.scopes, family.org_id, family.auth_time,
    family.amr, family.expires_at, family.status,
    (SELECT client.status FROM uts.third_party_clients AS client
     WHERE client.client_id = family.client_id),
    consent.status, account.status,
    (SELECT membership.status FROM uts.org_memberships AS membership
     WHERE membership.org_id = family.org_id AND membership.account_id = family.account_id),
    (SELECT policy.enforcement FROM uts.org_sso_policies AS policy
     WHERE policy.org_id = family.org_id)
  FROM uts.third_party_refresh_tokens AS token
  JOIN uts.third_party_grant_families AS family ON family.id = token.family_id
  JOIN uts.third_party_consents AS consent ON consent.id = family.consent_id
  JOIN uts.accounts AS account ON account.id = family.account_id
  WHERE token.token_hash = $1
  FOR UPDATE OF token, family
$$;

-- The family of a replaced third-party token, read when the hash is not a current token: one
-- probe of `third_party_rotated_tokens_pkey`, then `third_party_grant_families_pkey`. It locks the
-- family, so a reuse and a rotation of one family run one after another.
CREATE FUNCTION uts.read_rotated_third_party_token(p_token_hash bytea)
RETURNS TABLE (
  family_id uuid,
  account_id text,
  client_id text,
  family_expires_at timestamptz,
  family_status uts.grant_status
)
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT family.id, family.account_id, family.client_id, family.expires_at, family.status
  FROM uts.third_party_rotated_tokens AS rotated
  JOIN uts.third_party_grant_families AS family ON family.id = rotated.family_id
  WHERE rotated.token_key = uts.rotated_token_key($1)
  FOR UPDATE OF family
$$;

-- Revokes one grant and writes its feed entry. A first-party grant also ends its device session
-- once no active grant of that session is left. A third-party family's tokens keep their rows:
-- every reader of a token checks its family's status, so revoking a family writes one row however
-- many tokens it holds. Returns the grant's account when this call revoked it, NULL when it was
-- revoked already.
CREATE FUNCTION uts.end_grant(p_kind uts.client_kind, p_grant_id uuid, p_reason uts.revoke_reason)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  revoked_account text;
  session_id uuid;
BEGIN
  IF p_kind = 'first_party' THEN
    UPDATE uts.refresh_grants AS grant_row
    SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
    WHERE grant_row.id = p_grant_id AND grant_row.status = 'active'
    RETURNING grant_row.account_id, grant_row.device_session_id INTO revoked_account, session_id;
    IF NOT FOUND THEN
      RETURN NULL;
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

-- Blocking a third-party client (design 5.9) is the status change alone: every statement that
-- reads a family also checks its client, so code exchange, refresh and introspection stop at
-- once. `uts.maintain_oauth_rows()` then ends the client's live families in batches, each with
-- its feed entry, so its access tokens stop at the verifiers too and an unblock brings no family
-- back. Ending them in the blocking statement would grow with the client's families and hold
-- every family row lock until it ends. The status change writes its own audit row, with the
-- operator as the actor (design 8.1); the batches write none.
CREATE INDEX third_party_grant_families_client_idx ON uts.third_party_grant_families (client_id)
  WHERE status = 'active';
CREATE INDEX third_party_clients_blocked_idx ON uts.third_party_clients (client_id)
  WHERE status = 'blocked';

-- Whether a refused attempt on a grant writes its denied audit row: true for the first refusal in
-- a minute, which claims that minute; false while the grant's last denied row is under a minute
-- old, so refusals in between write no row.
CREATE FUNCTION uts.claim_denied_audit(p_kind uts.client_kind, p_grant_id uuid) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_kind = 'first_party' THEN
    UPDATE uts.refresh_grants AS grant_row SET denied_audited_at = now()
    WHERE grant_row.id = p_grant_id
      AND (grant_row.denied_audited_at IS NULL
        OR grant_row.denied_audited_at <= now() - interval '1 minute');
  ELSE
    UPDATE uts.third_party_grant_families AS family SET denied_audited_at = now()
    WHERE family.id = p_grant_id
      AND (family.denied_audited_at IS NULL
        OR family.denied_audited_at <= now() - interval '1 minute');
  END IF;
  RETURN FOUND;
END
$$;

-- GET /authorize, after the hand-off approved: stores a 60-second code (PKCE S256, and the DPoP
-- key thumbprint for a first-party client) and its audit row. Outcomes: `issued`;
-- `access_denied` for an inactive account or an unmet org requirement; `consent_required` for a
-- third-party client without an active consent that covers the scopes.
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
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_state uts.account_status;
  membership_state uts.membership_status;
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
    SELECT membership.status, policy.enforcement INTO membership_state, enforcement
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
  RETURN NEXT;
END
$$;

-- POST /token with `authorization_code`: consumes the code and creates the grant in one
-- statement. A first-party client gets a device session and a DPoP-bound refresh grant (the code
-- and the proof must name the same key, and the proof's `jti` is recorded under that key); a
-- third-party client gets a grant family and its first rotating refresh token. The caller derives
-- the new grant id from the code, so every attempt with one code names one grant; the grant id is
-- the `sid` of every token.
--
-- A retry (design 5.4), first party only: when signing, or anything else after this statement
-- committed, failed, the client sends the same request again. The same first-party client,
-- redirect URI, PKCE challenge and DPoP key presenting the consumed code while the code's
-- 60-second lifetime lasts get the same grant, the same refresh token and new access tokens, and
-- the code is not counted as reused; the DPoP key and a fresh proof `jti` show it is the same
-- client instance. The Worker derives the refresh token from the code and the PKCE verifier
-- (`firstPartyRefreshTokenOfExchange`), so a retry presents the hash the grant already holds and
-- the statement changes no hash: when the first attempt also answered, both answers carry the one
-- valid refresh token, whichever arrives last. A retry with another hash is refused and changes
-- nothing. The retry writes a `token.issued` row (`rotation` `code_retry`) instead of
-- a second `grant.created`. Any other use of a consumed code (another client, redirect URI,
-- verifier or key, after the code's lifetime, or any second use by a third-party client, whose
-- only proof is the PKCE verifier) revokes the grant it created and fails (OAuth 2.1 section
-- 4.1.2, RFC 6749 section 4.1.2). A third-party client that lost its response authorizes again;
-- its consent stands, so it sees no consent screen.
--
-- The audit row lists the `jti` each token will carry: the Worker signs the tokens after the
-- statement commits, so a failed signing leaves ids no token carries, and the retry lists new ids.
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
  refresh_expires_at timestamptz
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
    SELECT membership.status, policy.enforcement INTO membership_state, enforcement
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
        'tokenLifetimeSeconds', 600,
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
        'tokenLifetimeSeconds', 600,
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
  RETURN NEXT;
END
$$;

-- POST /token with `refresh_token` for a first-party client: the caller verified the DPoP proof
-- and passes its key thumbprint, which must be the grant's, and its `jti`, which the statement
-- records under the key. A mismatch writes a denied audit row; a recorded `jti` is a replay.
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
  token_scopes text[]
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
      'tokenLifetimeSeconds', 600,
      'org', grant_row.org_id
    )
  );
  outcome := 'issued';
  subject_id := grant_row.account_id;
  bound_org_id := grant_row.org_id;
  signed_in_at := grant_row.auth_time;
  sign_in_methods := grant_row.amr::text[];
  token_scopes := chosen.scopes;
  RETURN NEXT;
END
$$;

-- POST /token with `refresh_token` for a third-party client: rotation with reuse detection
-- (design sections 5.3 and 5.4). The current token rotates to `p_new_token_hash`, and its hash
-- becomes a tombstone (`uts.third_party_rotated_tokens`) until the family can no longer issue
-- tokens. A third-party client has no sender constraint, so a replaced token that comes back is
-- treated as stolen, whoever presents it: the statement revokes the whole family, writes the feed
-- entry and a denied audit row, and fails. There is no grace for a replaced token: a grace would
-- hand a fresh token, which outlives the grace, to a second holder of a just-replaced token. A
-- client that lost a rotation response authorizes again; its consent stands, so it sees no
-- consent screen.
-- Outcomes: `issued`, `invalid_grant`, `invalid_scope`, `invalid_target`, `reuse_detected`.
CREATE FUNCTION uts.refresh_third_party(
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
      'tokenLifetimeSeconds', 600,
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

-- POST /revoke (RFC 7009) with a refresh token: revokes the first-party grant or the third-party
-- family it belongs to, writes the feed entry and the audit row. A replaced third-party token
-- (a tombstone) names its family too, so a client can sign out with any token it was given.
-- Outcomes: `revoked`, `already_revoked`, `unknown` (no such token), `client_mismatch` (issued
-- to another client; a denied `grant.revoked` row, at most one per grant per minute, records it).
CREATE FUNCTION uts.revoke_refresh_token(p_environment text, p_token_hash bytea, p_client_id text)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_kind uts.client_kind;
  grant_ref uuid;
  grant_account text;
  owner_client text;
  revoked_account text;
BEGIN
  PERFORM uts.require_inputs('uts.revoke_refresh_token',
    p_environment IS NOT NULL AND p_token_hash IS NOT NULL AND p_client_id IS NOT NULL);
  SELECT 'first_party', grant_row.id, grant_row.account_id, grant_row.client_id
  INTO grant_kind, grant_ref, grant_account, owner_client
  FROM uts.refresh_grants AS grant_row WHERE grant_row.token_hash = p_token_hash;
  IF NOT FOUND THEN
    SELECT 'third_party', family.id, family.account_id, family.client_id
    INTO grant_kind, grant_ref, grant_account, owner_client
    FROM uts.third_party_refresh_tokens AS token
    JOIN uts.third_party_grant_families AS family ON family.id = token.family_id
    WHERE token.token_hash = p_token_hash;
  END IF;
  IF NOT FOUND THEN
    SELECT 'third_party', family.id, family.account_id, family.client_id
    INTO grant_kind, grant_ref, grant_account, owner_client
    FROM uts.third_party_rotated_tokens AS rotated
    JOIN uts.third_party_grant_families AS family ON family.id = rotated.family_id
    WHERE rotated.token_key = uts.rotated_token_key(p_token_hash);
  END IF;
  IF NOT FOUND THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF owner_client IS DISTINCT FROM p_client_id THEN
    IF uts.claim_denied_audit(grant_kind, grant_ref) THEN
      -- The requesting client id is caller input, so the row names it by its SHA-256 only: a value
      -- the audit row's credential check refuses must not fail the statement and so tell the caller
      -- that the token exists.
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, 'denied', 'client mismatch',
        grant_account,
        jsonb_build_object(
          'clientId', uts.audit_client_id(owner_client),
          'requestingClientRef', 'sha256:' || rtrim(
            translate(encode(sha256(convert_to(p_client_id, 'UTF8')), 'base64'), '+/', '-_'), '='
          ),
          'clientKind', grant_kind,
          'grantId', grant_ref,
          'refreshRef', uts.credential_reference(p_token_hash),
          'reason', 'sign_out'
        )
      );
    END IF;
    outcome := 'client_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  revoked_account := uts.end_grant(grant_kind, grant_ref, 'sign_out');
  IF revoked_account IS NULL THEN
    outcome := 'already_revoked';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.grant.revoked', 3002, 2, 'success', NULL, revoked_account,
    jsonb_build_object(
      'clientId', uts.audit_client_id(owner_client),
      'clientKind', grant_kind,
      'grantId', grant_ref,
      'refreshRef', uts.credential_reference(p_token_hash),
      'reason', 'sign_out'
    )
  );
  outcome := 'revoked';
  RETURN NEXT;
END
$$;

-- POST /introspect (RFC 7662) with a refresh token: `active` while the token is active and was
-- issued to `p_client_id`. A first-party grant also needs the key thumbprint of a verified DPoP
-- proof, and the statement records the proof's `jti` under the key (`dpop_replay` when it was
-- recorded before). `inactive` otherwise. It writes no audit row.
CREATE FUNCTION uts.introspect_refresh_token(
  p_token_hash bytea,
  p_client_id text,
  p_dpop_jkt bytea,
  p_dpop_jti text
) RETURNS TABLE (
  outcome text,
  grant_kind uts.client_kind,
  grant_id uuid,
  subject_id text,
  granted_scopes text[],
  issued_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_row record;
BEGIN
  PERFORM uts.require_inputs('uts.introspect_refresh_token',
    p_token_hash IS NOT NULL AND p_client_id IS NOT NULL
    AND (p_dpop_jkt IS NULL) = (p_dpop_jti IS NULL));
  IF p_dpop_jkt IS NOT NULL THEN
    SELECT * INTO grant_row FROM uts.read_refresh_grant(p_token_hash);
    IF NOT FOUND
      OR grant_row.client_id IS DISTINCT FROM p_client_id
      OR grant_row.dpop_jkt IS DISTINCT FROM p_dpop_jkt
      OR grant_row.grant_status IS DISTINCT FROM 'active'
      OR grant_row.session_status IS DISTINCT FROM 'active'
      OR grant_row.account_status IS DISTINCT FROM 'active'
      OR grant_row.expires_at <= now()
      OR grant_row.idle_expires_at <= now()
      OR uts.org_requirement_met(
        grant_row.org_id, grant_row.membership_status, grant_row.sso_enforcement, grant_row.amr
      ) IS NOT TRUE
    THEN
      outcome := 'inactive';
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
    outcome := 'active';
    grant_kind := 'first_party';
    grant_id := grant_row.id;
    subject_id := grant_row.account_id;
    granted_scopes := grant_row.allowed_scopes;
    issued_at := grant_row.created_at;
    expires_at := least(grant_row.idle_expires_at, grant_row.expires_at);
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT 'third_party', family.id, family.account_id, family.scopes, token.issued_at,
    least(token.idle_expires_at, family.expires_at)
  INTO grant_kind, grant_id, subject_id, granted_scopes, issued_at, expires_at
  FROM uts.third_party_refresh_tokens AS token
  JOIN uts.third_party_grant_families AS family ON family.id = token.family_id
  JOIN uts.third_party_clients AS client ON client.client_id = family.client_id
  JOIN uts.third_party_consents AS consent ON consent.id = family.consent_id
  JOIN uts.accounts AS account ON account.id = family.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = family.org_id AND membership.account_id = family.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = family.org_id
  WHERE token.token_hash = p_token_hash
    AND family.client_id = p_client_id
    AND token.idle_expires_at > now()
    AND family.status = 'active'
    AND family.expires_at > now()
    AND client.status = 'active'
    AND consent.status = 'active'
    AND account.status = 'active'
    AND uts.org_requirement_met(family.org_id, membership.status, policy.enforcement, family.amr) IS TRUE;
  outcome := CASE WHEN FOUND THEN 'active' ELSE 'inactive' END;
  RETURN NEXT;
END
$$;

-- Deletes OAuth rows that no statement reads again, at most 5,000 of each kind per call (README,
-- "OAuth row maintenance"). The UTS cron (slice 3.9) calls it until every count is under 5,000;
-- each call is one statement, so through Hyperdrive each batch is its own short transaction. The
-- app role holds it until that cron gets its own maintenance role. It never deletes a grant, a
-- family, the current token of a live family, a tombstone of a family that can still issue
-- tokens, or a code within its lifetime:
-- * authorization codes 1 hour past their 60-second lifetime, used or not (until then a second
--   use of a used code still revokes its grant);
-- * the live families of a blocked third-party client (not a deletion: each is revoked with
--   reason `client_blocked` and its feed entry, through `third_party_clients_blocked_idx` and
--   `third_party_grant_families_client_idx`; rows a refresh holds are left for the next call);
-- * the current token of a third-party family that ended (revoked, or past its 90-day end): it
--   already fails on the family's status;
-- * tombstones of replaced third-party tokens once their family is past its 90-day end, oldest
--   first through `third_party_rotated_tokens_expires_idx`: no token of the family can be issued
--   or refreshed again, so no reuse check needs them;
-- * revocation feed entries past `feed_expires_at`;
-- * DPoP proof `jti`s past `expires_at`, which no clock accepts again.
CREATE FUNCTION uts.maintain_oauth_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  batch CONSTANT integer := 5000;
BEGIN
  WITH ended AS (
    UPDATE uts.third_party_grant_families AS family
    SET status = 'revoked', revoked_at = now(), revoke_reason = 'client_blocked'
    WHERE family.id IN (
      SELECT live.id
      FROM uts.third_party_clients AS client
      JOIN uts.third_party_grant_families AS live
        ON live.client_id = client.client_id AND live.status = 'active'
      WHERE client.status = 'blocked'
      LIMIT batch
      FOR UPDATE OF live SKIP LOCKED
    ) AND family.status = 'active'
    RETURNING family.id
  ), fed AS (
    INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
    SELECT 'third_party_family', ended.id::text, now() + interval '20 minutes' FROM ended
    ON CONFLICT ON CONSTRAINT revocations_kind_subject_key DO NOTHING
  )
  SELECT count(*)::integer INTO deleted FROM ended;
  kind := 'blocked_client_families';
  RETURN NEXT;

  DELETE FROM uts.authorization_codes AS code
  WHERE code.code_hash IN (
    SELECT stale.code_hash FROM uts.authorization_codes AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'authorization_codes';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.third_party_refresh_tokens AS token
  WHERE token.family_id IN (
    SELECT ended.family_id
    FROM uts.third_party_grant_families AS family
    JOIN uts.third_party_refresh_tokens AS ended ON ended.family_id = family.id
    WHERE family.status = 'revoked' OR family.expires_at <= now()
    LIMIT batch
  );
  kind := 'third_party_refresh_tokens';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.third_party_rotated_tokens AS rotated
  WHERE rotated.token_key IN (
    SELECT stale.token_key FROM uts.third_party_rotated_tokens AS stale
    WHERE stale.family_expires_at <= now()
    ORDER BY stale.family_expires_at
    LIMIT batch
  );
  kind := 'third_party_rotated_tokens';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.revocations AS entry
  WHERE entry.id IN (
    SELECT stale.id FROM uts.revocations AS stale WHERE stale.feed_expires_at < now() LIMIT batch
  );
  kind := 'revocations';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.dpop_proofs AS proof
  WHERE (proof.jkt, proof.jti) IN (
    SELECT stale.jkt, stale.jti FROM uts.dpop_proofs AS stale
    WHERE stale.expires_at < now()
    LIMIT batch
  );
  kind := 'dpop_proofs';
  GET DIAGNOSTICS deleted = ROW_COUNT;
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
  uts.refresh_first_party(text, bytea, uuid, text, bytea, text, text[], text[]),
  uts.refresh_third_party(text, bytea, text, bytea, text[], text[]),
  uts.revoke_refresh_token(text, bytea, text),
  uts.introspect_refresh_token(bytea, text, bytea, text),
  uts.maintain_oauth_rows()
TO uts_app;

-- The functions above are now the only writers of these tables (README, "Rules for statements").
REVOKE INSERT, UPDATE, DELETE ON
  uts.authorization_codes,
  uts.refresh_grants,
  uts.device_sessions,
  uts.third_party_grant_families,
  uts.third_party_refresh_tokens,
  uts.revocations
FROM uts_app;
