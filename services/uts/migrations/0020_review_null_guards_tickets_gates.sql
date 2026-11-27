-- Fixes from the review of the sign-in, device grant, ticket and notice statements (design
-- sections 5.1, 5.3, 5.4, 5.11 and 5.13). Every file before this one is applied somewhere, so the
-- changed functions are replaced here rather than edited in place.
--
-- * A required input that is NULL is refused (`uts.require_inputs`, SQLSTATE 22004) by the device
--   decision and exchange, the ticket mint and redemption, the provider callback, and the email
--   start and link, and their guards compare with `IS DISTINCT FROM`. Before, a NULL argument made
--   a `<>` or `NOT` guard NULL, so the refusal branch was skipped: a NULL audience redeemed any
--   ticket, a NULL binder completed any flow, a NULL approval approved a device code, and a NULL
--   confirmation signed a link in from another browser.
-- * A ticket redemption names the purpose and the resource the redeeming service opens, and only a
--   ticket minted for all three (audience, purpose, resource) redeems. A mismatch answers `unknown`
--   and leaves the ticket usable, as a wrong audience did, with one denied audit row per ticket per
--   minute. The three-argument `uts.redeem_ticket` is dropped.
-- * `uts.open_browser_tier_a_gate_pass` opens a tier A pass (design 5.11) for the browser session a
--   cookie names, the session that passkey registration and an in-session method link consume a
--   pass of. `uts.open_tier_a_gate_pass` (0005) opens passes for the device session of a grant
--   only, and a pass belongs to one session (`gate_passes_one_session`), so before this no
--   statement a login role may call could open the pass those two actions need. The checks are
--   the same: a sign-in of the session within 10 minutes with the account's strongest method, the
--   emailed code (two for an email change, each in its own role), and the 24-hour cooling-off for
--   a removal or an email change.
-- * While codes are stopped for an address, a sign-in email carries only its link. At most 5 such
--   link-only emails go to one address in its hour (`links_in_hour`, `send_limited` past that),
--   the same bound as the code emails, so an address gets at most 10 sign-in emails an hour. The 5
--   code emails are never capped by it, and a link already sent keeps working.
-- * The app login loses direct INSERT, UPDATE and DELETE on `uts.notices`: only the SECURITY
--   DEFINER statements of a change write a notice, and only the notice functions move its delivery.

SET LOCAL ROLE uts_owner;

