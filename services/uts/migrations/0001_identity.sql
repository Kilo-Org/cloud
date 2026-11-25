-- Identity-store schema: accounts, sign-in methods, sessions, grants, codes, PATs, org bot keys,
-- clients, consents, policies, revocations, gates and notices (design sections 5.2 to 5.13).
--
-- Rules every table follows:
-- * Opaque values (refresh grants, PATs, bot keys, codes, tickets, cookies) are stored only as
--   32-byte SHA-256 or keyed hashes (`uts.sha256`).
-- * Each lifecycle has one status enum, and a CHECK ties every status to the columns it needs,
--   so a row cannot claim a state without its timestamps.
-- * Lifetimes from design section 5.3 are CHECKs, so no code path can store a longer one.
-- * Account ids are the app's user ids: arbitrary text, never assumed to be UUIDs.

-- A new schema grants nothing to PUBLIC; 0003_access.sql grants USAGE to the roles that need it.
CREATE SCHEMA uts AUTHORIZATION uts_owner;

SET LOCAL ROLE uts_owner;

-- Functions are not callable by PUBLIC; each migration grants EXECUTE where a role needs it.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Validation helpers used by domains and CHECK constraints. Every role that writes a checked
-- column needs EXECUTE on them, because PostgreSQL checks function privileges at run time.

