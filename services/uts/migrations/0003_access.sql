-- Privileges for the three Hyperdrive configs (design section 5.2).
--
--   uts_app     USAGE on `uts`; table DML on the credential tables; INSERT on chosen audit columns
--               and SELECT on audit rows; SELECT and UPDATE on watermarks; the partition entry
--               point. No TRUNCATE, no DDL, no role changes.
--   uts_pat     USAGE on `uts` and EXECUTE on the two lookup functions; no table privileges, so a
--               PAT login cannot read grants, sessions or codes.
--   uts_reader  USAGE on `uts_read` and SELECT on its views, which leave out every hash, DPoP key,
--               public key and client address. Its logins default to read-only transactions.

CREATE SCHEMA uts_read AUTHORIZATION uts_owner;

SET LOCAL ROLE uts_owner;

GRANT USAGE ON SCHEMA uts TO uts_app, uts_pat;

-- CHECK constraints and domains call these as the inserting role.
GRANT EXECUTE ON FUNCTION uts.is_scope(text), uts.is_scope_set(text[]), uts.is_audit_event(jsonb)
  TO uts_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  uts.accounts,
  uts.sso_connections,
  uts.sso_domains,
  uts.org_sso_policies,
  uts.org_memberships,
  uts.sign_in_methods,
  uts.passkey_credentials,
  uts.browser_sessions,
  uts.device_sessions,
  uts.gate_passes,
  uts.step_ups,
  uts.refresh_grants,
  uts.third_party_clients,
  uts.third_party_consents,
  uts.third_party_grant_families,
  uts.third_party_refresh_tokens,
  uts.authorization_codes,
  uts.device_codes,
  uts.email_codes,
  uts.email_code_limits,
  uts.tickets,
  uts.personal_access_tokens,
  uts.org_bot_keys,
  uts.ci_trust_policies,
  uts.sandbox_grants,
  uts.revocations,
  uts.notices
TO uts_app;

GRANT SELECT, INSERT (event_id, event_type, account_id, event) ON uts.audit_events TO uts_app;
GRANT SELECT, UPDATE (last_txid, last_id, last_seq, updated_at) ON uts.audit_relay_watermarks
  TO uts_app;
GRANT EXECUTE ON FUNCTION uts.maintain_audit_partitions() TO uts_app;

