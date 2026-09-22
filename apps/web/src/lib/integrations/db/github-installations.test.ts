import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  ...jest.requireActual('@/lib/organizations/effective-model-access.server'),
  isOrganizationModelUpdateAllowed: jest.fn(async () => true),
}));
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
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { assertGitHubAutomationCanBeEnabled } from '../github/sharing-compatibility';
import {
  createCodeReview,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
} from '@/lib/code-reviews/db/code-reviews';
import {
  bindGitHubIntegrationToCanonicalInstallation,
  claimGitHubInstallationDelivery,
  completeGitHubInstallationDelivery,
  connectVerifiedGitHubInstallation,
  GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS,
  getGitHubInstallationDeliveryStatus,
  materializeGitHubInstallationIdentity,
  disconnectGitHubInstallation,
  observeGitHubInstallationLifecycle,
  recordCompletedGitHubInstallationDelivery,
  releaseGitHubInstallationDelivery,
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
  getIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization,
  getIntegrationsByOrganization,
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

/**
 * Models a legacy association that was already locally disconnected when the
 * canonical backfill ran, so it stayed unbound (github_installation_id NULL)
 * and never received a canonical row.
 */
const legacyUnboundDisconnectedAssociation = (organizationId: string, installationId: string) => ({
  owned_by_organization_id: organizationId,
  platform: 'github',
  integration_type: 'app',
  platform_installation_id: installationId,
  github_app_type: 'standard' as const,
  integration_status: 'suspended' as const,
  suspended_by: 'local_disconnect',
  github_disconnected_at: new Date().toISOString(),
  repository_access: 'all',
});

async function applyConnectionRoleBackfill() {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      '../../packages/db/src/migrations/0255_github_connection_role_indexes.sql'
    ),
    'utf8'
  );
  const backfill = migration
    .split('--> statement-breakpoint')
    .map(statement => statement.trim())
    .filter(statement => statement.startsWith('WITH eligible AS'));
  expect(backfill).toHaveLength(1);
  await db.execute(sql.raw(backfill[0]));
}

