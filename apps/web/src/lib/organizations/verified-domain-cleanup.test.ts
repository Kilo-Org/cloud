import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  organization_audit_logs,
  organization_domain_claims,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  planWorkOsAction,
  runVerifiedDomainClaimCleanup,
  type CleanupProvider,
  type WorkOsSnapshot,
} from './verified-domain-cleanup';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

type FakeWorkOsOrganization = {
  id: string;
  metadata?: Record<string, string>;
  connections?: number;
};

function providerError(status: number) {
  return Object.assign(new Error(`status ${status}`), { status });
}

function createFakeProvider(
  workosByExternalId: Map<string, FakeWorkOsOrganization>,
  hooks: { onLookup?: (externalId: string) => Promise<void>; deleteError?: Error } = {}
) {
  const deleted: string[] = [];
  const provider = {
    organizations: {
      getOrganizationByExternalId: jest.fn(async (externalId: string) => {
        await hooks.onLookup?.(externalId);
        const found = workosByExternalId.get(externalId);
        if (!found) throw providerError(404);
        return {
          object: 'organization',
          id: found.id,
          name: 'WorkOS Org',
          externalId,
          metadata: found.metadata ?? {},
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
          domains: [{ id: `${found.id}-domain`, domain: 'example.com', state: 'verified' }],
        };
      }),
      deleteOrganization: jest.fn(async (id: string) => {
        if (hooks.deleteError) throw hooks.deleteError;
        deleted.push(id);
      }),
    },
    sso: {
      listConnections: jest.fn(async ({ organizationId }: { organizationId?: string }) => {
        const found = [...workosByExternalId.values()].find(o => o.id === organizationId);
        return {
          data: Array.from({ length: found?.connections ?? 0 }, (_, i) => ({ id: `c${i}` })),
        };
      }),
    },
  };
  return { provider: provider as unknown as CleanupProvider, deleted, mocks: provider };
}

