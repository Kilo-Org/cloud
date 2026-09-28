import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  github_app_installations,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  bindGitHubIntegrationToCanonicalInstallation,
  connectVerifiedGitHubInstallation,
} from '@/lib/integrations/db/github-installations';
import type * as GitHubInstallationsModule from '@/lib/integrations/db/github-installations';
import type * as PlatformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type { InstallationCreatedPayload } from '../webhook-schemas';
import { handleInstallationCreated, handleInstallationUnsuspend } from './installation-handler';

jest.mock('../adapter', () => ({
  fetchGitHubRepositories: jest.fn(async () => []),
}));
jest.mock('@/lib/bot', () => ({
  bot: { initialize: jest.fn(async () => undefined), getState: jest.fn(() => ({})) },
}));
jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(async () => undefined),
}));

// Test-controlled pause inside the pending completion, used only by the
// controlled-concurrency test below. The mock factory references this object
// only when the mocked function is called (long after initialization), so the
// hoisted factory never touches it while it is still uninitialized.
const autoCompleteGateState: {
  gate: Promise<void> | null;
  entered: Promise<void> | null;
  release: (() => void) | null;
  markEntered: (() => void) | null;
  failBind: boolean;
} = { gate: null, entered: null, release: null, markEntered: null, failBind: false };

jest.mock('@/lib/integrations/db/github-installations', () => {
  const actual = jest.requireActual<typeof GitHubInstallationsModule>(
    '@/lib/integrations/db/github-installations'
  );
  return {
    ...actual,
    bindGitHubIntegrationToCanonicalInstallation: async (
      ...args: Parameters<typeof actual.bindGitHubIntegrationToCanonicalInstallation>
    ) => {
      if (autoCompleteGateState.failBind) throw new Error('bind failed');
      return actual.bindGitHubIntegrationToCanonicalInstallation(...args);
    },
  };
});

jest.mock('@/lib/integrations/db/platform-integrations', () => {
  const actual = jest.requireActual<typeof PlatformIntegrationsModule>(
    '@/lib/integrations/db/platform-integrations'
  );
  return {
    ...actual,
    autoCompleteInstallation: async (
      ...args: Parameters<typeof actual.autoCompleteInstallation>
    ) => {
      autoCompleteGateState.markEntered?.();
      if (autoCompleteGateState.gate) await autoCompleteGateState.gate;
      return actual.autoCompleteInstallation(...args);
    },
  };
});

function installAutoCompleteGate() {
  autoCompleteGateState.gate = new Promise<void>(resolve => {
    autoCompleteGateState.release = resolve;
  });
  autoCompleteGateState.entered = new Promise<void>(resolve => {
    autoCompleteGateState.markEntered = resolve;
  });
}

const ownerId = 'oauth/installation-handler-db-owner';
const otherOwnerId = 'oauth/installation-handler-db-other-owner';
const ACCOUNT_ID = 98765;
const ACCOUNT_LOGIN = 'handler-db-acme';

function createdPayload(installationId: string): InstallationCreatedPayload {
  return {
    action: 'created',
    installation: {
      id: Number(installationId),
      account: { id: ACCOUNT_ID, login: ACCOUNT_LOGIN },
      repository_selection: 'all',
      permissions: {},
      events: [],
      created_at: '2026-09-15T00:00:00.000Z',
    },
    requester: { id: 4242, login: 'requester' },
    sender: { login: 'requester' },
  } as InstallationCreatedPayload;
}

function verifiedConnectionData(installationId: string, kiloUserId: string) {
  return {
    platformInstallationId: installationId,
    platformAccountId: String(ACCOUNT_ID),
    platformAccountLogin: ACCOUNT_LOGIN,
    permissions: {},
    scopes: [],
    repositoryAccess: 'all',
    repositories: null,
    installedAt: '2026-09-15T00:00:00.000Z',
    githubAppType: 'standard' as const,
    kiloUserId,
    githubUserId: '5678',
    accountType: 'Organization' as const,
  };
}

async function insertPendingRequest(organizationId: string) {
  const inserted = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'github',
      integration_type: 'app',
      github_app_type: 'standard',
      platform_account_id: String(ACCOUNT_ID),
      platform_account_login: ACCOUNT_LOGIN,
      platform_installation_id: null,
      integration_status: 'pending',
      repository_access: 'all',
    })
    .returning();
  const pending = inserted[0];
  if (!pending) throw new Error('Expected the pending request row');
  return pending;
}

