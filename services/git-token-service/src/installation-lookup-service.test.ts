import { describe, expect, it } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import {
  buildInstallationLookupQuery,
  buildInstallationRefreshCandidatesQuery,
} from './installation-lookup-service.js';

const params = {
  githubRepo: 'renamed-owner/repository',
  userId: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000001',
};

function buildQuery() {
  const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');
  return buildInstallationLookupQuery(db, params).toSQL();
}

describe('buildInstallationLookupQuery', () => {
  it('requires the current repository owner to match installation account metadata', () => {
    const query = buildQuery();

    expect(query.sql).toContain('lower("platform_integrations"."platform_account_login") =');
    expect(query.params).toContain('renamed-owner');
  });

  it('retains tenant authorization and fail-closed query guards', () => {
    const query = buildQuery();

    expect(query.sql).toContain('"platform_integrations"."platform_installation_id" is not null');
    expect(query.sql).toContain('"kilocode_users"."blocked_reason" is null');
    expect(query.sql).toContain('"organization_memberships"."kilo_user_id" =');
    expect(query.sql).toContain('"organization_memberships"."id" is not null');
    expect(query.sql).toContain('"platform_integrations"."owned_by_organization_id" =');
    expect(query.sql).toContain('"platform_integrations"."owned_by_user_id" =');
    expect(query.params.filter(param => param === 'user-1')).toHaveLength(3);
    expect(query.params).toContain('00000000-0000-4000-8000-000000000001');
    expect(query.params).toContain(2);
  });

  it('loads up to ten authorized repair candidates without relying on stale account login metadata', () => {
    const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');
    const query = buildInstallationRefreshCandidatesQuery(db, params).toSQL();

    expect(query.params).not.toContain('renamed-owner');
    expect(query.sql).toContain('"kilocode_users"."blocked_reason" is null');
    expect(query.sql).toContain('"organization_memberships"."id" is not null');
    expect(query.params).toContain(10);
  });
});
