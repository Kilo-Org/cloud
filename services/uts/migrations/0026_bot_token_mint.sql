-- The bot-token mint (design sections 5.3 and 6.5): a workload that runs as an internal bot account
-- gets one short-lived UTS access token for that account at POST /internal/bot-tokens. The Worker
-- verifies the caller's STS token and matches its policy (src/bot-token/); this statement is the
-- store step: one statement, no row lock, no stored token, and its audit row. The actor of the row
-- is the calling workload; the row's account is the bot account.
--
-- * `issued`: the account is active and an active `owner` or `member` of the policy's organization,
--   in a role the scope allows (`uts.role_allows_scopes`); returns the new token's id after the
--   `ai.kilo.uts.bot_token.issued` row that names it, the organization, the role and the scope.
-- * `account_inactive`: the account is missing or blocked; writes `ai.kilo.uts.bot_token.denied`.
-- * `membership_denied`: no active membership in the organization, or another role; writes the
--   denied row.
--
-- No SSO rule applies: a bot account never signs in. A bot token has no grant and no `sid`, and it
-- stops at its expiry, at most 1 hour after it was issued. To stop the tokens already issued, block
-- the bot account (subject operation `revoke`, reason `access_block`): the block refuses every
-- later mint and puts the account on the revocation feed for 70 minutes, so verifiers refuse its
-- tokens once their feed copy holds the entries (README, "Bot-token mint").

SET LOCAL ROLE uts_owner;

CREATE FUNCTION uts.mint_bot_token(
  p_environment text,
  p_workload text,
  p_account_id text,
  p_org_id uuid,
  p_scope text,
  p_lifetime_seconds integer
) RETURNS TABLE (outcome text, token_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_state uts.account_status;
  membership_state uts.membership_status;
  member_role uts.org_role;
  attributes jsonb;
  new_event_id uuid := gen_random_uuid();
  audit_type text;
BEGIN
  PERFORM uts.require_inputs(
    'uts.mint_bot_token',
    num_nulls(p_environment, p_workload, p_account_id, p_org_id, p_scope, p_lifetime_seconds) = 0
  );
  IF p_lifetime_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'a bot token lives 60 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  IF NOT uts.is_scope(p_scope) THEN
    RAISE EXCEPTION 'the scope is malformed' USING ERRCODE = '22023';
  END IF;
  IF p_account_id !~ '^bot-internal-[a-z0-9][a-z0-9-]{0,40}$' THEN
    RAISE EXCEPTION 'not an internal bot account id' USING ERRCODE = '22023';
  END IF;
  IF p_workload !~ '^[a-z][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION 'the workload name is malformed' USING ERRCODE = '22023';
  END IF;

  -- One probe of `accounts_pkey` and one of `org_memberships_pkey`.
  SELECT account.status, membership.status, membership.role
  INTO account_state, membership_state, member_role
  FROM uts.accounts AS account
  LEFT JOIN uts.org_memberships AS membership
    ON membership.org_id = p_org_id AND membership.account_id = account.id
  WHERE account.id = p_account_id;

  outcome := CASE
    WHEN account_state IS DISTINCT FROM 'active' THEN 'account_inactive'
    WHEN membership_state IS DISTINCT FROM 'active'
      OR member_role IS NULL
      OR member_role NOT IN ('owner', 'member')
      OR NOT uts.role_allows_scopes(ARRAY[p_scope], member_role)
    THEN 'membership_denied'
    ELSE 'issued'
  END;

  attributes := jsonb_build_object(
    'grantType', 'bot_token',
    'org', p_org_id,
    'orgRole', member_role,
    'scopes', to_jsonb(ARRAY[p_scope]),
    'audiences', to_jsonb(uts.scope_audiences(ARRAY[p_scope]))
  );
  IF outcome = 'issued' THEN
    token_id := gen_random_uuid();
    audit_type := 'ai.kilo.uts.bot_token.issued';
    attributes := attributes || jsonb_build_object(
      'tokenRefs', to_jsonb(ARRAY[token_id::text]),
      'tokenLifetimeSeconds', to_jsonb(ARRAY[p_lifetime_seconds::text])
    );
  ELSE
    audit_type := 'ai.kilo.uts.bot_token.denied';
  END IF;

  INSERT INTO uts.audit_events (event_id, event_type, account_id, event)
  VALUES (new_event_id, audit_type, p_account_id, jsonb_build_object(
    'specversion', '1.0',
    'id', new_event_id,
    'source', 'kilo:uts:' || p_environment,
    'type', audit_type,
    'time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'datacontenttype', 'application/json',
    'data', jsonb_build_object(
      'classUid', 6003,
      'activityId', 1,
      'outcome', CASE WHEN outcome = 'issued' THEN 'success' ELSE 'denied' END,
      'actor', jsonb_build_object('kind', 'workload', 'id', p_workload),
      'attributes', jsonb_strip_nulls(attributes)
    ) || CASE
      WHEN outcome = 'issued' THEN '{}'::jsonb
      ELSE jsonb_build_object('outcomeDetail', outcome)
    END
  ));
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION uts.mint_bot_token(text, text, text, uuid, text, integer) TO uts_app;