-- The two lookups below are the only statements the PAT config runs. Each is one probe of the
-- unique index on the token hash (plus the owner account's primary key for a PAT), and only a
-- live credential comes back; the caller treats no row as an unknown token. The bodies use `$1`
-- rather than the parameter name so `test/db/index-probes.test.ts` can plan the exact body.

-- A PAT of a blocked account finds nothing, so a block stops every PAT at once.
CREATE FUNCTION uts.lookup_pat(p_token_hash bytea)
RETURNS TABLE (
  pat_id uuid,
  account_id text,
  audience text,
  scope text,
  org_id uuid,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pat.id, pat.account_id, pat.audience, pat.scope, pat.org_id, pat.expires_at
  FROM uts.personal_access_tokens AS pat
  JOIN uts.accounts AS account ON account.id = pat.account_id
  WHERE pat.token_hash = $1
    AND pat.status = 'active'
    AND pat.expires_at > now()
    AND account.status = 'active'
$$;

-- A flagged key works until 7 days after it was flagged; `valid_until` is the earlier of that
-- cutoff and the key's expiry.
CREATE FUNCTION uts.lookup_bot_key(p_token_hash bytea)
RETURNS TABLE (
  bot_key_id uuid,
  org_id uuid,
  audience text,
  scope text,
  status uts.bot_key_status,
  valid_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    bot_key.id,
    bot_key.org_id,
    bot_key.audience,
    bot_key.scope,
    bot_key.status,
    CASE bot_key.status
      WHEN 'flagged' THEN least(bot_key.expires_at, bot_key.flagged_at + interval '7 days')
      ELSE bot_key.expires_at
    END
  FROM uts.org_bot_keys AS bot_key
  WHERE bot_key.token_hash = $1
    AND bot_key.expires_at > now()
    AND (
      bot_key.status IN ('active', 'kept')
      OR (bot_key.status = 'flagged' AND bot_key.flagged_at + interval '7 days' > now())
    )
$$;

GRANT EXECUTE ON FUNCTION uts.lookup_pat(bytea), uts.lookup_bot_key(bytea) TO uts_pat;

-- Read-only account views for the replica config. Views run with the owner's privileges, so the
-- reader role needs no privilege on the `uts` tables themselves.

CREATE VIEW uts_read.accounts AS
  SELECT id, primary_email, status, blocked_at, created_at, updated_at
  FROM uts.accounts;

CREATE VIEW uts_read.sign_in_methods AS
  SELECT id, account_id, provider, verified_email, sso_connection_id, added_at, last_used_at
  FROM uts.sign_in_methods;

CREATE VIEW uts_read.passkeys AS
  SELECT id, account_id, name, aaguid, backup_eligible, backed_up, added_at, last_used_at
  FROM uts.passkey_credentials;

CREATE VIEW uts_read.browser_sessions AS
  SELECT id, account_id, auth_time, amr, created_at, last_seen_at, idle_expires_at, expires_at,
    user_agent, asn, country, city, status, revoked_at, revoke_reason
  FROM uts.browser_sessions;

CREATE VIEW uts_read.device_sessions AS
  SELECT id, account_id, client_class, device_label, platform, auth_time, amr, created_at,
    last_seen_at, asn, country, city, status, revoked_at, revoke_reason
  FROM uts.device_sessions;

CREATE VIEW uts_read.refresh_grants AS
  SELECT id, account_id, device_session_id, client_id, client_class, allowed_scopes, org_id,
    created_at, last_used_at, idle_expires_at, expires_at, status, revoked_at, revoke_reason
  FROM uts.refresh_grants;

CREATE VIEW uts_read.third_party_grants AS
  SELECT family.id, family.account_id, family.client_id, client.client_name, family.scopes,
    family.org_id, family.created_at, family.expires_at, family.status, family.revoked_at
  FROM uts.third_party_grant_families AS family
  JOIN uts.third_party_clients AS client ON client.client_id = family.client_id;

CREATE VIEW uts_read.third_party_consents AS
  SELECT consent.id, consent.account_id, consent.client_id, client.client_name, consent.org_id,
    consent.scopes, consent.granted_at, consent.status, consent.revoked_at
  FROM uts.third_party_consents AS consent
  JOIN uts.third_party_clients AS client ON client.client_id = consent.client_id;

CREATE VIEW uts_read.personal_access_tokens AS
  SELECT id, account_id, name, last_four, audience, scope, org_id, created_at, expires_at,
    last_used_at, last_used_country, status, revoked_at
  FROM uts.personal_access_tokens;

CREATE VIEW uts_read.org_bot_keys AS
  SELECT id, org_id, created_by, name, last_four, audience, scope, created_at, expires_at,
    last_used_at, status, flagged_at, kept_by, kept_at, revoked_at, revoked_by
  FROM uts.org_bot_keys;

CREATE VIEW uts_read.ci_trust_policies AS
  SELECT id, account_id, org_id, repository, repository_id, ref_pattern, environment, audience,
    scopes, created_at, updated_at, status, revoked_at
  FROM uts.ci_trust_policies;

CREATE VIEW uts_read.notices AS
  SELECT id, account_id, kind, details, created_at, delivery, delivered_via, delivered_at, read_at
  FROM uts.notices;

CREATE VIEW uts_read.org_memberships AS
  SELECT org_id, account_id, role, status, updated_at
  FROM uts.org_memberships;

CREATE VIEW uts_read.sso_connections AS
  SELECT id, org_id, status, created_at, updated_at
  FROM uts.sso_connections;

CREATE VIEW uts_read.sso_domains AS
  SELECT id, org_id, domain, status, requested_at, verified_at
  FROM uts.sso_domains;

CREATE VIEW uts_read.org_sso_policies AS
  SELECT org_id, enforcement, updated_at
  FROM uts.org_sso_policies;

GRANT USAGE ON SCHEMA uts_read TO uts_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA uts_read TO uts_reader;
