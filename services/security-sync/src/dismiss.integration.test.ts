import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, type WorkerDb } from '@kilocode/db/client';
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
  security_audit_log,
  security_findings,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { processSecurityFindingDismissal } from './dismiss.js';
import type { SecurityDismissMessage } from './index.js';

let client: ReturnType<typeof createDrizzleClient>;

async function createFixture(db: WorkerDb, ownerType: 'org' | 'user') {
  const userId = `oauth/security-dismiss-${randomUUID()}`;
  const organizationId = randomUUID();
  await db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${randomUUID()}@example.com`,
    google_user_name: 'Dismissal Test',
    google_user_image_url: '',
    stripe_customer_id: `cus_${randomUUID()}`,
  });
  await db.insert(organizations).values({ id: organizationId, name: 'Dismissal Test' });
  const ownerValues = {
    owned_by_organization_id: ownerType === 'org' ? organizationId : null,
    owned_by_user_id: ownerType === 'user' ? userId : null,
  };
  const findingId = randomUUID();
  await db.insert(security_findings).values({
    id: findingId,
    ...ownerValues,
    repo_full_name: 'kilo/repo',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    title: 'Test finding',
  });

  const message: SecurityDismissMessage = {
    schemaVersion: 1,
    kind: 'dismiss',
    commandId: randomUUID(),
    runId: randomUUID(),
    messageId: randomUUID(),
    dispatchedAt: new Date().toISOString(),
    owner: ownerType === 'org' ? { organizationId } : { userId },
    actor: { id: userId },
    findingId,
    installationId: 'queued-before-reinstall',
    reason: 'not_used',
  };
  const getToken = vi.fn(async () => 'github-token');
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);

  async function insertIntegration(
    overrides: Partial<typeof platform_integrations.$inferInsert> = {},
    installationOverrides: Partial<typeof github_app_installations.$inferInsert> = {}
  ) {
    const installationId = randomInt(1, 2 ** 48 - 1).toString();
    const canonicalId = randomUUID();
    const repositories = [{ id: 1, name: 'repo', full_name: 'kilo/repo', private: true }];
    await db.insert(github_app_installations).values({
      id: canonicalId,
      installation_id: installationId,
      github_app_type: 'standard',
      account_login: 'kilo',
      repository_access: 'selected',
      repositories,
      permissions: { vulnerability_alerts: 'write' },
      lifecycle_state: 'active',
      ...installationOverrides,
    });
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        ...ownerValues,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        github_connection_role: 'workflow',
        platform_installation_id: installationId,
        github_installation_id: canonicalId,
        github_app_type: 'standard',
        platform_account_login: 'kilo',
        repository_access: 'selected',
        repositories,
        permissions: { vulnerability_alerts: 'write' },
        ...overrides,
      })
      .returning();
    return integration;
  }

  return {
    db,
    message,
    userId,
    organizationId,
    findingId,
    getToken,
    fetchSpy,
    insertIntegration,
    process: () =>
      processSecurityFindingDismissal({
        db,
        message,
        gitTokenService: { getToken } as unknown as GitTokenService,
      }),
    readFinding: async () => {
      const [finding] = await db
        .select()
        .from(security_findings)
        .where(eq(security_findings.id, findingId));
      return finding;
    },
    readAudit: () =>
      db.select().from(security_audit_log).where(eq(security_audit_log.finding_id, findingId)),
  };
}

async function withFixture(
  test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  ownerType: 'org' | 'user' = 'org'
) {
  const rollback = new Error('rollback test fixture');
  try {
    await client.db.transaction(async tx => {
      await test(await createFixture(tx as never, ownerType));
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('finding dismissal integration resolution in PostgreSQL', () => {
  beforeAll(() => {
    client = createDrizzleClient({
      connectionString:
        process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
      ssl: false,
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => client.pool.end());

  it.each(['org', 'user'] as const)(
    'dismisses an unlinked %s finding without a prior sync',
    ownerType =>
      withFixture(async fixture => {
        const integration = await fixture.insertIntegration();
        await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
        expect(fixture.getToken).toHaveBeenCalledWith(
          integration.platform_installation_id,
          'standard',
          integration.id
        );
        expect(await fixture.readFinding()).toMatchObject({
          status: 'ignored',
          platform_integration_id: integration.id,
        });
        expect(await fixture.readAudit()).toHaveLength(1);
      }, ownerType)
  );

  it('replaces a disconnected non-NULL link and ignores the old queued installation', () =>
    withFixture(async fixture => {
      const old = await fixture.insertIntegration({
        github_disconnected_at: new Date().toISOString(),
      });
      await fixture.db
        .update(security_findings)
        .set({ platform_integration_id: old.id })
        .where(eq(security_findings.id, fixture.findingId));
      const replacement = await fixture.insertIntegration();
      await fixture.process();
      expect(fixture.getToken).toHaveBeenCalledWith(
        replacement.platform_installation_id,
        'standard',
        replacement.id
      );
      expect(await fixture.readFinding()).toMatchObject({
        platform_integration_id: replacement.id,
      });
    }));

  it('uses repository access to choose between different current owner installations', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration(
        {},
        { repositories: [{ id: 2, name: 'other', full_name: 'other/repo', private: true }] }
      );
      const integration = await fixture.insertIntegration();
      await fixture.process();
      expect(fixture.getToken).toHaveBeenCalledWith(
        integration.platform_installation_id,
        'standard',
        integration.id
      );
    }));

  it('does not count an unlinked legacy association once its canonical installation exists', () =>
    withFixture(async fixture => {
      const legacy = await fixture.insertIntegration();
      await fixture.db
        .update(platform_integrations)
        .set({ github_installation_id: null })
        .where(eq(platform_integrations.id, legacy.id));
      const replacement = await fixture.insertIntegration();

      await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
      expect(fixture.getToken).toHaveBeenCalledWith(
        replacement.platform_installation_id,
        'standard',
        replacement.id
      );
    }));

  it('supports a legacy association when no canonical installation has been observed', () =>
    withFixture(async fixture => {
      const legacy = await fixture.insertIntegration({ github_app_type: null });
      if (!legacy.github_installation_id) throw new Error('Fixture canonical installation missing');
      await fixture.db
        .update(platform_integrations)
        .set({ github_installation_id: null })
        .where(eq(platform_integrations.id, legacy.id));
      await fixture.db
        .delete(github_app_installations)
        .where(eq(github_app_installations.id, legacy.github_installation_id));

      await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
      expect(fixture.getToken).toHaveBeenCalledWith(
        legacy.platform_installation_id,
        'standard',
        legacy.id
      );
    }));

  it('rejects a mismatched canonical installation tuple before requesting a token', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration({ github_app_type: 'lite' });
      await expect(fixture.process()).resolves.toMatchObject({
        resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
      });
      expect(fixture.getToken).not.toHaveBeenCalled();
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
    }));

  it('fails closed for multiple writable integrations for the same repository', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration();
      await fixture.insertIntegration();
      await expect(fixture.process()).resolves.toMatchObject({
        commandStatus: 'failed',
        resultCode: 'GITHUB_INTEGRATION_AMBIGUOUS',
      });
      expect(fixture.getToken).not.toHaveBeenCalled();
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
      expect(await fixture.readFinding()).toMatchObject({
        status: 'open',
        platform_integration_id: null,
      });
      expect(await fixture.readAudit()).toHaveLength(0);
    }));

  it.each([
    ['another owner', { owned_by_organization_id: null, owned_by_user_id: 'fixture-user' }],
    ['agent-only', { github_connection_role: 'agent_only' }],
    ['non-app', { integration_type: 'oauth', github_connection_role: null }],
    ['inactive', { integration_status: 'suspended' }],
    ['suspended', { suspended_at: '2026-01-01T00:00:00Z' }],
    ['auth-invalid', { auth_invalid_at: '2026-01-01T00:00:00Z' }],
    ['disconnected', { github_disconnected_at: '2026-01-01T00:00:00Z' }],
  ] satisfies [string, Partial<typeof platform_integrations.$inferInsert>][])(
    'rejects integration: %s',
    (_name, overrides) =>
      withFixture(async fixture => {
        await fixture.insertIntegration({
          ...overrides,
          ...('owned_by_user_id' in overrides ? { owned_by_user_id: fixture.userId } : {}),
        });
        await expect(fixture.process()).resolves.toMatchObject({
          commandStatus: 'failed',
          resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
        });
        expect(fixture.getToken).not.toHaveBeenCalled();
        expect(fixture.fetchSpy).not.toHaveBeenCalled();
        expect(await fixture.readFinding()).toMatchObject({
          status: 'open',
          platform_integration_id: null,
        });
        expect(await fixture.readAudit()).toHaveLength(0);
      })
  );

  it('rejects repository access revoked in canonical metadata despite the cached association', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration({}, { repositories: [] });
      await expect(fixture.process()).resolves.toMatchObject({
        resultCode: 'REPOSITORY_UNAVAILABLE',
      });
      expect(fixture.getToken).not.toHaveBeenCalled();
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
    }));

  it('rejects read-only canonical permissions despite cached write permissions', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration({}, { permissions: { vulnerability_alerts: 'read' } });
      await expect(fixture.process()).resolves.toMatchObject({
        resultCode: 'GITHUB_DISMISSAL_PERMISSION_REQUIRED',
      });
      expect(fixture.getToken).not.toHaveBeenCalled();
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
    }));

  it('selects the only writable integration when another is read-only', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration({}, { permissions: { vulnerability_alerts: 'read' } });
      const integration = await fixture.insertIntegration({ github_app_type: null });
      await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
      expect(fixture.getToken).toHaveBeenCalledWith(
        integration.platform_installation_id,
        'standard',
        integration.id
      );
    }));

  it('does not infer access from a repository list when the access mode is unknown', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration({ repository_access: null }, { repository_access: null });
      await expect(fixture.process()).resolves.toMatchObject({
        resultCode: 'REPOSITORY_UNAVAILABLE',
      });
      expect(fixture.getToken).not.toHaveBeenCalled();
    }));

  it.each(['suspended', 'deleted', 'unknown'] as const)(
    'rejects canonical installation lifecycle %s',
    lifecycle_state =>
      withFixture(async fixture => {
        await fixture.insertIntegration({}, { lifecycle_state });
        await expect(fixture.process()).resolves.toMatchObject({
          resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
        });
        expect(fixture.getToken).not.toHaveBeenCalled();
      })
  );

  it('supports all-repository installations only for their account owner', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration(
        {},
        { repository_access: 'all', repositories: [], account_login: 'other' }
      );
      await expect(fixture.process()).resolves.toMatchObject({
        resultCode: 'REPOSITORY_UNAVAILABLE',
      });
      const integration = await fixture.insertIntegration(
        {},
        { repository_access: 'all', repositories: [], account_login: 'KILO' }
      );
      await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
      expect(fixture.getToken).toHaveBeenCalledWith(
        integration.platform_installation_id,
        'standard',
        integration.id
      );
    }));

  it('matches selected repository names case-insensitively', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration(
        {},
        { repositories: [{ id: 1, name: 'Repo', full_name: 'Kilo/Repo', private: true }] }
      );
      await expect(fixture.process()).resolves.toMatchObject({ commandStatus: 'succeeded' });
    }));

  it('does not relink or dismiss locally when upstream writeback fails', () =>
    withFixture(async fixture => {
      await fixture.insertIntegration();
      fixture.fetchSpy.mockImplementation(async () => new Response('{}', { status: 503 }));
      await expect(fixture.process()).rejects.toThrow(
        'GitHub Dependabot dismissal failed with 503'
      );
      expect(await fixture.readFinding()).toMatchObject({
        status: 'open',
        platform_integration_id: null,
      });
      expect(await fixture.readAudit()).toHaveLength(0);
    }));
});