-- `uts.decide_device_code()` (migration 0008) with its inputs required: a NULL approval made
-- `NOT p_approve` NULL, which skipped the denial and went on to approve. Everything else is as in
-- 0008; the grant stays.
CREATE OR REPLACE FUNCTION uts.decide_device_code(
  p_environment text,
  p_user_code_hash bytea,
  p_session_token_hash bytea,
  p_client_ip inet,
  p_typed boolean,
  p_approve boolean
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  entry_network inet := uts.client_network(p_client_ip);
  code uts.device_codes%ROWTYPE;
  step_up_time timestamptz;
  checks uts.gate_check[];
  pass_id uuid;
  methods uts.auth_method[];
  event_id uuid;
BEGIN
  PERFORM uts.require_inputs(
    'uts.decide_device_code',
    p_environment IS NOT NULL AND p_user_code_hash IS NOT NULL
      AND p_session_token_hash IS NOT NULL AND p_typed IS NOT NULL AND p_approve IS NOT NULL
  );
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT uts.user_code_entries_left(live.account_id, entry_network) THEN
    outcome := 'too_many_attempts';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO code FROM uts.device_codes AS stored
  WHERE stored.user_code_hash = p_user_code_hash
    AND stored.status = 'pending'
    AND stored.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM uts.count_user_code_failure(live.account_id, entry_network);
    outcome := 'unknown_code';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT p_approve THEN
    UPDATE uts.device_codes AS stored
    SET status = 'denied', account_id = live.account_id, denied_at = now()
    WHERE stored.id = code.id;
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.device_code.denied', 3002, 99, 'success', NULL, live.account_id,
      jsonb_build_object(
        'clientId', uts.audit_client_id(code.client_id),
        'deviceCodeId', code.id,
        'sessionId', live.id
      )
    );
    outcome := 'denied';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT max(step_up.completed_at) INTO step_up_time
  FROM uts.step_ups AS step_up
  WHERE step_up.account_id = live.account_id
    AND step_up.browser_session_id = live.id
    AND step_up.purpose = 'gate'
    AND step_up.completed_at > now() - interval '10 minutes'
    AND step_up.expires_at > now();
  checks := array_remove(ARRAY[
    CASE WHEN p_typed AND live.auth_time > now() - interval '10 minutes' AND live.auth_time <= now()
      THEN 'recent_sign_in'::uts.gate_check END,
    CASE WHEN step_up_time IS NOT NULL THEN 'passkey'::uts.gate_check END
  ], NULL);
  IF cardinality(checks) = 0 THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, 'device_approve',
      CASE WHEN p_typed THEN 'sign-in or passkey check required'
        ELSE 'passkey check required for a linked code' END
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.gate_passes (
    account_id, browser_session_id, tier, action, satisfied_by, expires_at, status, consumed_at
  ) VALUES (
    live.account_id, live.id, 'b', 'device_approve', checks, now() + interval '10 minutes',
    'consumed', now()
  ) RETURNING id INTO pass_id;
  methods := ARRAY(
    SELECT DISTINCT method
    FROM unnest(
      live.amr
      || CASE WHEN step_up_time IS NULL THEN '{}'::uts.auth_method[] ELSE '{passkey}'::uts.auth_method[] END
      || '{device_grant}'::uts.auth_method[]
    ) AS method
    ORDER BY method
  );
  UPDATE uts.device_codes AS stored
  SET status = 'approved', account_id = live.account_id, gate_pass_id = pass_id,
    approved_at = now(),
    auth_time = greatest(live.auth_time, coalesce(step_up_time, live.auth_time)),
    amr = methods
  WHERE stored.id = code.id;
  event_id := uts.write_audit_event(
    p_environment, 'ai.kilo.uts.device_code.approved', 3002, 99, 'success', NULL, live.account_id,
    jsonb_build_object(
      'clientId', uts.audit_client_id(code.client_id),
      'deviceCodeId', code.id,
      'gatePassId', pass_id,
      'gateChecks', to_jsonb(checks::text[]),
      'scopes', to_jsonb(code.scopes),
      'sessionId', live.id,
      'deviceCountry', code.country
    )
  );
  INSERT INTO uts.notices (account_id, kind, details, audit_event_id)
  VALUES (
    live.account_id, 'device_sign_in_approved',
    jsonb_strip_nulls(jsonb_build_object(
      'clientId', uts.audit_client_id(code.client_id),
      'country', code.country,
      'city', code.city
    )),
    event_id
  );
  outcome := 'approved';
  RETURN NEXT;
END
$$;

