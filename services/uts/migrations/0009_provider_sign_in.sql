-- Sign-in through OAuth and OpenID Connect providers, WorkOS SSO, and the email link and code
-- (design sections 5.1, 5.2, 5.3, 5.11, 5.13, 8.1 and 8.2).
--
-- * A provider or SSO sign-in is a flow: its start stores the SHA-256 of the `state` it sends and
--   of a random binder that only the starting browser holds (a cookie); its callback consumes the
--   flow once, in the same statement that settles the account and opens the browser session, and
--   only for the same provider and binder. The binder is never stored; the PKCE verifier and the
--   OpenID Connect nonce derive from it in the Worker, so the identity store holds no flow secret.
-- * Account linking (design 5.2) happens in two cases only. Inside a browser session, the flow's
--   tier A `method_add` gate pass of that session is consumed by the new method's row. Outside a
--   session, a provider whose sign-in proves control of the address (the Worker decides per
--   provider, README "Sign-in providers") links to the one account whose primary email it is. An
--   SSO sign-in never links by email, and it is accepted only for a verified domain of the org
--   that owns the connection.
-- * A new account needs a proven address, so nobody can create an account under an address they
--   do not control and wait for its owner to sign in by email.
-- * An address whose domain is a verified domain of an org that requires SSO signs in through SSO
--   only.
-- * Email sign-in: every email carries a link (32 random bytes, stored as SHA-256) and, unless the
--   sign-in code stop is on, a six-digit code (a keyed hash); both live 10 minutes. The code
--   takes 5 wrong entries, after which it is exhausted; the link keeps working, so wrong entries
--   by someone else cannot lock the owner of the address out (design 5.3). At most 5 codes per
--   address per hour; past that cap, or after 20 wrong entries in a day, codes stop for 1 hour
--   and the email carries only the link.
-- * Every write is one call of a SECURITY DEFINER function that writes the rows and their audit
--   row in the same statement. The app role loses direct writes on sign-in methods, email codes
--   and their limits.
-- * Unauthenticated writes (a flow start, an email start) write no audit row: neither names an
--   account yet. A refusal that names an account writes at most one denied row per account per
--   minute; a wrong email code writes one per entry, which the code's 5 entries and the 5 codes an
--   hour bound.

SET LOCAL ROLE uts_owner;

CREATE TYPE uts.sign_in_intent AS ENUM ('sign_in', 'link');