CREATE FUNCTION uts.is_scope(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN value ~ '^[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9_.-]{0,62}$';

-- A canonical scope set: 1 to 64 scopes, strictly ascending in byte order, so equal sets have one
-- spelling (consent is per scope set, design section 5.9).
CREATE FUNCTION uts.is_scope_set(value text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN cardinality(value) BETWEEN 1 AND 64
  AND array_ndims(value) = 1
  AND array_position(value, NULL) IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM unnest(value) WITH ORDINALITY AS scope(name, position)
    WHERE NOT uts.is_scope(scope.name)
      OR (scope.position > 1 AND scope.name COLLATE "C" <= value[scope.position - 1] COLLATE "C")
  );

CREATE DOMAIN uts.sha256 AS bytea CHECK (octet_length(VALUE) = 32);
CREATE DOMAIN uts.scope AS text CHECK (uts.is_scope(VALUE));
CREATE DOMAIN uts.scope_set AS text[] CHECK (uts.is_scope_set(VALUE));
-- A service id that tokens name in `aud`, for example `gateway`.
CREATE DOMAIN uts.audience AS text CHECK (VALUE ~ '^[a-z][a-z0-9-]{0,62}$');
CREATE DOMAIN uts.account_id AS text CHECK (length(VALUE) BETWEEN 1 AND 255);
CREATE DOMAIN uts.email AS text
  CHECK (length(VALUE) <= 320 AND VALUE = lower(VALUE) AND VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+$');
CREATE DOMAIN uts.country_code AS text CHECK (VALUE ~ '^[A-Z]{2}$');
-- A first-party client id such as `kilo-cli`, or a Client ID Metadata Document URL.
CREATE DOMAIN uts.client_id AS text CHECK (length(VALUE) BETWEEN 1 AND 2048);
-- RFC 7636 S256 challenge: base64url of a SHA-256 digest, no padding.
CREATE DOMAIN uts.pkce_challenge AS text CHECK (VALUE ~ '^[A-Za-z0-9_-]{43}$');

CREATE TYPE uts.account_status AS ENUM ('active', 'blocked');
CREATE TYPE uts.sign_in_provider AS ENUM (
  'google', 'openai', 'anthropic', 'anaconda', 'apple', 'github', 'gitlab', 'discord', 'linkedin',
  'workos', 'email'
);
-- Values for the `amr` claim (design section 5.3).
CREATE TYPE uts.auth_method AS ENUM (
  'oauth', 'sso', 'email_link', 'email_code', 'passkey', 'device_grant', 'native', 'access_code'
);
CREATE TYPE uts.client_class AS ENUM ('desktop', 'mobile');
CREATE TYPE uts.client_kind AS ENUM ('first_party', 'third_party');
CREATE TYPE uts.revoke_reason AS ENUM (
  'sign_out', 'user_revoke', 'admin_revoke', 'org_admin_revoke', 'account_blocked',
  'member_removed', 'credential_change', 'reuse_detected', 'session_ended'
);
CREATE TYPE uts.session_status AS ENUM ('active', 'revoked');
CREATE TYPE uts.grant_status AS ENUM ('active', 'revoked');
CREATE TYPE uts.refresh_token_status AS ENUM ('active', 'rotated', 'revoked');
CREATE TYPE uts.code_status AS ENUM ('issued', 'consumed');
CREATE TYPE uts.device_code_status AS ENUM ('pending', 'approved', 'denied', 'consumed');
CREATE TYPE uts.email_code_purpose AS ENUM ('sign_in', 'tier_a');
CREATE TYPE uts.email_code_status AS ENUM ('pending', 'consumed', 'exhausted');
CREATE TYPE uts.email_code_limit_status AS ENUM ('open', 'stopped');
CREATE TYPE uts.ticket_purpose AS ENUM (
  'sign_in', 'stream', 'terminal', 'preview', 'dispatch', 'download'
);
CREATE TYPE uts.credential_status AS ENUM ('active', 'revoked');
CREATE TYPE uts.bot_key_status AS ENUM ('active', 'flagged', 'kept', 'revoked');
CREATE TYPE uts.sso_connection_status AS ENUM ('active', 'inactive');
CREATE TYPE uts.sso_domain_status AS ENUM ('pending', 'verified');
CREATE TYPE uts.sso_enforcement AS ENUM ('off', 'optional', 'required');
CREATE TYPE uts.org_role AS ENUM ('owner', 'admin', 'member', 'billing_manager');
CREATE TYPE uts.membership_status AS ENUM ('active', 'removed');
CREATE TYPE uts.client_status AS ENUM ('active', 'blocked');
CREATE TYPE uts.sandbox_grant_status AS ENUM ('active', 'ended');
CREATE TYPE uts.revocation_kind AS ENUM (
  'subject', 'session', 'grant', 'third_party_family', 'pat', 'bot_key', 'sandbox_grant', 'kid'
);
CREATE TYPE uts.gate_tier AS ENUM ('a', 'b');
CREATE TYPE uts.gated_action AS ENUM (
  'passkey_add', 'passkey_remove', 'method_add', 'method_remove', 'email_change', 'pat_create',
  'bot_key_create', 'ci_policy_create', 'device_approve', 'third_party_approve'
);
-- `recent_sign_in` is a sign-in within 10 minutes; for tier A it must be the strongest method.
CREATE TYPE uts.gate_check AS ENUM ('recent_sign_in', 'passkey', 'email_code', 'email_code_new');
CREATE TYPE uts.gate_pass_status AS ENUM ('open', 'consumed');
CREATE TYPE uts.step_up_purpose AS ENUM ('gate', 'admin');
CREATE TYPE uts.notice_kind AS ENUM (
  'new_device_network', 'sign_in_method_changed', 'primary_email_changed', 'credential_created',
  'device_sign_in_approved', 'ci_trust_policy_changed', 'third_party_client_approved',
  'sessions_revoked', 'suspicious_sign_in', 'sign_in_code_stopped'
);
CREATE TYPE uts.notice_channel AS ENUM ('push', 'email', 'in_app');
CREATE TYPE uts.notice_delivery AS ENUM ('pending', 'delivered', 'failed');

-- Accounts. UTS is the source of truth for status and primary email; the app keeps a copy.
-- `event_version` orders the cross-boundary events, so a late event never overwrites a newer one.
CREATE TABLE uts.accounts (
  id uts.account_id PRIMARY KEY,
  primary_email uts.email NOT NULL,
  status uts.account_status NOT NULL DEFAULT 'active',
  blocked_at timestamptz,
  event_version bigint NOT NULL DEFAULT 0 CHECK (event_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_status_shape CHECK ((status = 'blocked') = (blocked_at IS NOT NULL))
);
CREATE INDEX accounts_primary_email_idx ON uts.accounts (primary_email);

-- Organization SSO (design section 5.8). Org ids are the app's organization UUIDs.
CREATE TABLE uts.sso_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  workos_connection_id text NOT NULL UNIQUE CHECK (length(workos_connection_id) BETWEEN 1 AND 255),
  status uts.sso_connection_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sso_connections_org_idx ON uts.sso_connections (org_id);

-- A domain counts only after the org proved it through a DNS record; an assertion for any other
-- domain is rejected, and SSO never links accounts by email (design section 5.2).
CREATE TABLE uts.sso_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^([a-z0-9-]+\.)+[a-z]{2,63}$'),
  status uts.sso_domain_status NOT NULL DEFAULT 'pending',
  dns_challenge_hash uts.sha256 NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CONSTRAINT sso_domains_status_shape CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CONSTRAINT sso_domains_org_domain_key UNIQUE (org_id, domain)
);
-- One org owns a verified domain.
CREATE UNIQUE INDEX sso_domains_verified_domain_key ON uts.sso_domains (domain)
  WHERE status = 'verified';

CREATE TABLE uts.org_sso_policies (
  org_id uuid PRIMARY KEY,
  enforcement uts.sso_enforcement NOT NULL,
  event_version bigint NOT NULL CHECK (event_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Replica of the app's organization membership, kept current by membership events. A removed
-- membership keeps its row and version, so a late "added" event cannot bring it back.
CREATE TABLE uts.org_memberships (
  org_id uuid NOT NULL,
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  role uts.org_role NOT NULL,
  status uts.membership_status NOT NULL DEFAULT 'active',
  removed_at timestamptz,
  event_version bigint NOT NULL CHECK (event_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id),
  CONSTRAINT org_memberships_status_shape CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
CREATE INDEX org_memberships_account_idx ON uts.org_memberships (account_id);

-- Sign-in methods. `added_at` drives the 24-hour cooling-off (design section 5.11).
CREATE TABLE uts.sign_in_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  provider uts.sign_in_provider NOT NULL,
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 512),
  verified_email uts.email,
  sso_connection_id uuid REFERENCES uts.sso_connections (id),
  added_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT sign_in_methods_provider_subject_key UNIQUE (provider, provider_subject),
  CONSTRAINT sign_in_methods_sso_shape CHECK ((provider = 'workos') = (sso_connection_id IS NOT NULL))
);
CREATE INDEX sign_in_methods_account_idx ON uts.sign_in_methods (account_id);

CREATE TABLE uts.passkey_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 2048),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid uuid,
  transports text[] NOT NULL DEFAULT '{}',
  backup_eligible boolean NOT NULL,
  backed_up boolean NOT NULL,
  rp_id text NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  added_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT passkey_credentials_backup_shape CHECK (backup_eligible OR NOT backed_up)
);
CREATE INDEX passkey_credentials_account_idx ON uts.passkey_credentials (account_id);

-- Browser sessions: an opaque cookie that the web BFF holds; 14 days idle, 30 days maximum.
-- UTS moves `last_seen_at` and `idle_expires_at` at most once per 5 minutes.
CREATE TABLE uts.browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  token_hash uts.sha256 NOT NULL,
  auth_time timestamptz NOT NULL,
  amr uts.auth_method[] NOT NULL
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text CHECK (length(user_agent) <= 512),
  client_ip inet,
  asn integer CHECK (asn > 0),
  country uts.country_code,
  city text CHECK (length(city) <= 128),
  status uts.session_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason uts.revoke_reason,
  CONSTRAINT browser_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT browser_sessions_lifetime CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
    AND idle_expires_at <= expires_at
    AND idle_expires_at <= last_seen_at + interval '14 days'
  ),
  CONSTRAINT browser_sessions_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE INDEX browser_sessions_account_idx ON uts.browser_sessions (account_id)
  WHERE status = 'active';

