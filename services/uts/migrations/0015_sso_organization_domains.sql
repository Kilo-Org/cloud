-- The verified domains of an organization's SSO setup (design sections 5.2 and 5.8).
--
-- * `uts.sync_sso_organization` takes the organization's verified domains with its policy and
--   connections, so `POST /signin/sso/start` and the SSO callback find the organization of an
--   address. The sync replaces the organization's domain set, ordered by the organization's own
--   source version (`uts.org_sso_policies.event_version`), like its connections: a domain left out
--   is deleted, and a newer sync already applied makes an older one `already_applied`.
-- * One organization holds a verified domain (`sso_domains_verified_domain_key`, migration 0001).
--   A domain verified by another organization never moves: the sync answers `retry_later` with
--   `domain_conflict` and writes nothing, also when the other organization takes it during this
--   sync, and the outbox retries until that organization's sync releases it.
-- * The conflict checks run only for a sync that applies. A sync older than the applied version
--   changes nothing, so it answers `already_applied` even when a connection or a domain it names
--   is now held elsewhere; before, it answered `retry_later` for as long as that held.
-- * The app verified each domain through WorkOS, so UTS holds no DNS challenge for it:
--   `dns_challenge_hash` is required only while a domain is pending.
-- * The audit row counts the domains and names none of them.

SET LOCAL ROLE uts_owner;

ALTER TABLE uts.sso_domains
  ALTER COLUMN dns_challenge_hash DROP NOT NULL,
  ADD CONSTRAINT sso_domains_challenge_shape
    CHECK (status = 'verified' OR dns_challenge_hash IS NOT NULL);

DROP FUNCTION uts.sync_sso_organization(
  text, uuid, uuid, text, text[], uts.sso_enforcement, text, text, bigint
);

