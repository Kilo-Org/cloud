-- Device attestation of the mobile app `kilo-mobile` (design section 5.5, decision Q67).
--
-- * The app attests at its code exchange, over a challenge derived from the authorization code
--   (`@kilocode/uts-contracts` `attestation.ts`), so each attestation names one authorization
--   request and lasts as long as its 60-second code.
-- * `uts.claim_code_attestation` checks the code against the token request (client, redirect URI,
--   PKCE challenge, DPoP key, lifetime) before the Worker verifies anything, so a request without
--   a valid code costs no Play Integrity call, and it claims the code's attestation, so one code is
--   verified by one request at a time. A claim older than 15 seconds can be taken over: the
--   Worker gives up on its verification within 10 seconds.
-- * `uts.settle_code_attestation` records the result of the claim that is still current: an App
--   Attest key (with counter 0), an assertion's counter (which must grow), a refusal (one
--   `token.denied` audit row; the code then never exchanges), or a release after a retryable
--   failure. A settle of a claim that another request took over changes nothing.
-- * An attested code stays attested, so a retry of the same exchange needs no second verification.
-- * App Attest keys are kept until 400 days after their last use; a code's attestation goes with
--   its code (`uts.maintain_oauth_rows()`).
-- * Every write is a SECURITY DEFINER function; the app login reads neither new table.

SET LOCAL ROLE uts_owner;

CREATE TYPE uts.attestation_type AS ENUM ('app_attest_key', 'app_attest_assertion', 'play_integrity');
CREATE TYPE uts.attestation_state AS ENUM ('verifying', 'attested', 'refused');

-- App Attest keys: the key id is the SHA-256 of the key's uncompressed P-256 point (Apple's key
-- identifier), and the counter is the last accepted assertion's.
CREATE TABLE uts.app_attest_keys (
  key_id uts.sha256 PRIMARY KEY,
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 65 AND get_byte(public_key, 0) = 4),
  sign_count bigint NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_attest_keys_key_id_of_point CHECK (key_id = sha256(public_key))
);
CREATE INDEX app_attest_keys_last_used_idx ON uts.app_attest_keys (last_used_at);

-- One attestation per authorization code.
CREATE TABLE uts.code_attestations (
  code_hash uts.sha256 PRIMARY KEY REFERENCES uts.authorization_codes (code_hash) ON DELETE CASCADE,
  attestation_type uts.attestation_type NOT NULL,
  key_id uts.sha256,
  state uts.attestation_state NOT NULL DEFAULT 'verifying',
  claim_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT code_attestations_key_shape CHECK ((attestation_type = 'play_integrity') = (key_id IS NULL)),
  CONSTRAINT code_attestations_settled_shape CHECK ((state = 'verifying') = (settled_at IS NULL))
);