-- Device sessions: one signed-in device (CLI, IDE, extension, mobile). It has no lifetime of its
-- own; its refresh grants carry the idle and maximum windows by client class.
CREATE TABLE uts.device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  client_class uts.client_class NOT NULL,
  device_label text NOT NULL CHECK (length(device_label) BETWEEN 1 AND 128),
  platform text NOT NULL CHECK (length(platform) BETWEEN 1 AND 64),
  auth_time timestamptz NOT NULL,
  amr uts.auth_method[] NOT NULL
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  client_ip inet,
  asn integer CHECK (asn > 0),
  country uts.country_code,
  city text CHECK (length(city) <= 128),
  status uts.session_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason uts.revoke_reason,
  CONSTRAINT device_sessions_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE INDEX device_sessions_account_idx ON uts.device_sessions (account_id)
  WHERE status = 'active';

-- Gate passes (design section 5.11). Tier A needs a recent strongest-method sign-in plus an email
-- code, and an email change also needs the code sent to the new address. Tier B needs a recent
-- sign-in or a passkey check. A pass lasts at most 10 minutes and is consumed by one action.
-- Each table that records a gated action carries that action as a constant `gate_pass_action`
-- column, a foreign key on (pass, account, action) and a unique pass id, so a pass serves only
-- its own account, its own action and one row.
CREATE TABLE uts.gate_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  browser_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE CASCADE,
  device_session_id uuid REFERENCES uts.device_sessions (id) ON DELETE CASCADE,
  tier uts.gate_tier NOT NULL,
  action uts.gated_action NOT NULL,
  satisfied_by uts.gate_check[] NOT NULL CHECK (array_position(satisfied_by, NULL) IS NULL),
  passed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.gate_pass_status NOT NULL DEFAULT 'open',
  consumed_at timestamptz,
  CONSTRAINT gate_passes_one_session CHECK (num_nonnulls(browser_session_id, device_session_id) = 1),
  CONSTRAINT gate_passes_lifetime CHECK (
    expires_at > passed_at AND expires_at <= passed_at + interval '10 minutes'
  ),
  CONSTRAINT gate_passes_tier_action CHECK (
    (tier = 'a') = (action IN ('passkey_add', 'passkey_remove', 'method_add', 'method_remove', 'email_change'))
  ),
  CONSTRAINT gate_passes_requirement CHECK (
    CASE tier
      WHEN 'a' THEN satisfied_by @> ARRAY['recent_sign_in', 'email_code']::uts.gate_check[]
        AND (action <> 'email_change' OR satisfied_by @> ARRAY['email_code_new']::uts.gate_check[])
      ELSE satisfied_by && ARRAY['recent_sign_in', 'passkey']::uts.gate_check[]
    END
  ),
  CONSTRAINT gate_passes_status_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT gate_passes_account_action_key UNIQUE (id, account_id, action)
);
CREATE INDEX gate_passes_account_idx ON uts.gate_passes (account_id, passed_at);

