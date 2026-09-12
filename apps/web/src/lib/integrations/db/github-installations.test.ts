import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  github_app_installations,
  github_connection_attempts,
  github_installation_webhook_receipts,
  kilocode_users,
  operation_ledgers,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { assertGitHubAutomationCanBeEnabled } from '../github/sharing-compatibility';
import {
  createCodeReview,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
} from '@/lib/code-reviews/db/code-reviews';
import {
  connectVerifiedGitHubInstallation,
  getGitHubInstallationDeliveryStatus,
  materializeGitHubInstallationIdentity,
  disconnectGitHubInstallation,
  observeGitHubInstallationLifecycle,
  recordCompletedGitHubInstallationDelivery,
  uninstallExclusiveGitHubInstallation,
  updateGitHubInstallationRepositories,
  updateGitHubInstallationAccountIdentity,
} from './github-installations';
import { backfillGitHubInstallations } from './github-installations-backfill';
import { assertGitHubInstallationRuntimeAuthorized } from '../github/runtime-authorization';
import { upsertAgentConfig } from '@/lib/agent-config/db/agent-configs';
import { getPlatformIntegration } from '../../bot/platform-helpers';
import {
  findIntegrationByInstallationId,
  upsertPlatformIntegrationForOwner,
  updateRepositoriesForIntegration,
} from './platform-integrations';

const ownerId = 'oauth/github-installation-owner';
const otherOwnerId = 'oauth/github-installation-other-owner';

const data = (installationId = '123456') => ({
  platformInstallationId: installationId,
  platformAccountId: '98765',
  platformAccountLogin: 'acme',
  permissions: { contents: 'read' },
  scopes: ['push'],
  repositoryAccess: 'all',
  repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
  installedAt: '2026-09-04T00:00:00.000Z',
  githubAppType: 'standard' as const,
  kiloUserId: ownerId,
  githubUserId: '1234',
  accountType: 'Organization' as const,
});

