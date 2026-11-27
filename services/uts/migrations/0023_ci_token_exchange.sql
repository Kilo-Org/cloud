-- The CI token exchange (design sections 5.3, 5.5 and 6.2): a GitHub Actions job exchanges its
-- OIDC token at POST /token for one UTS access token of the one account its trust policy names.
-- The Worker verifies the OIDC token and matches the policy (src/ci/); this statement is the store
-- step: one statement, no row lock, no stored token, and its audit row.
--
-- * `issued`: the account is active; returns the new token's id after the
--   `ai.kilo.uts.ci_token.issued` row that names it, the policy and the GitHub run.
-- * `account_inactive`: the account is missing or blocked; writes `ai.kilo.uts.ci_token.denied`.
-- * `refused`: the Worker passes a refusal (`binding_mismatch`, `scope_not_granted`) for a token
--   that names a policy's repository and workflow but fails it; writes only the denied row. The
--   Worker writes at most one such row per policy and reason per minute in each isolate, and a
--   token that names no policy's repository costs no statement.
--
-- A CI token has no grant and no `sid`. It stops at its expiry, at most 1 hour after it was issued.
-- Removing its policy from the config stops new CI tokens only; tokens already issued live until
-- their expiry. To stop them early, block the policy's CI account or revoke its subject
-- (`revoked_before` on the revocation feed); verifiers refuse them once their feed copy holds the
-- entry (README, "CI token exchange").

SET LOCAL ROLE uts_owner;

CREATE FUNCTION uts.exchange_ci_token(
  p_environment text,
  p_policy text,
  p_account_id text,
  p_scope text,
  p_lifetime_seconds integer,
  p_refusal text,
  p_repository_id text,
  p_github_environment text,
  p_ref text,
  p_sha text,
  p_event_name text,
  p_job_workflow_ref text,
  p_run_id text,
  p_run_attempt text,
  p_subject_token_id text
) RETURNS TABLE (outcome text, token_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attributes jsonb;
  account_active boolean;
BEGIN
  PERFORM uts.require_inputs(
    'uts.exchange_ci_token',
    num_nulls(
      p_environment, p_policy, p_account_id, p_scope, p_lifetime_seconds, p_repository_id,
      p_github_environment, p_ref, p_sha, p_event_name, p_job_workflow_ref, p_run_id,
      p_run_attempt, p_subject_token_id
    ) = 0
  );
  IF p_lifetime_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'a CI token lives 60 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  IF NOT uts.is_scope(p_scope) THEN
    RAISE EXCEPTION 'the scope is malformed' USING ERRCODE = '22023';
  END IF;
  IF p_refusal IS NOT NULL AND p_refusal NOT IN ('binding_mismatch', 'scope_not_granted') THEN
    RAISE EXCEPTION 'unknown CI token refusal' USING ERRCODE = '22023';
  END IF;

  attributes := jsonb_build_object(
    'grantType', 'ci_token_exchange',
    'policy', p_policy,
    'repositoryId', p_repository_id,
    'githubEnvironment', p_github_environment,
    'ref', p_ref,
    'sha', p_sha,
    'eventName', p_event_name,
    'jobWorkflowRef', p_job_workflow_ref,
    'runId', p_run_id,
    'runAttempt', p_run_attempt,
    'subjectTokenRef', p_subject_token_id,
    'scopes', to_jsonb(ARRAY[p_scope]),
    'audiences', to_jsonb(uts.scope_audiences(ARRAY[p_scope]))
  );

  IF p_refusal IS NULL THEN
    SELECT account.status = 'active' INTO account_active
    FROM uts.accounts AS account
    WHERE account.id = p_account_id;
  END IF;

  IF p_refusal IS NOT NULL OR account_active IS NOT TRUE THEN
    PERFORM uts.write_audit_event(
      p_environment, 'ai.kilo.uts.ci_token.denied', 6003, 1, 'denied',
      coalesce(p_refusal, 'account_inactive'), p_account_id, attributes
    );
    outcome := CASE WHEN p_refusal IS NULL THEN 'account_inactive' ELSE 'refused' END;
    RETURN NEXT;
    RETURN;
  END IF;

  token_id := gen_random_uuid();
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.ci_token.issued', 6003, 1, 'success', NULL, p_account_id,
    attributes || jsonb_build_object(
      'tokenRefs', to_jsonb(ARRAY[token_id::text]),
      'tokenLifetimeSeconds', to_jsonb(ARRAY[p_lifetime_seconds::text])
    )
  );
  outcome := 'issued';
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION uts.exchange_ci_token(
  text, text, text, text, integer, text, text, text, text, text, text, text, text, text, text
) TO uts_app;