-- POST /internal/authority/sso-organization: an organization's SSO setup, ordered by the
-- organization's own source version: the policy, the WorkOS organization whose `externalId` is
-- this organization, its connections (one left out becomes inactive) and its verified domains (one
-- left out is deleted). A connection active in another organization, or a domain verified by
-- another organization, never moves: the sync answers `retry_later` with `connection_conflict` or
-- `domain_conflict` and writes nothing. Outcomes: `applied`, `already_applied`, `retry_later`.
CREATE FUNCTION uts.sync_sso_organization(
  p_environment text,
  p_operation_id uuid,
  p_org_id uuid,
  p_workos_organization_id text,
  p_workos_connection_ids text[],
  p_domains text[],
  p_enforcement uts.sso_enforcement,
  p_actor text,
  p_workload text,
  p_source_version bigint
) RETURNS TABLE (outcome text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  stored_version bigint;
  touched integer;
  held integer;
  changed integer := 0;
BEGIN
  PERFORM uts.require_inputs(
    'uts.sync_sso_organization',
    num_nulls(p_environment, p_operation_id, p_org_id, p_workos_organization_id,
      p_workos_connection_ids, p_domains, p_enforcement, p_actor, p_workload,
      p_source_version) = 0
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('uts.organization:' || p_org_id::text, 0));
  IF uts.repeated_operation(p_operation_id, 'sso_organization_sync', p_org_id::text) IS NOT NULL THEN
    outcome := 'already_applied';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT policy.event_version INTO stored_version
  FROM uts.org_sso_policies AS policy WHERE policy.org_id = p_org_id;
  IF stored_version IS NULL OR stored_version <= p_source_version THEN
    IF EXISTS (
      SELECT 1 FROM uts.sso_connections AS connection
      WHERE connection.workos_connection_id = ANY (p_workos_connection_ids)
        AND connection.org_id <> p_org_id AND connection.status = 'active'
    ) THEN
      outcome := 'retry_later';
      error := 'connection_conflict';
      RETURN NEXT;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM uts.sso_domains AS domain
      WHERE domain.domain = ANY (p_domains)
        AND domain.org_id <> p_org_id AND domain.status = 'verified'
    ) THEN
      outcome := 'retry_later';
      error := 'domain_conflict';
      RETURN NEXT;
      RETURN;
    END IF;
    -- The block is a savepoint: a connection or a domain another organization took meanwhile
    -- (its row is skipped by the guards below) undoes every write of this sync.
    BEGIN
      INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version)
      VALUES (p_org_id, p_enforcement, p_source_version)
      ON CONFLICT (org_id) DO UPDATE
      SET enforcement = EXCLUDED.enforcement, event_version = EXCLUDED.event_version, updated_at = now()
      WHERE uts.org_sso_policies.enforcement <> EXCLUDED.enforcement
        OR uts.org_sso_policies.event_version <> EXCLUDED.event_version;
      GET DIAGNOSTICS touched = ROW_COUNT;
      changed := changed + touched;
      INSERT INTO uts.sso_connections (org_id, workos_connection_id, workos_organization_id)
      SELECT p_org_id, connection_id, p_workos_organization_id
      FROM unnest(p_workos_connection_ids) AS connection_id
      ON CONFLICT (workos_connection_id) DO UPDATE
      SET org_id = EXCLUDED.org_id, workos_organization_id = EXCLUDED.workos_organization_id,
        status = 'active', updated_at = now()
      WHERE (uts.sso_connections.org_id = EXCLUDED.org_id OR uts.sso_connections.status <> 'active')
        AND (uts.sso_connections.org_id <> EXCLUDED.org_id
          OR uts.sso_connections.workos_organization_id IS DISTINCT FROM EXCLUDED.workos_organization_id
          OR uts.sso_connections.status <> 'active');
      GET DIAGNOSTICS touched = ROW_COUNT;
      changed := changed + touched;
      -- Every connection sent must now be an active connection of this organization; a row the
      -- guard skipped is not.
      SELECT count(*)::integer INTO held FROM uts.sso_connections AS connection
      WHERE connection.workos_connection_id = ANY (p_workos_connection_ids)
        AND connection.org_id = p_org_id AND connection.status = 'active';
      IF held <> (SELECT count(DISTINCT sent) FROM unnest(p_workos_connection_ids) AS sent) THEN
        RAISE EXCEPTION 'a connection is active in another organization' USING ERRCODE = 'U3171';
      END IF;
      UPDATE uts.sso_connections AS connection SET status = 'inactive', updated_at = now()
      WHERE connection.org_id = p_org_id AND connection.status = 'active'
        AND connection.workos_connection_id <> ALL (p_workos_connection_ids);
      GET DIAGNOSTICS touched = ROW_COUNT;
      changed := changed + touched;
      -- The domain set: a domain left out, and a pending row of a domain sent, go; each domain
      -- sent is then a verified row of this organization. A verified row of another organization
      -- makes the insert skip the domain, and the count below refuses the sync.
      DELETE FROM uts.sso_domains AS domain
      WHERE domain.org_id = p_org_id
        AND (domain.status <> 'verified' OR domain.domain <> ALL (p_domains));
      GET DIAGNOSTICS touched = ROW_COUNT;
      changed := changed + touched;
      INSERT INTO uts.sso_domains (org_id, domain, status, verified_at)
      SELECT p_org_id, sent, 'verified', now()
      FROM unnest(p_domains) AS sent
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS touched = ROW_COUNT;
      changed := changed + touched;
      SELECT count(*)::integer INTO held FROM uts.sso_domains AS domain
      WHERE domain.domain = ANY (p_domains)
        AND domain.org_id = p_org_id AND domain.status = 'verified';
      IF held <> (SELECT count(DISTINCT sent) FROM unnest(p_domains) AS sent) THEN
        RAISE EXCEPTION 'a domain is verified by another organization' USING ERRCODE = 'U3172';
      END IF;
    EXCEPTION
      WHEN SQLSTATE 'U3171' THEN
        outcome := 'retry_later';
        error := 'connection_conflict';
        RETURN NEXT;
        RETURN;
      WHEN SQLSTATE 'U3172' THEN
        outcome := 'retry_later';
        error := 'domain_conflict';
        RETURN NEXT;
        RETURN;
    END;
  END IF;
  IF changed > 0 THEN
    PERFORM uts.write_workload_audit_event(
      p_environment, 'ai.kilo.uts.sso_organization.synced', 3001, 99, NULL, p_workload,
      jsonb_build_object(
        'operationId', p_operation_id,
        'org', p_org_id,
        'enforcement', p_enforcement,
        'connections', cardinality(p_workos_connection_ids),
        'domains', cardinality(p_domains),
        'requestedBy', p_actor,
        'sourceVersion', p_source_version
      )
    );
  END IF;
  PERFORM uts.record_operation(
    p_operation_id, 'sso_organization_sync', p_org_id::text, p_source_version, '[]'
  );
  outcome := CASE WHEN changed > 0 THEN 'applied' ELSE 'already_applied' END;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION
  uts.sync_sso_organization(text, uuid, uuid, text, text[], text[], uts.sso_enforcement, text, text, bigint)
TO uts_app;