-- Claims the attestation of a code for one verification. `p_type` NULL asks only whether the code
-- is attested already (a retry that carries no attestation).
-- Outcomes:
-- * `claimed`: verify now; for an assertion `public_key` and `sign_count` are the stored key's.
-- * `attested`: the code was attested before; exchange it without a verification.
-- * `proof_required`: no attestation was sent and the code has none.
-- * `unknown_key`: an assertion of a key this store does not hold; nothing was claimed.
-- * `busy`: another request verifies this code's attestation now.
-- * `refused`: the code's attestation was refused; the code never exchanges.
-- * `reused`: the code was exchanged and this request differs from that exchange; the exchange
--   statement decides (a second use of a code revokes its grant).
-- * `invalid_grant`: no such code, or it is expired or belongs to another request.
CREATE FUNCTION uts.claim_code_attestation(
  p_code_hash bytea,
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_dpop_jkt bytea,
  p_claim_id uuid,
  p_type uts.attestation_type,
  p_key_id bytea
) RETURNS TABLE (outcome text, public_key bytea, sign_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  code uts.authorization_codes%ROWTYPE;
  claim uts.code_attestations%ROWTYPE;
  stored uts.app_attest_keys%ROWTYPE;
BEGIN
  PERFORM uts.require_inputs('uts.claim_code_attestation',
    p_code_hash IS NOT NULL AND p_client_id IS NOT NULL AND p_redirect_uri IS NOT NULL
    AND p_code_challenge IS NOT NULL AND p_dpop_jkt IS NOT NULL AND p_claim_id IS NOT NULL
    AND (p_type IS NOT NULL OR p_key_id IS NULL)
    AND (p_type IS NULL OR (p_type = 'play_integrity') = (p_key_id IS NULL)));

  SELECT * INTO code FROM uts.authorization_codes AS existing WHERE existing.code_hash = p_code_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (code.expires_at > now()
    AND code.client_kind = 'first_party'
    AND code.client_id = p_client_id
    AND code.redirect_uri = p_redirect_uri
    AND code.code_challenge = p_code_challenge
    AND code.dpop_jkt = p_dpop_jkt) IS NOT TRUE
  THEN
    outcome := CASE WHEN code.status = 'consumed' THEN 'reused' ELSE 'invalid_grant' END;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO claim FROM uts.code_attestations AS existing WHERE existing.code_hash = p_code_hash
  FOR UPDATE;
  IF FOUND AND claim.state = 'attested' THEN
    outcome := 'attested';
    RETURN NEXT;
    RETURN;
  END IF;
  IF FOUND AND claim.state = 'refused' THEN
    outcome := 'refused';
    RETURN NEXT;
    RETURN;
  END IF;
  -- An attestation-required code is exchanged only once attested, so a consumed code without
  -- one was never this client's; nothing more is done with it.
  IF code.status = 'consumed' THEN
    outcome := 'invalid_grant';
    RETURN NEXT;
    RETURN;
  END IF;
  IF FOUND AND claim.claimed_at > now() - interval '15 seconds' THEN
    outcome := 'busy';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_type IS NULL THEN
    outcome := 'proof_required';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_type = 'app_attest_assertion' THEN
    SELECT * INTO stored FROM uts.app_attest_keys AS existing WHERE existing.key_id = p_key_id;
    IF NOT FOUND THEN
      outcome := 'unknown_key';
      RETURN NEXT;
      RETURN;
    END IF;
    public_key := stored.public_key;
    sign_count := stored.sign_count;
  END IF;

  INSERT INTO uts.code_attestations AS target (code_hash, attestation_type, key_id, claim_id)
  VALUES (p_code_hash, p_type, p_key_id, p_claim_id)
  ON CONFLICT ON CONSTRAINT code_attestations_pkey DO UPDATE
  SET attestation_type = excluded.attestation_type, key_id = excluded.key_id,
    claim_id = excluded.claim_id, claimed_at = now();
  outcome := 'claimed';
  RETURN NEXT;
END
$$;

-- Records the result of a claim. `p_result`: `attested` (with the key's point for a new App Attest
-- key, or the assertion's counter), `refused` (with a fixed reason) or `released` (a retryable
-- failure: the claim is dropped so a retry can verify again).
-- Outcomes: `attested`; `refused` (also an App Attest key that exists already, and an assertion
-- whose counter did not grow); `released`; `stale` (the claim is no longer current, nothing
-- changed).
CREATE FUNCTION uts.settle_code_attestation(
  p_environment text,
  p_code_hash bytea,
  p_claim_id uuid,
  p_result text,
  p_public_key bytea,
  p_sign_count bigint,
  p_reason text
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  claim uts.code_attestations%ROWTYPE;
  code uts.authorization_codes%ROWTYPE;
  refusal text := p_reason;
BEGIN
  PERFORM uts.require_inputs('uts.settle_code_attestation',
    p_environment IS NOT NULL AND p_code_hash IS NOT NULL AND p_claim_id IS NOT NULL
    AND p_result IN ('attested', 'refused', 'released')
    AND (p_result = 'refused') = (p_reason IS NOT NULL)
    AND (p_reason IS NULL OR p_reason ~ '^[a-z_]{1,48}$'));

  SELECT * INTO claim FROM uts.code_attestations AS existing WHERE existing.code_hash = p_code_hash
  FOR UPDATE;
  IF NOT FOUND OR claim.claim_id <> p_claim_id OR claim.state <> 'verifying' THEN
    outcome := 'stale';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_result = 'released' THEN
    DELETE FROM uts.code_attestations AS existing WHERE existing.code_hash = p_code_hash;
    outcome := 'released';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_result = 'attested' THEN
    PERFORM uts.require_inputs('uts.settle_code_attestation',
      CASE claim.attestation_type
        WHEN 'app_attest_key' THEN p_public_key IS NOT NULL AND p_sign_count IS NULL
        WHEN 'app_attest_assertion' THEN p_public_key IS NULL AND p_sign_count IS NOT NULL
        ELSE p_public_key IS NULL AND p_sign_count IS NULL
      END);
    IF claim.attestation_type = 'app_attest_key' THEN
      INSERT INTO uts.app_attest_keys (key_id, public_key, sign_count)
      VALUES (claim.key_id, p_public_key, 0)
      ON CONFLICT ON CONSTRAINT app_attest_keys_pkey DO NOTHING;
      IF NOT FOUND THEN
        refusal := 'key_attested_before';
      END IF;
    ELSIF claim.attestation_type = 'app_attest_assertion' THEN
      UPDATE uts.app_attest_keys AS existing
      SET sign_count = p_sign_count, last_used_at = now()
      WHERE existing.key_id = claim.key_id AND existing.sign_count < p_sign_count;
      IF NOT FOUND THEN
        refusal := 'counter_not_increased';
      END IF;
    END IF;
    IF refusal IS NULL THEN
      UPDATE uts.code_attestations AS existing SET state = 'attested', settled_at = now()
      WHERE existing.code_hash = p_code_hash;
      outcome := 'attested';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  UPDATE uts.code_attestations AS existing SET state = 'refused', settled_at = now()
  WHERE existing.code_hash = p_code_hash;
  SELECT * INTO code FROM uts.authorization_codes AS existing WHERE existing.code_hash = p_code_hash;
  PERFORM uts.write_audit_event(
    p_environment, 'ai.kilo.uts.token.denied', 6003, 1, 'denied', 'attestation refused',
    code.account_id,
    jsonb_build_object(
      'grantType', 'authorization_code',
      'clientId', uts.audit_client_id(code.client_id),
      'codeRef', uts.credential_reference(p_code_hash),
      'attestationType', claim.attestation_type,
      'reason', refusal
    )
  );
  outcome := 'refused';
  RETURN NEXT;
END
$$;

-- The minute cron: App Attest keys 400 days past their last use (a mobile grant lasts at most 365
-- days, so no live grant's device still needs its key's counter).
CREATE FUNCTION uts.maintain_attestation_rows()
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM uts.app_attest_keys AS stored
  WHERE stored.key_id IN (
    SELECT stale.key_id FROM uts.app_attest_keys AS stale
    WHERE stale.last_used_at < now() - interval '400 days'
    ORDER BY stale.last_used_at
    LIMIT 5000
  );
  kind := 'app_attest_keys';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.claim_code_attestation(bytea, text, text, text, bytea, uuid, uts.attestation_type, bytea),
  uts.settle_code_attestation(text, bytea, uuid, text, bytea, bigint, text),
  uts.maintain_attestation_rows()
TO uts_app;