describe('GitHub installation persistence', () => {
  beforeEach(async () => {
    process.env.GITHUB_AGENT_ONLY_CONNECTIONS_ENABLED = 'true';
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

  test.each([
    'auth_invalid',
    'suspended',
    'disconnected',
    'active_old_writer',
    'bound_old_writer',
  ] as const)('recovers an unambiguous verified legacy owner after %s', async state => {
    const organization = await createTestOrganization('Legacy recovery', ownerId, 0);
    const oldWriter = state === 'active_old_writer' || state === 'bound_old_writer';
    if (oldWriter) await applyConnectionRoleBackfill();
    const [canonical] =
      state === 'bound_old_writer'
        ? await db
            .insert(github_app_installations)
            .values({
              installation_id: '996001',
              github_app_type: 'standard',
              lifecycle_state: 'active',
            })
            .returning()
        : [];
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '996001',
        github_app_type: null,
        github_installation_id: canonical?.id ?? null,
        integration_status: state === 'suspended' ? 'suspended' : 'active',
        suspended_at: state === 'suspended' ? new Date().toISOString() : null,
        auth_invalid_at: state === 'auth_invalid' ? new Date().toISOString() : null,
        github_disconnected_at: state === 'disconnected' ? new Date().toISOString() : null,
      })
      .returning();
    if (!oldWriter) await applyConnectionRoleBackfill();
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, legacy.id) })
    ).resolves.toMatchObject({ github_connection_role: null });
    await expect(
      connectVerifiedGitHubInstallation({ type: 'org', id: organization.id }, data('996001'))
    ).resolves.toEqual({ ok: true, integrationId: legacy.id });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, legacy.id) })
    ).resolves.toMatchObject({
      github_connection_role: 'workflow',
      github_installation_id: expect.any(String),
      integration_status: 'active',
      auth_invalid_at: null,
      suspended_at: null,
      github_disconnected_at: null,
      github_authorized_by_user_id: ownerId,
    });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('996001', 'standard', legacy.id)
    ).resolves.toBeUndefined();
  });

  test('does not recover an unhealthy legacy shadow over a current canonical workflow owner', async () => {
    const original = await createTestOrganization('Canonical incumbent', ownerId, 0);
    const shadowOwner = await createTestOrganization('Legacy shadow', otherOwnerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: original.id },
      data('996002')
    );
    if (!connected.ok) throw new Error('Expected incumbent');
    const [shadow] = await db
      .insert(platform_integrations)
      .values({
        ...legacyUnboundDisconnectedAssociation(shadowOwner.id, '996002'),
        github_app_type: null,
      })
      .returning();
    await applyConnectionRoleBackfill();
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: shadowOwner.id },
        { ...data('996002'), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    await expect(
      connectVerifiedGitHubInstallation({ type: 'org', id: original.id }, data('996002'))
    ).resolves.toEqual({ ok: true, integrationId: connected.integrationId });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, shadow.id) })
    ).resolves.toMatchObject({
      github_connection_role: null,
      github_disconnected_at: expect.any(String),
    });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('996002', 'standard', connected.integrationId)
    ).resolves.toBeUndefined();
  });

  test.each(['github_dedup', 'pending_approval', 'completed_installation'] as const)(
    'does not infer legacy authority from a sole row with %s history',
    async history => {
      const organization = await createTestOrganization('Unreconciled legacy history', ownerId, 0);
      const [legacy] = await db
        .insert(platform_integrations)
        .values({
          ...legacyUnboundDisconnectedAssociation(organization.id, '996003'),
          metadata: { [history]: {} },
        })
        .returning();
      await applyConnectionRoleBackfill();
      await expect(
        connectVerifiedGitHubInstallation({ type: 'org', id: organization.id }, data('996003'))
      ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
      await expect(
        db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, legacy.id) })
      ).resolves.toMatchObject({ github_connection_role: null });
    }
  );

  test('keeps inactive same-identity legacy owners unreconciled after verified reconnect', async () => {
    const organizationA = await createTestOrganization('Inactive legacy A', ownerId, 0);
    const organizationB = await createTestOrganization('Inactive legacy B', otherOwnerId, 0);
    await db
      .insert(platform_integrations)
      .values([
        legacyUnboundDisconnectedAssociation(organizationA.id, '996004'),
        legacyUnboundDisconnectedAssociation(organizationB.id, '996004'),
      ]);
    await applyConnectionRoleBackfill();
    await expect(
      connectVerifiedGitHubInstallation({ type: 'org', id: organizationA.id }, data('996004'))
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    const roles = await db
      .select({ role: platform_integrations.github_connection_role })
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, '996004'));
    expect(roles).toEqual([{ role: null }, { role: null }]);
  });

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
      sharing_mode: 'exclusive',
      sharing_admission_checked_at: null,
    });
    expect(associations.find(row => row.id === first.integrationId)?.github_connection_role).toBe(
      'workflow'
    );
    expect(associations.find(row => row.id !== first.integrationId)?.github_connection_role).toBe(
      'agent_only'
    );
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

  test('claims a shared delivery exactly once until it completes', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910001', appType: 'standard' });
    const input = {
      installationId: '910001',
      appType: 'standard' as const,
      deliveryId: 'delivery-claim',
      eventType: 'installation.deleted',
    };
    const delivered = {
      installationId: '910001',
      appType: 'standard' as const,
      deliveryId: 'delivery-claim',
    };

    const first = await claimGitHubInstallationDelivery(input);
    expect(first).toEqual({ status: 'claimed', githubInstallationId: expect.any(String) });
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await expect(getGitHubInstallationDeliveryStatus(delivered)).resolves.toBe('processing');
    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({
      status: 'processing',
    });

    await completeGitHubInstallationDelivery({
      githubInstallationId: first.githubInstallationId,
      deliveryId: 'delivery-claim',
    });
    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({ status: 'completed' });
    await expect(getGitHubInstallationDeliveryStatus(delivered)).resolves.toBe('completed');
    await expect(db.select().from(github_installation_webhook_receipts)).resolves.toHaveLength(1);
  });

  test('enforces worker SQL purpose, exact identity, membership, repository and disconnect fences', async () => {
    const {
      buildInstallationLookupQuery,
      buildManagedInstallationLookupQuery,
      InstallationLookupService,
    } = jest.requireActual(
      '../../../../../../services/git-token-service/src/installation-lookup-service'
    );
    const organizationA = await createTestOrganization('Workflow SQL A', ownerId, 0);
    const organizationB = await createTestOrganization('Agent SQL B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      { ...data(), repositoryAccess: 'selected' }
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId, repositoryAccess: 'selected' }
    );
    if (!first.ok || !second.ok) throw new Error('Expected both associations');
    const params = {
      githubRepo: 'acme/repo',
      userId: otherOwnerId,
      orgId: organizationB.id,
      expectedIntegrationId: second.integrationId,
      accessPurpose: 'agent',
    };
    await expect(buildInstallationLookupQuery(db, params)).resolves.toEqual([]);
    await expect(
      buildManagedInstallationLookupQuery(db, { ...params, accessPurpose: 'workflow' })
    ).resolves.toEqual([]);
    await expect(buildManagedInstallationLookupQuery(db, params)).resolves.toMatchObject([
      { id: second.integrationId },
    ]);
    await expect(
      buildManagedInstallationLookupQuery(db, {
        ...params,
        expectedIntegrationId: first.integrationId,
      })
    ).resolves.toEqual([]);
    await expect(
      buildManagedInstallationLookupQuery(db, { ...params, userId: ownerId })
    ).resolves.toEqual([]);
    await expect(
      new InstallationLookupService(
        { HYPERDRIVE: { connectionString: 'unused' } },
        db
      ).findManagedInstallationForRepo({ ...params, githubRepo: 'acme/other' })
    ).resolves.toMatchObject({ success: false, reason: 'integration_mismatch' });
    await expect(
      buildManagedInstallationLookupQuery(db, { ...params, expectedIntegrationId: undefined })
    ).resolves.toEqual([]);
    await disconnectGitHubInstallation({ type: 'org', id: organizationA.id }, first.integrationId);
    await expect(
      findIntegrationByInstallationId('github', '123456', 'standard')
    ).resolves.toMatchObject({ id: first.integrationId, github_connection_role: 'workflow' });
    await expect(buildInstallationLookupQuery(db, params)).resolves.toEqual([]);
    await expect(buildManagedInstallationLookupQuery(db, params)).resolves.toHaveLength(1);
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toMatchObject({ integrationId: second.integrationId });
    await disconnectGitHubInstallation({ type: 'org', id: organizationB.id }, second.integrationId);
    await expect(buildManagedInstallationLookupQuery(db, params)).resolves.toEqual([]);
    await expect(
      db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, second.integrationId),
      })
    ).resolves.toMatchObject({ github_connection_role: 'agent_only' });
  });

  test('keeps mixed-owner workflow selection independent of the oldest agent-only connection', async () => {
    const organizationA = await createTestOrganization('Mixed workflow A', ownerId, 0);
    const organizationB = await createTestOrganization('Mixed workflow B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    await connectVerifiedGitHubInstallation({ type: 'org', id: organizationA.id }, data());
    const secondary = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data(), kiloUserId: otherOwnerId }
    );
    const workflow = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('777999'), kiloUserId: otherOwnerId }
    );
    if (!secondary.ok || !workflow.ok) throw new Error('Expected mixed connections');
    await expect(
      getIntegrationForOwner({ type: 'org', id: organizationB.id }, 'github')
    ).resolves.toMatchObject({ id: workflow.integrationId });
    await expect(
      getPrimaryGitHubIntegrationForOrganization(organizationB.id)
    ).resolves.toMatchObject({ id: workflow.integrationId });
    await expect(getIntegrationsByOrganization(organizationB.id, 'github')).resolves.toHaveLength(
      1
    );
    await expect(
      getIntegrationsByOrganization(organizationB.id, 'github', 'agent')
    ).resolves.toHaveLength(2);
    await expect(
      assertGitHubAutomationCanBeEnabled({ type: 'org', id: organizationB.id })
    ).resolves.toBeUndefined();
    const { getRepositoryCustomizations, updateInstallationSettings, updateRepositorySettings } =
      await import('@/lib/integrations/github-apps-service');
    await expect(
      getRepositoryCustomizations({ type: 'org', id: organizationB.id }, secondary.integrationId)
    ).resolves.toMatchObject({ canEditReviews: false });
    await expect(
      updateInstallationSettings({ type: 'org', id: organizationB.id }, secondary.integrationId, {
        prReviewMode: 'on',
      })
    ).resolves.toMatchObject({ success: false });
    await expect(
      updateRepositorySettings({ type: 'org', id: organizationB.id }, secondary.integrationId, 1, {
        prReviewMode: 'off',
      })
    ).resolves.toMatchObject({ success: false });
    await expect(
      updateInstallationSettings({ type: 'org', id: organizationB.id }, secondary.integrationId, {
        modelSlug: 'model-a',
      })
    ).resolves.toMatchObject({ success: true });
    await expect(
      updateRepositorySettings({ type: 'org', id: organizationB.id }, secondary.integrationId, 1, {
        modelSlug: 'model-b',
      })
    ).resolves.toMatchObject({ success: true });
  });

  test.each([
    'oldest',
    'pending_history',
    'workflow_binding',
    'conflicting_bindings',
    'stale_unbound',
    'dedup_loser',
  ] as const)('migrates association authority safely for %s', async scenario => {
    const organizationA = await createTestOrganization('Migration A', ownerId, 0);
    const organizationB = await createTestOrganization('Migration B', otherOwnerId, 0);
    const [canonical] = await db
      .insert(github_app_installations)
      .values({ installation_id: '999001', github_app_type: 'standard', lifecycle_state: 'active' })
      .returning();
    const rows = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organizationA.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: scenario === 'dedup_loser' ? null : '999001',
          github_installation_id:
            scenario === 'stale_unbound' || scenario === 'dedup_loser' ? null : canonical.id,
          github_app_type: null,
          integration_status:
            scenario === 'stale_unbound' || scenario === 'dedup_loser' ? 'suspended' : 'active',
          suspended_at: scenario === 'stale_unbound' ? '2026-01-01T00:00:00Z' : null,
          metadata:
            scenario === 'pending_history'
              ? { pending_approval: {} }
              : scenario === 'dedup_loser'
                ? { github_dedup: { original_installation_id: '999001' } }
                : {},
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          owned_by_organization_id: organizationB.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '999001',
          github_installation_id: canonical.id,
          github_app_type: 'standard',
          integration_status: 'active',
          created_at: '2026-02-01T00:00:00Z',
        },
      ])
      .returning();
    if (scenario === 'workflow_binding' || scenario === 'conflicting_bindings') {
      await db.insert(agent_configs).values({
        owned_by_organization_id: organizationB.id,
        agent_type: 'code_review',
        platform: 'github',
        is_enabled: true,
        config: {},
        created_by: otherOwnerId,
      });
    }
    if (scenario === 'conflicting_bindings') {
      await db.insert(agent_configs).values({
        owned_by_organization_id: organizationA.id,
        agent_type: 'code_review',
        platform: 'github',
        is_enabled: true,
        config: {},
        created_by: ownerId,
      });
    }
    await applyConnectionRoleBackfill();
    const updated = await db
      .select()
      .from(platform_integrations)
      .orderBy(platform_integrations.created_at);
    const expected =
      scenario === 'oldest'
        ? ['workflow', 'agent_only']
        : scenario === 'workflow_binding'
          ? ['agent_only', 'workflow']
          : scenario === 'stale_unbound' || scenario === 'dedup_loser'
            ? [null, 'workflow']
            : [null, null];
    expect(updated.map(row => row.github_connection_role)).toEqual(expected);
    if (scenario === 'oldest') {
      await disconnectGitHubInstallation({ type: 'org', id: organizationA.id }, rows[0].id);
      await expect(
        db
          .update(platform_integrations)
          .set({ github_connection_role: 'workflow' })
          .where(eq(platform_integrations.id, rows[1].id))
      ).rejects.toThrow();
    }
  });

  test('keeps a fresh processing claim as a duplicate instead of reclaiming it', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910003', appType: 'standard' });
    const input = {
      installationId: '910003',
      appType: 'standard' as const,
      deliveryId: 'delivery-fresh',
      eventType: 'installation.deleted',
    };

    const first = await claimGitHubInstallationDelivery(input);
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({ status: 'processing' });
    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '910003',
        appType: 'standard',
        deliveryId: 'delivery-fresh',
      })
    ).resolves.toBe('processing');
  });

  test('reclaims a stale processing claim left by a killed dispatch', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910004', appType: 'standard' });
    const input = {
      installationId: '910004',
      appType: 'standard' as const,
      deliveryId: 'delivery-stale',
      eventType: 'installation.deleted',
    };

    const first = await claimGitHubInstallationDelivery(input);
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await db
      .update(github_installation_webhook_receipts)
      .set({
        created_at: new Date(
          Date.now() - GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS - 60_000
        ).toISOString(),
      })
      .where(eq(github_installation_webhook_receipts.delivery_id, 'delivery-stale'));

    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({
      status: 'claimed',
      githubInstallationId: first.githubInstallationId,
    });
    // The reclaim refreshes the claim timestamp, so a second attempt is a duplicate again.
    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({ status: 'processing' });
  });

  test('keeps a completed receipt terminal for its delivery id', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910005', appType: 'standard' });
    const input = {
      installationId: '910005',
      appType: 'standard' as const,
      deliveryId: 'delivery-terminal',
      eventType: 'installation.deleted',
    };

    const first = await claimGitHubInstallationDelivery(input);
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await completeGitHubInstallationDelivery({
      githubInstallationId: first.githubInstallationId,
      deliveryId: 'delivery-terminal',
    });
    await db
      .update(github_installation_webhook_receipts)
      .set({
        created_at: new Date(
          Date.now() - GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS - 60_000
        ).toISOString(),
      })
      .where(eq(github_installation_webhook_receipts.delivery_id, 'delivery-terminal'));

    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({ status: 'completed' });
  });

  test('lets only one concurrent redelivery reclaim a stale processing claim', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910006', appType: 'standard' });
    const input = {
      installationId: '910006',
      appType: 'standard' as const,
      deliveryId: 'delivery-concurrent-reclaim',
      eventType: 'installation.deleted',
    };

    const first = await claimGitHubInstallationDelivery(input);
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await db
      .update(github_installation_webhook_receipts)
      .set({
        created_at: new Date(
          Date.now() - GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS - 60_000
        ).toISOString(),
      })
      .where(eq(github_installation_webhook_receipts.delivery_id, 'delivery-concurrent-reclaim'));

    // Hold the receipt row open so both contenders fully acquire and then
    // block on the same row, guaranteeing genuine contention on the reclaim
    // update rather than incidental serialization.
    let releaseHolder: (() => void) | undefined;
    const holderRelease = new Promise<void>(resolve => {
      releaseHolder = resolve;
    });
    let reportHolderPid: ((pid: number) => void) | undefined;
    const holderReady = new Promise<number>(resolve => {
      reportHolderPid = resolve;
    });
    const holder = db.transaction(async tx => {
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      await tx.execute(
        sql`SELECT id FROM github_installation_webhook_receipts WHERE delivery_id = ${'delivery-concurrent-reclaim'} FOR UPDATE`
      );
      reportHolderPid?.(backend.rows[0]!.pid);
      await holderRelease;
    });

    const holderPid = await githubTestTimeout(holderReady, 'reclaim holder readiness');
    const contenders = [
      claimGitHubInstallationDelivery(input),
      claimGitHubInstallationDelivery(input),
    ];
    try {
      await githubTestTimeout(
        waitForBlockedGitHubDeliveryLock(holderPid, 2),
        'reclaim contender blocking'
      );
    } finally {
      releaseHolder?.();
    }
    await holder;

    const results = await Promise.all(contenders);
    expect(results.filter(result => result.status === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'processing')).toHaveLength(1);
  });

  test('releases a failed claim so redelivery can reprocess', async () => {
    await materializeGitHubInstallationIdentity({ installationId: '910002', appType: 'standard' });
    const input = {
      installationId: '910002',
      appType: 'standard' as const,
      deliveryId: 'delivery-release',
      eventType: 'installation.deleted',
    };

    const first = await claimGitHubInstallationDelivery(input);
    if (first.status !== 'claimed') throw new Error('Expected first claim to win');
    await releaseGitHubInstallationDelivery({
      githubInstallationId: first.githubInstallationId,
      deliveryId: 'delivery-release',
    });

    await expect(
      getGitHubInstallationDeliveryStatus({
        installationId: '910002',
        appType: 'standard',
        deliveryId: 'delivery-release',
      })
    ).resolves.toBe('not_completed');
    await expect(claimGitHubInstallationDelivery(input)).resolves.toEqual({
      status: 'claimed',
      githubInstallationId: first.githubInstallationId,
    });
  });

  test('refuses to bind an association to a non-active canonical installation', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('773003')
    );
    if (!connected.ok) throw new Error('Expected canonical connection');
    await observeGitHubInstallationLifecycle({
      installationId: '773003',
      appType: 'standard',
      state: 'suspended',
    });
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.platform_installation_id, '773003')
        )
      )
      .limit(1);
    if (!integration) throw new Error('Expected GitHub association');

    await expect(
      bindGitHubIntegrationToCanonicalInstallation({
        integrationId: integration.id,
        installationId: '773003',
        appType: 'standard',
      })
    ).rejects.toThrow('Canonical GitHub installation is not active');
  });

  test('treats a malformed persisted repository cache as empty during webhook updates', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('773004')
    );
    if (!connected.ok) throw new Error('Expected canonical connection');
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, 'standard'),
          eq(github_app_installations.installation_id, '773004')
        )
      )
      .limit(1);
    if (!canonical) throw new Error('Expected canonical installation');
    await db
      .update(github_app_installations)
      .set({ repositories: { not: 'an array' } as never })
      .where(eq(github_app_installations.id, canonical.id));

    await expect(
      updateGitHubInstallationRepositories({
        installationId: '773004',
        appType: 'standard',
        repositoriesAdded: [{ id: 5, name: 'ok', full_name: 'acme/ok', private: true }],
      })
    ).resolves.toBeUndefined();
    const [refreshed] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, canonical.id));
    expect(refreshed.repositories).toEqual([
      { id: 5, name: 'ok', full_name: 'acme/ok', private: true },
    ]);
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

  test('preserves an incumbent workflow enabled concurrently with secondary attachment', async () => {
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
    await expect(attach).resolves.toMatchObject({ ok: true });
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

  test('admits a secondary without changing an incumbent automation workflow', async () => {
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
    ).resolves.toMatchObject({ ok: true });
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
    await expect(
      assertGitHubInstallationRuntimeAuthorized('123456', 'standard')
    ).resolves.toBeUndefined();

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
        github_connection_role: 'agent_only',
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
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
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
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
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
    ).resolves.toMatchObject({ ok: true, integrationId: first.integrationId });
  });

  test('keeps generic runtime workflow-only and requires purpose for exact secondary access', async () => {
    const organizationA = await createTestOrganization('Shared runtime A', ownerId, 0);
    const organizationB = await createTestOrganization('Shared runtime B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;

    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('881881')
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('881881'), kiloUserId: otherOwnerId }
    );
    if (!first.ok || !second.ok) throw new Error('Expected shared connections');
    const [sharedCanonical] = await db
      .select({ sharingMode: github_app_installations.sharing_mode })
      .from(github_app_installations)
      .where(eq(github_app_installations.installation_id, '881881'));
    expect(sharedCanonical?.sharingMode).toBe('exclusive');

    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard')
    ).resolves.toBeUndefined();

    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', first.integrationId)
    ).resolves.toBeUndefined();
    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', second.integrationId)
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');
    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', second.integrationId, 'agent')
    ).resolves.toBeUndefined();
    await expect(
      assertGitHubInstallationRuntimeAuthorized(
        '881881',
        'standard',
        second.integrationId,
        'management'
      )
    ).resolves.toBeUndefined();

    // An unknown association id is still rejected.
    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', crypto.randomUUID())
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');

    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', '')
    ).resolves.toBeUndefined();

    // Local health is still enforced on the exact-id path.
    await db
      .update(platform_integrations)
      .set({ suspended_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, second.integrationId));
    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', second.integrationId, 'agent')
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');

    // Owner validity is still enforced on the exact-id path.
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationA.id));
    await expect(
      assertGitHubInstallationRuntimeAuthorized('881881', 'standard', first.integrationId)
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');
  });

  test('rejects an exact association whose canonical installation is unhealthy', async () => {
    const organization = await createTestOrganization('Shared runtime canonical A', ownerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('882882')
    );
    if (!connected.ok) throw new Error('Expected initial connection');

    await expect(
      assertGitHubInstallationRuntimeAuthorized('882882', 'standard', connected.integrationId)
    ).resolves.toBeUndefined();

    await db
      .update(github_app_installations)
      .set({ auth_invalid_at: new Date().toISOString() })
      .where(eq(github_app_installations.installation_id, '882882'));
    await expect(
      assertGitHubInstallationRuntimeAuthorized('882882', 'standard', connected.integrationId)
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');
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

  test('rejects a new personal claimant while another personal owner is actively connected', async () => {
    const first = await connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data());
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected initial connection');
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'user', id: otherOwnerId },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'claimed_by_other_owner' });
  });

  test('reconnects the same personal association after local disconnect', async () => {
    const first = await connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data());
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, first.integrationId);
    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data())
    ).resolves.toEqual({ ok: true, integrationId: first.integrationId });
  });

  test('lets an incumbent personal owner reconnect after another tenant attaches to their installation', async () => {
    const organization = await createTestOrganization(
      'Personal incumbent sharing org',
      otherOwnerId,
      0
    );
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organization.id;

    const incumbent = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('990101')
    );
    if (!incumbent.ok) {
      throw new Error('Expected the personal owner to connect as the original tenant');
    }

    const shared = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      { ...data('990101'), kiloUserId: otherOwnerId }
    );
    expect(shared).toMatchObject({ ok: true });

    const [canonical] = await db
      .select({ sharingMode: github_app_installations.sharing_mode })
      .from(github_app_installations)
      .where(eq(github_app_installations.installation_id, '990101'));
    expect(canonical?.sharingMode).toBe('exclusive');

    // Regression: a tenant attaching afterwards must not lock the incumbent
    // personal owner out of their own installation.
    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data('990101'))
    ).resolves.toEqual({ ok: true, integrationId: incumbent.integrationId });
  });

  test('still rejects a new personal claimant while an organization is actively connected', async () => {
    const organization = await createTestOrganization('Active org holds installation', ownerId, 0);
    const incumbent = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organization.id },
      data('990103')
    );
    if (!incumbent.ok) throw new Error('Expected the organization incumbent to connect');
    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: otherOwnerId }, data('990103'))
    ).resolves.toEqual({ ok: false, reason: 'claimed_by_other_owner' });
  });

  test('does not transfer workflow authority to a new personal owner after disconnect', async () => {
    const first = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data('990104')
    );
    if (!first.ok) throw new Error('Expected the first personal owner to connect');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, first.integrationId);

    // A purely disconnected other-owner row has relinquished the
    // installation, so it is not an active incumbent and must not force a
    // claimed_by_other_owner rejection for a new personal claimant.
    const second = await connectVerifiedGitHubInstallation(
      { type: 'user', id: otherOwnerId },
      { ...data('990104'), kiloUserId: otherOwnerId }
    );
    expect(second).toEqual({ ok: false, reason: 'claimed_by_other_owner' });
  });

  test('still requires sharing admission for an organization attaching as a new second tenant', async () => {
    const organizationA = await createTestOrganization('Second tenant source org', ownerId, 0);
    const organizationB = await createTestOrganization(
      'Second tenant destination org',
      otherOwnerId,
      0
    );
    const incumbent = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('990105')
    );
    if (!incumbent.ok) throw new Error('Expected the incumbent organization to connect');

    // organizationB is not on the shared-installation allowlist, so a
    // genuine new second-tenant org still goes through (and fails) the
    // unchanged sharing-admission gate.
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...data('990105'), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'shared_installation_disabled' });
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

  test('still requires secondary admission after the workflow owner disconnects', async () => {
    const organizationA = await createTestOrganization('First tenant disconnect A', ownerId, 0);
    const organizationB = await createTestOrganization(
      'First tenant disconnect B',
      otherOwnerId,
      0
    );
    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('881010')
    );
    if (!first.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'org', id: organizationA.id }, first.integrationId);

    // organizationB is not in GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS.
    // A fully disconnected prior tenant is no longer an active incumbent,
    // so this must succeed as an ordinary (non-shared) attach rather than
    // being forced through sharing admission.
    expect(process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS).toBeFalsy();
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('881010'), kiloUserId: otherOwnerId }
    );
    expect(second).toEqual({ ok: false, reason: 'shared_installation_disabled' });

    const [canonical] = await db
      .select({ sharingMode: github_app_installations.sharing_mode })
      .from(github_app_installations)
      .where(eq(github_app_installations.installation_id, '881010'));
    expect(canonical?.sharingMode).toBe('exclusive');
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

  test('refuses to uninstall an unbound legacy association while another tenant is actively connected', async () => {
    const organizationA = await createTestOrganization('Legacy unbound removal A', ownerId, 0);
    const organizationB = await createTestOrganization('Legacy unbound removal B', otherOwnerId, 0);
    const sibling = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('993001'), kiloUserId: otherOwnerId }
    );
    if (!sibling.ok) throw new Error('Expected the sibling tenant to connect');

    const inserted = await db
      .insert(platform_integrations)
      .values(legacyUnboundDisconnectedAssociation(organizationA.id, '993001'))
      .returning();
    const legacy = inserted[0];
    if (!legacy) throw new Error('Expected legacy association');

    let deleteUpstreamCalled = false;
    await expect(
      uninstallExclusiveGitHubInstallation({
        owner: { type: 'org', id: organizationA.id },
        integrationId: legacy.id,
        deleteUpstream: async () => {
          deleteUpstreamCalled = true;
        },
      })
    ).rejects.toThrow('GitHub installation must be disconnected locally');
    expect(deleteUpstreamCalled).toBe(false);

    // The sibling tenant must be untouched: no upstream delete, no
    // github_deleted suspension cascade.
    const [siblingRow] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, sibling.integrationId));
    expect(siblingRow).toMatchObject({ integration_status: 'active', suspended_at: null });
  });

  test('allows uninstalling a reconciled legacy workflow association with no connected sibling', async () => {
    const organization = await createTestOrganization('Legacy unbound sole removal', ownerId, 0);
    const inserted = await db
      .insert(platform_integrations)
      .values({
        ...legacyUnboundDisconnectedAssociation(organization.id, '993002'),
        github_connection_role: 'workflow',
      })
      .returning();
    const legacy = inserted[0];
    if (!legacy) throw new Error('Expected legacy association');

    let deleteUpstreamCalled = false;
    await uninstallExclusiveGitHubInstallation({
      owner: { type: 'org', id: organization.id },
      integrationId: legacy.id,
      deleteUpstream: async () => {
        deleteUpstreamCalled = true;
      },
    });
    expect(deleteUpstreamCalled).toBe(true);
    await expect(
      db.select().from(platform_integrations).where(eq(platform_integrations.id, legacy.id))
    ).resolves.toHaveLength(0);
  });

  test('refuses to uninstall an unbound legacy association whose canonical installation is shared', async () => {
    const organizationA = await createTestOrganization('Legacy shared removal A', ownerId, 0);
    const organizationB = await createTestOrganization('Legacy shared removal B', otherOwnerId, 0);
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('993003'), kiloUserId: otherOwnerId }
    );
    if (!connected.ok) throw new Error('Expected the sibling tenant to connect');

    const inserted = await db
      .insert(platform_integrations)
      .values(legacyUnboundDisconnectedAssociation(organizationA.id, '993003'))
      .returning();
    const legacy = inserted[0];
    if (!legacy) throw new Error('Expected legacy association');

    await disconnectGitHubInstallation(
      { type: 'org', id: organizationB.id },
      connected.integrationId
    );

    // Force the canonical into a non-exclusive sharing mode with no connected
    // sibling remaining, isolating the shared-mode guard: it must be read via
    // the installation identity, not the unbound target's missing binding.
    await db
      .update(github_app_installations)
      .set({ sharing_mode: 'web_cloud_agent' })
      .where(
        and(
          eq(github_app_installations.installation_id, '993003'),
          eq(github_app_installations.github_app_type, 'standard')
        )
      );

    let deleteUpstreamCalled = false;
    await expect(
      uninstallExclusiveGitHubInstallation({
        owner: { type: 'org', id: organizationA.id },
        integrationId: legacy.id,
        deleteUpstream: async () => {
          deleteUpstreamCalled = true;
        },
      })
    ).rejects.toThrow('GitHub installation must be disconnected locally');
    expect(deleteUpstreamCalled).toBe(false);
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
        github_connection_role: 'workflow',
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
    await expect(
      assertGitHubInstallationRuntimeAuthorized('654322', 'standard')
    ).resolves.toBeUndefined();
  });

  test('treats an empty exact-association id as the generic exclusive-only path', async () => {
    const organizationA = await createTestOrganization('Empty id shared A', ownerId, 0);
    const organizationB = await createTestOrganization('Empty id shared B', otherOwnerId, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;

    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      data('883883')
    );
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...data('883883'), kiloUserId: otherOwnerId }
    );
    if (!first.ok || !second.ok) throw new Error('Expected shared connections');

    // Leave exactly one healthy association on a shared installation, with an
    // unhealthy sibling, so only an exact-id lookup could legitimately pick it.
    await db
      .update(platform_integrations)
      .set({ suspended_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, first.integrationId));

    // An empty string must behave like the generic path (exclusive-only), not
    // like a genuine exact association.
    await expect(
      assertGitHubInstallationRuntimeAuthorized('883883', 'standard', '')
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');

    // The real exact id still resolves.
    await expect(
      assertGitHubInstallationRuntimeAuthorized('883883', 'standard', second.integrationId, 'agent')
    ).resolves.toBeUndefined();
  });

  test('routes the same numeric GitHub installation ID by app identity', async () => {
    await db.insert(platform_integrations).values([
      {
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '777777',
        github_connection_role: 'workflow',
        github_app_type: null,
        integration_status: 'active',
      },
      {
        owned_by_user_id: otherOwnerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '777777',
        github_connection_role: 'workflow',
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

async function waitForBlockedGitHubDeliveryLock(
  _holderPid: number,
  expected: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Count every backend blocked while updating the receipt row. The first
    // contender blocks on the holder's row lock and the second queues behind
    // the first, so only one directly lists the holder in pg_blocking_pids.
    const result = await db.execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%github_installation_webhook_receipts%'
    `);
    if ((result.rows[0]?.blocked ?? 0) >= expected) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Expected delivery-claim contenders blocked on the receipt row');
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