-- `uts.exchange_device_code()` (migration 0008) with its inputs required and `IS DISTINCT FROM`
-- guards: a NULL client id skipped the check that the code is the polling client's. Everything else
-- is as in 0008; the grant stays.
CREATE OR REPLACE FUNCTION uts.exchange_device_code(
  p_environment text,
  p_device_code_hash bytea,
  p_client_id text,
  p_client_class uts.client_class,
  p_dpop_jkt bytea,
  p_dpop_jti text,
  p_grant_id uuid,
  p_refresh_token_hash bytea,
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
  code uts.device_codes%ROWTYPE;
  retry boolean := false;
  revoked_account text;
  chosen record;
  account_state uts.account_status;
  new_session_id uuid;
  idle_window interval;
  grant_state uts.grant_status;
  previous_hash bytea;
BEGIN
  PERFORM uts.require_inputs(
    'uts.exchange_device_code',
    p_environment IS NOT NULL AND p_device_code_hash IS NOT NULL AND p_client_id IS NOT NULL
      AND p_client_class IS NOT NULL AND p_dpop_jkt IS NOT NULL AND p_dpop_jti IS NOT NULL
      AND p_grant_id IS NOT NULL AND p_refresh_token_hash IS NOT NULL
  );
  SELECT * INTO code FROM uts.device_codes AS stored WHERE stored.device_code_hash = p_device_code_hash
  FOR UPDATE;
  IF NOT FOUND OR code.client_id IS DISTINCT FROM p_client_id THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF code.status = 'consumed' THEN
    IF code.expires_at > now() AND code.dpop_jkt = p_dpop_jkt AND code.grant_id = p_grant_id THEN
      retry := true;
    ELSE
      revoked_account := uts.end_grant('first_party', code.grant_id, 'reuse_detected');
      IF revoked_account IS NOT NULL THEN
        PERFORM uts.write_audit_event(
          p_environment, 'ai.kilo.uts.device_code.reused', 6003, 99, 'denied', 'grant revoked',
          revoked_account,
          jsonb_build_object(
            'clientId', uts.audit_client_id(code.client_id),
            'deviceCodeId', code.id,
            'grantId', code.grant_id
          )
        );
      END IF;
      outcome := 'invalid_grant';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF NOT retry THEN
    IF code.expires_at <= now() THEN
      outcome := 'expired_token';
      RETURN NEXT;
      RETURN;
    END IF;
    IF code.status = 'denied' THEN
      outcome := 'access_denied';
      RETURN NEXT;
      RETURN;
    END IF;
    IF code.status = 'pending' THEN
      IF code.last_polled_at IS NOT NULL
        AND code.last_polled_at > now() - make_interval(secs => code.poll_interval_seconds)
      THEN
        UPDATE uts.device_codes AS stored
        SET poll_interval_seconds = least(60, stored.poll_interval_seconds + 5), last_polled_at = now()
        WHERE stored.id = code.id;
        outcome := 'slow_down';
      ELSE
        UPDATE uts.device_codes AS stored SET last_polled_at = now() WHERE stored.id = code.id;
        outcome := 'authorization_pending';
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  INSERT INTO uts.dpop_proofs (jkt, jti, expires_at)
  VALUES (p_dpop_jkt, p_dpop_jti, now() + interval '121 seconds')
  ON CONFLICT ON CONSTRAINT dpop_proofs_pkey DO NOTHING;
  IF NOT FOUND THEN
    outcome := 'dpop_replay';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO chosen FROM uts.select_token_scopes(code.scopes, p_scopes, p_resources);
  IF chosen.outcome IS DISTINCT FROM 'ok' THEN
    outcome := chosen.outcome;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT account.status INTO account_state FROM uts.accounts AS account WHERE account.id = code.account_id;
  IF account_state IS DISTINCT FROM 'active' THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT retry THEN
    UPDATE uts.device_codes AS stored
    SET status = 'consumed', consumed_at = now(), grant_id = p_grant_id, dpop_jkt = p_dpop_jkt
    WHERE stored.id = code.id;
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
      p_refresh_token_hash, p_dpop_jkt, code.scopes, NULL, now() + idle_window,
      now() + CASE p_client_class WHEN 'desktop' THEN interval '180 days' ELSE interval '365 days' END
    );
    refresh_expires_at := now() + idle_window;
  ELSE
    SELECT grant_row.status, grant_row.token_hash, least(grant_row.idle_expires_at, grant_row.expires_at)
    INTO grant_state, previous_hash, refresh_expires_at
    FROM uts.refresh_grants AS grant_row WHERE grant_row.id = p_grant_id
    FOR UPDATE;
    IF grant_state IS DISTINCT FROM 'active' THEN
      outcome := 'invalid_grant';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE uts.refresh_grants AS grant_row SET token_hash = p_refresh_token_hash
    WHERE grant_row.id = p_grant_id;
  END IF;

  token_ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, cardinality(chosen.scopes)));
  IF retry THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.token.issued', 6003, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'device_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', 'first_party',
        'grantId', p_grant_id,
        'rotation', 'device_code_retry',
        'deviceCodeId', code.id,
        'previousRefreshRef', uts.credential_reference(previous_hash),
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', 600
      )
    );
  ELSE
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.grant.created', 3002, 1, 'success', NULL, code.account_id,
      jsonb_build_object(
        'grantType', 'device_code',
        'clientId', uts.audit_client_id(code.client_id),
        'clientKind', 'first_party',
        'grantId', p_grant_id,
        'deviceCodeId', code.id,
        'gatePassId', code.gate_pass_id,
        'refreshRef', uts.credential_reference(p_refresh_token_hash),
        'tokenRefs', to_jsonb(token_ids::text[]),
        'scopes', to_jsonb(chosen.scopes),
        'audiences', to_jsonb(uts.scope_audiences(chosen.scopes)),
        'tokenLifetimeSeconds', 600
      )
    );
  END IF;
  outcome := 'issued';
  subject_id := code.account_id;
  bound_org_id := NULL;
  signed_in_at := code.auth_time;
  sign_in_methods := code.amr::text[];
  token_scopes := chosen.scopes;
  RETURN NEXT;