-- Passkey step-ups (design sections 5.11 and 5.12): at most 10 minutes. An admin step-up also
-- records the company-SSO sign-in time (within 12 hours) and the client address, and only a
-- browser session of the web BFF can hold one.
CREATE TABLE uts.step_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  browser_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE CASCADE,
  device_session_id uuid REFERENCES uts.device_sessions (id) ON DELETE CASCADE,
  purpose uts.step_up_purpose NOT NULL,
  passkey_credential_id uuid NOT NULL REFERENCES uts.passkey_credentials (id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sso_auth_time timestamptz,
  client_ip inet,
  CONSTRAINT step_ups_one_session CHECK (num_nonnulls(browser_session_id, device_session_id) = 1),
  CONSTRAINT step_ups_lifetime CHECK (
    expires_at > completed_at AND expires_at <= completed_at + interval '10 minutes'
  ),
  CONSTRAINT step_ups_purpose_shape CHECK (
    CASE purpose
      WHEN 'admin' THEN browser_session_id IS NOT NULL
        AND client_ip IS NOT NULL
        AND sso_auth_time IS NOT NULL
        AND sso_auth_time > completed_at - interval '12 hours'
        AND sso_auth_time <= completed_at
      ELSE sso_auth_time IS NULL AND client_ip IS NULL
    END
  )
);
CREATE INDEX step_ups_account_idx ON uts.step_ups (account_id, completed_at);

-- First-party refresh grants: a `kilo_rt_` value bound to a DPoP key. Lifetimes by client class
-- (design section 5.3): desktop 30 days idle and 180 days maximum, mobile 60 and 365 days.
-- The grant id is the `sid` claim. A refresh may request any subset of `allowed_scopes`.
-- UTS moves `last_used_at` and `idle_expires_at` at most once per grant per hour, not on every
-- mint, and the free space that fillfactor 90 leaves lets those updates stay on the same page.
CREATE TABLE uts.refresh_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  device_session_id uuid NOT NULL REFERENCES uts.device_sessions (id) ON DELETE CASCADE,
  client_id uts.client_id NOT NULL,
  client_class uts.client_class NOT NULL,
  token_hash uts.sha256 NOT NULL,
  -- RFC 7638 JWK SHA-256 thumbprint of the device key, as raw bytes.
  dpop_jkt uts.sha256 NOT NULL,
  allowed_scopes uts.scope_set NOT NULL,
  org_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status uts.grant_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason uts.revoke_reason,
  CONSTRAINT refresh_grants_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_grants_lifetime CHECK (
    expires_at > created_at
    AND expires_at <= created_at + CASE client_class
      WHEN 'desktop' THEN interval '180 days'
      ELSE interval '365 days'
    END
    AND idle_expires_at <= expires_at
    AND idle_expires_at <= last_used_at + CASE client_class
      WHEN 'desktop' THEN interval '30 days'
      ELSE interval '60 days'
    END
  ),
  CONSTRAINT refresh_grants_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
) WITH (fillfactor = 90);
CREATE INDEX refresh_grants_account_idx ON uts.refresh_grants (account_id) WHERE status = 'active';
CREATE INDEX refresh_grants_device_session_idx ON uts.refresh_grants (device_session_id);
CREATE INDEX refresh_grants_org_idx ON uts.refresh_grants (org_id, account_id)
  WHERE org_id IS NOT NULL AND status = 'active';