describe('GitHub installation persistence', () => {
  beforeEach(async () => {
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    await cleanupDbForTest();
    await db.insert(kilocode_users).values([
      {
        id: ownerId,
        google_user_email: 'owner@example.com',
        google_user_name: 'Owner',
        google_user_image_url: '',
        stripe_customer_id: 'cus_owner',
      },
      {
        id: otherOwnerId,
        google_user_email: 'other@example.com',
        google_user_name: 'Other',
        google_user_image_url: '',
        stripe_customer_id: 'cus_other',
      },
    ]);
  });

  afterEach(cleanupDbForTest);

  test('connects two approved organizations to one canonical installation', async () => {
    const organizationA = await createTestOrganization('Shared GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Shared GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;

    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected first shared association');
    const refreshedRepositories = [
      { id: 2, name: 'shared', full_name: 'acme/shared', private: true },
    ];
    await updateRepositoriesForIntegration(first.integrationId, refreshedRepositories);
    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, '123456'));
    expect(associations).toHaveLength(2);
    expect(associations.every(association => association.repositories?.length === 1)).toBe(true);
    expect(associations.map(association => association.repositories)).toEqual([
      refreshedRepositories,
      refreshedRepositories,
    ]);
    expect(new Set(associations.map(association => association.github_installation_id)).size).toBe(
      1
    );
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, associations[0]?.github_installation_id ?? ''));
    expect(canonical).toMatchObject({
      sharing_mode: 'web_cloud_agent',
      sharing_admission_checked_at: expect.any(String),
    });
    await expect(
      assertGitHubAutomationCanBeEnabled({ type: 'org', id: organizationB.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '123456',
        appType: 'standard',
        deliveryId: 'delivery-1',
      })
    ).resolves.toBe('not_completed');
    await recordCompletedGitHubInstallationDelivery({
      installationId: '123456',
      appType: 'standard',
      deliveryId: 'delivery-1',
      eventType: 'installation.deleted',
    });
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '123456',
        appType: 'standard',
        deliveryId: 'delivery-1',
      })
    ).resolves.toBe('completed');
    await expect(db.select().from(github_installation_webhook_receipts)).resolves.toHaveLength(1);
  });

  test('serializes shared attach commit before a concurrent agent enable recheck', async () => {
    const organizationA = await createTestOrganization('Attach race GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Attach race GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    if (!first.ok) throw new Error('Expected incumbent connection');
    let releaseAttach: (() => void) | undefined;
    const attachBarrier = new Promise<void>(resolve => {
      releaseAttach = resolve;
    });
    let markAttached: (() => void) | undefined;
    const attachedBeforeCommit = new Promise<void>(resolve => {
      markAttached = resolve;
    });
    const attach = db.transaction(async tx => {
      const result = await connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data(), kiloUserId: otherOwnerId },
        tx
      );
      markAttached?.();
      await attachBarrier;
      return result;
    });
    await attachedBeforeCommit;
    let enableSettled = false;
    const enable = upsertAgentConfig({
      organizationId: organizationB.id,
      agentType: 'code_review',
      platform: 'github',
      config: {},
      isEnabled: true,
      createdBy: otherOwnerId,
    }).finally(() => {
      enableSettled = true;
    });
    await Promise.resolve();
    expect(enableSettled).toBe(false);
    releaseAttach?.();

    await expect(attach).resolves.toMatchObject({ ok: true });
    await expect(enable).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  test('rechecks compatibility after a concurrent agent enable commits before attach', async () => {
    const organizationA = await createTestOrganization('Enable race GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Enable race GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    if (!first.ok) throw new Error('Expected incumbent connection');
    let releaseEnable: (() => void) | undefined;
    const enableBarrier = new Promise<void>(resolve => {
      releaseEnable = resolve;
    });
    let markEnabled: (() => void) | undefined;
    const enabledBeforeCommit = new Promise<void>(resolve => {
      markEnabled = resolve;
    });
    const enable = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`org:${organizationA.id}`}))`);
      await tx.insert(agent_configs).values({
        owned_by_organization_id: organizationA.id,
        agent_type: 'code_review',
        platform: 'github',
        config: {},
        is_enabled: true,
        created_by: ownerId,
      });
      markEnabled?.();
      await enableBarrier;
    });
    await enabledBeforeCommit;
    const attach = connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );
    releaseEnable?.();

    await expect(enable).resolves.toBeUndefined();
    await expect(attach).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
  });

  test('orders participant owner locks across inverse concurrent shared attaches', async () => {
    const organizationA = await createTestOrganization('Inverse attach GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Inverse attach GitHub B', otherOwnerId, 0);
    const allowlist = [organizationA.id, organizationB.id].join(',');
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = allowlist;
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = allowlist;
    const firstA = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('123456')
    );
    const firstB = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('654321'), kiloUserId: otherOwnerId }
    );
    if (!firstA.ok || !firstB.ok) throw new Error('Expected incumbent connections');

    const [attachBToA, attachAToB] = await Promise.all([
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data('123456'), kiloUserId: otherOwnerId }
      ),
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationA.id },
        { ...data('654321'), kiloUserId: ownerId }
      ),
    ]);

    expect(attachBToA).toMatchObject({ ok: true });
    expect(attachAToB).toMatchObject({ ok: true });
  });

  test('keeps admission off for an unapproved destination without changing the incumbent', async () => {
    const organizationA = await createTestOrganization('Unshared GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Unshared GitHub B', otherOwnerId, 0);
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    expect(first).toMatchObject({ ok: true });

    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'shared_installation_disabled' });
    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, '123456'));
    expect(associations).toHaveLength(1);
    expect(associations[0]?.id).toBe(first.ok ? first.integrationId : undefined);
  });

  test('refuses sharing without changing an incumbent automation workflow', async () => {
    const organizationA = await createTestOrganization('Automated GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Automated GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    if (!first.ok) throw new Error('Expected incumbent connection');
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationA.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {},
      is_enabled: true,
      created_by: ownerId,
    });

    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
    const [incumbentConfig] = await db
      .select()
      .from(agent_configs)
      .where(eq(agent_configs.owned_by_organization_id, organizationA.id));
    expect(incumbentConfig?.is_enabled).toBe(true);
  });

  test('keeps local disconnect separate from shared upstream suspension recovery', async () => {
    const organizationA = await createTestOrganization('Lifecycle GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Lifecycle GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );
    if (!first.ok || !second.ok) throw new Error('Expected shared connections');
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );

    await disconnectGitHubInstallation({ type: 'org', id: organizationA.id }, first.integrationId);
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'suspended',
    });
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'active',
    });

    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, '123456'));
    expect(associations.find(association => association.id === first.integrationId)).toMatchObject({
      integration_status: 'suspended',
      suspended_by: 'local_disconnect',
      github_disconnected_at: expect.any(String),
    });
    expect(associations.find(association => association.id === second.integrationId)).toMatchObject(
      {
        integration_status: 'active',
        suspended_by: null,
        github_disconnected_at: null,
      }
    );
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, associations[0]?.github_installation_id ?? ''));
    expect(canonical).toMatchObject({
      sharing_mode: 'exclusive',
      sharing_admission_checked_at: null,
    });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('123456', 'standard')
    ).resolves.toBeUndefined();
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '123456',
        appType: 'standard',
        deliveryId: 'delivery-after-demotion',
      })
    ).resolves.toBe('not_completed');
    await recordCompletedGitHubInstallationDelivery({
      installationId: '123456',
      appType: 'standard',
      deliveryId: 'delivery-after-demotion',
      eventType: 'installation.deleted',
    });
    await expect(
      assertGitHubAutomationCanBeEnabled({ type: 'org', id: organizationB.id })
    ).resolves.toBeUndefined();
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationB.id,
      agent_type: 'code_review',
      platform: 'github',
      config: {},
      is_enabled: true,
      created_by: otherOwnerId,
    });
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = [
      organizationA.id,
      organizationB.id,
    ].join(',');
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationA.id },
        { ...data(), kiloUserId: ownerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
  });

  test('serializes distinct installations for a non-allowlisted organization', async () => {
    const organization = await createTestOrganization('Cardinality lock org', ownerId, 0);
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    let ready: ((pid: number) => void) | undefined;
    const holderReady = new Promise<number>(resolve => {
      ready = resolve;
    });
    const first = db.transaction(async tx => {
      const result = await connectVerifiedGitHubInstallation(
        { type: 'org', id: organization.id },
        data('771001'),
        tx
      );
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      ready?.(backend.rows[0]!.pid);
      await barrier;
      return result;
    });
    let second: ReturnType<typeof connectVerifiedGitHubInstallation> | undefined;
    let observationError: unknown;
    try {
      const holderPid = await githubTestTimeout(holderReady, 'owner-cardinality holder');
      second = connectVerifiedGitHubInstallation(
        { type: 'org', id: organization.id },
        data('771002')
      );
      await githubTestTimeout(
        waitForBlockedGitHubOwnerLock(holderPid, `org:${organization.id}`),
        'owner-cardinality contender'
      );
    } catch (error) {
      observationError = error;
    } finally {
      release?.();
    }
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second ?? Promise.reject(new Error('Second callback did not start')),
    ]);
    if (observationError) throw observationError;
    expect(firstResult).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(secondResult).toEqual({
      status: 'fulfilled',
      value: { ok: false, reason: 'multiple_installations_disabled' },
    });
    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    expect(associations).toHaveLength(1);
  });

  test('allows distinct installations for an allowlisted organization', async () => {
    const organization = await createTestOrganization('Multi-install org', ownerId, 0);
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = organization.id;
    const results = await Promise.all([
      connectVerifiedGitHubInstallation({ type: 'org', id: organization.id }, data('772001')),
      connectVerifiedGitHubInstallation({ type: 'org', id: organization.id }, data('772002')),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    expect(associations).toHaveLength(2);
  });

  test('serializes upstream uninstall against a concurrent shared attach', async () => {
    const organizationA = await createTestOrganization('Uninstall race GitHub A', ownerId, 0);
    const organizationB = await createTestOrganization('Uninstall race GitHub B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    if (!first.ok) throw new Error('Expected incumbent connection');
    let releaseDelete: (() => void) | undefined;
    const deleteBarrier = new Promise<void>(resolve => {
      releaseDelete = resolve;
    });
    let markDeleteStarted: (() => void) | undefined;
    const upstreamDeleteStarted = new Promise<void>(resolve => {
      markDeleteStarted = resolve;
    });
    const uninstall = uninstallExclusiveGitHubInstallation({
      owner: { type: 'org', id: organizationA.id },
      integrationId: first.integrationId,
      deleteUpstream: async () => {
        markDeleteStarted?.();
        await deleteBarrier;
      },
    });
    await upstreamDeleteStarted;
    const attach = connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );
    releaseDelete?.();

    await expect(uninstall).resolves.toBeUndefined();
    await expect(attach).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
  });

  test('serializes repository refresh behind terminal lifecycle without reviving projection', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('773001')
    );
    if (!connected.ok) throw new Error('Expected canonical connection');
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    let deleted: ((pid: number) => void) | undefined;
    const deletedBeforeCommit = new Promise<number>(resolve => {
      deleted = resolve;
    });
    const lifecycle = db.transaction(async tx => {
      await observeGitHubInstallationLifecycle(
        { installationId: '773001', appType: 'standard', state: 'deleted' },
        tx
      );
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      deleted?.(backend.rows[0]!.pid);
      await barrier;
    });
    let refresh: ReturnType<typeof updateRepositoriesForIntegration> | undefined;
    let observationError: unknown;
    try {
      const holderPid = await githubTestTimeout(deletedBeforeCommit, 'lifecycle holder readiness');
      refresh = updateRepositoriesForIntegration(connected.integrationId, [
        { id: 99, name: 'revived', full_name: 'acme/revived', private: true },
      ]);
      await githubTestTimeout(
        waitForBlockedGitHubOwnerLock(holderPid, 'standard:773001'),
        'repository refresh lock observation'
      );
    } catch (error) {
      observationError = error;
    } finally {
      release?.();
    }
    const results = await Promise.allSettled([
      lifecycle,
      refresh ?? Promise.reject(new Error('Repository refresh did not start')),
    ]);
    if (observationError) throw observationError;
    expect(results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);

    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.installation_id, '773001'));
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(canonical).toMatchObject({ lifecycle_state: 'deleted' });
    expect(canonical?.repositories).toEqual([expect.objectContaining({ full_name: 'acme/repo' })]);
    expect(association).toMatchObject({ integration_status: 'suspended' });
    expect(association?.repositories).toEqual([
      expect.objectContaining({ full_name: 'acme/repo' }),
    ]);
  });

  test('keeps concurrent duplicate deletion cleanup idempotent with one completed receipt', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('773002')
    );
    if (!connected.ok) throw new Error('Expected canonical connection');
    const processDeletion = async () => {
      await observeGitHubInstallationLifecycle({
        installationId: '773002',
        appType: 'standard',
        state: 'deleted',
      });
      await recordCompletedGitHubInstallationDelivery({
        installationId: '773002',
        appType: 'standard',
        deliveryId: 'concurrent-delete',
        eventType: 'installation.deleted',
      });
    };

    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    let held: ((pid: number) => void) | undefined;
    const holderReady = new Promise<number>(resolve => {
      held = resolve;
    });
    const first = db
      .transaction(async tx => {
        await observeGitHubInstallationLifecycle(
          { installationId: '773002', appType: 'standard', state: 'deleted' },
          tx
        );
        const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        held?.(backend.rows[0]!.pid);
        await barrier;
      })
      .then(() =>
        recordCompletedGitHubInstallationDelivery({
          installationId: '773002',
          appType: 'standard',
          deliveryId: 'concurrent-delete',
          eventType: 'installation.deleted',
        })
      );
    let second: ReturnType<typeof processDeletion> | undefined;
    let observationError: unknown;
    try {
      const holderPid = await githubTestTimeout(holderReady, 'duplicate deletion holder readiness');
      second = processDeletion();
      await githubTestTimeout(
        waitForBlockedGitHubOwnerLock(holderPid, 'standard:773002'),
        'duplicate deletion lock observation'
      );
    } catch (error) {
      observationError = error;
    } finally {
      release?.();
    }
    const deletionResults = await Promise.allSettled([
      first,
      second ?? Promise.reject(new Error('Second deletion did not start')),
    ]);
    if (observationError) throw observationError;
    expect(deletionResults).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
    await observeGitHubInstallationLifecycle({
      installationId: '773002',
      appType: 'standard',
      state: 'active',
    });

    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.installation_id, '773002'));
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(canonical?.lifecycle_state).toBe('deleted');
    expect(association?.integration_status).toBe('suspended');
    await expect(
      db
        .select()
        .from(github_installation_webhook_receipts)
        .where(eq(github_installation_webhook_receipts.delivery_id, 'concurrent-delete'))
    ).resolves.toHaveLength(1);
  });

  test('maps bounded lock waits to a retryable connection conflict', async () => {
    const statements: string[] = [];
    const transaction = {
      execute: async (query: { toQuery: (config: unknown) => { sql: string } }) => {
        const rendered = query.toQuery({
          escapeName: (name: string) => name,
          escapeParam: (index: number) => `$${index + 1}`,
          escapeString: (value: string) => `'${value}'`,
          casing: { getColumnCasing: (column: { name: string }) => column.name },
        });
        statements.push(rendered.sql);
        if (statements.length === 4) {
          throw { cause: { code: '55P03' } };
        }
      },
    } as never;

    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data(), transaction)
    ).resolves.toEqual({ ok: false, reason: 'retryable_conflict' });
    expect(statements.slice(0, 3).join(' ')).toContain('SET LOCAL lock_timeout');
    expect(statements.slice(0, 3).join(' ')).toContain('SET LOCAL statement_timeout');
    expect(statements.slice(0, 3).join(' ')).toContain('idle_in_transaction_session_timeout');
  });

  test.each([
    { sharing: false, multiple: false, expected: 'multiple_installations_disabled' },
    { sharing: true, multiple: false, expected: 'multiple_installations_disabled' },
    { sharing: false, multiple: true, expected: 'shared_installation_disabled' },
    { sharing: true, multiple: true, expected: 'ok' },
  ] as const)(
    'applies sharing=$sharing and multiple-installation=$multiple independently',
    async ({ sharing, multiple, expected }) => {
      const organizationA = await createTestOrganization('Policy GitHub A', ownerId, 0);
      const organizationB = await createTestOrganization('Policy GitHub B', otherOwnerId, 0);
      process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = sharing ? organizationB.id : '';
      process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = multiple ? organizationB.id : '';
      const incumbent = await connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationA.id },
        data('123456')
      );
      const destinationExisting = await connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data('654321'), kiloUserId: otherOwnerId }
      );
      if (!incumbent.ok || !destinationExisting.ok) {
        throw new Error('Expected policy fixtures');
      }

      const result = await connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data('123456'), kiloUserId: otherOwnerId }
      );
      if (expected === 'ok') {
        expect(result).toMatchObject({ ok: true });
      } else {
        expect(result).toEqual({ ok: false, reason: expected });
      }
    }
  );

  test('reconnects the same association after local disconnect and rejects another owner', async () => {
    const first = await connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data());
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, first.integrationId);
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'user', id: otherOwnerId },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'claimed_by_other_owner' });
    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data())
    ).resolves.toEqual({ ok: true, integrationId: first.integrationId });
  });

  test('frees a non-allowlisted organization to connect a different installation after local disconnect', async () => {
    const organization = await createTestOrganization('Disconnect frees slot org', ownerId, 0);
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('881001')
    );
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected initial connection');

    await disconnectGitHubInstallation({ type: 'org', id: organization.id }, first.integrationId);

    // Reconnecting a completely different installation must not be blocked
    // by the stale, locally disconnected association left behind.
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('881002')
    );
    expect(second).toEqual({ ok: true, integrationId: expect.any(String) });
    if (!second.ok) throw new Error('Expected reconnection to a new installation');
    expect(second.integrationId).not.toBe(first.integrationId);

    const rows = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    expect(rows.find(row => row.id === first.integrationId)).toMatchObject({
      platform_installation_id: '881001',
      github_disconnected_at: expect.any(String),
    });
    expect(rows.find(row => row.id === second.integrationId)).toMatchObject({
      platform_installation_id: '881002',
      github_disconnected_at: null,
      integration_status: 'active',
    });
  });

  test('allows uninstalling an already locally disconnected sole association', async () => {
    const organization = await createTestOrganization('Disconnected removal org', ownerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('881003')
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation(
      { type: 'org', id: organization.id },
      connected.integrationId
    );

    let deleteUpstreamCalled = false;
    await uninstallExclusiveGitHubInstallation({
      owner: { type: 'org', id: organization.id },
      integrationId: connected.integrationId,
      deleteUpstream: async () => {
        deleteUpstreamCalled = true;
      },
    });
    expect(deleteUpstreamCalled).toBe(true);

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(row).toBeUndefined();
  });

  test('refuses to uninstall a disconnected association while another owner remains connected', async () => {
    const organizationA = await createTestOrganization('Shared disconnect removal A', ownerId, 0);
    const organizationB = await createTestOrganization(
      'Shared disconnect removal B',
      otherOwnerId,
      0
    );
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data()
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );
    if (!first.ok || !second.ok) throw new Error('Expected shared connections');

    await disconnectGitHubInstallation({ type: 'org', id: organizationA.id }, first.integrationId);

    await expect(
      uninstallExclusiveGitHubInstallation({
        owner: { type: 'org', id: organizationA.id },
        integrationId: first.integrationId,
        deleteUpstream: async () => {
          throw new Error('deleteUpstream must not be called while another owner is connected');
        },
      })
    ).rejects.toThrow('GitHub installation must be disconnected locally');
  });

  test('disconnect terminalizes active review work, clears its dispatch reservation, leaves unrelated work untouched, and unblocks connect-existing', async () => {
    const organizationA = await createTestOrganization('Disconnect review cleanup A', ownerId, 0);
    const unrelatedOrganization = await createTestOrganization(
      'Disconnect review cleanup unrelated',
      ownerId,
      0
    );

    const connectedA = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('991001')
    );
    const connectedUnrelated = await connectVerifiedGitHubInstallation(
      { type: 'org', id: unrelatedOrganization.id },
      data('991002')
    );
    if (!connectedA.ok || !connectedUnrelated.ok) throw new Error('Expected both connections');

    const activeReviewId = await createCodeReview({
      owner: { type: 'org', id: organizationA.id, userId: ownerId },
      platformIntegrationId: connectedA.integrationId,
      repoFullName: 'acme/disconnect-review-cleanup',
      prNumber: 1,
      prUrl: 'https://github.com/acme/disconnect-review-cleanup/pull/1',
      prTitle: 'disconnect review cleanup',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/disconnect-review-cleanup',
      headSha: 'disconnect-review-cleanup-head-sha',
      platform: 'github',
    });
    await updateCodeReviewStatus(activeReviewId, 'queued');
    const activeAttempt = await createCodeReviewAttempt({
      codeReviewId: activeReviewId,
      status: 'queued',
    });
    await db
      .update(cloud_agent_code_reviews)
      .set({ dispatch_reservation_id: crypto.randomUUID() })
      .where(eq(cloud_agent_code_reviews.id, activeReviewId));

    const unrelatedReviewId = await createCodeReview({
      owner: { type: 'org', id: unrelatedOrganization.id, userId: ownerId },
      platformIntegrationId: connectedUnrelated.integrationId,
      repoFullName: 'acme/disconnect-review-cleanup-unrelated',
      prNumber: 2,
      prUrl: 'https://github.com/acme/disconnect-review-cleanup-unrelated/pull/2',
      prTitle: 'unrelated integration review',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/unrelated-integration-review',
      headSha: 'unrelated-integration-review-head-sha',
      platform: 'github',
    });
    await updateCodeReviewStatus(unrelatedReviewId, 'queued');

    await disconnectGitHubInstallation(
      { type: 'org', id: organizationA.id },
      connectedA.integrationId
    );

    const [reviewRow] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        dispatchReservationId: cloud_agent_code_reviews.dispatch_reservation_id,
        terminalReason: cloud_agent_code_reviews.terminal_reason,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, activeReviewId));
    expect(reviewRow).toMatchObject({
      status: 'cancelled',
      dispatchReservationId: null,
      terminalReason: 'user_cancelled',
    });

    const [attemptRow] = await db
      .select({ status: cloud_agent_code_review_attempts.status })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, activeAttempt.id));
    expect(attemptRow?.status).toBe('cancelled');

    // A completely different integration's active review must be untouched.
    const [unrelatedReviewRow] = await db
      .select({ status: cloud_agent_code_reviews.status })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, unrelatedReviewId));
    expect(unrelatedReviewRow?.status).toBe('queued');

    // A different, newly approved organization can now connect-existing to
    // the same canonical installation that organization A disconnected from.
    const organizationC = await createTestOrganization('Disconnect review cleanup C', ownerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationC.id;
    const connectedC = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationC.id },
      { ...data('991001'), kiloUserId: ownerId }
    );
    expect(connectedC).toEqual({ ok: true, integrationId: expect.any(String) });
  });

  test('uninstall terminalizes active review work, clears its reservation, and settles the ledger only after the delete commits', async () => {
    const organization = await createTestOrganization('Uninstall review cleanup org', ownerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('992001')
    );
    if (!connected.ok) throw new Error('Expected initial connection');

    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organization.id, userId: ownerId },
      platformIntegrationId: connected.integrationId,
      repoFullName: 'acme/uninstall-review-cleanup',
      prNumber: 1,
      prUrl: 'https://github.com/acme/uninstall-review-cleanup/pull/1',
      prTitle: 'uninstall review cleanup',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/uninstall-review-cleanup',
      headSha: 'uninstall-review-cleanup-head-sha',
      platform: 'github',
      triggerSource: 'manual',
    });
    await updateCodeReviewStatus(reviewId, 'queued');
    const attempt = await createCodeReviewAttempt({ codeReviewId: reviewId, status: 'queued' });
    await db
      .update(cloud_agent_code_reviews)
      .set({ dispatch_reservation_id: crypto.randomUUID() })
      .where(eq(cloud_agent_code_reviews.id, reviewId));

    await uninstallExclusiveGitHubInstallation({
      owner: { type: 'org', id: organization.id },
      integrationId: connected.integrationId,
      deleteUpstream: async () => {},
    });

    const [reviewRow] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        dispatchReservationId: cloud_agent_code_reviews.dispatch_reservation_id,
        platformIntegrationId: cloud_agent_code_reviews.platform_integration_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    // ON DELETE SET NULL: the terminal review survives the association's
    // deletion, but is no longer linked to it.
    expect(reviewRow).toMatchObject({
      status: 'cancelled',
      dispatchReservationId: null,
      platformIntegrationId: null,
    });

    const [attemptRow] = await db
      .select({ status: cloud_agent_code_review_attempts.status })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));
    expect(attemptRow?.status).toBe('cancelled');

    const [integrationRow] = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(integrationRow).toBeUndefined();

    const [ledgerRow] = await db
      .select({ status: operation_ledgers.status, settledAt: operation_ledgers.settled_at })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));
    expect(ledgerRow).toMatchObject({ status: 'no_op', settledAt: expect.any(String) });
  });

  test('a failed uninstall rolls back review cancellation and never settles the ledger', async () => {
    const organization = await createTestOrganization('Uninstall rollback org', ownerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('992002')
    );
    if (!connected.ok) throw new Error('Expected initial connection');

    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organization.id, userId: ownerId },
      platformIntegrationId: connected.integrationId,
      repoFullName: 'acme/uninstall-rollback',
      prNumber: 1,
      prUrl: 'https://github.com/acme/uninstall-rollback/pull/1',
      prTitle: 'uninstall rollback',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/uninstall-rollback',
      headSha: 'uninstall-rollback-head-sha',
      platform: 'github',
      triggerSource: 'manual',
    });
    await updateCodeReviewStatus(reviewId, 'queued');
    const attempt = await createCodeReviewAttempt({ codeReviewId: reviewId, status: 'queued' });
    const reservationId = crypto.randomUUID();
    await db
      .update(cloud_agent_code_reviews)
      .set({ dispatch_reservation_id: reservationId })
      .where(eq(cloud_agent_code_reviews.id, reviewId));

    await expect(
      uninstallExclusiveGitHubInstallation({
        owner: { type: 'org', id: organization.id },
        integrationId: connected.integrationId,
        deleteUpstream: async () => {
          throw new Error('upstream GitHub delete failed');
        },
      })
    ).rejects.toThrow('upstream GitHub delete failed');

    // The whole transaction — including the review cancellation and the
    // association delete — must have rolled back together.
    const [reviewRow] = await db
      .select({
        status: cloud_agent_code_reviews.status,
        dispatchReservationId: cloud_agent_code_reviews.dispatch_reservation_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    expect(reviewRow).toMatchObject({ status: 'queued', dispatchReservationId: reservationId });

    const [attemptRow] = await db
      .select({ status: cloud_agent_code_review_attempts.status })
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));
    expect(attemptRow?.status).toBe('queued');

    const [integrationRow] = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(integrationRow).toBeDefined();

    // The ledger must never have been settled for a cancellation that was
    // itself rolled back.
    const [ledgerRow] = await db
      .select({ status: operation_ledgers.status, settledAt: operation_ledgers.settled_at })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.operation_key, `review:${reviewId}`));
    expect(ledgerRow).toMatchObject({ status: 'admitted', settledAt: null });
  });

  test('revokes the real runtime authorization query on local disconnect', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await expect(
      assertGitHubInstallationRuntimeAuthorized('123456', 'standard')
    ).resolves.toBeUndefined();
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
  });

  test('rejects the real runtime authorization query for a blocked personal owner', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'test block' })
      .where(eq(kilocode_users.id, ownerId));
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
  });

  test('finds legacy Standard installations whose app type is null', async () => {
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '654321',
        github_app_type: null,
        integration_status: 'active',
      })
      .returning();
    await expect(
      findIntegrationByInstallationId('github', '654321', 'standard')
    ).resolves.toMatchObject({ id: legacy.id });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('654321', 'standard')
    ).resolves.toBeUndefined();
    await materializeGitHubInstallationIdentity({ installationId: '654321', appType: 'standard' });
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '654321',
        appType: 'standard',
        deliveryId: 'legacy-delete',
      })
    ).resolves.toBe('not_completed');
    await recordCompletedGitHubInstallationDelivery({
      installationId: '654321',
      appType: 'standard',
      deliveryId: 'legacy-delete',
      eventType: 'installation.deleted',
    });
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '654321',
        appType: 'standard',
        deliveryId: 'legacy-delete',
      })
    ).resolves.toBe('completed');
  });

  test('ignores an unbound shadow when canonical identity already exists', async () => {
    const organization = await createTestOrganization('Canonical coexistence org', ownerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('654322')
    );
    if (!connected.ok) throw new Error('Expected canonical connection');
    await db.insert(platform_integrations).values({
      owned_by_user_id: ownerId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: '654322',
      github_app_type: 'standard',
      integration_status: 'active',
    });

    await expect(
      assertGitHubInstallationRuntimeAuthorized('654322', 'standard')
    ).resolves.toBeUndefined();
    await db
      .update(github_app_installations)
      .set({ sharing_mode: 'web_cloud_agent' })
      .where(eq(github_app_installations.installation_id, '654322'));
    await expect(assertGitHubInstallationRuntimeAuthorized('654322', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
  });

  test('routes the same numeric GitHub installation ID by app identity', async () => {
    await db.insert(platform_integrations).values([
      {
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '777777',
        github_app_type: null,
        integration_status: 'active',
      },
      {
        owned_by_user_id: otherOwnerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '777777',
        github_app_type: 'lite',
        integration_status: 'active',
      },
    ]);
    await expect(
      getPlatformIntegration({
        platform: 'github',
        teamId: '777777',
        userId: 'github-user',
        githubAppType: 'standard',
      })
    ).resolves.toMatchObject({ owned_by_user_id: ownerId });
    await expect(
      getPlatformIntegration({
        platform: 'github',
        teamId: '777777',
        userId: 'github-user',
        githubAppType: 'lite',
      })
    ).resolves.toMatchObject({ owned_by_user_id: otherOwnerId });
  });

  test('consumes a legacy Standard-null pending row without creating a duplicate association', async () => {
    const [pending] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_account_id: '222',
        github_app_type: null,
        integration_status: 'pending',
      })
      .returning();
    const result = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      { ...data(), pendingIntegrationId: pending.id }
    );
    expect(result).toEqual({ ok: true, integrationId: pending.id });
    const associations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, ownerId));
    expect(associations).toHaveLength(1);
    expect(associations[0]).toMatchObject({
      id: pending.id,
      github_app_type: 'standard',
      platform_installation_id: '123456',
    });
  });

  test('serializes concurrent legacy writers and fails closed on Standard-null peers', async () => {
    const payload = {
      platform: 'github',
      integrationType: 'app',
      platformInstallationId: '888881',
      repositoryAccess: 'all',
      githubAppType: 'standard' as const,
    };
    const results = await Promise.all([
      upsertPlatformIntegrationForOwner({ type: 'user', id: ownerId }, payload),
      upsertPlatformIntegrationForOwner({ type: 'user', id: otherOwnerId }, payload),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'claimed_by_other_owner' });

    await db.insert(platform_integrations).values({
      owned_by_user_id: ownerId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: '888882',
      github_app_type: null,
      integration_status: 'active',
    });
    await expect(
      upsertPlatformIntegrationForOwner(
        { type: 'user', id: otherOwnerId },
        { ...payload, platformInstallationId: '888882' }
      )
    ).resolves.toEqual({ ok: false, reason: 'claimed_by_other_owner' });
  });

  test('keeps canonical repositories aligned with user refresh and suppresses disconnected projection', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    const refreshed = [{ id: 2, name: 'fresh', full_name: 'acme/fresh', private: false }];
    await updateRepositoriesForIntegration(connected.integrationId, refreshed);
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(association?.repositories).toEqual(refreshed);
    expect(canonical?.repositories).toEqual(refreshed);

    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await updateGitHubInstallationRepositories({
      installationId: '123456',
      appType: 'standard',
      repositoriesAdded: [{ id: 3, name: 'late', full_name: 'acme/late', private: false }],
    });
    const [disconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [updatedCanonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(disconnected?.repositories).toEqual(refreshed);
    expect(updatedCanonical?.repositories).toContainEqual(
      expect.objectContaining({ id: 3, full_name: 'acme/late' })
    );
  });

  test('clears a retained attempt reference when its integration is deleted', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    const [attempt] = await db
      .insert(github_connection_attempts)
      .values({
        kilo_user_id: ownerId,
        owner_type: 'user',
        owner_id: ownerId,
        github_app_type: 'standard',
        completed_integration_id: connected.integrationId,
        expires_at: '2026-09-08T00:00:00.000Z',
      })
      .returning();
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [retained] = await db
      .select()
      .from(github_connection_attempts)
      .where(eq(github_connection_attempts.id, attempt.id));
    expect(retained?.completed_integration_id).toBeNull();
  });

  test('keeps a late rename out of a disconnected projection while updating canonical identity', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await updateGitHubInstallationAccountIdentity({
      installationId: '123456',
      appType: 'standard',
      accountId: '222',
      accountLogin: 'renamed-acme',
    });
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(association?.platform_account_login).toBe('acme');
    expect(canonical).toMatchObject({ account_id: '222', account_login: 'renamed-acme' });
  });

  test('rejects malformed upstream installation ids', async () => {
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'user', id: ownerId },
        data('not-an-installation-id')
      )
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
  });

  test('does not revive a locally disconnected association after an upstream unsuspend', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'suspended',
    });
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'active',
    });
    await expect(
      db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, connected.integrationId),
      })
    ).resolves.toMatchObject({
      github_disconnected_at: expect.any(String),
      integration_status: 'suspended',
    });
  });

  test('backfills one safe legacy association as a shadow observation', async () => {
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '5555',
        platform_account_id: '22',
        platform_account_login: 'acme',
        integration_status: 'active',
        github_app_type: null,
      })
      .returning();
    const result = await backfillGitHubInstallations();
    expect(result).toMatchObject({ scanned: 1, canonicalCreated: 1, linked: 1, skipped: 0 });
    expect(result).toMatchObject({ scanComplete: true, nextCursor: null });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, legacy.id) })
    ).resolves.toMatchObject({ github_installation_id: expect.any(String) });
    await expect(db.select().from(github_app_installations)).resolves.toEqual([
      expect.objectContaining({ installation_id: '5555', lifecycle_state: 'active' }),
    ]);
  });

  test('leaves disabled migration-0205 losers unbound', async () => {
    const [loser] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: null,
        integration_status: 'suspended',
        metadata: { github_dedup: { original_installation_id: '6666' } },
      })
      .returning();
    await expect(backfillGitHubInstallations()).resolves.toEqual({
      scanned: 1,
      canonicalCreated: 0,
      linked: 0,
      skipped: 1,
      skippedInvalid: 0,
      skippedDeduplicated: 1,
      skippedAmbiguous: 0,
      skippedUnhealthy: 0,
      scanComplete: true,
      nextCursor: null,
    });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, loser.id) })
    ).resolves.toMatchObject({ github_installation_id: null, integration_status: 'suspended' });
  });
});

async function waitForBlockedGitHubOwnerLock(
  holderPid: number,
  expectedLockKey: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${holderPid} = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE 'SELECT pg_advisory_xact_lock(hashtext(%'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Expected contender blocked on advisory lock ${expectedLockKey}`);
}

async function githubTestTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