END
$$;

-- `uts.issue_ticket()` (migration 0008) with its inputs required and `IS DISTINCT FROM` guards: a
-- NULL grant id, client id or DPoP key skipped its check. A grant without a DPoP key (a web grant)
-- answers `dpop_mismatch`. Everything else is as in 0008; the grant stays.
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

-- `uts.redeem_ticket()` (migration 0008) with the purpose and the resource the redeemer expects:
-- a ticket redeems only for its own audience, purpose and resource, and any mismatch is refused
-- as a wrong audience was. A new parameter list is a new function, so the old one is dropped.
DROP FUNCTION uts.redeem_ticket(text, bytea, text);

CREATE FUNCTION uts.redeem_ticket(
  p_environment text,
  p_ticket_hash bytea,
  p_audience text,
  p_purpose uts.ticket_purpose,
  p_resource text
)
RETURNS TABLE (
  outcome text,
  ticket_account text,
  ticket_purpose uts.ticket_purpose,
  ticket_resource text,
  ticket_org uuid,
  ticket_grant uuid,
  ticket_client text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ticket uts.tickets%ROWTYPE;
  live boolean;
BEGIN
  PERFORM uts.require_inputs(
    'uts.redeem_ticket',
    p_environment IS NOT NULL AND p_ticket_hash IS NOT NULL AND p_audience IS NOT NULL
      AND p_purpose IS NOT NULL
  );
  SELECT * INTO ticket FROM uts.tickets AS stored WHERE stored.ticket_hash = p_ticket_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF ticket.status = 'consumed' THEN
    UPDATE uts.tickets AS stored SET denied_audited_at = now()
    -- The first use after the consumption writes the row; a wrong-audience row before it does not
    -- count.
    WHERE stored.ticket_hash = p_ticket_hash
      AND (stored.denied_audited_at IS NULL OR stored.denied_audited_at < stored.consumed_at);
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.ticket.reused', 6003, 2, 'denied', 'ticket used before',
        ticket.account_id,
        jsonb_build_object(
          'ticketRef', uts.credential_reference(p_ticket_hash),
          'purpose', ticket.purpose,
          'audience', ticket.audience,
          'grantId', ticket.grant_id
        )
      );
    END IF;
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT ticket.expires_at > now() THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  IF ticket.audience IS DISTINCT FROM p_audience
    OR ticket.purpose IS DISTINCT FROM p_purpose
    OR ticket.resource IS DISTINCT FROM p_resource
  THEN
    UPDATE uts.tickets AS stored SET denied_audited_at = now()
    WHERE stored.ticket_hash = p_ticket_hash
      AND (stored.denied_audited_at IS NULL OR stored.denied_audited_at <= now() - interval '1 minute');
    IF FOUND THEN
      PERFORM uts.write_audit_event(
        p_environment, 'ai.kilo.uts.ticket.denied', 6003, 2, 'denied',
        CASE
          WHEN ticket.audience IS DISTINCT FROM p_audience THEN 'audience mismatch'
          WHEN ticket.purpose IS DISTINCT FROM p_purpose THEN 'purpose mismatch'
          ELSE 'resource mismatch'
        END,
        ticket.account_id,
        jsonb_build_object(
          'ticketRef', uts.credential_reference(p_ticket_hash),
          'purpose', ticket.purpose,
          'audience', ticket.audience,
          'grantId', ticket.grant_id
        )
      );
    END IF;
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;
  -- The grant, its device session and the account must be live, and an organization ticket needs
  -- the membership and SSO requirement it was minted under (design 5.8).
  SELECT true INTO live
  FROM uts.refresh_grants AS grant_row
  JOIN uts.device_sessions AS session ON session.id = grant_row.device_session_id
  JOIN uts.accounts AS account ON account.id = grant_row.account_id
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = ticket.org_id AND membership.account_id = ticket.account_id
  LEFT JOIN uts.org_sso_policies AS policy ON policy.org_id = ticket.org_id
  WHERE grant_row.id = ticket.grant_id
    AND grant_row.status = 'active'
    AND grant_row.expires_at > now()
    AND grant_row.idle_expires_at > now()
    AND session.status = 'active'
    AND account.status = 'active'
    AND uts.org_requirement_met(ticket.org_id, membership.status, policy.enforcement, session.amr);
  IF live IS NULL THEN
    outcome := 'unknown';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE uts.tickets AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.ticket_hash = p_ticket_hash;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.ticket.redeemed', 6003, 2, 'success', NULL, ticket.account_id,
    jsonb_build_object(
      'ticketRef', uts.credential_reference(p_ticket_hash),
      'purpose', ticket.purpose,
      'audience', ticket.audience,
      'grantId', ticket.grant_id
    )
  );
  outcome := 'redeemed';
  ticket_account := ticket.account_id;
  ticket_purpose := ticket.purpose;
  ticket_resource := ticket.resource;
  ticket_org := ticket.org_id;
  ticket_grant := ticket.grant_id;
  ticket_client := ticket.client_id;
  RETURN NEXT;