-- Third-party clients register through Client ID Metadata Documents (design section 5.9). The
-- client id is the document's HTTPS URL, which must have a path; the row caches the document.
CREATE TABLE uts.third_party_clients (
  client_id uts.client_id PRIMARY KEY CHECK (client_id ~ '^https://[^/?#]+/[^?#]+$'),
  client_name text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 200),
  redirect_uris text[] NOT NULL
    CHECK (cardinality(redirect_uris) BETWEEN 1 AND 32 AND array_position(redirect_uris, NULL) IS NULL),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 16384),
  etag text CHECK (length(etag) <= 256),
  fetched_at timestamptz NOT NULL,
  cache_expires_at timestamptz NOT NULL,
  status uts.client_status NOT NULL DEFAULT 'active',
  CONSTRAINT third_party_clients_cache_window CHECK (cache_expires_at >= fetched_at)
);

-- Consent is per account, client, organization and canonical scope set; a change to the client or
-- the scope set brings the consent screen back.
CREATE TABLE uts.third_party_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  client_id uts.client_id NOT NULL REFERENCES uts.third_party_clients (client_id) ON DELETE CASCADE,
  org_id uuid,
  scopes uts.scope_set NOT NULL,
  gate_pass_id uuid NOT NULL,
  gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('third_party_approve'::uts.gated_action) STORED,
  granted_at timestamptz NOT NULL DEFAULT now(),
  status uts.credential_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  CONSTRAINT third_party_consents_status_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT third_party_consents_gate_pass_key UNIQUE (gate_pass_id),
  CONSTRAINT third_party_consents_gate_pass_fkey FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action)
);
CREATE UNIQUE INDEX third_party_consents_active_key
  ON uts.third_party_consents (account_id, client_id, org_id, scopes) NULLS NOT DISTINCT
  WHERE status = 'active';

-- Third-party refresh tokens rotate on every use. A family is one consented grant: 90 days
-- maximum. Each token lives at most 30 days idle; a rotated token stays usable for a 60-second
-- grace, and a reuse after that revokes the family (design sections 5.3 and 5.4).
CREATE TABLE uts.third_party_grant_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  client_id uts.client_id NOT NULL REFERENCES uts.third_party_clients (client_id) ON DELETE CASCADE,
  consent_id uuid NOT NULL REFERENCES uts.third_party_consents (id) ON DELETE CASCADE,
  scopes uts.scope_set NOT NULL,
  org_id uuid,
  auth_time timestamptz NOT NULL,
  amr uts.auth_method[] NOT NULL
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.grant_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason uts.revoke_reason,
  CONSTRAINT third_party_grant_families_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'
  ),
  CONSTRAINT third_party_grant_families_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE INDEX third_party_grant_families_account_idx ON uts.third_party_grant_families (account_id)
  WHERE status = 'active';
CREATE INDEX third_party_grant_families_consent_idx ON uts.third_party_grant_families (consent_id);

CREATE TABLE uts.third_party_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES uts.third_party_grant_families (id) ON DELETE CASCADE,
  -- The token this one replaced; the chain runs back to the family's first token.
  parent_id uuid UNIQUE REFERENCES uts.third_party_refresh_tokens (id) ON DELETE CASCADE,
  token_hash uts.sha256 NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  status uts.refresh_token_status NOT NULL DEFAULT 'active',
  rotated_at timestamptz,
  grace_until timestamptz,
  revoked_at timestamptz,
  CONSTRAINT third_party_refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT third_party_refresh_tokens_lifetime CHECK (
    idle_expires_at > issued_at AND idle_expires_at <= issued_at + interval '30 days'
  ),
  -- `IS NOT DISTINCT FROM`, not `=`: a CHECK that evaluates to NULL passes, so a missing grace
  -- time must compare as false.
  CONSTRAINT third_party_refresh_tokens_status_shape CHECK (
    grace_until IS NOT DISTINCT FROM rotated_at + interval '60 seconds'
    AND CASE status
      WHEN 'active' THEN rotated_at IS NULL AND revoked_at IS NULL
      WHEN 'rotated' THEN rotated_at IS NOT NULL AND revoked_at IS NULL
      ELSE revoked_at IS NOT NULL
    END
  )
);
-- One live token per family.
CREATE UNIQUE INDEX third_party_refresh_tokens_active_key
  ON uts.third_party_refresh_tokens (family_id)
  WHERE status = 'active';