describe('verified domain claim cleanup', () => {
  let owner: User;
  const createdOrganizationIds: string[] = [];

  async function createOrganizationWithClaims(
    name: string,
    claims: { domain: string; status?: 'pending' | 'verified'; workosOrganizationId?: string }[],
    overrides: Partial<typeof organizations.$inferInsert> = {}
  ): Promise<Organization> {
    const organization = await createTestOrganization(name, owner.id, 0);
    createdOrganizationIds.push(organization.id);
    if (Object.keys(overrides).length > 0) {
      await db.update(organizations).set(overrides).where(eq(organizations.id, organization.id));
    }
    for (const claim of claims) {
      const verified = claim.status === 'verified';
      await db.insert(organization_domain_claims).values({
        organization_id: organization.id,
        domain: claim.domain,
        status: claim.status ?? 'pending',
        verified_at: verified ? new Date().toISOString() : null,
        workos_organization_id: claim.workosOrganizationId ?? null,
        workos_domain_id: verified ? `wd-${claim.domain}` : null,
      });
    }
    return organization;
  }

  async function claimDomains(organizationId: string) {
    const rows = await db
      .select({ domain: organization_domain_claims.domain })
      .from(organization_domain_claims)
      .where(eq(organization_domain_claims.organization_id, organizationId));
    return rows.map(row => row.domain).sort();
  }

  async function auditActions(organizationId: string) {
    const rows = await db
      .select({ action: organization_audit_logs.action, message: organization_audit_logs.message })
      .from(organization_audit_logs)
      .where(
        and(
          eq(organization_audit_logs.organization_id, organizationId),
          inArray(organization_audit_logs.action, [
            'organization.domain_claim.cleanup_started',
            'organization.domain_claim.cleanup_completed',
            'organization.domain_claim.cleanup_failed',
          ])
        )
      );
    return rows;
  }

  beforeAll(async () => {
    owner = await insertTestUser({ google_user_email: 'cleanup-owner@example.com' });
  });

  afterEach(async () => {
    if (createdOrganizationIds.length === 0) return;
    await db
      .delete(organization_domain_claims)
      .where(inArray(organization_domain_claims.organization_id, createdOrganizationIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, createdOrganizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    createdOrganizationIds.length = 0;
  });

  it('dry run reports the plan and changes nothing', async () => {
    const org = await createOrganizationWithClaims('dry-run', [
      { domain: 'dry.example.com', status: 'verified', workosOrganizationId: 'org_dry' },
    ]);
    const { provider, mocks } = createFakeProvider(new Map([[org.id, { id: 'org_dry' }]]));

    const report = await runVerifiedDomainClaimCleanup({
      execute: false,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.mode).toBe('dry_run');
    expect(report.summary).toEqual({ planned: 1, completed: 0, failed: 0, aborted: 0 });
    expect(report.results[0]).toMatchObject({
      organizationId: org.id,
      status: 'planned',
      workosAction: 'delete_workos_organization',
    });
    expect(mocks.organizations.deleteOrganization).not.toHaveBeenCalled();
    expect(await claimDomains(org.id)).toEqual(['dry.example.com']);
    expect(await auditActions(org.id)).toEqual([]);
  });

  it('deletes the claim-created WorkOS organization and claims while keeping members', async () => {
    const org = await createOrganizationWithClaims('execute', [
      { domain: 'a.example.com', status: 'verified', workosOrganizationId: 'org_exec' },
      { domain: 'b.example.com' },
    ]);
    const { provider, deleted } = createFakeProvider(new Map([[org.id, { id: 'org_exec' }]]));

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.summary.completed).toBe(1);
    expect(report.results[0]).toMatchObject({
      status: 'completed',
      claimsDeleted: 2,
      workosOrganizationDeleted: true,
    });
    expect(deleted).toEqual(['org_exec']);
    expect(await claimDomains(org.id)).toEqual([]);

    const members = await db
      .select({ id: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.organization_id, org.id));
    expect(members.map(m => m.id)).toEqual([owner.id]);

    const audit = await auditActions(org.id);
    expect(audit.map(row => row.action).sort()).toEqual([
      'organization.domain_claim.cleanup_completed',
      'organization.domain_claim.cleanup_started',
    ]);
    const started = audit.find(row => row.action.endsWith('cleanup_started'));
    expect(started?.message).toContain('a.example.com');
    expect(started?.message).toContain('org_exec');
    expect(started?.message).toContain(report.runId);
  });

  it('leaves admin-enrolled WorkOS organizations alone but removes the claims', async () => {
    const org = await createOrganizationWithClaims('admin-enrolled', [
      { domain: 'enrolled.example.com' },
    ]);
    const { provider, deleted } = createFakeProvider(
      new Map([[org.id, { id: 'org_enrolled', metadata: { createdById: 'admin-1' } }]])
    );

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.results[0]).toMatchObject({
      status: 'completed',
      workosAction: 'retain_workos_has_metadata',
      workosOrganizationDeleted: false,
      claimsDeleted: 1,
    });
    expect(deleted).toEqual([]);
    expect(await claimDomains(org.id)).toEqual([]);
  });

  it('leaves WorkOS organizations with SSO connections alone', async () => {
    const org = await createOrganizationWithClaims('with-connection', [
      { domain: 'conn.example.com' },
    ]);
    const { provider, deleted } = createFakeProvider(
      new Map([[org.id, { id: 'org_conn', connections: 1 }]])
    );

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.results[0]).toMatchObject({
      status: 'completed',
      workosAction: 'retain_workos_has_connections',
    });
    expect(deleted).toEqual([]);
  });

  it('removes only the claims when the WorkOS organization no longer exists', async () => {
    const org = await createOrganizationWithClaims('not-found', [{ domain: 'gone.example.com' }]);
    const { provider, deleted } = createFakeProvider(new Map());

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.results[0]).toMatchObject({
      status: 'completed',
      workosAction: 'skip_workos_not_found',
    });
    expect(deleted).toEqual([]);
    expect(await claimDomains(org.id)).toEqual([]);
  });

  it('excludes SSO organizations and their children, and reports SSO organizations with claims', async () => {
    const sso = await createOrganizationWithClaims('sso', [{ domain: 'sso.example.com' }], {
      sso_domain: 'sso.example.com',
    });
    const child = await createOrganizationWithClaims(
      'sso-child',
      [{ domain: 'child.example.com' }],
      {
        parent_organization_id: sso.id,
      }
    );
    const plain = await createOrganizationWithClaims('plain', [{ domain: 'plain.example.com' }]);
    const { provider } = createFakeProvider(new Map());

    const report = await runVerifiedDomainClaimCleanup({
      execute: false,
      limit: 50,
      organizationIds: [sso.id, child.id, plain.id],
      provider,
    });

    expect(report.results.map(result => result.organizationId)).toEqual([plain.id]);
    const reported = report.ssoOrganizationsWithClaims.map(row => row.id);
    expect(reported).toEqual(expect.arrayContaining([sso.id, child.id]));
    expect(await claimDomains(sso.id)).toEqual(['sso.example.com']);
  });

  it('respects the limit and reports the total candidate count', async () => {
    const first = await createOrganizationWithClaims('limit-1', [{ domain: 'l1.example.com' }]);
    const second = await createOrganizationWithClaims('limit-2', [{ domain: 'l2.example.com' }]);
    const { provider } = createFakeProvider(new Map());

    const report = await runVerifiedDomainClaimCleanup({
      execute: false,
      limit: 1,
      organizationIds: [first.id, second.id],
      provider,
    });

    expect(report.totalCandidates).toBe(2);
    expect(report.results).toHaveLength(1);
  });

  it('aborts without touching WorkOS when SSO is configured after inspection', async () => {
    const org = await createOrganizationWithClaims('raced-sso', [{ domain: 'race.example.com' }]);
    let lookups = 0;
    const { provider, deleted } = createFakeProvider(new Map([[org.id, { id: 'org_race' }]]), {
      onLookup: async () => {
        lookups += 1;
        if (lookups === 1) {
          await db
            .update(organizations)
            .set({ sso_domain: 'race.example.com' })
            .where(eq(organizations.id, org.id));
        }
      },
    });

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.results[0]).toMatchObject({
      status: 'aborted',
      reason: 'organization_has_sso_domain',
    });
    expect(deleted).toEqual([]);
    expect(await claimDomains(org.id)).toEqual(['race.example.com']);
    const actions = (await auditActions(org.id)).map(row => row.action).sort();
    expect(actions).toEqual([
      'organization.domain_claim.cleanup_failed',
      'organization.domain_claim.cleanup_started',
    ]);
  });

  it('keeps the claims and records a failure when the WorkOS deletion fails', async () => {
    const org = await createOrganizationWithClaims('delete-fails', [
      { domain: 'fail.example.com' },
    ]);
    const { provider } = createFakeProvider(new Map([[org.id, { id: 'org_fail' }]]), {
      deleteError: providerError(500),
    });

    const report = await runVerifiedDomainClaimCleanup({
      execute: true,
      limit: 10,
      organizationIds: [org.id],
      provider,
    });

    expect(report.summary.failed).toBe(1);
    expect(report.results[0]).toMatchObject({ status: 'failed', workosOrganizationDeleted: false });
    expect(await claimDomains(org.id)).toEqual(['fail.example.com']);
    const failure = (await auditActions(org.id)).find(row => row.action.endsWith('cleanup_failed'));
    expect(failure?.message).toContain('status 500');
  });

  it('is idempotent across reruns', async () => {
    const org = await createOrganizationWithClaims('rerun', [{ domain: 'rerun.example.com' }]);
    const { provider } = createFakeProvider(new Map([[org.id, { id: 'org_rerun' }]]));
    const options = { execute: true, limit: 10, organizationIds: [org.id], provider };

    await runVerifiedDomainClaimCleanup(options);
    const second = await runVerifiedDomainClaimCleanup(options);

    expect(second.totalCandidates).toBe(0);
    expect(second.results).toEqual([]);
  });
});