END
$$;

-- `uts.complete_provider_sign_in()` with the 15 parameters of migration 0009, with its inputs
-- required and `IS DISTINCT FROM` guards: a NULL provider or binder skipped the flow check, and a
-- NULL proof flag skipped the refusal of an unproven address. Migration 0013 calls this signature
-- from its own; everything else is as in 0009, and the grants stay as they are.
CREATE OR REPLACE FUNCTION uts.complete_provider_sign_in(
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
  flow uts.sign_in_flows%ROWTYPE;
  sso_org uuid;
  holder text;
  owner_account text;
  signed record;
  attributes jsonb := jsonb_build_object('provider', p_provider);
BEGIN
  PERFORM uts.require_inputs(
    'uts.complete_provider_sign_in',
    p_environment IS NOT NULL AND p_state_hash IS NOT NULL AND p_binder_hash IS NOT NULL
      AND p_provider IS NOT NULL AND p_subject IS NOT NULL AND p_email_proven IS NOT NULL
      AND p_session_token_hash IS NOT NULL AND p_new_account_id IS NOT NULL
  );
  UPDATE uts.sign_in_flows AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.state_hash = p_state_hash AND stored.status = 'issued' AND stored.expires_at > now()
  RETURNING * INTO flow;
  IF NOT FOUND OR flow.provider IS DISTINCT FROM p_provider
    OR flow.binder_hash IS DISTINCT FROM p_binder_hash
  THEN
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
    p_session_token_hash, p_user_agent, p_client_ip, p_asn, p_country, p_city, p_new_account_id
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

-- `uts.complete_email_link()` (migration 0009) with its inputs required: a NULL confirmation made
-- the other-browser check NULL, which signed the link in without the confirmation. Everything else
-- is as in 0009; the grant stays.
CREATE OR REPLACE FUNCTION uts.complete_email_link(
  p_environment text,
  p_link_hash bytea,
  p_binder_hash bytea,
  p_other_browser boolean,
  p_session_token_hash bytea,
  p_user_agent text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text,
  p_new_account_id text
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
  PERFORM uts.require_inputs(
    'uts.complete_email_link',
    p_environment IS NOT NULL AND p_link_hash IS NOT NULL AND p_other_browser IS NOT NULL
      AND p_session_token_hash IS NOT NULL AND p_new_account_id IS NOT NULL
  );
  SELECT * INTO code FROM uts.email_codes AS stored
  WHERE stored.link_hash = p_link_hash
    AND stored.purpose = 'sign_in'
    AND stored.status IN ('pending', 'exhausted')
    AND stored.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'invalid_link';
    RETURN NEXT;
    RETURN;
  END IF;
  link_return_to := code.return_to;
  IF code.binder_hash IS DISTINCT FROM p_binder_hash AND NOT p_other_browser THEN
    outcome := 'confirm_other_browser';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE uts.email_codes AS stored SET status = 'consumed', consumed_at = now()
  WHERE stored.id = code.id;
  SELECT * INTO finished
  FROM uts.finish_email_sign_in(
    p_environment, code.email, 'email_link', p_session_token_hash, p_user_agent, p_client_ip,
    p_asn, p_country, p_city, p_new_account_id
  );
  outcome := finished.outcome;
  session_id := finished.session_id;
  session_account := finished.session_account;
  signed_in_at := finished.signed_in_at;
  account_created := finished.account_created;
  RETURN NEXT;
END
$$;

-- At most 5 link-only emails per address in its hour while codes are stopped. `links_in_hour`
-- counts them and starts again with the hour, as `sent_in_hour` counts the code emails.
ALTER TABLE uts.email_code_limits
  ADD COLUMN links_in_hour smallint NOT NULL DEFAULT 0 CHECK (links_in_hour BETWEEN 0 AND 5);

-- `uts.start_email_sign_in()` (migration 0009) with its inputs required and the link-only cap: while
-- codes are stopped, the sixth email of the hour is refused (`send_limited`) with nothing stored.
-- The limits row and the notice of a stop that this call started are still written. Everything else
-- is as in 0009; the grant stays.
CREATE OR REPLACE FUNCTION uts.start_email_sign_in(
  p_email text,
  p_email_hash bytea,
  p_link_hash bytea,
  p_code_hash bytea,
  p_binder_hash bytea,
  p_return_to text
) RETURNS TABLE (outcome text, with_code boolean, email_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  limits uts.email_code_limits%ROWTYPE;
  stop_started boolean := false;
  capped boolean := false;
  holder record;
BEGIN
  PERFORM uts.require_inputs(
    'uts.start_email_sign_in',
    p_email IS NOT NULL AND p_email_hash IS NOT NULL AND p_link_hash IS NOT NULL
      AND p_code_hash IS NOT NULL AND p_binder_hash IS NOT NULL AND p_return_to IS NOT NULL
  );
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
    limits.links_in_hour := 0;
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
  ELSIF limits.links_in_hour >= 5 THEN
    capped := true;
  ELSE
    limits.links_in_hour := limits.links_in_hour + 1;
  END IF;
  UPDATE uts.email_code_limits AS stored
  SET hour_started_at = limits.hour_started_at, sent_in_hour = limits.sent_in_hour,
    links_in_hour = limits.links_in_hour,
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
  IF capped THEN
    outcome := 'send_limited';
    with_code := false;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE uts.email_codes AS stored SET status = 'exhausted', attempts = 5
  WHERE stored.email_hash = p_email_hash
    AND stored.purpose = 'sign_in'
    AND stored.status = 'pending'
    AND stored.code_hash IS NOT NULL;
  INSERT INTO uts.email_codes (
    purpose, email_hash, email, link_hash, code_hash, binder_hash, return_to, expires_at
  ) VALUES (
    'sign_in', p_email_hash, p_email, p_link_hash, CASE WHEN with_code THEN p_code_hash END,
    p_binder_hash, p_return_to, now() + interval '10 minutes'
  ) RETURNING expires_at INTO email_expires_at;
  outcome := 'stored';
  RETURN NEXT;
END
$$;

-- Opens a tier A gate pass (design 5.11) for one action of the browser session that
-- `p_session_token_hash` names; the action's statement (`uts.register_passkey`, the method link of
-- `uts.complete_provider_sign_in`) consumes it within 10 minutes. The checks are those of
-- `uts.open_tier_a_gate_pass` (0005) on the browser session instead of a grant's device session:
-- a sign-in of the session within 10 minutes with the account's strongest method (a passkey when
-- the account holds one, else SSO when it has an SSO link, else any method); the code emailed to
-- the primary address, and for an email change also the code sent to the new address, each only
-- in its own role and both checked before either is consumed; and no method or passkey added in
-- the last 24 hours for a removal or an email change. A refusal writes at most one denied audit
-- row per session per minute. Outcomes: `opened` with the pass; `no_session`; `gate_required`;
-- `cooling_off`; `code_invalid` (a missing, wrong, expired or exhausted code; a wrong code counts
-- an attempt).
CREATE FUNCTION uts.open_browser_tier_a_gate_pass(
  p_environment text,
  p_session_token_hash bytea,
  p_action uts.gated_action,
  p_email_hash bytea,
  p_code_hash bytea,
  p_new_email_hash bytea,
  p_new_code_hash bytea
) RETURNS TABLE (outcome text, gate_pass_id uuid, pass_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  live record;
  strongest uts.auth_method;
  checks uts.gate_check[] := ARRAY['recent_sign_in', 'email_code']::uts.gate_check[];
  old_ok boolean;
  new_ok boolean := true;
BEGIN
  PERFORM uts.require_inputs(
    'uts.open_browser_tier_a_gate_pass',
    p_environment IS NOT NULL AND p_session_token_hash IS NOT NULL AND p_action IS NOT NULL
      AND p_email_hash IS NOT NULL AND p_code_hash IS NOT NULL
  );
  IF p_action NOT IN ('passkey_add', 'passkey_remove', 'method_add', 'method_remove', 'email_change') THEN
    RAISE EXCEPTION 'not a tier A action' USING ERRCODE = '22023';
  END IF;
  IF (p_action = 'email_change') <> (p_new_email_hash IS NOT NULL AND p_new_code_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'an email change, and only an email change, names the new address and its code'
      USING ERRCODE = '22023';
  END IF;
  IF p_action = 'email_change' AND p_email_hash = p_new_email_hash THEN
    RAISE EXCEPTION 'an email change needs a new address' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO live FROM uts.live_browser_session(p_session_token_hash);
  IF NOT FOUND THEN
    outcome := 'no_session';
    RETURN NEXT;
    RETURN;
  END IF;
  strongest := CASE
    WHEN EXISTS (
      SELECT 1 FROM uts.passkey_credentials AS passkey WHERE passkey.account_id = live.account_id
    ) THEN 'passkey'::uts.auth_method
    WHEN EXISTS (
      SELECT 1 FROM uts.sign_in_methods AS method
      WHERE method.account_id = live.account_id AND method.provider = 'workos'
    ) THEN 'sso'::uts.auth_method
  END;
  IF NOT (live.auth_time > now() - interval '10 minutes' AND live.auth_time <= now())
    OR (strongest IS NOT NULL AND NOT strongest = ANY (live.amr))
  THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, p_action, 'strongest-method sign-in required'
    );
    outcome := 'gate_required';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_action IN ('passkey_remove', 'method_remove', 'email_change') AND (
    EXISTS (
      SELECT 1 FROM uts.sign_in_methods AS method
      WHERE method.account_id = live.account_id AND method.added_at > now() - interval '24 hours'
    )
    OR EXISTS (
      SELECT 1 FROM uts.passkey_credentials AS passkey
      WHERE passkey.account_id = live.account_id AND passkey.added_at > now() - interval '24 hours'
    )
  ) THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, p_action, 'method added in the last 24 hours'
    );
    outcome := 'cooling_off';
    RETURN NEXT;
    RETURN;
  END IF;

  old_ok := uts.use_tier_a_code(live.account_id, 'current', p_email_hash, p_code_hash, false);
  IF p_action = 'email_change' THEN
    new_ok := uts.use_tier_a_code(live.account_id, 'new', p_new_email_hash, p_new_code_hash, false);
    checks := checks || 'email_code_new'::uts.gate_check;
  END IF;
  IF NOT (old_ok AND new_ok) THEN
    PERFORM uts.audit_session_gate_refusal(
      p_environment, live.account_id, live.id, p_action, 'email code invalid'
    );
    outcome := 'code_invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM uts.use_tier_a_code(live.account_id, 'current', p_email_hash, p_code_hash, true);
  IF p_action = 'email_change' THEN
    PERFORM uts.use_tier_a_code(live.account_id, 'new', p_new_email_hash, p_new_code_hash, true);
  END IF;

  INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
  VALUES (live.account_id, live.id, 'a', p_action, checks, now() + interval '10 minutes')
  RETURNING id, expires_at INTO gate_pass_id, pass_expires_at;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.gate.passed', 3001, 99, 'success', NULL, live.account_id,
    jsonb_build_object(
      'action', p_action,
      'tier', 'a',
      'gatePassId', gate_pass_id,
      'gateChecks', to_jsonb(checks::text[]),
      'sessionId', live.id
    )
  );
  outcome := 'opened';
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.redeem_ticket(text, bytea, text, uts.ticket_purpose, text),
  uts.open_browser_tier_a_gate_pass(text, bytea, uts.gated_action, bytea, bytea, bytea, bytea)
TO uts_app;

-- Only the SECURITY DEFINER statements of a change write a notice, and only the notice functions of
-- migration 0010 move its delivery; no Worker statement writes the table.
REVOKE INSERT, UPDATE, DELETE ON uts.notices FROM uts_app;