-- Authorization codes: OAuth 2.1 with PKCE S256 only, about 60 seconds, single use.
CREATE TABLE uts.authorization_codes (
  code_hash uts.sha256 PRIMARY KEY,
  client_id uts.client_id NOT NULL,
  client_kind uts.client_kind NOT NULL,
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  browser_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE CASCADE,
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  -- RFC 8707 resource indicators, as audiences.
  resources uts.audience[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(resources) <= 8 AND array_position(resources, NULL) IS NULL),
  scopes uts.scope_set NOT NULL,
  org_id uuid,
  code_challenge uts.pkce_challenge NOT NULL,
  dpop_jkt uts.sha256,
  auth_time timestamptz NOT NULL,
  amr uts.auth_method[] NOT NULL
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.code_status NOT NULL DEFAULT 'issued',
  consumed_at timestamptz,
  CONSTRAINT authorization_codes_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '60 seconds'
  ),
  -- First-party grants are DPoP-bound, so their code carries the key thumbprint.
  CONSTRAINT authorization_codes_dpop_shape CHECK (client_kind = 'third_party' OR dpop_jkt IS NOT NULL),
  CONSTRAINT authorization_codes_status_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX authorization_codes_expires_idx ON uts.authorization_codes (expires_at);

-- RFC 8628 device grant: 10 minutes. Approval needs a tier B gate pass (design section 5.4), and
-- the row keeps the device context that the approval page shows.
CREATE TABLE uts.device_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash uts.sha256 NOT NULL,
  -- HMAC-SHA-256 of the normalized user code under a key that only UTS holds. A user code is
  -- short enough (RFC 8628, section 6.1) that a plain SHA-256 could be reversed offline.
  user_code_hash uts.sha256 NOT NULL,
  client_id uts.client_id NOT NULL,
  scopes uts.scope_set NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  poll_interval_seconds smallint NOT NULL DEFAULT 5 CHECK (poll_interval_seconds BETWEEN 1 AND 60),
  last_polled_at timestamptz,
  user_agent text CHECK (length(user_agent) <= 512),
  client_ip inet,
  asn integer CHECK (asn > 0),
  country uts.country_code,
  city text CHECK (length(city) <= 128),
  status uts.device_code_status NOT NULL DEFAULT 'pending',
  account_id uts.account_id REFERENCES uts.accounts (id) ON DELETE CASCADE,
  -- The foreign key below applies only once both the account and the pass are set (approval).
  gate_pass_id uuid,
  gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('device_approve'::uts.gated_action) STORED,
  approved_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT device_codes_device_code_hash_key UNIQUE (device_code_hash),
  CONSTRAINT device_codes_user_code_hash_key UNIQUE (user_code_hash),
  CONSTRAINT device_codes_gate_pass_key UNIQUE (gate_pass_id),
  CONSTRAINT device_codes_gate_pass_fkey FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action),
  CONSTRAINT device_codes_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT device_codes_status_shape CHECK (
    CASE status
      WHEN 'pending' THEN account_id IS NULL AND gate_pass_id IS NULL AND approved_at IS NULL
        AND denied_at IS NULL AND consumed_at IS NULL
      WHEN 'approved' THEN account_id IS NOT NULL AND gate_pass_id IS NOT NULL
        AND approved_at IS NOT NULL AND denied_at IS NULL AND consumed_at IS NULL
      WHEN 'denied' THEN account_id IS NOT NULL AND gate_pass_id IS NULL AND approved_at IS NULL
        AND denied_at IS NOT NULL AND consumed_at IS NULL
      ELSE account_id IS NOT NULL AND gate_pass_id IS NOT NULL AND approved_at IS NOT NULL
        AND denied_at IS NULL AND consumed_at IS NOT NULL
    END
  )
);
CREATE INDEX device_codes_expires_idx ON uts.device_codes (expires_at);

-- Email codes: six digits stored as a keyed hash, 10 minutes, 5 attempts. `email_hash` is a keyed
-- hash of the address. A sign-in code can target an address with no account yet; a tier A code
-- always belongs to an account.
CREATE TABLE uts.email_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose uts.email_code_purpose NOT NULL,
  email_hash uts.sha256 NOT NULL,
  account_id uts.account_id REFERENCES uts.accounts (id) ON DELETE CASCADE,
  code_hash uts.sha256 NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.email_code_status NOT NULL DEFAULT 'pending',
  consumed_at timestamptz,
  CONSTRAINT email_codes_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT email_codes_account_shape CHECK (purpose = 'sign_in' OR account_id IS NOT NULL),
  CONSTRAINT email_codes_status_shape CHECK (
    CASE status
      WHEN 'pending' THEN attempts < 5 AND consumed_at IS NULL
      WHEN 'consumed' THEN consumed_at IS NOT NULL
      ELSE attempts = 5 AND consumed_at IS NULL
    END
  )
);
CREATE INDEX email_codes_lookup_idx ON uts.email_codes (email_hash, purpose, created_at)
  WHERE status = 'pending';
CREATE INDEX email_codes_expires_idx ON uts.email_codes (expires_at);