describe('planWorkOsAction', () => {
  const workos = (overrides: Partial<WorkOsSnapshot> = {}): WorkOsSnapshot => ({
    id: 'org_1',
    name: 'Org',
    externalId: 'kilo-org',
    metadata: {},
    createdAt: '2026-08-27T00:00:00.000Z',
    domains: [],
    connectionCount: 0,
    ...overrides,
  });

  it('plans deletion only for an unconfigured claim-created organization', () => {
    expect(planWorkOsAction([{ workos_organization_id: 'org_1' }], workos())).toBe(
      'delete_workos_organization'
    );
    expect(planWorkOsAction([{ workos_organization_id: null }], workos())).toBe(
      'delete_workos_organization'
    );
  });

  it('retains organizations that may belong to an SSO setup', () => {
    expect(planWorkOsAction([], workos({ connectionCount: 2 }))).toBe(
      'retain_workos_has_connections'
    );
    expect(planWorkOsAction([], workos({ metadata: { createdById: 'u' } }))).toBe(
      'retain_workos_has_metadata'
    );
    expect(planWorkOsAction([{ workos_organization_id: 'org_other' }], workos())).toBe(
      'retain_workos_id_mismatch'
    );
    expect(planWorkOsAction([], null)).toBe('skip_workos_not_found');
  });
});