CREATE TABLE uts.sign_in_flows (
  state_hash uts.sha256 PRIMARY KEY,
  provider uts.sign_in_provider NOT NULL CHECK (provider <> 'email'),
  binder_hash uts.sha256 NOT NULL,
  intent uts.sign_in_intent NOT NULL,
  -- A link adds the method to this session's account and consumes this tier A pass.
  link_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE CASCADE,
  gate_pass_id uuid REFERENCES uts.gate_passes (id) ON DELETE CASCADE,
  -- An SSO flow names the connection it sent the user to.
  sso_connection_id uuid REFERENCES uts.sso_connections (id) ON DELETE CASCADE,
  -- A path on the issuer origin; the Worker allows only its own sign-in destinations.
  return_to text NOT NULL CHECK (length(return_to) <= 4096 AND return_to ~ '^/([^/\\]|$)'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status uts.code_status NOT NULL DEFAULT 'issued',
  consumed_at timestamptz,
  CONSTRAINT sign_in_flows_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT sign_in_flows_intent_shape CHECK (
    (intent = 'link') = (link_session_id IS NOT NULL)
    AND (link_session_id IS NULL) = (gate_pass_id IS NULL)
  ),
  CONSTRAINT sign_in_flows_sso_shape CHECK ((provider = 'workos') = (sso_connection_id IS NOT NULL)),
  CONSTRAINT sign_in_flows_status_shape CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX sign_in_flows_expires_idx ON uts.sign_in_flows (expires_at);
CREATE INDEX sign_in_flows_link_session_idx ON uts.sign_in_flows (link_session_id)
  WHERE link_session_id IS NOT NULL;
CREATE INDEX sign_in_flows_gate_pass_idx ON uts.sign_in_flows (gate_pass_id)
  WHERE gate_pass_id IS NOT NULL;
CREATE INDEX sign_in_flows_sso_connection_idx ON uts.sign_in_flows (sso_connection_id)
  WHERE sso_connection_id IS NOT NULL;

-- A method linked inside a session keeps the tier A pass that allowed it (README, "Gate passes"
-- rule in 0001). A method added by a sign-up or by a proven address has none. No row exists yet in
-- any environment.
ALTER TABLE uts.sign_in_methods
  ADD COLUMN gate_pass_id uuid,
  ADD COLUMN gate_pass_action uts.gated_action NOT NULL
    GENERATED ALWAYS AS ('method_add'::uts.gated_action) STORED,
  ADD CONSTRAINT sign_in_methods_gate_pass_key UNIQUE (gate_pass_id),
  ADD CONSTRAINT sign_in_methods_gate_pass_fkey FOREIGN KEY (gate_pass_id, account_id, gate_pass_action)
    REFERENCES uts.gate_passes (id, account_id, action);

-- When the account's last denied sign-in row was written (`uts.claim_account_denied_audit`).
ALTER TABLE uts.accounts ADD COLUMN sign_in_denied_audited_at timestamptz;

-- A sign-in email keeps its address (an account created by it needs one), its link and where the
-- sign-in returns to; a tier A code has none of them. A sign-in email sent while codes are stopped
-- has no code. Rows live 10 minutes and maintenance deletes them an hour later.
ALTER TABLE uts.email_codes
  ADD COLUMN email uts.email,
  ADD COLUMN link_hash uts.sha256,
  ADD COLUMN return_to text CHECK (length(return_to) <= 4096 AND return_to ~ '^/([^/\\]|$)'),
  ALTER COLUMN code_hash DROP NOT NULL,
  ADD CONSTRAINT email_codes_link_hash_key UNIQUE (link_hash),
  ADD CONSTRAINT email_codes_purpose_shape CHECK (
    CASE purpose
      WHEN 'sign_in' THEN email IS NOT NULL AND link_hash IS NOT NULL AND return_to IS NOT NULL
      ELSE email IS NULL AND link_hash IS NULL AND return_to IS NULL AND code_hash IS NOT NULL
    END
  );

-- True when the address's domain is a verified domain of an org that requires SSO. One probe of
-- `sso_domains_verified_domain_key`, then `org_sso_policies_pkey`.
CREATE FUNCTION uts.sso_required_for(p_email text) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM uts.sso_domains AS domain
    JOIN uts.org_sso_policies AS policy ON policy.org_id = domain.org_id
    WHERE domain.domain = split_part($1, '@', 2)
      AND domain.status = 'verified'
      AND policy.enforcement = 'required'
  )
$$;

-- Whether a refused sign-in that names an account writes its denied audit row: true for the first
-- refusal in a minute, as `uts.claim_denied_audit` does for a grant.
CREATE FUNCTION uts.claim_account_denied_audit(p_account_id text) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE uts.accounts AS account SET sign_in_denied_audited_at = now()
  WHERE account.id = p_account_id
    AND (account.sign_in_denied_audited_at IS NULL
      OR account.sign_in_denied_audited_at <= now() - interval '1 minute');
  RETURN FOUND;
END
$$;

-- A refused sign-in or link that names an account: one denied row per account per minute at most.
CREATE FUNCTION uts.audit_account_refusal(
  p_environment text,
  p_account_id text,
  p_type text,
  p_class integer,
  p_activity integer,
  p_attributes jsonb,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_account_id IS NOT NULL AND uts.claim_account_denied_audit(p_account_id) THEN
    PERFORM uts.write_audit_event(
      p_environment, p_type, p_class, p_activity, 'denied', p_reason, p_account_id,
      p_attributes || jsonb_build_object('reason', p_reason)
    );
  END IF;
END
$$;

-- The one account whose primary email is `p_email`, or no row when none or several are.
CREATE FUNCTION uts.account_of_email(p_email text)
RETURNS TABLE (id text, status uts.account_status)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT only_match.id, only_match.status
  FROM (
    SELECT account.id, account.status, count(*) OVER () AS matches
    FROM uts.accounts AS account
    WHERE account.primary_email = $1
    LIMIT 2
  ) AS only_match
  WHERE only_match.matches = 1
$$;

-- Opens a browser session (design 5.3: 14 days idle, 30 days at most) and writes its audit row.
CREATE FUNCTION uts.open_browser_session(
  p_environment text,
  p_account_id text,
  p_token_hash bytea,
  p_method uts.auth_method,
  p_attributes jsonb,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_session_id uuid;
BEGIN
  INSERT INTO uts.browser_sessions (
    account_id, token_hash, auth_time, amr, idle_expires_at, expires_at, user_agent, client_ip,
    asn, country, city
  ) VALUES (
    p_account_id, p_token_hash, now(), ARRAY[p_method], now() + interval '14 days',
    now() + interval '30 days', p_user_agent, p_client_ip, p_asn, p_country, p_city
  ) RETURNING id INTO new_session_id;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.session.created', 3002, 1, 'success', NULL, p_account_id,
    jsonb_build_object(
      'method', p_method,
      'sessionKind', 'browser',
      'sessionId', new_session_id,
      'country', p_country,
      'asn', p_asn
    ) || p_attributes
  );
  RETURN new_session_id;
END
$$;

-- Adds a sign-in method to an account with its audit row and the account's notice (design 5.13).
CREATE FUNCTION uts.add_sign_in_method(
  p_environment text,
  p_account_id text,
  p_provider uts.sign_in_provider,
  p_subject text,
  p_verified_email text,
  p_sso_connection_id uuid,
  p_gate_pass_id uuid,
  p_linked_by text
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_method_id uuid;
  event_id uuid;
BEGIN
  INSERT INTO uts.sign_in_methods (
    account_id, provider, provider_subject, verified_email, sso_connection_id, gate_pass_id,
    last_used_at
  ) VALUES (
    p_account_id, p_provider, p_subject, p_verified_email, p_sso_connection_id, p_gate_pass_id,
    CASE WHEN p_gate_pass_id IS NULL THEN now() END
  ) RETURNING id INTO new_method_id;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.sign_in_method.linked', 3001, 99, 'success', NULL, p_account_id,
    jsonb_build_object(
      'methodId', new_method_id,
      'provider', p_provider,
      'linkedBy', p_linked_by,
      'gatePassId', p_gate_pass_id
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    p_account_id, 'sign_in_method_changed',
    jsonb_build_object('change', 'added', 'provider', p_provider),
    event_id
  );
  RETURN new_method_id;
END
$$;

-- Settles the account of a sign-in whose method is new. Outcomes: `ok` with the account;
-- `email_required` (the provider gave no address); `link_required` (an account holds the address
-- and the sign-in may not link to it: SSO, or an address the provider did not prove);
-- `email_unverified` (a new account without a proven address); `sso_required`;
-- `account_blocked`.
CREATE FUNCTION uts.settle_new_method(
  p_environment text,
  p_provider uts.sign_in_provider,
  p_subject text,
  p_email text,
  p_email_proven boolean,
  p_sso_connection_id uuid,
  OUT outcome text,
  OUT settled_account text,
  OUT account_created boolean,
  OUT method_linked boolean
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder record;
  attributes jsonb := jsonb_build_object('method', CASE p_provider
    WHEN 'workos' THEN 'sso' WHEN 'email' THEN 'email' ELSE 'oauth' END, 'provider', p_provider);
BEGIN
  account_created := false;
  method_linked := false;
  IF p_email IS NULL THEN
    outcome := 'email_required';
    RETURN;
  END IF;
  IF p_provider <> 'workos' AND uts.sso_required_for(p_email) THEN
    SELECT * INTO holder FROM uts.account_of_email(p_email);
    PERFORM uts.audit_account_refusal(
      p_environment, holder.id, 'ai.kilo.uts.sign_in.denied', 3002, 1, attributes, 'sso_required'
    );
    outcome := 'sso_required';
    RETURN;
  END IF;
  SELECT * INTO holder FROM uts.account_of_email(p_email);
  IF FOUND OR EXISTS (SELECT 1 FROM uts.accounts AS account WHERE account.primary_email = p_email) THEN
    IF holder.id IS NULL OR p_provider = 'workos' OR NOT p_email_proven THEN
      PERFORM uts.audit_account_refusal(
        p_environment, holder.id, 'ai.kilo.uts.sign_in.denied', 3002, 1, attributes, 'link_required'
      );
      outcome := 'link_required';
      RETURN;
    END IF;
    IF holder.status <> 'active' THEN
      PERFORM uts.audit_account_refusal(
        p_environment, holder.id, 'ai.kilo.uts.sign_in.denied', 3002, 1, attributes, 'account_blocked'
      );
      outcome := 'account_blocked';
      RETURN;
    END IF;
    PERFORM uts.add_sign_in_method(
      p_environment, holder.id, p_provider, p_subject, p_email, NULL, NULL, 'verified_email'
    );
    outcome := 'ok';
    settled_account := holder.id;
    method_linked := true;
    RETURN;
  END IF;
  -- An SSO profile's address lies in a domain its org verified (`uts.complete_provider_sign_in`).
  IF NOT p_email_proven AND p_provider <> 'workos' THEN
    outcome := 'email_unverified';
    RETURN;
  END IF;
  INSERT INTO uts.accounts (id, primary_email) VALUES (gen_random_uuid()::text, p_email)
  RETURNING id INTO settled_account;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.account.created', 3001, 1, 'success', NULL, settled_account,
    attributes
  );
  INSERT INTO uts.sign_in_methods (
    account_id, provider, provider_subject, verified_email, sso_connection_id, last_used_at
  ) VALUES (settled_account, p_provider, p_subject, p_email, p_sso_connection_id, now());
  outcome := 'ok';
  account_created := true;
END
$$;

-- Signs in with a provider identity: the known method's account, else the account the new method
-- settles on, then a browser session (`p_method` is the `amr` value). Outcomes: `signed_in`;
-- `account_blocked`; `sso_required`; and the refusals of `uts.settle_new_method`.
CREATE FUNCTION uts.sign_in_with_method(
  p_environment text,
  p_provider uts.sign_in_provider,
  p_subject text,
  p_email text,
  p_email_proven boolean,
  p_sso_connection_id uuid,
  p_method uts.auth_method,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text,
  OUT outcome text,
  OUT session_id uuid,
  OUT session_account text,
  OUT account_created boolean,
  OUT method_linked boolean
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  known record;
  settled record;
  attributes jsonb := jsonb_build_object('method', p_method, 'provider', p_provider);
BEGIN
  account_created := false;
  method_linked := false;
  SELECT method.id, method.account_id, method.last_used_at, account.status, account.primary_email
  INTO known
  FROM uts.sign_in_methods AS method
  JOIN uts.accounts AS account ON account.id = method.account_id
  WHERE method.provider = p_provider AND method.provider_subject = p_subject;
  IF FOUND THEN
    IF known.status <> 'active' THEN
      PERFORM uts.audit_account_refusal(
        p_environment, known.account_id, 'ai.kilo.uts.sign_in.denied', 3002, 1, attributes,
        'account_blocked'
      );
      outcome := 'account_blocked';
      RETURN;
    END IF;
    IF p_provider <> 'workos' AND uts.sso_required_for(known.primary_email) THEN
      PERFORM uts.audit_account_refusal(
        p_environment, known.account_id, 'ai.kilo.uts.sign_in.denied', 3002, 1, attributes,
        'sso_required'
      );
      outcome := 'sso_required';
      RETURN;
    END IF;
    -- Last use moves at most once an hour.
    IF known.last_used_at IS NULL OR known.last_used_at < now() - interval '1 hour' THEN
      UPDATE uts.sign_in_methods AS method SET last_used_at = now() WHERE method.id = known.id;
    END IF;
    session_account := known.account_id;
  ELSE
    SELECT * INTO settled
    FROM uts.settle_new_method(
      p_environment, p_provider, p_subject, p_email, p_email_proven, p_sso_connection_id
    );
    IF settled.outcome <> 'ok' THEN
      outcome := settled.outcome;
      RETURN;
    END IF;
    session_account := settled.settled_account;
    account_created := settled.account_created;
    method_linked := settled.method_linked;
  END IF;
  session_id := uts.open_browser_session(
    p_environment, session_account, p_session_token_hash, p_method,
    jsonb_build_object(
      'provider', p_provider,
      'accountCreated', account_created,
      'methodLinked', method_linked
    ),
    p_user_agent, p_client_ip, p_asn, p_country, p_city
  );
  outcome := 'signed_in';
END
$$;

-- GET /signin/oauth/<provider>/start and POST /signin/sso/start: stores a 10-minute flow. A link
-- needs the live browser session `p_session_token_hash` names and an open tier A `method_add`
-- pass of that session (checked again, and consumed, by the callback). An SSO flow needs exactly
-- one active connection of the org that verified `p_sso_domain`. Outcomes: `started` (with the
-- WorkOS connection id of an SSO flow); `no_session`; `gate_required`; `no_sso_connection`.
CREATE FUNCTION uts.start_sign_in_flow(
  p_environment text,
  p_state_hash bytea,
  p_provider uts.sign_in_provider,
  p_binder_hash bytea,
  p_intent uts.sign_in_intent,
  p_session_token_hash bytea,
  p_gate_pass_id uuid,
  p_sso_domain text,
  p_return_to text
) RETURNS TABLE (outcome text, workos_connection_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  connection_ids uuid[];
  connection_external text[];
  session_id uuid;
BEGIN
  IF p_provider = 'workos' THEN
    SELECT array_agg(connection.id), array_agg(connection.workos_connection_id)
    INTO connection_ids, connection_external
    FROM uts.sso_domains AS domain
    JOIN uts.sso_connections AS connection
      ON connection.org_id = domain.org_id AND connection.status = 'active'
    WHERE domain.domain = p_sso_domain AND domain.status = 'verified';
    IF coalesce(cardinality(connection_ids), 0) <> 1 THEN
      outcome := 'no_sso_connection';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF p_intent = 'link' THEN
    SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
    IF NOT FOUND THEN
      outcome := 'no_session';
      RETURN NEXT;
      RETURN;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM uts.gate_passes AS pass
      WHERE pass.id = p_gate_pass_id
        AND pass.account_id = live.account_id
        AND pass.browser_session_id = live.id
        AND pass.tier = 'a'
        AND pass.action = 'method_add'
        AND pass.status = 'open'
        AND pass.expires_at > now()
    ) THEN
      PERFORM uts.audit_session_gate_refusal(
        p_environment, live.account_id, live.id, 'method_add', 'tier A pass required'
      );
      outcome := 'gate_required';
      RETURN NEXT;
      RETURN;
    END IF;
    session_id := live.id;
  END IF;
  INSERT INTO uts.sign_in_flows (
    state_hash, provider, binder_hash, intent, link_session_id, gate_pass_id, sso_connection_id,
    return_to, expires_at
  ) VALUES (
    p_state_hash, p_provider, p_binder_hash, p_intent, session_id,
    CASE WHEN p_intent = 'link' THEN p_gate_pass_id END, connection_ids[1], p_return_to,
    now() + interval '10 minutes'
  );
  outcome := 'started';
  workos_connection_id := connection_external[1];
  RETURN NEXT;
END
$$;

-- A provider or SSO callback, after the Worker exchanged the code and checked the identity:
-- consumes the flow (one use, same provider, same binder) and then either signs in or, for a link,
-- adds the method to the flow's session account. `p_email_proven` is the provider's proof of the
-- address; `p_workos_connection_id` is the connection an SSO profile names. Outcomes:
-- `signed_in` with the session; `linked`; `invalid_state`; `sso_refused` (the profile's connection
-- or domain is not the flow's); `no_session`, `gate_required` or `method_in_use` for a link; and
-- the refusals of `uts.sign_in_with_method`.
CREATE FUNCTION uts.complete_provider_sign_in(
  p_environment text,
  p_state_hash bytea,
  p_binder_hash bytea,
  p_provider uts.sign_in_provider,
  p_subject text,
  p_email text,
  p_email_proven boolean,
  p_workos_connection_id text,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
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
  flow uts.sign_in_flows%ROWTYPE;
  sso_org uuid;
  holder text;
  owner_account text;
  signed record;
  attributes jsonb := jsonb_build_object('provider', p_provider);
BEGIN
  UPDATE uts.sign_in_flows AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.state_hash = p_state_hash AND stored.status = 'issued' AND stored.expires_at > now()
  RETURNING * INTO flow;
  IF NOT FOUND OR flow.provider <> p_provider OR flow.binder_hash <> p_binder_hash THEN
    outcome := 'invalid_state';
    RETURN NEXT;
    RETURN;
  END IF;
  flow_return_to := flow.return_to;

  IF p_provider = 'workos' THEN
    SELECT connection.org_id INTO sso_org
    FROM uts.sso_connections AS connection
    WHERE connection.id = flow.sso_connection_id
      AND connection.workos_connection_id = p_workos_connection_id
      AND connection.status = 'active';
    IF sso_org IS NULL OR p_email IS NULL OR NOT EXISTS (
      SELECT 1 FROM uts.sso_domains AS domain
      WHERE domain.org_id = sso_org
        AND domain.domain = split_part(p_email, '@', 2)
        AND domain.status = 'verified'
    ) THEN
      outcome := 'sso_refused';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF flow.intent = 'link' THEN
    SELECT session.account_id INTO holder
    FROM uts.browser_sessions AS session
    JOIN uts.accounts AS account ON account.id = session.account_id
    WHERE session.id = flow.link_session_id
      AND session.status = 'active'
      AND session.idle_expires_at > now()
      AND session.expires_at > now()
      AND account.status = 'active';
    IF holder IS NULL THEN
      outcome := 'no_session';
      RETURN NEXT;
      RETURN;
    END IF;
    session_account := holder;
    SELECT method.account_id INTO owner_account
    FROM uts.sign_in_methods AS method
    WHERE method.provider = p_provider AND method.provider_subject = p_subject;
    IF owner_account = holder THEN
      outcome := 'linked';
      RETURN NEXT;
      RETURN;
    END IF;
    IF owner_account IS NOT NULL THEN
      PERFORM uts.audit_account_refusal(
        p_environment, holder, 'ai.kilo.uts.sign_in_method.linked', 3001, 99, attributes,
        'method_in_use'
      );
      outcome := 'method_in_use';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE uts.gate_passes AS pass SET status = 'consumed', consumed_at = now()
    WHERE pass.id = flow.gate_pass_id
      AND pass.account_id = holder
      AND pass.browser_session_id = flow.link_session_id
      AND pass.tier = 'a'
      AND pass.action = 'method_add'
      AND pass.status = 'open'
      AND pass.expires_at > now();
    IF NOT FOUND THEN
      PERFORM uts.audit_session_gate_refusal(
        p_environment, holder, flow.link_session_id, 'method_add', 'tier A pass required'
      );
      outcome := 'gate_required';
      RETURN NEXT;
      RETURN;
    END IF;
    PERFORM uts.add_sign_in_method(
      p_environment, holder, p_provider, p_subject,
      CASE WHEN p_email_proven THEN p_email END, flow.sso_connection_id, flow.gate_pass_id,
      'gate_pass'
    );
    outcome := 'linked';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO signed
  FROM uts.sign_in_with_method(
    p_environment, p_provider, p_subject, p_email, p_email_proven, flow.sso_connection_id,
    CASE WHEN p_provider = 'workos' THEN 'sso' ELSE 'oauth' END::uts.auth_method,
    p_session_token_hash, p_user_agent, p_client_ip, p_asn, p_country, p_city
  );
  outcome := signed.outcome;
  IF signed.outcome = 'signed_in' THEN
    session_id := signed.session_id;
    session_account := signed.session_account;
    signed_in_at := now();
    account_created := signed.account_created;
    method_linked := signed.method_linked;
  END IF;
  RETURN NEXT;
END
$$;

-- POST /signin/email/start: stores a 10-minute sign-in email with its link and, unless codes are
-- stopped for the address, its code. Codes stop for 1 hour when a sixth code is asked for within
-- the hour, and the account (when the address has one) gets a notice. Outcomes: `stored` (with
-- whether a code was stored); `sso_required`.
CREATE FUNCTION uts.start_email_sign_in(
  p_email text,
  p_email_hash bytea,
  p_link_hash bytea,
  p_code_hash bytea,
  p_return_to text
) RETURNS TABLE (outcome text, with_code boolean, email_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  limits uts.email_code_limits%ROWTYPE;
  stop_started boolean := false;
  holder record;
BEGIN
  IF uts.sso_required_for(p_email) THEN
    outcome := 'sso_required';
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO uts.email_code_limits (purpose, email_hash, hour_started_at, day_started_at)
  VALUES ('sign_in', p_email_hash, now(), now())
  ON CONFLICT (purpose, email_hash) DO NOTHING;
  SELECT * INTO limits FROM uts.email_code_limits AS stored
  WHERE stored.purpose = 'sign_in' AND stored.email_hash = p_email_hash
  FOR UPDATE;
  IF limits.hour_started_at <= now() - interval '1 hour' THEN
    limits.hour_started_at := now();
    limits.sent_in_hour := 0;
  END IF;
  IF limits.day_started_at <= now() - interval '1 day' THEN
    limits.day_started_at := now();
    limits.failures_in_day := 0;
  END IF;
  IF limits.status = 'stopped' AND limits.stopped_until <= now() THEN
    limits.status := 'open';
    limits.stopped_until := NULL;
  END IF;
  IF limits.status = 'open' AND limits.sent_in_hour >= 5 THEN
    limits.status := 'stopped';
    limits.stopped_until := now() + interval '1 hour';
    stop_started := true;
  END IF;
  with_code := limits.status = 'open';
  IF with_code THEN
    limits.sent_in_hour := limits.sent_in_hour + 1;
  END IF;
  UPDATE uts.email_code_limits AS stored
  SET hour_started_at = limits.hour_started_at, sent_in_hour = limits.sent_in_hour,
    day_started_at = limits.day_started_at, failures_in_day = limits.failures_in_day,
    status = limits.status, stopped_until = limits.stopped_until
  WHERE stored.purpose = 'sign_in' AND stored.email_hash = p_email_hash;
  IF stop_started THEN
    SELECT * INTO holder FROM uts.account_of_email(p_email);
    IF FOUND THEN
      INSERT INTO uts.notices (account_id, kind, details)
      VALUES (holder.id, 'sign_in_code_stopped', jsonb_build_object('reason', 'code_cap'));
    END IF;
  END IF;

  INSERT INTO uts.email_codes (
    purpose, email_hash, email, link_hash, code_hash, return_to, expires_at
  ) VALUES (
    'sign_in', p_email_hash, p_email, p_link_hash, CASE WHEN with_code THEN p_code_hash END,
    p_return_to, now() + interval '10 minutes'
  ) RETURNING expires_at INTO email_expires_at;
  outcome := 'stored';
  RETURN NEXT;
END
$$;

-- The end of an email sign-in whose row was consumed: the address's `email` method, else the
-- account the address settles on, then a browser session.
CREATE FUNCTION uts.finish_email_sign_in(
  p_environment text,
  p_email text,
  p_method uts.auth_method,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS TABLE (
  outcome text,
  session_id uuid,
  session_account text,
  signed_in_at timestamptz,
  account_created boolean
)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  signed record;
BEGIN
  SELECT * INTO signed
  FROM uts.sign_in_with_method(
    p_environment, 'email', p_email, p_email, true, NULL, p_method, p_session_token_hash,
    p_user_agent, p_client_ip, p_asn, p_country, p_city
  );
  outcome := signed.outcome;
  IF signed.outcome = 'signed_in' THEN
    session_id := signed.session_id;
    session_account := signed.session_account;
    signed_in_at := now();
    account_created := signed.account_created;
  END IF;
  RETURN NEXT;
END
$$;

-- Counts a wrong sign-in code entry for the address: 20 in a day stop codes for 1 hour, and the
-- account (when the address has one) gets a notice.
CREATE FUNCTION uts.count_email_code_failure(p_email text, p_email_hash bytea) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  limits uts.email_code_limits%ROWTYPE;
  holder record;
BEGIN
  UPDATE uts.email_code_limits AS stored
  SET day_started_at = CASE WHEN stored.day_started_at <= now() - interval '1 day'
      THEN now() ELSE stored.day_started_at END,
    failures_in_day = CASE WHEN stored.day_started_at <= now() - interval '1 day'
      THEN 1 ELSE stored.failures_in_day + 1 END
  WHERE stored.purpose = 'sign_in' AND stored.email_hash = p_email_hash
  RETURNING * INTO limits;
  IF FOUND AND limits.failures_in_day >= 20
    AND (limits.status = 'open' OR limits.stopped_until <= now())
  THEN
    UPDATE uts.email_code_limits AS stored
    SET status = 'stopped', stopped_until = now() + interval '1 hour'
    WHERE stored.purpose = 'sign_in' AND stored.email_hash = p_email_hash;
    SELECT * INTO holder FROM uts.account_of_email(p_email);
    IF FOUND THEN
      INSERT INTO uts.notices (account_id, kind, details)
      VALUES (holder.id, 'sign_in_code_stopped', jsonb_build_object('reason', 'failed_entries'));
    END IF;
  END IF;
END
$$;

-- POST /signin/email/code: the newest pending code sent to the address. A wrong code counts an
-- entry; the fifth wrong entry exhausts the code (`code_locked`), and only the email's link can
-- still sign in. Each wrong entry writes a denied row for the address's account, when it has
-- one. Outcomes: `signed_in` with the session; `invalid_code` with the entries left;
-- `code_locked`; and the refusals of `uts.sign_in_with_method`.
CREATE FUNCTION uts.verify_email_code(
  p_environment text,
  p_email_hash bytea,
  p_code_hash bytea,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS TABLE (
  outcome text,
  code_return_to text,
  entries_left integer,
  session_id uuid,
  session_account text,
  signed_in_at timestamptz,
  account_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.email_codes%ROWTYPE;
  holder record;
  finished record;
BEGIN
  SELECT * INTO code FROM uts.email_codes AS stored
  WHERE stored.email_hash = p_email_hash
    AND stored.purpose = 'sign_in'
    AND stored.status = 'pending'
    AND stored.expires_at > now()
  ORDER BY stored.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND OR code.code_hash IS NULL THEN
    outcome := 'invalid_code';
    entries_left := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  code_return_to := code.return_to;
  IF code.code_hash <> p_code_hash THEN
    UPDATE uts.email_codes AS stored
    SET attempts = stored.attempts + 1,
      status = CASE WHEN stored.attempts + 1 >= 5 THEN 'exhausted'::uts.email_code_status
        ELSE stored.status END
    WHERE stored.id = code.id
    RETURNING 5 - stored.attempts INTO entries_left;
    PERFORM uts.count_email_code_failure(code.email, p_email_hash);
    SELECT * INTO holder FROM uts.account_of_email(code.email);
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.sign_in.denied', 3002, 1, 'denied',
        CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'wrong_code' END, holder.id,
        jsonb_build_object(
          'method', 'email_code',
          'reason', CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'wrong_code' END,
          'entriesLeft', entries_left
        )
      );
    END IF;
    outcome := CASE WHEN entries_left = 0 THEN 'code_locked' ELSE 'invalid_code' END;
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.email_codes AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.id = code.id;
  SELECT * INTO finished
  FROM uts.finish_email_sign_in(
    p_environment, code.email, 'email_code', p_session_token_hash, p_user_agent, p_client_ip,
    p_asn, p_country, p_city
  );
  outcome := finished.outcome;
  session_id := finished.session_id;
  session_account := finished.session_account;
  signed_in_at := finished.signed_in_at;
  account_created := finished.account_created;
  RETURN NEXT;
END
$$;

-- POST /signin/email/link: the unexpired, unused sign-in email whose link hash this is; a link
-- works after its code was exhausted, because only the address's owner holds the link. Outcomes:
-- `signed_in` with the session; `invalid_link`; and the refusals of `uts.sign_in_with_method`.
CREATE FUNCTION uts.complete_email_link(
  p_environment text,
  p_link_hash bytea,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS TABLE (
  outcome text,
  link_return_to text,
  session_id uuid,
  session_account text,
  signed_in_at timestamptz,
  account_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.email_codes%ROWTYPE;
  finished record;
BEGIN
  UPDATE uts.email_codes AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.link_hash = p_link_hash
    AND stored.purpose = 'sign_in'
    AND stored.status IN ('pending', 'exhausted')
    AND stored.expires_at > now()
  RETURNING * INTO code;
  IF NOT FOUND THEN
    outcome := 'invalid_link';
    RETURN NEXT;
    RETURN;
  END IF;
  link_return_to := code.return_to;
  SELECT * INTO finished
  FROM uts.finish_email_sign_in(
    p_environment, code.email, 'email_link', p_session_token_hash, p_user_agent, p_client_ip,
    p_asn, p_country, p_city
  );
  outcome := finished.outcome;
  session_id := finished.session_id;
  session_account := finished.session_account;
  signed_in_at := finished.signed_in_at;
  account_created := finished.account_created;
  RETURN NEXT;
END
$$;

-- Deletes sign-in flows and sign-in emails 1 hour past their 10-minute lifetime, and address
-- limits whose windows and stop have all ended, at most 5,000 of each kind per call, as
-- `uts.maintain_sign_in_rows()` does.
CREATE FUNCTION uts.maintain_provider_sign_in_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  batch CONSTANT integer := 5000;
BEGIN
  DELETE FROM uts.sign_in_flows AS flow
  WHERE flow.state_hash IN (
    SELECT stale.state_hash FROM uts.sign_in_flows AS stale
    WHERE stale.expires_at < now() - interval '1 hour'
    LIMIT batch
  );
  kind := 'sign_in_flows';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.email_codes AS code
  WHERE code.id IN (
    SELECT stale.id FROM uts.email_codes AS stale
    WHERE stale.expires_at < now() - interval '1 hour' AND stale.purpose = 'sign_in'
    LIMIT batch
  );
  kind := 'sign_in_emails';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.email_code_limits AS limits
  WHERE (limits.purpose, limits.email_hash) IN (
    SELECT stale.purpose, stale.email_hash FROM uts.email_code_limits AS stale
    WHERE stale.purpose = 'sign_in'
      AND stale.hour_started_at < now() - interval '1 hour'
      AND stale.day_started_at < now() - interval '1 day'
      AND (stale.status = 'open' OR stale.stopped_until < now())
    LIMIT batch
  );
  kind := 'email_code_limits';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;
CREATE INDEX email_code_limits_day_idx ON uts.email_code_limits (day_started_at);

GRANT EXECUTE ON FUNCTION
  uts.start_sign_in_flow(
    text, bytea, uts.sign_in_provider, bytea, uts.sign_in_intent, bytea, uuid, text, text
  ),
  uts.complete_provider_sign_in(
    text, bytea, bytea, uts.sign_in_provider, text, text, boolean, text, bytea, text, inet,
    integer, text, text
  ),
  uts.start_email_sign_in(text, bytea, bytea, bytea, text),
  uts.verify_email_code(text, bytea, bytea, bytea, text, inet, integer, text, text),
  uts.complete_email_link(text, bytea, bytea, text, inet, integer, text, text),
  uts.maintain_provider_sign_in_rows()
TO uts_app;

-- The functions above are now the only writers of these tables (README, "Rules for statements").
REVOKE INSERT, UPDATE, DELETE ON
  uts.sign_in_methods,
  uts.email_codes,
  uts.email_code_limits
FROM uts_app;