-- Email code limits (design section 5.3): at most 5 codes per address per hour for each purpose.
-- Past that cap, or after 20 failed sign-in code entries in a day, sign-in codes stop for an hour
-- and sign-in emails carry only the link. Tier A codes keep their own count and never stop.
CREATE TABLE uts.email_code_limits (
  purpose uts.email_code_purpose NOT NULL,
  email_hash uts.sha256 NOT NULL,
  hour_started_at timestamptz NOT NULL,
  sent_in_hour smallint NOT NULL DEFAULT 0 CHECK (sent_in_hour BETWEEN 0 AND 5),
  day_started_at timestamptz NOT NULL,
  failures_in_day smallint NOT NULL DEFAULT 0 CHECK (failures_in_day >= 0),
  status uts.email_code_limit_status NOT NULL DEFAULT 'open',
  stopped_until timestamptz,
  PRIMARY KEY (purpose, email_hash),
  CONSTRAINT email_code_limits_status_shape CHECK (
    (status = 'open' AND stopped_until IS NULL)
    OR (status = 'stopped' AND purpose = 'sign_in' AND stopped_until IS NOT NULL)
  )
);

-- One-time tickets (sign-in, stream, terminal, preview, dispatch, download): one audience,
-- 60 seconds, single use.
CREATE TABLE uts.tickets (
  ticket_hash uts.sha256 PRIMARY KEY,
  purpose uts.ticket_purpose NOT NULL,
  audience uts.audience NOT NULL,
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  resource text CHECK (length(resource) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.code_status NOT NULL DEFAULT 'issued',
  consumed_at timestamptz,
  CONSTRAINT tickets_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '60 seconds'
  ),
  CONSTRAINT tickets_status_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX tickets_expires_idx ON uts.tickets (expires_at);

-- Personal access tokens: `kilo_pat_` values, stored as SHA-256 with the last four characters
-- for display. One audience and one scope; 1 year maximum. UTS moves `last_used_*` at most once
-- per PAT per hour, and at once from a new network.
CREATE TABLE uts.personal_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash uts.sha256 NOT NULL,
  last_four text NOT NULL CHECK (last_four ~ '^[A-Za-z0-9_-]{4}$'),
  audience uts.audience NOT NULL,
  scope uts.scope NOT NULL,
  org_id uuid,
  gate_pass_id uuid NOT NULL,
  gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('pat_create'::uts.gated_action) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  last_used_ip inet,
  last_used_asn integer CHECK (last_used_asn > 0),
  last_used_country uts.country_code,
  status uts.credential_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason uts.revoke_reason,
  CONSTRAINT personal_access_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT personal_access_tokens_gate_pass_key UNIQUE (gate_pass_id),
  CONSTRAINT personal_access_tokens_gate_pass_fkey
    FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action),
  CONSTRAINT personal_access_tokens_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '365 days'
  ),
  CONSTRAINT personal_access_tokens_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE INDEX personal_access_tokens_account_idx ON uts.personal_access_tokens (account_id);

-- Org bot keys: `kilo_bot_` values owned by the organization. `created_by` names the member who
-- created the key and has no foreign key, because the key outlives that account. Member removal
-- flags the member's keys; a flagged key stops working 7 days after `flagged_at` unless an org
-- admin keeps it (design section 5.8).
CREATE TABLE uts.org_bot_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  created_by uts.account_id NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash uts.sha256 NOT NULL,
  last_four text NOT NULL CHECK (last_four ~ '^[A-Za-z0-9_-]{4}$'),
  audience uts.audience NOT NULL,
  scope uts.scope NOT NULL,
  gate_pass_id uuid NOT NULL,
  gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('bot_key_create'::uts.gated_action) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  status uts.bot_key_status NOT NULL DEFAULT 'active',
  flagged_at timestamptz,
  kept_by uts.account_id,
  kept_at timestamptz,
  revoked_at timestamptz,
  revoked_by uts.account_id,
  CONSTRAINT org_bot_keys_token_hash_key UNIQUE (token_hash),
  CONSTRAINT org_bot_keys_gate_pass_key UNIQUE (gate_pass_id),
  -- The pass belongs to the member who created the key.
  CONSTRAINT org_bot_keys_gate_pass_fkey FOREIGN KEY (gate_pass_id, created_by, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action),
  CONSTRAINT org_bot_keys_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '365 days'
  ),
  CONSTRAINT org_bot_keys_status_shape CHECK (
    (kept_by IS NULL) = (kept_at IS NULL)
    AND (kept_at IS NULL OR flagged_at IS NOT NULL)
    AND CASE status
      WHEN 'active' THEN flagged_at IS NULL AND kept_at IS NULL AND revoked_at IS NULL
      WHEN 'flagged' THEN flagged_at IS NOT NULL AND kept_at IS NULL AND revoked_at IS NULL
      WHEN 'kept' THEN kept_at IS NOT NULL AND revoked_at IS NULL
      ELSE revoked_at IS NOT NULL
    END
  )
);
CREATE INDEX org_bot_keys_org_idx ON uts.org_bot_keys (org_id);
CREATE INDEX org_bot_keys_creator_idx ON uts.org_bot_keys (org_id, created_by)
  WHERE status IN ('active', 'kept');