async function boundAssociations(installationId: string) {
  return db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.platform_installation_id, installationId),
        isNotNull(platform_integrations.github_installation_id)
      )
    );
}

async function canonicalSharingMode(installationId: string) {
  const [canonical] = await db
    .select({ sharingMode: github_app_installations.sharing_mode })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, 'standard'),
        eq(github_app_installations.installation_id, installationId)
      )
    );
  return canonical?.sharingMode;
}

describe('handleInstallationCreated sharing-admission serialization', () => {
  beforeEach(async () => {
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    await cleanupDbForTest();
    await db.insert(kilocode_users).values([
      {
        id: ownerId,
        google_user_email: 'handler-db-owner@example.com',
        google_user_name: 'Handler DB Owner',
        google_user_image_url: '',
        stripe_customer_id: 'cus_handler_db_owner',
      },
      {
        id: otherOwnerId,
        google_user_email: 'handler-db-other@example.com',
        google_user_name: 'Handler DB Other',
        google_user_image_url: '',
        stripe_customer_id: 'cus_handler_db_other',
      },
    ]);
  });

  afterEach(cleanupDbForTest);

  test('leaves a pending request pending when another tenant already owns the installation', async () => {
    const organizationA = await createTestOrganization('Handler DB Pending A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Pending B', otherOwnerId, 0);
    const installationId = '424242';

    const bound = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    if (!bound.ok) throw new Error('Expected the competing tenant to connect first');

    const pending = await insertPendingRequest(organizationA.id);

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: 'Installation association requires verified connection confirmation',
    });

    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      github_installation_id: null,
      platform_installation_id: null,
    });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationB.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('a pending completion that wins the installation lock still forces the verified path through sharing admission', async () => {
    const organizationA = await createTestOrganization('Handler DB Winner A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Winner B', otherOwnerId, 0);
    const installationId = '434343';

    await insertPendingRequest(organizationA.id);

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ message: 'Installation completed' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationA.id);

    // The organization that lost the race is not on the shared-installation
    // allowlist, so the verified path must require admission instead of
    // silently becoming a second exclusive tenant.
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        verifiedConnectionData(installationId, otherOwnerId)
      )
    ).resolves.toEqual({ ok: false, reason: 'shared_installation_disabled' });

    await expect(boundAssociations(installationId)).resolves.toHaveLength(1);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('a concurrent verified connection cannot commit between the pending-row check and its bind', async () => {
    const organizationA = await createTestOrganization('Handler DB Gate A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Gate B', otherOwnerId, 0);
    const installationId = '515151';

    await insertPendingRequest(organizationA.id);

    installAutoCompleteGate();
    const handlerPromise = handleInstallationCreated(createdPayload(installationId), 'standard');
    // The handler has passed its exclusivity check and is paused mid-completion.
    await autoCompleteGateState.entered;

    const verifiedPromise = connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    // Give the competing verified connection every chance to commit.
    await new Promise(resolve => setTimeout(resolve, 250));

    // It must be blocked on the installation lock rather than becoming the
    // first exclusive tenant while the pending completion is still in flight.
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);

    autoCompleteGateState.release?.();
    const [response, verifiedResult] = await Promise.all([handlerPromise, verifiedPromise]);

    expect(response.status).toBe(200);
    expect(verifiedResult).toEqual({ ok: false, reason: 'shared_installation_disabled' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationA.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('rolls back the pending completion when the canonical binding fails', async () => {
    const organization = await createTestOrganization('Handler DB Rollback', ownerId, 0);
    const installationId = '525252';

    const pending = await insertPendingRequest(organization.id);
    autoCompleteGateState.failBind = true;
    await expect(
      handleInstallationCreated(createdPayload(installationId), 'standard')
    ).rejects.toThrow('bind failed');
    autoCompleteGateState.failBind = false;

    // The completion ran inside the same transaction as the binding, so a
    // binding failure must leave nothing partially applied.
    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      platform_installation_id: null,
      github_installation_id: null,
    });
  });

  test('does not auto-attach a second tenant while legacy associations are committed but unbound', async () => {
    const legacyOwner = await createTestOrganization('Handler DB Legacy Unbound', otherOwnerId, 0);
    const otherLegacyOwner = await createTestOrganization(
      'Handler DB Legacy Unbound Two',
      otherOwnerId,
      0
    );
    const requester = await createTestOrganization('Handler DB Legacy Pending', ownerId, 0);
    const installationId = '575757';

    // The legacy (management-disabled) callback commits its association for
    // this installation and binds it in a separate step. Two such rows exist
    // here, so the active-unbound repair path does not converge them before
    // the pending completion runs.
    const legacyRows = await db
      .insert(platform_integrations)
      .values(
        [legacyOwner.id, otherLegacyOwner.id].map((organizationId, index) => ({
          github_connection_role: index === 0 ? ('workflow' as const) : null,
          owned_by_organization_id: organizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard' as const,
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'active' as const,
          repository_access: 'all',
        }))
      )
      .returning();
    const legacy = legacyRows[0];
    if (!legacy) throw new Error('Expected a legacy association');

    const pending = await insertPendingRequest(requester.id);

    await handleInstallationCreated(createdPayload(installationId), 'standard');

    // The pending request must not become a second tenant on this installation
    // just because the legacy peer is not bound yet.
    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      github_installation_id: null,
    });

    // The legacy path then completes its own bind, as the callback does.
    await bindGitHubIntegrationToCanonicalInstallation({
      integrationId: legacy.id,
      installationId,
      appType: 'standard',
    });

    // Invariant: never two live tenants on one installation.
    const bound = await boundAssociations(installationId);
    expect(bound.length).toBeLessThanOrEqual(1);
  });

  test('recovers the connected tenant when a disconnected former tenant is also present', async () => {
    const disconnectedOwner = await createTestOrganization(
      'Handler DB Unsuspend Former Tenant',
      otherOwnerId,
      0
    );
    const connectedOwner = await createTestOrganization(
      'Handler DB Unsuspend Live Tenant',
      ownerId,
      0
    );
    const installationId = '585858';

    const inserted = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: disconnectedOwner.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard',
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'suspended',
          suspended_at: new Date().toISOString(),
          suspended_by: 'local_disconnect',
          github_disconnected_at: new Date().toISOString(),
          repository_access: 'all',
        },
        {
          owned_by_organization_id: connectedOwner.id,
          github_connection_role: 'workflow',
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard',
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'suspended',
          suspended_at: new Date().toISOString(),
          suspended_by: 'github_suspend',
          repository_access: 'all',
        },
      ])
      .returning();
    const live = inserted[1];
    if (!live) throw new Error('Expected the connected association');

    await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    // The connected tenant must recover even though an arbitrary lookup can
    // return the retained disconnected row first.
    const [recovered] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, live.id));
    expect(recovered).toMatchObject({ integration_status: 'active', suspended_at: null });
  });

  test('recovers a suspended association when GitHub delivers installation.unsuspend', async () => {
    const organization = await createTestOrganization('Handler DB Unsuspend', ownerId, 0);
    const installationId = '545454';

    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_connection_role: 'workflow',
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_by: 'github_suspend',
        repository_access: 'all',
      })
      .returning();
    const suspended = inserted[0];
    if (!suspended) throw new Error('Expected the suspended association');

    const response = await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    await expect(response.json()).resolves.toEqual({ message: 'Installation unsuspended' });
    const [recovered] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, suspended.id));
    expect(recovered).toMatchObject({ integration_status: 'active', suspended_at: null });
  });

  test('does not unsuspend a locally disconnected former tenant', async () => {
    const organization = await createTestOrganization(
      'Handler DB Unsuspend Disconnected',
      ownerId,
      0
    );
    const installationId = '565656';

    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_by: 'local_disconnect',
        github_disconnected_at: new Date().toISOString(),
        repository_access: 'all',
      })
      .returning();
    const disconnected = inserted[0];
    if (!disconnected) throw new Error('Expected the disconnected association');

    await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, disconnected.id));
    expect(unchanged).toMatchObject({
      github_disconnected_at: expect.any(String),
      integration_status: 'suspended',
    });
  });
});