-- CI trust policies: a GitHub OIDC subject that UTS exchanges for 1-hour tokens (design section
-- 5.3). Creation needs a tier B gate pass.
CREATE TABLE uts.ci_trust_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  org_id uuid,
  gate_pass_id uuid NOT NULL,
  gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('ci_policy_create'::uts.gated_action) STORED,
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  ref_pattern text CHECK (length(ref_pattern) BETWEEN 1 AND 255),
  environment text CHECK (length(environment) BETWEEN 1 AND 255),
  audience uts.audience NOT NULL,
  scopes uts.scope_set NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status uts.credential_status NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  CONSTRAINT ci_trust_policies_status_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT ci_trust_policies_gate_pass_key UNIQUE (gate_pass_id),
  CONSTRAINT ci_trust_policies_gate_pass_fkey FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action)
);
CREATE INDEX ci_trust_policies_repository_idx ON uts.ci_trust_policies (repository_id)
  WHERE status = 'active';
CREATE INDEX ci_trust_policies_account_idx ON uts.ci_trust_policies (account_id);

-- Sandbox grants (design section 5.10): UTS mints delegated tokens only against one of these, and
-- the grant ends with the sandbox session.
CREATE TABLE uts.sandbox_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  sandbox_session_id text NOT NULL UNIQUE CHECK (length(sandbox_session_id) BETWEEN 1 AND 256),
  allowed_scopes uts.scope_set NOT NULL,
  org_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.sandbox_grant_status NOT NULL DEFAULT 'active',
  ended_at timestamptz,
  CONSTRAINT sandbox_grants_lifetime CHECK (expires_at > created_at),
  CONSTRAINT sandbox_grants_status_shape CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX sandbox_grants_account_idx ON uts.sandbox_grants (account_id) WHERE status = 'active';

-- Revocations feed the two feed objects (design section 5.6). `subject` rows hold the per-user
-- `revoked_before`; every other kind holds one revoked id. A PAT entry stays 15 minutes; every
-- other entry stays until 10 minutes after the last token it affects expires. The feed backfill
-- reads the last 20 minutes by `revoked_at`.
CREATE TABLE uts.revocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind uts.revocation_kind NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 255),
  revoked_before timestamptz,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  feed_expires_at timestamptz NOT NULL,
  CONSTRAINT revocations_kind_subject_key UNIQUE (kind, subject_id),
  CONSTRAINT revocations_kind_shape CHECK (
    CASE kind
      WHEN 'subject' THEN revoked_before IS NOT NULL
        AND revoked_before <= revoked_at
        AND feed_expires_at >= revoked_at + interval '10 minutes'
      WHEN 'pat' THEN revoked_before IS NULL
        AND feed_expires_at = revoked_at + interval '15 minutes'
      ELSE revoked_before IS NULL AND feed_expires_at >= revoked_at + interval '10 minutes'
    END
  )
);
CREATE INDEX revocations_revoked_at_idx ON uts.revocations (revoked_at);
CREATE INDEX revocations_feed_expires_idx ON uts.revocations (feed_expires_at);

-- In-app security notices (design section 5.13). Channel order is push, then email; the in-app
-- page always shows the row. `details` carries event context such as the device label and an
-- approximate region, never an email address or a link.
CREATE TABLE uts.notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  kind uts.notice_kind NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2048),
  audit_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery uts.notice_delivery NOT NULL DEFAULT 'pending',
  delivered_via uts.notice_channel,
  delivered_at timestamptz,
  failed_at timestamptz,
  read_at timestamptz,
  CONSTRAINT notices_delivery_shape CHECK (
    CASE delivery
      WHEN 'pending' THEN delivered_via IS NULL AND delivered_at IS NULL AND failed_at IS NULL
      WHEN 'delivered' THEN delivered_via IS NOT NULL AND delivered_at IS NOT NULL AND failed_at IS NULL
      ELSE delivered_via IS NULL AND delivered_at IS NULL AND failed_at IS NOT NULL
    END
  )
);
CREATE INDEX notices_account_idx ON uts.notices (account_id, created_at);
CREATE INDEX notices_pending_idx ON uts.notices (created_at) WHERE delivery = 'pending';
